-- migrate:up
-- claim_delivery checks that the delivery's event exists inside its UPDATE.
--
-- Before this, the UPDATE marked the delivery in_flight and took a lease first, and the
-- event was joined only afterwards. If the event row was gone (an orphan left after its
-- partition was dropped), the claim returned no row but the delivery was still left
-- in_flight under a lease nobody held, until the reaper reclaimed it and it looped again.
-- Now a missing event matches nothing: no row is returned and nothing changes.
-- Same signature and result columns as 0010, so CREATE OR REPLACE keeps grants and owner.

GRANT CREATE ON SCHEMA delivery TO relay_claims;  -- only while creating, as in 0002
SET ROLE relay_claims;

CREATE OR REPLACE FUNCTION delivery.claim_delivery(
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
      AND EXISTS (SELECT 1 FROM delivery.events ev
                  WHERE ev.id = d.event_id AND ev.created_at = d.event_created_at)
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

RESET ROLE;
REVOKE CREATE ON SCHEMA delivery FROM relay_claims;

-- migrate:down
-- Not reversible automatically; restore from backup instead.
