-- migrate:up
-- Replay (spec sections 3 and 5), live-update context for workers, and maintenance:
-- monthly event partitions, cleanup of published outbox rows, and an orphan report.
--
-- delivery_attempts stays unpartitioned on purpose: the unique index on counted
-- attempts (one counted attempt per number) is what makes double counting impossible,
-- and a unique index on a partitioned table must include the partition key, which
-- would remove that guarantee. Its rows are removed by the retention job instead.

SET ROLE relay_owner;

-- Maintenance functions run as relay_owner. Row-level security is forced on the
-- owner, so it needs explicit read policies to see what it checks.
CREATE POLICY owner_read ON delivery.events     TO relay_owner USING (true);
CREATE POLICY owner_read ON delivery.deliveries TO relay_owner USING (true);
CREATE POLICY owner_read ON delivery.idempotency_keys TO relay_owner USING (true);
CREATE POLICY owner_read ON control.tenants     TO relay_owner USING (true);

CREATE INDEX deliveries_replay_of_idx ON delivery.deliveries (replay_of) WHERE replay_of IS NOT NULL;

-- ---------------------------------------------------------------- partitions
-- Monthly partitions named events_yYYYYmMM. Months that already have rows in the
-- default partition are left there (attaching a range over existing default rows
-- fails); the retention job empties them over time.
CREATE FUNCTION delivery.ensure_event_partitions(p_months_ahead int)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m date := date_trunc('month', now())::date;
  last date;
  created int := 0;
  part text;
