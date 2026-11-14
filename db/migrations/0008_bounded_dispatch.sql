-- migrate:up
-- Bounded dispatching (spec section 6). The scheduler only dispatches work an
-- endpoint can accept, so a slow endpoint's backlog waits in PostgreSQL and never
-- fills RabbitMQ or the workers.
--
-- - endpoints.concurrency_limit: at most this many of the endpoint's deliveries are
--   queued or in flight at once.
-- - tenants.dispatch_cap: at most this many of the tenant's deliveries are queued or
--   in flight at once (the spec puts this on a plan; plans do not exist yet).
--
-- The counts are read inside dispatch_batch while it holds the tenant's dispatch lock,
-- so two schedulers can never both count the same free slot. Finishing a delivery only
-- lowers a count, so it needs no lock.

SET ROLE relay_owner;

ALTER TABLE control.endpoints
  ADD COLUMN concurrency_limit int NOT NULL DEFAULT 10 CHECK (concurrency_limit BETWEEN 1 AND 1000);
ALTER TABLE control.tenants
  ADD COLUMN dispatch_cap int NOT NULL DEFAULT 100 CHECK (dispatch_cap BETWEEN 1 AND 100000);

-- Capacity counting reads only active deliveries.
CREATE INDEX deliveries_active_endpoint_idx ON delivery.deliveries (endpoint_id)
  WHERE status IN ('queued', 'in_flight');
CREATE INDEX deliveries_active_tenant_idx ON delivery.deliveries (tenant_id)
  WHERE status IN ('queued', 'in_flight');

RESET ROLE;

GRANT SELECT (id, dispatch_cap) ON control.tenants TO relay_claims;
GRANT CREATE ON SCHEMA delivery TO relay_claims;  -- only while replacing, as in 0002
SET ROLE relay_claims;

-- Same signature, lock and outbox handling as before; only the choice of rows changes.
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
           ep.concurrency_limit - coalesce(act.busy, 0) AS room
    FROM delivery.deliveries d
    JOIN control.endpoints ep ON ep.id = d.endpoint_id
    LEFT JOIN active act ON act.endpoint_id = d.endpoint_id
    WHERE d.tenant_id = p_tenant_id AND d.status = 'scheduled' AND d.next_attempt_at <= now()
      AND ep.status = 'enabled'
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

RESET ROLE;
REVOKE CREATE ON SCHEMA delivery FROM relay_claims;

-- migrate:down
-- Restores nothing automatically; the previous dispatch_batch is in 0002.
