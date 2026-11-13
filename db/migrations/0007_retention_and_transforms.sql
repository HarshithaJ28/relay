-- migrate:up
-- Retention (spec section 3, AC-3) and transformation failures (spec section 9, AC-2).
--
-- Retention: the job runs as relay_retention, per tenant and in small batches. It
-- deletes expired attempts, then terminal deliveries, then events with no deliveries
-- left, then expired idempotency keys. Non-terminal deliveries keep their payload until
-- the AC-3 ceiling (retention_days + the longest retry window + the maximum deferral
-- age); past it they become dead with retention_expired and are then deleted.
--
-- Transformations: an endpoint may name a transformation. If the runner confirms the
-- expression failed, the delivery is dead (transform_error, via record_attempt). If the
-- runner is unavailable the outcome is unknown, so defer_delivery returns it to scheduled
-- WITHOUT using an attempt, until the deferral has lasted longer than the maximum
-- deferral age; after that each further deferral counts as a failed attempt.

SET ROLE relay_owner;

-- ---------------------------------------------------------------- retention support
-- A replay keeps working after its original is deleted; outbox rows go with their delivery.
ALTER TABLE delivery.deliveries DROP CONSTRAINT deliveries_replay_of_fkey,
  ADD CONSTRAINT deliveries_replay_of_fkey FOREIGN KEY (replay_of) REFERENCES delivery.deliveries(id) ON DELETE SET NULL;
ALTER TABLE delivery.outbox DROP CONSTRAINT outbox_delivery_id_fkey,
  ADD CONSTRAINT outbox_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES delivery.deliveries(id) ON DELETE CASCADE;
CREATE INDEX deliveries_event_idx ON delivery.deliveries (event_id);
CREATE INDEX deliveries_tenant_event_time_idx ON delivery.deliveries (tenant_id, event_created_at);
CREATE INDEX attempts_delivery_idx ON delivery.delivery_attempts (delivery_id);
CREATE INDEX events_tenant_time_idx ON delivery.events (tenant_id, created_at);

-- ---------------------------------------------------------------- transformations
CREATE TABLE control.transformations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES control.tenants(id),
  expression text NOT NULL CHECK (length(expression) BETWEEN 1 AND 65536),
  version    int  NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE control.transformations ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_own ON control.transformations TO relay_tenant
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY claims_all ON control.transformations TO relay_claims USING (true) WITH CHECK (true);

ALTER TABLE control.endpoints ADD COLUMN transformation_id uuid REFERENCES control.transformations(id);
-- When the current run of deferrals started; cleared by any real attempt.
ALTER TABLE delivery.deliveries ADD COLUMN first_deferred_at timestamptz;

-- ---------------------------------------------------------------- relay_retention
CREATE POLICY retention_all ON control.tenants          TO relay_retention USING (true);
CREATE POLICY retention_all ON delivery.events          TO relay_retention USING (true);
CREATE POLICY retention_all ON delivery.deliveries      TO relay_retention USING (true) WITH CHECK (true);
CREATE POLICY retention_all ON delivery.idempotency_keys TO relay_retention USING (true);

RESET ROLE;

GRANT USAGE ON SCHEMA control, delivery TO relay_retention;
GRANT SELECT (id, retention_days) ON control.tenants TO relay_retention;
GRANT SELECT (id, tenant_id, created_at), DELETE ON delivery.events TO relay_retention;
GRANT SELECT (id, tenant_id, event_id, event_created_at, status), DELETE ON delivery.deliveries TO relay_retention;
GRANT UPDATE (status, last_error_class, lease_token_hash, lease_until, dispatch_token_hash, updated_at)
  ON delivery.deliveries TO relay_retention;
GRANT SELECT (id, delivery_id), DELETE ON delivery.delivery_attempts TO relay_retention;
GRANT SELECT (tenant_id, key, expires_at), DELETE ON delivery.idempotency_keys TO relay_retention;

