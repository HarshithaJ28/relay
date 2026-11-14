-- migrate:up
-- Control plane (spec sections 3, 7 and 8): plans, users, sessions, usage, billing.
--
-- Two new roles:
--   relay_control  the control-plane API. Like relay_tenant it is bound by row-level
--                  security on app.tenant_id, but it may manage endpoints, users and
--                  keys and read deliveries and attempts. Ingestion keeps the narrower
--                  relay_tenant, so a bug in ingestion cannot read endpoint URLs.
--   relay_auth     owns the few functions that run before a tenant is known (register,
--                  login lookup, refresh-token rotation, logout, Stripe events). Plain
--                  role, no BYPASSRLS, explicit policies only.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['relay_control', 'relay_auth'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', r);
    END IF;
  END LOOP;
END $$;

SET ROLE relay_owner;

-- ---------------------------------------------------------------- plans
CREATE TABLE control.plans (
  id                  text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{0,31}$'),
  name                text NOT NULL,
  price_cents         int  NOT NULL CHECK (price_cents >= 0),
  events_per_month    int  NOT NULL CHECK (events_per_month > 0),
  ingest_rate_per_sec int  NOT NULL CHECK (ingest_rate_per_sec BETWEEN 1 AND 100000),
  ingest_burst        int  NOT NULL CHECK (ingest_burst BETWEEN 1 AND 1000000),
  max_endpoints       int  NOT NULL CHECK (max_endpoints > 0),
  retention_days      int  NOT NULL CHECK (retention_days >= 2),
  dispatch_cap        int  NOT NULL CHECK (dispatch_cap BETWEEN 1 AND 100000)
);
INSERT INTO control.plans VALUES
  ('free', 'Free', 0,    10000,  10, 20,   3,  7,  20),
  ('pro',  'Pro',  2900, 1000000, 100, 200, 50, 30, 100);

ALTER TABLE control.tenants
  ADD COLUMN plan_id text NOT NULL DEFAULT 'free' REFERENCES control.plans(id),
  ADD COLUMN status  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'));

-- ---------------------------------------------------------------- users and sessions
CREATE TABLE control.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES control.tenants(id),
  email         text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON control.users (email);

CREATE TABLE control.sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES control.users(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES control.tenants(id),
  family       uuid NOT NULL,                       -- every rotation of one login shares it
  refresh_hash bytea NOT NULL UNIQUE CHECK (length(refresh_hash) = 32),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_family_idx ON control.sessions (family);

-- ---------------------------------------------------------------- usage and billing
CREATE TABLE control.usage_daily (
  tenant_id       uuid NOT NULL REFERENCES control.tenants(id),
  day             date NOT NULL,
  events_ingested bigint NOT NULL DEFAULT 0,
  attempts        bigint NOT NULL DEFAULT 0,
  successes       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

CREATE TABLE control.billing_accounts (
  tenant_id              uuid PRIMARY KEY REFERENCES control.tenants(id),
  stripe_customer_id     text UNIQUE,
  stripe_subscription_id text,
  status                 text NOT NULL DEFAULT 'none',
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.stripe_events (
  id           text PRIMARY KEY,                   -- Stripe's event id: each event applies once
  type         text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Attempts get a tenant column so they can be protected like everything else.
ALTER TABLE delivery.delivery_attempts ADD COLUMN tenant_id uuid;
CREATE INDEX attempts_tenant_idx ON delivery.delivery_attempts (tenant_id);

-- ---------------------------------------------------------------- row-level security
ALTER TABLE control.plans            ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE control.users            ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE control.sessions         ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE control.usage_daily      ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE control.billing_accounts ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE control.stripe_events    ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery.delivery_attempts ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

-- Plans are a public catalogue.
CREATE POLICY anyone_reads ON control.plans TO relay_control, relay_auth USING (true);

-- relay_control: its own tenant's rows.
CREATE POLICY control_own ON control.tenants          TO relay_control USING (id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON control.endpoints        TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON control.api_keys         TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON control.event_types      TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON control.subscriptions    TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON control.transformations  TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON control.users            TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON control.sessions         TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON control.usage_daily      TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON control.billing_accounts TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON delivery.events          TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON delivery.deliveries      TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY control_own ON delivery.delivery_attempts TO relay_control USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- relay_auth: what its functions touch, across tenants.
CREATE POLICY auth_all ON control.tenants          TO relay_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_all ON control.users            TO relay_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_all ON control.sessions         TO relay_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_all ON control.billing_accounts TO relay_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_all ON control.stripe_events    TO relay_auth USING (true) WITH CHECK (true);

-- Existing roles keep their access to attempts now that they are protected too.
CREATE POLICY claims_all    ON delivery.delivery_attempts TO relay_claims    USING (true) WITH CHECK (true);
CREATE POLICY retention_all ON delivery.delivery_attempts TO relay_retention USING (true);
CREATE POLICY owner_read    ON delivery.delivery_attempts TO relay_owner     USING (true);
CREATE POLICY retention_all ON control.usage_daily        TO relay_retention USING (true) WITH CHECK (true);

RESET ROLE;

-- Attempts written from now on carry their tenant (set from the delivery by a trigger, so
-- every writer of attempts, old and new, fills it in).
CREATE FUNCTION delivery.attempt_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  SELECT tenant_id INTO NEW.tenant_id FROM delivery.deliveries WHERE id = NEW.delivery_id;
  RETURN NEW;
END $$;
ALTER FUNCTION delivery.attempt_tenant() OWNER TO relay_owner;
REVOKE ALL ON FUNCTION delivery.attempt_tenant() FROM PUBLIC;
CREATE TRIGGER attempts_tenant BEFORE INSERT ON delivery.delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION delivery.attempt_tenant();

-- ---------------------------------------------------------------- relay_auth functions
GRANT USAGE ON SCHEMA control TO relay_auth;
GRANT SELECT, INSERT, UPDATE (plan_id, retention_days, ingest_rate_per_sec, ingest_burst, dispatch_cap)
  ON control.tenants TO relay_auth;
GRANT SELECT ON control.plans TO relay_auth;
GRANT SELECT, INSERT ON control.users TO relay_auth;
GRANT SELECT, INSERT, UPDATE (revoked_at) ON control.sessions TO relay_auth;
GRANT SELECT, INSERT, UPDATE ON control.billing_accounts TO relay_auth;
GRANT SELECT, INSERT ON control.stripe_events TO relay_auth;
GRANT CREATE ON SCHEMA control TO relay_auth;  -- only while creating
SET ROLE relay_auth;

-- Create a tenant on the free plan with its owner. Raises 23505 if the email is taken.
CREATE FUNCTION control.register_tenant(p_tenant_name text, p_email text, p_password_hash text)
RETURNS TABLE (o_tenant_id uuid, o_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t uuid;
  u uuid;
  p control.plans%ROWTYPE;
BEGIN
  IF p_tenant_name IS NULL OR length(btrim(p_tenant_name)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid tenant name' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO p FROM control.plans WHERE id = 'free';
  INSERT INTO control.tenants (name, plan_id, retention_days, ingest_rate_per_sec, ingest_burst, dispatch_cap)
  VALUES (btrim(p_tenant_name), p.id, p.retention_days, p.ingest_rate_per_sec, p.ingest_burst, p.dispatch_cap)
  RETURNING id INTO t;
  INSERT INTO control.users (tenant_id, email, password_hash, role)
  VALUES (t, lower(p_email), p_password_hash, 'owner') RETURNING id INTO u;
  o_tenant_id := t; o_user_id := u;
  RETURN NEXT;
END $$;

-- For login: the stored hash is checked by the API (argon2id), never by SQL.
CREATE FUNCTION control.user_for_login(p_email text)
RETURNS TABLE (o_user_id uuid, o_tenant_id uuid, o_password_hash text, o_role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.password_hash, u.role
  FROM control.users u JOIN control.tenants t ON t.id = u.tenant_id
  WHERE u.email = lower(p_email) AND t.status = 'active'
$$;

-- Start a session for a user who just proved their password.
CREATE FUNCTION control.start_session(p_user_id uuid, p_refresh_hash bytea, p_ttl interval)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s uuid;
BEGIN
  IF p_ttl <= interval '0' OR p_ttl > interval '90 days' THEN
    RAISE EXCEPTION 'invalid session lifetime' USING ERRCODE = '22023';
  END IF;
  INSERT INTO control.sessions (user_id, tenant_id, family, refresh_hash, expires_at)
  SELECT u.id, u.tenant_id, gen_random_uuid(), p_refresh_hash, now() + p_ttl FROM control.users u WHERE u.id = p_user_id
  RETURNING id INTO s;
  RETURN s;
END $$;

-- Rotate a refresh token. A token is good once: using it revokes it and issues the next
-- one in the same family. Presenting an already revoked token means it was stolen or
-- replayed, so the whole family is revoked (the real user has to log in again).
-- Returns the user, tenant and role, or no row when the token is not accepted.
CREATE FUNCTION control.rotate_session(p_old_hash bytea, p_new_hash bytea, p_ttl interval)
RETURNS TABLE (o_user_id uuid, o_tenant_id uuid, o_role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s control.sessions%ROWTYPE;
BEGIN
  IF p_ttl <= interval '0' OR p_ttl > interval '90 days' THEN
    RAISE EXCEPTION 'invalid session lifetime' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO s FROM control.sessions WHERE refresh_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF s.revoked_at IS NOT NULL THEN
    UPDATE control.sessions SET revoked_at = now() WHERE family = s.family AND revoked_at IS NULL;
    RETURN;
  END IF;
  IF s.expires_at <= now() THEN RETURN; END IF;
  UPDATE control.sessions SET revoked_at = now() WHERE id = s.id;
  INSERT INTO control.sessions (user_id, tenant_id, family, refresh_hash, expires_at)
  VALUES (s.user_id, s.tenant_id, s.family, p_new_hash, now() + p_ttl);
  RETURN QUERY
  SELECT u.id, u.tenant_id, u.role FROM control.users u JOIN control.tenants t ON t.id = u.tenant_id
  WHERE u.id = s.user_id AND t.status = 'active';
END $$;

-- Logout: revoke the whole family of the presented refresh token.
CREATE FUNCTION control.end_session(p_refresh_hash bytea)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE control.sessions SET revoked_at = now()
  WHERE revoked_at IS NULL AND family = (SELECT family FROM control.sessions WHERE refresh_hash = p_refresh_hash)
$$;

-- Apply a verified Stripe event once. Moves the tenant to the paid plan while the
-- subscription is active (or trialing) and back to the free plan otherwise, and copies the
-- plan's limits onto the tenant. Returns false if the event was already applied.
CREATE FUNCTION control.apply_stripe_event(
  p_event_id text, p_type text, p_tenant_id uuid, p_customer_id text, p_subscription_id text, p_status text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tenant uuid := p_tenant_id;
  p control.plans%ROWTYPE;
BEGIN
  INSERT INTO control.stripe_events (id, type) VALUES (p_event_id, p_type) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  IF tenant IS NULL THEN
    SELECT tenant_id INTO tenant FROM control.billing_accounts WHERE stripe_customer_id = p_customer_id;
  END IF;
  IF tenant IS NULL THEN RETURN true; END IF;  -- not ours: recorded, nothing to apply
  INSERT INTO control.billing_accounts (tenant_id, stripe_customer_id, stripe_subscription_id, status, updated_at)
  VALUES (tenant, p_customer_id, p_subscription_id, coalesce(p_status, 'none'), now())
  ON CONFLICT (tenant_id) DO UPDATE SET
    stripe_customer_id = coalesce(excluded.stripe_customer_id, control.billing_accounts.stripe_customer_id),
    stripe_subscription_id = coalesce(excluded.stripe_subscription_id, control.billing_accounts.stripe_subscription_id),
    status = excluded.status, updated_at = now();
  SELECT * INTO p FROM control.plans
  WHERE id = CASE WHEN p_status IN ('active', 'trialing') THEN 'pro' ELSE 'free' END;
  UPDATE control.tenants SET plan_id = p.id, retention_days = p.retention_days,
         ingest_rate_per_sec = p.ingest_rate_per_sec, ingest_burst = p.ingest_burst, dispatch_cap = p.dispatch_cap
  WHERE id = tenant;
  RETURN true;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA control FROM relay_auth;

REVOKE ALL ON FUNCTION control.register_tenant(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.user_for_login(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.start_session(uuid, bytea, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.rotate_session(bytea, bytea, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.end_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION control.apply_stripe_event(text, text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.register_tenant(text, text, text) TO relay_control;
GRANT EXECUTE ON FUNCTION control.user_for_login(text) TO relay_control;
GRANT EXECUTE ON FUNCTION control.start_session(uuid, bytea, interval) TO relay_control;
GRANT EXECUTE ON FUNCTION control.rotate_session(bytea, bytea, interval) TO relay_control;
GRANT EXECUTE ON FUNCTION control.end_session(bytea) TO relay_control;
GRANT EXECUTE ON FUNCTION control.apply_stripe_event(text, text, uuid, text, text, text) TO relay_control;

-- ---------------------------------------------------------------- relay_control grants
GRANT USAGE ON SCHEMA control, delivery TO relay_control;
GRANT SELECT ON control.plans TO relay_control;
GRANT SELECT (id, name, plan_id, status, retention_days, ingest_rate_per_sec, ingest_burst, dispatch_cap, created_at),
  UPDATE (name) ON control.tenants TO relay_control;
GRANT SELECT (id, tenant_id, email, role, created_at), INSERT (tenant_id, email, password_hash, role),
  UPDATE (role), DELETE ON control.users TO relay_control;
GRANT SELECT (id, user_id, tenant_id, expires_at, revoked_at, created_at) ON control.sessions TO relay_control;
GRANT SELECT, INSERT, UPDATE (url, status, concurrency_limit, signing_secrets, transformation_id), DELETE
  ON control.endpoints TO relay_control;
GRANT SELECT, INSERT, DELETE ON control.event_types, control.subscriptions TO relay_control;
GRANT SELECT (id, tenant_id, prefix, name, scopes, created_at, revoked_at, last_used_at),
  INSERT (tenant_id, prefix, key_hash, name, scopes), UPDATE (revoked_at) ON control.api_keys TO relay_control;
GRANT SELECT ON control.transformations, control.usage_daily, control.billing_accounts TO relay_control;
GRANT SELECT, INSERT ON delivery.events TO relay_control;
GRANT SELECT (id, tenant_id, endpoint_id, event_id, event_created_at, status, attempt_count, next_attempt_at,
              message_id, replay_of, last_error_class, created_at, updated_at),
  INSERT (tenant_id, endpoint_id, event_id, event_created_at) ON delivery.deliveries TO relay_control;
GRANT SELECT (id, delivery_id, tenant_id, attempt_no, counted, outcome, status_code, error_class, created_at)
  ON delivery.delivery_attempts TO relay_control;
GRANT EXECUTE ON FUNCTION delivery.replay_delivery(uuid, text) TO relay_control;

-- ---------------------------------------------------------------- usage
-- Daily totals, recomputed from the source tables for the given days (idempotent), before
-- retention deletes those rows. Run by the retention job.
GRANT SELECT (tenant_id, created_at) ON delivery.events TO relay_retention;
GRANT SELECT (tenant_id, created_at, outcome, counted) ON delivery.delivery_attempts TO relay_retention;
GRANT SELECT, INSERT, UPDATE ON control.usage_daily TO relay_retention;

-- migrate:down
-- Not reversible automatically; restore from backup instead.
