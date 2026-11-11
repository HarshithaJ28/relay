# Relay

Multi-tenant webhook delivery platform. Design: see the Relay Technical Specification (v1.2.2).

## Milestone 1: Foundations + Delivery Core (current)

Built: SQL migrations (`db/migrations`), least-privilege roles, guarded state-transition
functions (`dispatch_batch`, `claim_delivery`, `record_attempt`, `reclaim_expired`),
transactional outbox, and an outbox publisher (`services/data-plane/relay_dataplane`).

Run the tests (needs PostgreSQL 16 server binaries and RabbitMQ; the harness starts both):

    pip install "psycopg[binary]" pytest hypothesis aio-pika
    python3 -m pytest tests

### What the tests demonstrate (real PostgreSQL 16, real RabbitMQ 3.12, synthetic data)

- Wrong, stale or duplicated dispatch tokens, lease tokens and dispatch sequences change nothing.
- Ten concurrent claims of one dispatch produce exactly one winner.
- A stalled worker's late result is rejected after the reaper reclaims the lease.
- The database rejects impossible states (CHECK constraints), and `relay_worker` has no table privileges.
- The publisher process is killed (`os._exit`) before publish, after confirm and before marking, and mid-batch;
  no delivery is lost, a republish carries the same token, and a duplicate message claims at most once.
- Mutation checks: removing each token, sequence, status or lease guard, or marking an outbox row before the
  broker confirms, makes at least one test fail.

### Not verified yet (do not claim these)

- No performance, throughput or latency numbers exist. None have been measured.
- RabbitMQ ran as a single node. Nothing here supports a high-availability claim.
- `docker-compose.yml` has not been run. The kind/k3s, Helm, Terraform and CI pieces do not exist yet.
- Not built yet: HTTP sending, retries with jitter in the worker, endpoint capacity and circuit breaker,
  SSRF protection, ingestion API with idempotency, retention job, transformations, control plane, console, AI.
- The state machine is tested by example and by concurrency tests; the Hypothesis state-machine test is still to do.
- Monthly partition management for `delivery.events` is not implemented (a default partition is used).
- AC-2 (transform timeout classification) and AC-3 (retention ceiling) have no code or tests yet.