-- ---------------------------------------------------------------- functions
GRANT SELECT ON control.transformations TO relay_claims;
GRANT CREATE ON SCHEMA delivery TO relay_claims;  -- only while creating, as in 0002
DROP FUNCTION delivery.claim_delivery(uuid, int, bytea, bytea, interval);
SET ROLE relay_claims;

-- claim_delivery as in 0004, plus the endpoint's transformation expression (or NULL) at the end.
CREATE FUNCTION delivery.claim_delivery(
  p_delivery_id uuid, p_dispatch_seq int, p_dispatch_token bytea,
  p_lease_token bytea, p_lease_for interval)
RETURNS TABLE (o_delivery_id uuid, o_attempt_no int, o_message_id uuid, o_event_id uuid,
               o_url text, o_signing_secrets jsonb, o_payload jsonb, o_endpoint_id uuid,
               o_transformation text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_lease_for <= interval '0' OR p_lease_for > interval '1 hour' THEN
    RAISE EXCEPTION 'invalid lease' USING ERRCODE = '22023';
  END IF;
  IF p_dispatch_token IS NULL OR p_lease_token IS NULL
     OR length(p_dispatch_token) < 16 OR length(p_lease_token) < 16 THEN
    RAISE EXCEPTION 'invalid token' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH c AS (
    UPDATE delivery.deliveries d
    SET status = 'in_flight',
        lease_token_hash = sha256(p_lease_token),
        lease_until = now() + p_lease_for,
        updated_at = now()
    WHERE d.id = p_delivery_id
      AND d.status = 'queued'
      AND d.dispatch_seq = p_dispatch_seq
      AND d.dispatch_token_hash = sha256(p_dispatch_token)
    RETURNING d.id, d.attempt_count, d.message_id, d.endpoint_id, d.event_id, d.event_created_at
  )
  SELECT c.id, c.attempt_count + 1, c.message_id, c.event_id, ep.url, ep.signing_secrets, ev.payload, ep.id,
         tr.expression
  FROM c
  JOIN control.endpoints ep ON ep.id = c.endpoint_id
  JOIN delivery.events ev ON ev.id = c.event_id AND ev.created_at = c.event_created_at
  LEFT JOIN control.transformations tr ON tr.id = ep.transformation_id;
END $$;

-- record_attempt as in 0002, and a real attempt ends any run of deferrals.
CREATE OR REPLACE FUNCTION delivery.record_attempt(
  p_delivery_id uuid, p_lease_token bytea, p_outcome text,
  p_status_code int, p_error_class text, p_retry_after interval)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur_count int;
  n int;
  new_status text;
  new_next timestamptz := now();
  final_error text := p_error_class;
BEGIN
  IF p_outcome NOT IN ('success','retry','dead') THEN
    RAISE EXCEPTION 'invalid outcome' USING ERRCODE = '22023';
  END IF;
  IF p_lease_token IS NULL OR length(p_lease_token) < 16 THEN
    RAISE EXCEPTION 'invalid token' USING ERRCODE = '22023';
  END IF;

  SELECT attempt_count INTO cur_count
  FROM delivery.deliveries
  WHERE id = p_delivery_id AND status = 'in_flight' AND lease_token_hash = sha256(p_lease_token)
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  n := cur_count + 1;
  IF p_outcome = 'success' THEN
    new_status := 'succeeded';
  ELSIF p_outcome = 'dead' THEN
    new_status := 'dead';
  ELSIF n >= 12 THEN
    new_status := 'dead';
    final_error := 'max_attempts';
  ELSE
    new_status := 'scheduled';
    new_next := now() + least(greatest(coalesce(p_retry_after, interval '0'), interval '0'), interval '6 hours');
  END IF;

  INSERT INTO delivery.delivery_attempts (delivery_id, attempt_no, counted, outcome, status_code, error_class)
  VALUES (p_delivery_id, n, true,
          CASE WHEN new_status = 'dead' AND p_outcome = 'retry' THEN 'dead' ELSE p_outcome END,
          p_status_code, final_error);

  UPDATE delivery.deliveries
  SET status = new_status, attempt_count = n, next_attempt_at = new_next,
      lease_token_hash = NULL, lease_until = NULL, dispatch_token_hash = NULL,
      last_error_class = final_error, first_deferred_at = NULL, updated_at = now()
  WHERE id = p_delivery_id;
  RETURN new_status;
END $$;

-- The transformation runner could not be reached: give the delivery back without
-- sending. Uncounted while the deferral run is younger than p_max_age; after that,
-- each deferral is a counted failed attempt (the 12th makes the delivery dead).
-- Returns the new status, or NULL (changing nothing) for a wrong token or a delivery
-- that is no longer in flight.
CREATE FUNCTION delivery.defer_delivery(
  p_delivery_id uuid, p_lease_token bytea, p_delay interval, p_max_age interval, p_error_class text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur_count int;
  deferred_since timestamptz;
  n int;
  new_status text;
BEGIN
  IF p_lease_token IS NULL OR length(p_lease_token) < 16 THEN
    RAISE EXCEPTION 'invalid token' USING ERRCODE = '22023';
  END IF;
  IF p_delay < interval '0' OR p_delay > interval '6 hours'
     OR p_max_age < interval '1 second' OR p_max_age > interval '7 days' THEN
    RAISE EXCEPTION 'invalid interval' USING ERRCODE = '22023';
  END IF;
  IF p_error_class IS NULL OR p_error_class !~ '^[a-z_]{1,64}$' THEN
    RAISE EXCEPTION 'invalid error class' USING ERRCODE = '22023';
  END IF;

  SELECT attempt_count, first_deferred_at INTO cur_count, deferred_since
  FROM delivery.deliveries
  WHERE id = p_delivery_id AND status = 'in_flight' AND lease_token_hash = sha256(p_lease_token)
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF deferred_since IS NOT NULL AND now() - deferred_since >= p_max_age THEN
    n := cur_count + 1;  -- deferred too long: this one counts
    new_status := CASE WHEN n >= 12 THEN 'dead' ELSE 'scheduled' END;
    INSERT INTO delivery.delivery_attempts (delivery_id, attempt_no, counted, outcome, error_class)
    VALUES (p_delivery_id, n, true, CASE WHEN new_status = 'dead' THEN 'dead' ELSE 'retry' END,
            CASE WHEN new_status = 'dead' THEN 'max_attempts' ELSE p_error_class END);
    UPDATE delivery.deliveries
    SET status = new_status, attempt_count = n, next_attempt_at = now() + p_delay,
        lease_token_hash = NULL, lease_until = NULL, dispatch_token_hash = NULL,
        last_error_class = CASE WHEN new_status = 'dead' THEN 'max_attempts' ELSE p_error_class END,
        updated_at = now()
    WHERE id = p_delivery_id;
    RETURN new_status;
  END IF;

  INSERT INTO delivery.delivery_attempts (delivery_id, attempt_no, counted, outcome, error_class)
  VALUES (p_delivery_id, cur_count + 1, false, 'deferred', p_error_class);
  UPDATE delivery.deliveries
  SET status = 'scheduled', next_attempt_at = now() + p_delay,
      lease_token_hash = NULL, lease_until = NULL, dispatch_token_hash = NULL,
      first_deferred_at = coalesce(first_deferred_at, now()),
      last_error_class = p_error_class, updated_at = now()
  WHERE id = p_delivery_id;
  RETURN 'scheduled';
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA delivery FROM relay_claims;

REVOKE ALL ON FUNCTION delivery.claim_delivery(uuid, int, bytea, bytea, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION delivery.defer_delivery(uuid, bytea, interval, interval, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delivery.claim_delivery(uuid, int, bytea, bytea, interval) TO relay_worker;
GRANT EXECUTE ON FUNCTION delivery.defer_delivery(uuid, bytea, interval, interval, text) TO relay_worker;

-- migrate:down
-- Not reversible without data loss; restore from backup instead.
