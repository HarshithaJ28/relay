-- migrate:up
-- Ingestion (spec section 4): API keys, event types, subscriptions, idempotency keys,
-- and row-level security so the ingestion role only ever sees its own tenant.
--
-- The ingestion API connects as relay_tenant. After authenticating the caller it runs
-- every statement in a transaction that first does SET LOCAL app.tenant_id, and the
-- policies below compare that setting with each row's tenant_id. Without the setting
-- current_setting(..., true) is NULL, the comparison is never true, and no row is visible.
--
-- Adding NOT NULL columns without defaults needs empty tables; nothing is deployed yet.

SET ROLE relay_owner;

CREATE TABLE control.api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES control.tenants(id),
  prefix       text NOT NULL UNIQUE CHECK (prefix ~ '^[0-9a-f]{12}$'),  -- shown in logs and lists
  key_hash     bytea NOT NULL UNIQUE CHECK (length(key_hash) = 32),    -- SHA-256 of the full key
  name         text NOT NULL DEFAULT '' CHECK (length(name) <= 200),
  scopes       text[] NOT NULL DEFAULT ARRAY['events:write','events:read']
               CHECK (scopes <@ ARRAY['events:write','events:read']),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);

CREATE TABLE control.event_types (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES control.tenants(id),
  name       text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE control.endpoints
  ADD COLUMN status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled','breaker_open'));

CREATE TABLE control.subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES control.tenants(id),
  endpoint_id   uuid NOT NULL REFERENCES control.endpoints(id),
  event_type_id uuid NOT NULL REFERENCES control.event_types(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_type_id)
);
CREATE INDEX subscriptions_event_type_idx ON control.subscriptions (event_type_id);

ALTER TABLE delivery.events
  ADD COLUMN event_type text NOT NULL,
  ADD COLUMN payload_sha256 bytea NOT NULL CHECK (length(payload_sha256) = 32);

-- Idempotency has its own table: a unique key on the partitioned events table would
-- have to include created_at. Rows live at least until expires_at; the retention job
-- deletes them afterwards.
CREATE TABLE delivery.idempotency_keys (
  tenant_id        uuid NOT NULL REFERENCES control.tenants(id),
  key              text NOT NULL CHECK (key ~ '^[\x21-\x7e]{1,255}$'),
  event_id         uuid NOT NULL,
  event_created_at timestamptz NOT NULL,
  payload_sha256   bytea NOT NULL CHECK (length(payload_sha256) = 32),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX idempotency_keys_expiry_idx ON delivery.idempotency_keys (expires_at);

-- ---------------------------------------------------------------- row-level security
-- FORCE also applies the policies to the table owner. Superusers (migrations) bypass RLS.
ALTER TABLE control.tenants          ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE control.endpoints        ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE control.api_keys         ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE control.event_types      ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE control.subscriptions    ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery.events          ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery.deliveries      ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery.idempotency_keys ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

-- The tenant's own rows, for relay_tenant (ingestion API, later the control plane).
CREATE POLICY tenant_own ON control.tenants TO relay_tenant
  USING (id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_own ON control.endpoints TO relay_tenant
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_own ON control.api_keys TO relay_tenant
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_own ON control.event_types TO relay_tenant
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_own ON control.subscriptions TO relay_tenant
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_own ON delivery.events TO relay_tenant
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_own ON delivery.deliveries TO relay_tenant
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_own ON delivery.idempotency_keys TO relay_tenant
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The guarded functions run as relay_claims and must keep working across tenants.
CREATE POLICY claims_all ON control.tenants       TO relay_claims USING (true) WITH CHECK (true);
CREATE POLICY claims_all ON control.endpoints     TO relay_claims USING (true) WITH CHECK (true);
CREATE POLICY claims_all ON control.api_keys      TO relay_claims USING (true) WITH CHECK (true);
CREATE POLICY claims_all ON delivery.events       TO relay_claims USING (true) WITH CHECK (true);
CREATE POLICY claims_all ON delivery.deliveries   TO relay_claims USING (true) WITH CHECK (true);

RESET ROLE;

-- ---------------------------------------------------------------- API key lookup
-- relay_tenant cannot read api_keys before it knows the tenant, so authentication goes
-- through this function. It takes only the SHA-256 of the presented key, returns the
-- key's tenant and scopes if the key exists and is not revoked, and records use at most
-- once a minute (so authentication is not a write per request).
GRANT CREATE ON SCHEMA control TO relay_claims;  -- only while creating
GRANT SELECT, UPDATE (last_used_at) ON control.api_keys TO relay_claims;
SET ROLE relay_claims;

CREATE FUNCTION control.authenticate_api_key(p_key_hash bytea)
RETURNS TABLE (o_key_id uuid, o_tenant_id uuid, o_scopes text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_key_hash IS NULL OR length(p_key_hash) <> 32 THEN
    RETURN;
  END IF;
  UPDATE control.api_keys SET last_used_at = now()
  WHERE key_hash = p_key_hash AND revoked_at IS NULL
    AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');
  RETURN QUERY
  SELECT k.id, k.tenant_id, k.scopes FROM control.api_keys k
  WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA control FROM relay_claims;

REVOKE ALL ON FUNCTION control.authenticate_api_key(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.authenticate_api_key(bytea) TO relay_tenant;

-- ---------------------------------------------------------------- relay_tenant grants
-- Only what ingestion needs: read its configuration, write events, deliveries and
-- idempotency keys, create its own API keys (CLI, later the control plane).
GRANT USAGE ON SCHEMA control, delivery TO relay_tenant;
GRANT SELECT (id, retention_days) ON control.tenants TO relay_tenant;
GRANT SELECT (id, tenant_id, status) ON control.endpoints TO relay_tenant;  -- never url or secrets
GRANT SELECT ON control.event_types, control.subscriptions TO relay_tenant;
GRANT SELECT (id, tenant_id, prefix, name, scopes, created_at, revoked_at), INSERT (tenant_id, prefix, key_hash, name, scopes)
  ON control.api_keys TO relay_tenant;
GRANT SELECT, INSERT ON delivery.events TO relay_tenant;
GRANT SELECT (id, tenant_id, event_id, status), INSERT (tenant_id, endpoint_id, event_id, event_created_at)
  ON delivery.deliveries TO relay_tenant;
GRANT SELECT, INSERT ON delivery.idempotency_keys TO relay_tenant;

-- Inserts must also pass the tenant policy (WITH CHECK defaults to USING), so a tenant
-- cannot write a row for another tenant even with the INSERT privilege.

-- migrate:down
-- Not reversible once events carry event types; restore from backup instead.
