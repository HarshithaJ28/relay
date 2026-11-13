# Relay

[![CI](https://github.com/HarshithaJ28/relay/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/HarshithaJ28/relay/actions/workflows/ci.yml)
[![Image](https://github.com/HarshithaJ28/relay/actions/workflows/image.yml/badge.svg?branch=main)](https://github.com/HarshithaJ28/relay/actions/workflows/image.yml)

Multi-tenant webhook delivery platform. Design: see the Relay Technical Specification (v1.2.2).

## Status

Built (`db/migrations`, `services/data-plane/relay_dataplane`):

- SQL migrations, least-privilege roles, guarded state-transition functions
  (`dispatch_batch`, `claim_delivery`, `record_attempt`, `reclaim_expired`, and for the running processes
  `due_tenants`, `requeue_stale`, `check_lease`), transactional outbox.
- Outbox publisher (RabbitMQ quorum queue, publisher confirms).
- Worker core: claim, Standard Webhooks signing, send through an injected `Sender`, response
  classification, full-jitter backoff honouring `Retry-After`, fenced result recording.
- HTTP sender (aiohttp) with SSRF protection (`destination.py`, `http_sender.py`): HTTPS only, port
  allowlist, no credentials or numeric IPv4 forms in URLs; the sender resolves DNS itself, rejects private,
  loopback, CGNAT, link-local/metadata, reserved and multicast addresses (IPv4 and IPv6, including
  IPv4-mapped, IPv4-compatible, NAT64, 6to4 and Teredo forms), and connects only to the addresses it
  checked while verifying TLS against the original hostname. No redirects, no proxies from the environment,
  no cookies, at most 1 KB of the response body read. `RELAY_ALLOW_PRIVATE_TARGETS`, `RELAY_ALLOW_HTTP` and
  `RELAY_ALLOWED_PORTS` relax the rules for tests and private benchmark setups.
- Signing secrets encrypted at rest (`endpoint_secrets.py`, migration 0004): AES-256-GCM, each ciphertext
  bound to its endpoint and secret id; master keys from `RELAY_SECRET_KEYS` or a mounted file
  (`RELAY_SECRET_KEYS_FILE`) with key ids, so the master key rotates without downtime. An endpoint holds one
  or two signing secrets with optional expiry; during a rotation every request carries a signature from each.
  A secret that cannot be decrypted sends nothing and is retried (`secret_unavailable`).
- Ingestion API (`ingest.py`, migration 0006; FastAPI, `POST /ingest/v1/events`, `GET /ingest/v1/events/{id}`):
  API keys (only their SHA-256 stored; `python -m relay_dataplane create-api-key --tenant <id>` prints one
  once), scopes, `Idempotency-Key` with its own table, and the idempotency key, event and one delivery per
  subscribed endpoint written in one transaction. A repeated key with the same body returns the original event
  (`Idempotent-Replayed: true`); with a different body, 422. Authentication happens before the body is read;
  bodies over 256 KB get 413; errors are RFC 9457 problem details; PostgreSQL's jsonb parser decides what is
  storable (NaN, Infinity and `\u0000` get 422, numbers are stored exactly). `NOTIFY` on commit wakes the
  scheduler early; polling remains the guarantee. Health: `/healthz`, `/readyz`. OpenAPI at
  `/ingest/v1/openapi.json`.
- Row-level security on every tenant-scoped table (migrations 0006 and 0007): the ingestion role sets
  `app.tenant_id` after authentication and sees only that tenant's rows; without it, nothing. It cannot read
  endpoint URLs, signing secrets or key hashes.
- Retention job (`retention.py`, AC-3): per tenant and in batches, deletes expired attempts, then terminal
  deliveries, then events no delivery refers to, then expired idempotency keys. An active delivery keeps its
  payload (the read API hides it at the boundary) until the ceiling: `retention_days` + the longest retry
  window (52,290 s) + the maximum deferral age (6 h); past it the delivery becomes dead with
  `retention_expired` and is deleted. Each pass logs `relay_retention_blocked_events` and
  `relay_retention_lag_seconds`. The process refuses to start if the shortest retention window, minus one day,
  does not exceed that ceiling margin.
- Transformation failures (`transform.py`, migration 0007, AC-2): an endpoint may name a transformation run
  by an external runner (`RELAY_TRANSFORM_URL`). Only a failure the runner confirms (`expression_error`,
  `limit_exceeded`) is `transform_error` and dead; a timeout, refusal, reset, 5xx or unattributable answer is
  `transform_unavailable`, deferred with no attempt used, until the deferral run passes the maximum deferral
  age (`RELAY_MAX_DEFERRAL_AGE`, default 6 h), after which each deferral counts. The signature covers the
  transformed body.
- Long-running processes (`python -m relay_dataplane worker|scheduler|reaper|publisher|ingest|retention`, one
  image):
  - worker: consumes with a prefetch limit, checks by the database clock that the lease outlives the request
    before sending (spec section 5), acks only after the outcome is recorded;
  - scheduler: dispatches due deliveries tenant by tenant;
  - reaper: reclaims expired leases and requeues deliveries whose message was lost or rejected;
  - publisher: the outbox publisher as a loop.
  All reconnect with capped backoff after database or broker errors and shut down gracefully on SIGTERM
  (sends in progress finish and are recorded). Settings are environment variables
  (`relay_dataplane/settings.py`); a configuration error exits with code 2.

Run the tests (Python 3.12+ and a running Docker daemon; the harness starts throwaway
`postgres:16` and `rabbitmq:3.13` containers with testcontainers and removes them afterwards):

    pip install -r requirements-dev.txt
    python3 -m pytest tests

Or run them against services that are already up, for example the Compose stack:

    docker compose up -d --wait
    RELAY_TEST_PG_DSN="host=127.0.0.1 port=5432" \
    RELAY_TEST_AMQP_URL="amqp://guest:guest@127.0.0.1:5672/" python3 -m pytest tests

If Docker or a service is unavailable the tests fail; they never skip.

### CI/CD

- `ci.yml` (every push to main and every pull request): ruff lint and format check, the full test suite on
  Python 3.12 and 3.13 against real PostgreSQL 16 and RabbitMQ started by testcontainers, and `pip-audit` on
  the pinned dependencies.
- `image.yml`: builds `services/data-plane/Dockerfile` and smoke-tests it on pull requests; on main and on
  `v*.*.*` tags it pushes a linux/amd64 + linux/arm64 image to `ghcr.io/harshithaj28/relay-data-plane` with an
  SBOM and a build-provenance attestation.
- Dependabot opens weekly grouped updates for GitHub Actions (pinned to commit SHAs), pip packages and the
  base image.

### What the tests verify (real PostgreSQL 16 and RabbitMQ 3.13 in Docker, synthetic data)

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
- The HTTP sender delivers to a real local HTTPS receiver (test CA) and the receiver verifies the signature;
  scripted DNS shows that private, metadata, mapped and tunnelled answers are blocked before any connection,
  a certificate for a different name is rejected, redirects are not followed, an endless response body is
  not read past 1 KB, and the worker records a blocked destination as `dead` without sending.
- A corpus of SSRF bypass URLs (decimal, hex and octal IPv4, IPv6 forms, credentials, ports, and URLs that
  Python's and aiohttp's URL parsers read differently) is rejected without a DNS lookup.
- Signing matches the official Standard Webhooks test vector, and a one-character change fails verification.
- Encrypted secrets: a flipped byte, a ciphertext copied to another endpoint or relabelled, or an unknown master
  key is rejected; master-key rotation (add, re-encrypt, remove) keeps secrets readable; during a signing-secret
  rotation a receiver holding either secret verifies the request, and an expired secret is no longer used.
- The four processes run as real subprocesses against a real HTTPS chaos receiver (503s, a timeout, 429 with
  Retry-After, permanent 500 and 410, a metadata URL): every delivery reaches the expected final state and
  attempt count, every request is correctly signed, and all processes exit 0 on SIGTERM. Fault injection:
  a worker killed with SIGKILL mid-send is recovered by the reaper (the receiver then sees the same message
  twice: the documented at-least-once window); SIGTERM during a send lets it finish and be recorded; a message
  purged from the broker is requeued after the queue timeout without using an attempt.
- Ingestion: 47 API tests as the real `relay_tenant` role (authentication, scopes, revoked keys, tenant isolation,
  validation, size limits including chunked uploads, exact number storage); 20 concurrent requests with one
  `Idempotency-Key` create exactly one event; a failure after the key and event were written leaves nothing, so
  a retry succeeds. Schemathesis generates requests from the OpenAPI document and finds no 5xx and no response
  that breaks the document. End to end: a key from the CLI, an event over HTTP to the real `ingest` process,
  delivered signed to the chaos receiver in under 3 s with a 10 s scheduler poll (so the `NOTIFY` wake-up works).
- Row-level security, table by table: each tenant sees only its rows, no tenant context sees nothing, and an
  insert for another tenant is refused.
- AC-3, as the spec states it: with a delivery stuck in `scheduled` past the window, the read API returns 404,
  the job keeps the payload and reports it as blocked, the delivery is still dispatched and delivered, and then
  deleted; past the ceiling a scheduled, queued or in-flight delivery becomes dead and its payload is deleted,
  and a worker still holding the old lease can record nothing.
- AC-2, as the spec states it: a runner that hangs past the RPC timeout produces a deferral, never dead (also
  for refusals, resets, 5xx and malformed answers); `limit_exceeded` produces dead with nothing sent; after the
  runner recovers the same delivery is transformed and delivered.
- Mutation checks: removing each token, sequence, status or lease guard, an off-by-one at the retry limit, or
  marking an outbox row before the broker confirms, makes at least one test fail. The same holds for each
  SSRF guard (25 mutants: the address checks, URL checks, redirects, proxies, cookies, body limit and
  the URL-parser cross-check), each secret-encryption guard (26 mutants), and the process rules (ack only after
  recording, no requeue loops, graceful shutdown, every due tenant served, the lease check, the reaper's two jobs),
  ingestion (13 mutants plus each of the 8 tenant policies) and retention and transformations (20 mutants).

### Known limitations

- No performance, throughput or latency numbers exist. None have been measured.
- RabbitMQ ran as a single node. Nothing here supports a high-availability claim.
- The harness and `docker-compose.yml` were run on Linux (Docker 29) only, not yet on macOS or Windows.
- There is no deployment step: CI publishes an image but nothing deploys it. kind/k3s, Helm and Terraform do
  not exist yet.
- The processes have run only as local subprocesses with shrunk timings (1 s request timeout, sub-second
  retries), not in a cluster and not with the production defaults. A database or broker outage while they run
  has not been tested; the reconnect paths are untested code.
- No metrics or traces exist yet; the retention metrics are log lines, not exported. Logs are plain text. Only
  the ingestion API has health endpoints.
- Ingestion has no per-tenant rate limit (the spec's Valkey token bucket) and no API-key cache; every request
  authenticates against PostgreSQL. Event types, endpoints and subscriptions have no API yet (the control plane
  is not built); tests create them directly.
- The real transformation runner (Node, JSONata) does not exist; AC-2 was tested against an HTTP runner double
  that follows the documented protocol. There is no runner circuit breaker yet.
- If a claimed delivery's event row were missing, `claim_delivery` would still mark it in flight and the reaper
  would reclaim it (bounded by the 12-attempt limit). Ingestion writes both in one transaction, so this needs
  manual tampering; it is noted, not fixed.
- The HTTP sender has only sent to a local test receiver, never to a real public endpoint, and only with
  scripted DNS in tests. The Kubernetes NetworkPolicy and the post-deploy egress smoke test (the second SSRF
  layer) do not exist yet.
- Master keys are read from the environment or a file; no KMS integration. Re-encrypting stored secrets after a
  master-key change is a library function (`reencrypt`) with no job or command that runs it yet.
- Not built yet: endpoint capacity and circuit breaker, per-tenant fairness, replay API, control plane, console,
  AI.
- The publisher confirms one message at a time; its throughput is unmeasured.
- Monthly partition management for `delivery.events` is not implemented (a default partition is used).
- Partitions are never dropped: retention deletes rows only.
