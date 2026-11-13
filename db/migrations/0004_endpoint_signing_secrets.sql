-- migrate:up
-- Endpoint signing secrets as a list, so a secret can be rotated without downtime:
-- during a rotation an endpoint holds two secrets and every request carries a
-- signature from each. Each entry is
--   {"kid": text, "key_id": text, "ciphertext": base64, "expires_at": timestamptz | null}
-- where ciphertext is AES-256-GCM (nonce || ciphertext || tag) under the master key
-- named by key_id, bound to the endpoint id and kid. Plaintext never reaches the
-- database.
--
-- Adding a NOT NULL column without a default needs an empty table. Nothing is
-- deployed yet; once something is, a change like this needs a backfill step.

SET ROLE relay_owner;

ALTER TABLE control.endpoints
  ADD COLUMN signing_secrets jsonb NOT NULL
    CONSTRAINT endpoints_signing_secrets_shape CHECK (
      jsonb_typeof(signing_secrets) = 'array'
      AND jsonb_array_length(signing_secrets) BETWEEN 1 AND 2
      -- every entry is an object with string kid, key_id and ciphertext (an entry
      -- with a missing key is filtered out, so the counts differ)
      AND jsonb_array_length(jsonb_path_query_array(signing_secrets,
            '$[*] ? (@.type() == "object" && @.kid.type() == "string"
                     && @.key_id.type() == "string" && @.ciphertext.type() == "string")'))
          = jsonb_array_length(signing_secrets)
    );
ALTER TABLE control.endpoints DROP COLUMN secret_ciphertext;

RESET ROLE;

-- claim_delivery now returns the secret list and the endpoint id (needed to
-- decrypt: ciphertexts are bound to their endpoint). The result type changes,
-- so the function is dropped and recreated with the same owner, guards and grant.
DROP FUNCTION delivery.claim_delivery(uuid, int, bytea, bytea, interval);

GRANT CREATE ON SCHEMA delivery TO relay_claims;  -- only while creating, as in 0002
SET ROLE relay_claims;

CREATE FUNCTION delivery.claim_delivery(
  p_delivery_id uuid, p_dispatch_seq int, p_dispatch_token bytea,
  p_lease_token bytea, p_lease_for interval)
RETURNS TABLE (o_delivery_id uuid, o_attempt_no int, o_message_id uuid, o_event_id uuid,
               o_url text, o_signing_secrets jsonb, o_payload jsonb, o_endpoint_id uuid)
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
  SELECT c.id, c.attempt_count + 1, c.message_id, c.event_id, ep.url, ep.signing_secrets, ev.payload, ep.id
  FROM c
  JOIN control.endpoints ep ON ep.id = c.endpoint_id
  JOIN delivery.events ev ON ev.id = c.event_id AND ev.created_at = c.event_created_at;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA delivery FROM relay_claims;

REVOKE ALL ON FUNCTION delivery.claim_delivery(uuid, int, bytea, bytea, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delivery.claim_delivery(uuid, int, bytea, bytea, interval) TO relay_worker;

-- migrate:down
-- Not reversible without the old single-secret ciphertexts; restore from backup instead.