BEGIN
  IF p_months_ahead < 0 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'invalid months ahead' USING ERRCODE = '22023';
  END IF;
  last := (m + make_interval(months => p_months_ahead))::date;
  WHILE m <= last LOOP
    part := format('events_y%sm%s', to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF to_regclass(format('delivery.%I', part)) IS NULL
       AND NOT EXISTS (SELECT 1 FROM delivery.events_default
                       WHERE created_at >= m AND created_at < (m + interval '1 month')) THEN
      EXECUTE format('CREATE TABLE delivery.%I PARTITION OF delivery.events FOR VALUES FROM (%L) TO (%L)',
                     part, m, (m + interval '1 month')::date);
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END $$;

-- Drop a monthly partition only when every row in it is older than the longest tenant
-- retention plus p_margin AND no delivery still refers to an event in its range (the
-- retention job deletes those first). Anything else is skipped and reported, never forced.
CREATE FUNCTION delivery.drop_expired_event_partitions(p_margin interval)
RETURNS TABLE (o_partition text, o_action text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  keep interval;
  r record;
  lo timestamptz;
  hi timestamptz;
BEGIN
  IF p_margin < interval '0' OR p_margin > interval '90 days' THEN
    RAISE EXCEPTION 'invalid margin' USING ERRCODE = '22023';
  END IF;
  SELECT make_interval(days => coalesce(max(retention_days), 0)) + p_margin INTO keep FROM control.tenants;
  FOR r IN
    SELECT c.relname FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'delivery.events'::regclass AND c.relname ~ '^events_y[0-9]{4}m[0-9]{2}$'
    ORDER BY c.relname
  LOOP
    lo := to_timestamp(substr(r.relname, 9, 4) || substr(r.relname, 14, 2), 'YYYYMM');
    hi := lo + interval '1 month';
    IF hi > now() - keep THEN
      CONTINUE;  -- still inside the longest retention window: not a candidate
    END IF;
    IF EXISTS (SELECT 1 FROM delivery.deliveries d WHERE d.event_created_at >= lo AND d.event_created_at < hi) THEN
      o_partition := r.relname; o_action := 'skipped_deliveries_remain'; RETURN NEXT;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TABLE delivery.%I', r.relname);
    o_partition := r.relname; o_action := 'dropped'; RETURN NEXT;
  END LOOP;
END $$;

-- Rows that should not exist if every write path is correct. Reported, never repaired.
CREATE FUNCTION delivery.orphan_report()
RETURNS TABLE (o_kind text, o_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT 'deliveries_without_event', count(*) FROM delivery.deliveries d
  WHERE NOT EXISTS (SELECT 1 FROM delivery.events e WHERE e.id = d.event_id AND e.created_at = d.event_created_at)
  UNION ALL
  SELECT 'idempotency_keys_without_event', count(*) FROM delivery.idempotency_keys k
  WHERE NOT EXISTS (SELECT 1 FROM delivery.events e WHERE e.id = k.event_id AND e.created_at = k.event_created_at)
$$;

RESET ROLE;

-- The maintenance functions are DDL-capable; only the retention job may call them.
REVOKE ALL ON FUNCTION delivery.ensure_event_partitions(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION delivery.drop_expired_event_partitions(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION delivery.orphan_report() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delivery.ensure_event_partitions(int) TO relay_retention;
GRANT EXECUTE ON FUNCTION delivery.drop_expired_event_partitions(interval) TO relay_retention;
GRANT EXECUTE ON FUNCTION delivery.orphan_report() TO relay_retention;

-- Outbox cleanup by the retention job: a published row may go once its delivery has
-- moved past that dispatch (requeue_stale needs the row while the dispatch is current).
GRANT SELECT (id, delivery_id, dispatch_seq, published_at), DELETE ON delivery.outbox TO relay_retention;
GRANT SELECT (dispatch_seq) ON delivery.deliveries TO relay_retention;

-- ---------------------------------------------------------------- replay and claim
GRANT SELECT (id, retention_days) ON control.tenants TO relay_claims;
GRANT INSERT ON delivery.deliveries TO relay_claims;
GRANT CREATE ON SCHEMA delivery TO relay_claims;  -- only while creating, as in 0002
DROP FUNCTION delivery.claim_delivery(uuid, int, bytea, bytea, interval);
SET ROLE relay_claims;

-- claim_delivery as in 0007, plus what the original was (replay headers) and the tenant
-- (live updates), appended so existing column positions stay the same.
CREATE FUNCTION delivery.claim_delivery(
  p_delivery_id uuid, p_dispatch_seq int, p_dispatch_token bytea,
  p_lease_token bytea, p_lease_for interval)
RETURNS TABLE (o_delivery_id uuid, o_attempt_no int, o_message_id uuid, o_event_id uuid,
               o_url text, o_signing_secrets jsonb, o_payload jsonb, o_endpoint_id uuid,
               o_transformation text, o_replay_of uuid, o_tenant_id uuid)
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
    RETURNING d.id, d.attempt_count, d.message_id, d.endpoint_id, d.event_id, d.event_created_at,
              d.replay_of, d.tenant_id
  )
  SELECT c.id, c.attempt_count + 1, c.message_id, c.event_id, ep.url, ep.signing_secrets, ev.payload, ep.id,
         tr.expression, c.replay_of, c.tenant_id
  FROM c
  JOIN control.endpoints ep ON ep.id = c.endpoint_id
  JOIN delivery.events ev ON ev.id = c.event_id AND ev.created_at = c.event_created_at
  LEFT JOIN control.transformations tr ON tr.id = ep.transformation_id;
END $$;

-- Replay one finished delivery as a NEW delivery; the original's history is never
-- changed (spec section 5). Called by the control plane as relay_tenant, inside a
-- transaction that has set app.tenant_id; the function checks the tenant itself.
--   p_mode 'new'   : a fresh webhook-id, so a deduplicating receiver processes it again
--   p_mode 'reuse' : the original webhook-id, so deduplication still protects the receiver
--   p_mode NULL    : 'new' for a succeeded delivery, 'reuse' for a dead one (the outcome of
--                    a timeout or 5xx is unknown, so the receiver may already have it)
-- Errors: P0002 not found (also another tenant's); 55000 still active;
--         RL410 payload expired (DETAIL holds the expiry time); 22023 bad mode.
CREATE FUNCTION delivery.replay_delivery(p_delivery_id uuid, p_mode text)
RETURNS TABLE (o_delivery_id uuid, o_message_id uuid, o_mode text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  orig record;
  expires timestamptz;
  mode text := p_mode;
  new_id uuid;
  new_message uuid;
BEGIN
  IF mode IS NOT NULL AND mode NOT IN ('new', 'reuse') THEN
    RAISE EXCEPTION 'invalid replay mode' USING ERRCODE = '22023';
  END IF;
  SELECT d.id, d.tenant_id, d.endpoint_id, d.event_id, d.event_created_at, d.status, d.message_id
  INTO orig FROM delivery.deliveries d
  WHERE d.id = p_delivery_id AND d.tenant_id = tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery not found' USING ERRCODE = 'P0002';
  END IF;
  IF orig.status NOT IN ('succeeded', 'dead', 'cancelled') THEN
    RAISE EXCEPTION 'delivery is still active' USING ERRCODE = '55000';
  END IF;
  SELECT e.created_at + make_interval(days => t.retention_days) INTO expires
  FROM delivery.events e JOIN control.tenants t ON t.id = e.tenant_id
  WHERE e.id = orig.event_id AND e.created_at = orig.event_created_at;
  IF expires IS NULL OR expires <= now() THEN
    RAISE EXCEPTION 'payload expired'
      USING ERRCODE = 'RL410', DETAIL = coalesce(to_char(expires AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '');
  END IF;
  mode := coalesce(mode, CASE WHEN orig.status = 'succeeded' THEN 'new' ELSE 'reuse' END);
  new_message := CASE WHEN mode = 'reuse' THEN orig.message_id ELSE gen_random_uuid() END;
  INSERT INTO delivery.deliveries (tenant_id, endpoint_id, event_id, event_created_at, message_id, replay_of)
  VALUES (orig.tenant_id, orig.endpoint_id, orig.event_id, orig.event_created_at, new_message, orig.id)
  RETURNING id INTO new_id;
  PERFORM pg_notify('relay_dispatch', '');
  o_delivery_id := new_id; o_message_id := new_message; o_mode := mode;
  RETURN NEXT;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA delivery FROM relay_claims;

REVOKE ALL ON FUNCTION delivery.claim_delivery(uuid, int, bytea, bytea, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION delivery.replay_delivery(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delivery.claim_delivery(uuid, int, bytea, bytea, interval) TO relay_worker;
GRANT EXECUTE ON FUNCTION delivery.replay_delivery(uuid, text) TO relay_tenant;

-- migrate:down
-- Not reversible automatically; restore from backup instead.
