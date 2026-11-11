-- migrate:up
-- Least privilege. Nothing is granted to PUBLIC. relay_worker has no table
-- privileges at all: it can only execute claim_delivery and record_attempt.

REVOKE ALL ON SCHEMA control, delivery FROM PUBLIC;
REVOKE ALL ON ALL TABLES    IN SCHEMA control, delivery FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control, delivery FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA delivery FROM PUBLIC;

-- Function owner: only what the guarded functions need.
GRANT USAGE ON SCHEMA control, delivery TO relay_claims;
GRANT SELECT ON control.endpoints, delivery.events TO relay_claims;
GRANT SELECT, UPDATE ON delivery.deliveries TO relay_claims;
GRANT INSERT ON delivery.delivery_attempts, delivery.outbox, delivery.dispatch_locks TO relay_claims;
GRANT SELECT, UPDATE ON delivery.dispatch_locks TO relay_claims;
GRANT USAGE ON SEQUENCE delivery.delivery_attempts_id_seq, delivery.outbox_id_seq TO relay_claims;

-- Callers: execute only.
GRANT USAGE ON SCHEMA delivery TO relay_worker, relay_scheduler, relay_reaper, relay_publisher;
GRANT EXECUTE ON FUNCTION delivery.claim_delivery(uuid,int,bytea,bytea,interval) TO relay_worker;
GRANT EXECUTE ON FUNCTION delivery.record_attempt(uuid,bytea,text,int,text,interval) TO relay_worker;
GRANT EXECUTE ON FUNCTION delivery.dispatch_batch(uuid,int) TO relay_scheduler;
GRANT EXECUTE ON FUNCTION delivery.reclaim_expired(int) TO relay_reaper;

-- Publisher: read unpublished outbox rows and mark them published. Column-level
-- UPDATE so it cannot touch delivery_id or dispatch_seq.
GRANT SELECT ON delivery.outbox TO relay_publisher;
GRANT UPDATE (published_at, dispatch_token) ON delivery.outbox TO relay_publisher;
