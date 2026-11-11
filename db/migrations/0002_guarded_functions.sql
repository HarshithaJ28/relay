-- migrate:up
-- Guarded state transitions. Every function is SECURITY DEFINER, owned by the
-- plain role relay_claims, with a fixed search_path and fully qualified names.
-- Each check (token, lease, status) lives in the same statement as the write,
-- so a stale, duplicated or unauthorized call changes nothing.

GRANT CREATE ON SCHEMA delivery TO relay_claims;
SET ROLE relay_claims;

-- Scheduler side: lock one tenant, move due deliveries to queued, write outbox rows.
CREATE FUNCTION delivery.dispatch_batch(p_tenant_id uuid, p_limit int)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n int;
BEGIN
  IF p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid batch limit' USING ERRCODE = '22023';
  END IF;
  INSERT INTO delivery.dispatch_locks (tenant_id) VALUES (p_tenant_id) ON CONFLICT DO NOTHING;
  -- Another scheduler replica already holds this tenant: do nothing.
  PERFORM 1 FROM delivery.dispatch_locks WHERE tenant_id = p_tenant_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN 0; END IF;

  WITH due AS (
    SELECT id FROM delivery.deliveries
    WHERE tenant_id = p_tenant_id AND status = 'scheduled' AND next_attempt_at <= now()
    ORDER BY next_attempt_at, id
    LIMIT p_limit
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

-- Worker side, step 1: claim. Zero rows = stale or duplicate message.
CREATE FUNCTION delivery.claim_delivery(
  p_delivery_id uuid, p_dispatch_seq int, p_dispatch_token bytea,
  p_lease_token bytea, p_lease_for interval)
RETURNS TABLE (o_delivery_id uuid, o_attempt_no int, o_message_id uuid, o_event_id uuid,
               o_url text, o_secret_ciphertext bytea, o_payload jsonb)
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
  SELECT c.id, c.attempt_count + 1, c.message_id, c.event_id, ep.url, ep.secret_ciphertext, ev.payload
  FROM c
  JOIN control.endpoints ep ON ep.id = c.endpoint_id
  JOIN delivery.events ev ON ev.id = c.event_id AND ev.created_at = c.event_created_at;
END $$;

-- Worker side, step 2: record the result. Fenced by the lease token.
-- Returns false (and changes nothing) for a wrong token, an already-finished
-- delivery, or one the reaper has reclaimed.
CREATE FUNCTION delivery.record_attempt(
  p_delivery_id uuid, p_lease_token bytea, p_outcome text,
  p_status_code int, p_error_class text, p_retry_after interval)
RETURNS boolean
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
  IF NOT FOUND THEN RETURN false; END IF;

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
      last_error_class = final_error, updated_at = now()
  WHERE id = p_delivery_id;
  RETURN true;
END $$;

-- Reaper: reclaim deliveries whose lease expired. After this, the original
-- worker's record_attempt is rejected because status/lease no longer match.
CREATE FUNCTION delivery.reclaim_expired(p_limit int)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n int;
BEGIN
  IF p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid batch limit' USING ERRCODE = '22023';
  END IF;
  WITH expired AS (
    SELECT id, attempt_count FROM delivery.deliveries
    WHERE status = 'in_flight' AND lease_until < now()
    ORDER BY lease_until LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  upd AS (
    UPDATE delivery.deliveries d
    SET attempt_count = e.attempt_count + 1,
        status = CASE WHEN e.attempt_count + 1 >= 12 THEN 'dead' ELSE 'scheduled' END,
        next_attempt_at = now(),
        lease_token_hash = NULL, lease_until = NULL, dispatch_token_hash = NULL,
        last_error_class = CASE WHEN e.attempt_count + 1 >= 12 THEN 'max_attempts' ELSE 'lease_expired' END,
        updated_at = now()
    FROM expired e WHERE d.id = e.id
    RETURNING d.id, d.attempt_count
  ),
  ins AS (
    INSERT INTO delivery.delivery_attempts (delivery_id, attempt_no, counted, outcome, error_class)
    SELECT id, attempt_count, true, 'lease_expired', 'lease_expired' FROM upd
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ins;
  RETURN n;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA delivery FROM relay_claims;
