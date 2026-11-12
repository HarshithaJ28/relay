# Relay

Multi-tenant webhook delivery platform. Design: see the Relay Technical Specification (v1.2.2).

## Status: Milestone 1 (delivery core) and Phase 2 (worker logic)

Built (`db/migrations`, `services/data-plane/relay_dataplane`):

- SQL migrations, least-privilege roles, guarded state-transition functions
  (`dispatch_batch`, `claim_delivery`, `record_attempt`, `reclaim_expired`), transactional outbox.
- Outbox publisher (RabbitMQ quorum queue, publisher confirms).
- Worker core: claim, Standard Webhooks signing, send through an injected `Sender`, response
  classification, full-jitter backoff honouring `Retry-After`, fenced result recording.

Run the tests (Python 3.12+ and a running Docker daemon; the harness starts throwaway
`postgres:16` and `rabbitmq:3.13` containers with testcontainers and removes them afterwards):

    pip install "psycopg[binary]" pytest hypothesis aio-pika testcontainers
    python3 -m pytest tests

Or run them against services that are already up, for example the Compose stack:

    docker compose up -d --wait
    RELAY_TEST_PG_DSN="host=127.0.0.1 port=5432" \
    RELAY_TEST_AMQP_URL="amqp://guest:guest@127.0.0.1:5672/" python3 -m pytest tests

If Docker or a service is unavailable the tests fail; they never skip.

### What the tests demonstrate (real PostgreSQL 16, real RabbitMQ 3.13 in Docker, synthetic data)

- Wrong, stale or duplicated dispatch tokens, lease tokens and dispatch sequences change nothing.
- Ten concurrent claims of one dispatch produce exactly one winner.
- A stalled worker's late result is rejected after the reaper reclaims the lease.
- The database rejects impossible states (CHECK constraints), and `relay_worker` has no table privileges.
- The publisher process is killed (`os._exit`) before publish, after confirm and before marking, and mid-batch;
  no delivery is lost, a republish carries the same token, and a duplicate message claims at most once.
- A Hypothesis state-machine test runs random valid and invalid operation sequences against the real database
  and compares every result with an independent model.
- The worker never reports a state the database did not produce, and a lease lost during a send is fenced
  (the request itself may still have reached the receiver, which is the documented at-least-once window).
- Mutation checks: removing each token, sequence, status or lease guard, an off-by-one at the retry limit, or
  marking an outbox row before the broker confirms, makes at least one test fail.

### Not verified yet (do not claim these)

- No performance, throughput or latency numbers exist. None have been measured.
- RabbitMQ ran as a single node. Nothing here supports a high-availability claim.
- The harness and `docker-compose.yml` were run on Linux (Docker 29) only, not yet on macOS or Windows.
- The kind/k3s, Helm, Terraform and CI pieces do not exist yet.
- Not built yet: the real HTTP sender (so no request has been sent to a real endpoint), SSRF protection,
  secret encryption/decryption (AES-256-GCM), the long-running worker/scheduler/reaper processes, endpoint
  capacity and circuit breaker, ingestion API with idempotency, retention job, transformations, control
  plane, console, AI.
- Signing was checked against an independent recomputation of the published scheme, not against the
  official test vectors.
- The publisher confirms one message at a time; its throughput is unmeasured.
- Monthly partition management for `delivery.events` is not implemented (a default partition is used).
- AC-2 (transform timeout classification) and AC-3 (retention ceiling) have no code or tests yet.
