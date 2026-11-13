-- migrate:up
-- Guarded functions the long-running processes need. Same rules as 0002:
-- SECURITY DEFINER, owned by relay_claims, fixed search_path, each check in the
-- same statement as the write, and callers get EXECUTE only.
--
-- due_tenants     scheduler: which tenants have due deliveries (it has no table access)
-- requeue_stale   reaper: a queued delivery whose message was published long ago and
--                 never claimed (lost or rejected) goes back to scheduled
-- check_lease     worker, right before sending: confirm enough lease is left, by the
--                 database clock; if not, give the delivery back without using an attempt

SET ROLE relay_owner;
-- requeue_stale scans queued deliveries (outbox rows are found through their unique key).
CREATE INDEX deliveries_queued_idx ON delivery.deliveries (updated_at) WHERE status = 'queued';
RESET ROLE;

GRANT CREATE ON SCHEMA delivery TO relay_claims;  -- only while creating, as in 0002
SET ROLE relay_claims;

-- Tenants with at least one scheduled delivery that is due, oldest due first.
CREATE FUNCTION delivery.due_tenants(p_limit int)
RETURNS TABLE (o_tenant_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'invalid limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT d.tenant_id
  FROM delivery.deliveries d
  WHERE d.status = 'scheduled' AND d.next_attempt_at <= now()
  GROUP BY d.tenant_id
  ORDER BY min(d.next_attempt_at)
  LIMIT p_limit;
END $$;

-- A queued delivery whose current message was confirmed by the broker more than
-- p_older_than ago and still has not been claimed was lost or rejected. Put it
-- back to scheduled: the next dispatch bumps dispatch_seq, so a late copy of the
-- old message can no longer claim. No attempt is used: nothing was sent.
CREATE FUNCTION delivery.requeue_stale(p_older_than interval, p_limit int)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n int;
BEGIN
  IF p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid batch limit' USING ERRCODE = '22023';
  END IF;
  IF p_older_than < interval '1 second' OR p_older_than > interval '1 day' THEN
    RAISE EXCEPTION 'invalid queue timeout' USING ERRCODE = '22023';
  END IF;
  WITH stale AS (
    SELECT d.id
    FROM delivery.deliveries d
    JOIN delivery.outbox o ON o.delivery_id = d.id AND o.dispatch_seq = d.dispatch_seq
    WHERE d.status = 'queued'
      AND o.published_at IS NOT NULL
      AND o.published_at < now() - p_older_than
    ORDER BY o.published_at
    LIMIT p_limit
    FOR UPDATE OF d SKIP LOCKED
  ),
  upd AS (
    UPDATE delivery.deliveries d
    SET status = 'scheduled', next_attempt_at = now(), dispatch_token_hash = NULL,
        last_error_class = 'queue_timeout', updated_at = now()
    FROM stale s
    WHERE d.id = s.id AND d.status = 'queued'
    RETURNING d.id, d.attempt_count
  ),
  ins AS (
    INSERT INTO delivery.delivery_attempts (delivery_id, attempt_no, counted, outcome, error_class)
    SELECT id, attempt_count + 1, false, 'deferred', 'queue_timeout' FROM upd
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ins;
  RETURN n;
END $$;

-- Called by the worker after claiming and right before sending. Returns true if
-- the lease (checked by token) has at least p_min_remaining left. Otherwise the
-- delivery returns to scheduled with no attempt used, and false is returned; a
-- wrong token or a delivery no longer in flight also returns false and changes nothing.
CREATE FUNCTION delivery.check_lease(p_delivery_id uuid, p_lease_token bytea, p_min_remaining interval)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_until timestamptz;
  cur_count int;
BEGIN
  IF p_lease_token IS NULL OR length(p_lease_token) < 16 THEN
    RAISE EXCEPTION 'invalid token' USING ERRCODE = '22023';
  END IF;
  IF p_min_remaining < interval '0' OR p_min_remaining > interval '1 hour' THEN
    RAISE EXCEPTION 'invalid interval' USING ERRCODE = '22023';
  END IF;
  SELECT lease_until, attempt_count INTO v_until, cur_count
  FROM delivery.deliveries
  WHERE id = p_delivery_id AND status = 'in_flight' AND lease_token_hash = sha256(p_lease_token)
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_until - now() >= p_min_remaining THEN RETURN true; END IF;

  UPDATE delivery.deliveries
  SET status = 'scheduled', next_attempt_at = now(),
      lease_token_hash = NULL, lease_until = NULL, dispatch_token_hash = NULL,
      last_error_class = 'lease_too_short', updated_at = now()
  WHERE id = p_delivery_id;
  INSERT INTO delivery.delivery_attempts (delivery_id, attempt_no, counted, outcome, error_class)
  VALUES (p_delivery_id, cur_count + 1, false, 'deferred', 'lease_too_short');
  RETURN false;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA delivery FROM relay_claims;

GRANT SELECT ON delivery.outbox TO relay_claims;

REVOKE ALL ON FUNCTION delivery.due_tenants(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION delivery.requeue_stale(interval, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION delivery.check_lease(uuid, bytea, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delivery.due_tenants(int) TO relay_scheduler;
GRANT EXECUTE ON FUNCTION delivery.requeue_stale(interval, int) TO relay_reaper;
GRANT EXECUTE ON FUNCTION delivery.check_lease(uuid, bytea, interval) TO relay_worker;

-- migrate:down
DROP FUNCTION delivery.check_lease(uuid, bytea, interval);
DROP FUNCTION delivery.requeue_stale(interval, int);
DROP FUNCTION delivery.due_tenants(int);
DROP INDEX delivery.deliveries_queued_idx;
REVOKE SELECT ON delivery.outbox FROM relay_claims;
