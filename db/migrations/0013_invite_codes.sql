-- migrate:up
-- Invite-only registration (A2): a new tenant can be created only with a single-use,
-- expiring invite code made by the operator. Only the SHA-256 of a code is stored.
--
--   control.create_invite         the operator (relay_owner) makes a code; the API cannot.
--   control.register_with_invite  marks the code used and creates the tenant and owner in
--                                 one transaction. A taken email rolls the whole call back,
--                                 so the code stays usable. Two calls racing on one code:
--                                 the second waits for the first's row lock, then finds the
--                                 code used.
-- relay_control loses EXECUTE on register_tenant, so no registration skips the invite.

SET ROLE relay_owner;

CREATE TABLE control.invite_codes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash      bytea NOT NULL UNIQUE CHECK (length(code_hash) = 32),
  note           text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  used_by_tenant uuid REFERENCES control.tenants(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at)
);

ALTER TABLE control.invite_codes ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_all ON control.invite_codes TO relay_auth USING (true) WITH CHECK (true);

RESET ROLE;

GRANT SELECT, INSERT, UPDATE (used_at, used_by_tenant) ON control.invite_codes TO relay_auth;
GRANT CREATE ON SCHEMA control TO relay_auth;  -- only while creating
SET ROLE relay_auth;

-- Make an invite valid for p_ttl (1 hour to 30 days). Returns its id.
CREATE FUNCTION control.create_invite(p_code_hash bytea, p_ttl interval, p_note text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i uuid;
BEGIN
  IF p_ttl IS NULL OR p_ttl < interval '1 hour' OR p_ttl > interval '30 days' THEN
    RAISE EXCEPTION 'invalid invite lifetime' USING ERRCODE = '22023';
  END IF;
  INSERT INTO control.invite_codes (code_hash, note, expires_at)
  VALUES (p_code_hash, coalesce(p_note, ''), now() + p_ttl)
  RETURNING id INTO i;
  RETURN i;
END $$;

-- Use an invite and register. Errors: RLINV the code is unknown, used or expired;
-- 23505 the email is taken (and the code is left unused).
CREATE FUNCTION control.register_with_invite(
  p_code_hash bytea, p_tenant_name text, p_email text, p_password_hash text)
RETURNS TABLE (o_tenant_id uuid, o_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  inv uuid;
  r record;
BEGIN
  UPDATE control.invite_codes SET used_at = now()
  WHERE code_hash = p_code_hash AND used_at IS NULL AND expires_at > now()
  RETURNING id INTO inv;
  IF inv IS NULL THEN
    RAISE EXCEPTION 'invalid invite' USING ERRCODE = 'RLINV';
  END IF;
  SELECT * INTO r FROM control.register_tenant(p_tenant_name, p_email, p_password_hash);
  UPDATE control.invite_codes SET used_by_tenant = r.o_tenant_id WHERE id = inv;
  o_tenant_id := r.o_tenant_id; o_user_id := r.o_user_id;
  RETURN NEXT;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA control FROM relay_auth;

REVOKE ALL ON FUNCTION control.create_invite(bytea, interval, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.register_with_invite(bytea, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.create_invite(bytea, interval, text) TO relay_owner;
GRANT EXECUTE ON FUNCTION control.register_with_invite(bytea, text, text, text) TO relay_control;
REVOKE EXECUTE ON FUNCTION control.register_tenant(text, text, text) FROM relay_control;

-- migrate:down
-- Not reversible automatically; restore from backup instead.
