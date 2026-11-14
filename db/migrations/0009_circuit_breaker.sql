-- migrate:up
-- Circuit breaker mirror and ingestion rate limits (spec sections 4 and 6).
--
-- The breaker's state lives in Valkey (rolling window, cool-down). PostgreSQL holds a
-- mirror the scheduler can use in its dispatch query:
--   endpoints.status = 'breaker_open' and endpoints.breaker_until = reopen time.
-- While breaker_until is in the future the scheduler dispatches nothing to the
-- endpoint; after it (half-open) at most one delivery, the probe. A successful probe
-- closes the mirror inside record_attempt, so a breaker always closes even if Valkey
-- was lost in between; losing Valkey can only make breakers close, never stay open.

SET ROLE relay_owner;

ALTER TABLE control.endpoints
  ADD COLUMN breaker_until timestamptz,
  ADD CONSTRAINT breaker_state CHECK ((status = 'breaker_open') = (breaker_until IS NOT NULL));

ALTER TABLE control.tenants
  ADD COLUMN ingest_rate_per_sec int NOT NULL DEFAULT 100 CHECK (ingest_rate_per_sec BETWEEN 1 AND 100000),
  ADD COLUMN ingest_burst int NOT NULL DEFAULT 200 CHECK (ingest_burst BETWEEN 1 AND 1000000);

RESET ROLE;

GRANT SELECT (id, ingest_rate_per_sec, ingest_burst) ON control.tenants TO relay_tenant;
GRANT UPDATE (status, breaker_until) ON control.endpoints TO relay_claims;
GRANT CREATE ON SCHEMA delivery TO relay_claims;  -- only while creating, as in 0002
SET ROLE relay_claims;

-- dispatch_batch as in 0008, plus the breaker: closed endpoints use their concurrency
-- limit, open ones get nothing until breaker_until and then one slot for the probe.
CREATE OR REPLACE FUNCTION delivery.dispatch_batch(p_tenant_id uuid, p_limit int)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n int;
  tenant_room int;
BEGIN
  IF p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid batch limit' USING ERRCODE = '22023';
  END IF;
  INSERT INTO delivery.dispatch_locks (tenant_id) VALUES (p_tenant_id) ON CONFLICT DO NOTHING;
  -- Another scheduler replica already holds this tenant: do nothing.
  PERFORM 1 FROM delivery.dispatch_locks WHERE tenant_id = p_tenant_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT greatest(t.dispatch_cap - (
           SELECT count(*) FROM delivery.deliveries a
           WHERE a.tenant_id = p_tenant_id AND a.status IN ('queued', 'in_flight')), 0)
  INTO tenant_room
  FROM control.tenants t WHERE t.id = p_tenant_id;
  IF coalesce(tenant_room, 0) = 0 THEN RETURN 0; END IF;

  WITH active AS (
    SELECT a.endpoint_id, count(*) AS busy
    FROM delivery.deliveries a
    WHERE a.tenant_id = p_tenant_id AND a.status IN ('queued', 'in_flight')
    GROUP BY a.endpoint_id
  ),
  ranked AS (
    SELECT d.id, d.next_attempt_at,
           row_number() OVER (PARTITION BY d.endpoint_id ORDER BY d.next_attempt_at, d.id) AS rn,
           CASE WHEN ep.status = 'breaker_open' THEN 1 ELSE ep.concurrency_limit END
             - coalesce(act.busy, 0) AS room
    FROM delivery.deliveries d
    JOIN control.endpoints ep ON ep.id = d.endpoint_id
    LEFT JOIN active act ON act.endpoint_id = d.endpoint_id
    WHERE d.tenant_id = p_tenant_id AND d.status = 'scheduled' AND d.next_attempt_at <= now()
      AND (ep.status = 'enabled' OR (ep.status = 'breaker_open' AND ep.breaker_until <= now()))
  ),
  chosen AS (
    SELECT r.id FROM ranked r
    WHERE r.rn <= r.room
    ORDER BY r.next_attempt_at, r.id
    LIMIT least(p_limit, tenant_room)
  ),
  due AS (
    SELECT d.id FROM delivery.deliveries d
    WHERE d.id IN (SELECT id FROM chosen) AND d.status = 'scheduled'
    FOR UPDATE SKIP LOCKED
  ),
  tok AS (
    SELECT id, uuid_send(gen_random_uuid()) AS raw FROM due   -- 128 random bits
  ),
  upd AS (
    UPDATE delivery.deliveries d
    SET status = 'queued',
        dispatch_seq = d.dispatch_seq + 1,
        dispatch_token_hash = sha256(tok.raw),
        updated_at = now()
    FROM tok WHERE d.id = tok.id
    RETURNING d.id, d.dispatch_seq, tok.raw
  ),
  ins AS (
    INSERT INTO delivery.outbox (delivery_id, dispatch_seq, dispatch_token)
    SELECT id, dispatch_seq, raw FROM upd
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ins;
  RETURN n;
END $$;

-- Mirror an open (or reopened) breaker for the endpoint of a delivery the caller holds a
-- live lease on, and move that endpoint's due deliveries past the reopen time, spread by
-- up to p_jitter, in one update. Those moves use no attempts. Returns the number of
-- deliveries moved, or NULL (changing nothing) for a wrong lease. A disabled endpoint
-- stays disabled.
CREATE FUNCTION delivery.open_breaker(
  p_delivery_id uuid, p_lease_token bytea, p_until timestamptz, p_jitter interval)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ep uuid;
  n int;
BEGIN
  IF p_lease_token IS NULL OR length(p_lease_token) < 16 THEN
    RAISE EXCEPTION 'invalid token' USING ERRCODE = '22023';
  END IF;
  IF p_until IS NULL OR p_until <= now() OR p_until > now() + interval '1 day'
     OR p_jitter < interval '0' OR p_jitter > interval '1 hour' THEN
    RAISE EXCEPTION 'invalid interval' USING ERRCODE = '22023';
  END IF;
  SELECT endpoint_id INTO ep FROM delivery.deliveries
  WHERE id = p_delivery_id AND status = 'in_flight' AND lease_token_hash = sha256(p_lease_token);
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE control.endpoints SET status = 'breaker_open', breaker_until = p_until
  WHERE id = ep AND status <> 'disabled';
  UPDATE delivery.deliveries
  SET next_attempt_at = p_until + random() * p_jitter, updated_at = now()
  WHERE endpoint_id = ep AND status = 'scheduled' AND next_attempt_at < p_until;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- record_attempt as in 0007; a success after the cool-down (the probe) also closes the
-- breaker mirror. A late success from before the breaker opened does not.
CREATE OR REPLACE FUNCTION delivery.record_attempt(
  p_delivery_id uuid, p_lease_token bytea, p_outcome text,
  p_status_code int, p_error_class text, p_retry_after interval)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cur_count int;
  ep uuid;
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

  SELECT attempt_count, endpoint_id INTO cur_count, ep
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

  IF p_outcome = 'success' THEN
    UPDATE control.endpoints SET status = 'enabled', breaker_until = NULL
    WHERE id = ep AND status = 'breaker_open' AND breaker_until <= now();
  END IF;
  RETURN new_status;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA delivery FROM relay_claims;

REVOKE ALL ON FUNCTION delivery.open_breaker(uuid, bytea, timestamptz, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delivery.open_breaker(uuid, bytea, timestamptz, interval) TO relay_worker;

-- migrate:down
-- Not reversible automatically; the previous functions are in 0007 and 0008.
