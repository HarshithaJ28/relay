-- migrate:up
-- Foundations: schemas, NOLOGIN roles, tables, state invariants.
-- Applied by a superuser/owner during deploy. Login + passwords are set by the
-- deploy step (never in a migration). No role gets BYPASSRLS or SUPERUSER.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['relay_owner','relay_tenant','relay_scheduler','relay_publisher',
                           'relay_worker','relay_claims','relay_reaper','relay_retention'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', r);
    END IF;
  END LOOP;
END $$;

CREATE SCHEMA control  AUTHORIZATION relay_owner;
CREATE SCHEMA delivery AUTHORIZATION relay_owner;

SET ROLE relay_owner;

CREATE TABLE control.tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  retention_days int  NOT NULL DEFAULT 30 CHECK (retention_days > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control.endpoints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES control.tenants(id),
  url               text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Partitioned by month in production (partition job comes later); a default
-- partition is used until partition management exists. No FKs point into it.
CREATE TABLE delivery.events (
  id         uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  tenant_id  uuid NOT NULL,
  payload    jsonb NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE delivery.events_default PARTITION OF delivery.events DEFAULT;

CREATE TABLE delivery.deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES control.tenants(id),
  endpoint_id         uuid NOT NULL REFERENCES control.endpoints(id),
  event_id            uuid NOT NULL,
  event_created_at    timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','queued','in_flight','succeeded','dead','cancelled')),
  attempt_count       int  NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 12),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  dispatch_seq        int  NOT NULL DEFAULT 0 CHECK (dispatch_seq >= 0),
  dispatch_token_hash bytea,
  lease_token_hash    bytea,
  lease_until         timestamptz,
  message_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  replay_of           uuid REFERENCES delivery.deliveries(id),
  last_error_class    text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- State invariants enforced by the database itself, so no code path can
  -- leave a row in a shape the state machine does not allow.
  CONSTRAINT queued_has_dispatch_token CHECK
    (status <> 'queued' OR (dispatch_token_hash IS NOT NULL AND lease_token_hash IS NULL AND lease_until IS NULL)),
  CONSTRAINT in_flight_has_lease CHECK
    (status <> 'in_flight' OR (lease_token_hash IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT idle_states_have_no_lease CHECK
    (status NOT IN ('scheduled','succeeded','dead','cancelled')
     OR (lease_token_hash IS NULL AND lease_until IS NULL AND dispatch_token_hash IS NULL))
);
CREATE INDEX deliveries_due_idx    ON delivery.deliveries (tenant_id, next_attempt_at) WHERE status = 'scheduled';
CREATE INDEX deliveries_lease_idx  ON delivery.deliveries (lease_until) WHERE status = 'in_flight';

CREATE TABLE delivery.delivery_attempts (
  id          bigserial PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES delivery.deliveries(id),
  attempt_no  int  NOT NULL,
  counted     boolean NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('success','retry','dead','lease_expired','deferred')),
  status_code int,
  error_class text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX attempts_counted_unique ON delivery.delivery_attempts (delivery_id, attempt_no) WHERE counted;

-- The raw dispatch token lives only here, only until the broker confirms the
-- publish (AC-1). The check ties "published" and "token cleared" together.
CREATE TABLE delivery.outbox (
  id             bigserial PRIMARY KEY,
  delivery_id    uuid NOT NULL REFERENCES delivery.deliveries(id),
  dispatch_seq   int  NOT NULL,
  dispatch_token bytea,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  UNIQUE (delivery_id, dispatch_seq),
  CONSTRAINT token_until_published CHECK ((published_at IS NULL) = (dispatch_token IS NOT NULL))
);
CREATE INDEX outbox_unpublished_idx ON delivery.outbox (id) WHERE published_at IS NULL;

CREATE TABLE delivery.dispatch_locks (
  tenant_id uuid PRIMARY KEY REFERENCES control.tenants(id),
  locked_at timestamptz NOT NULL DEFAULT now()
);

RESET ROLE;
