# Relay

[![CI](https://github.com/HarshithaJ28/relay/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/HarshithaJ28/relay/actions/workflows/ci.yml)
[![Image](https://github.com/HarshithaJ28/relay/actions/workflows/image.yml/badge.svg?branch=main)](https://github.com/HarshithaJ28/relay/actions/workflows/image.yml)

Multi-tenant webhook delivery platform. Design: see the Relay Technical Specification (v1.2.2).

Two services share one PostgreSQL database (migrations in `db/migrations`):

- `services/data-plane` (Python 3.12): ingestion API, scheduler, publisher, workers, reaper and retention job.
- `services/control-plane` (TypeScript, Fastify, Zod, Drizzle): accounts, endpoints, subscriptions, API keys,
  deliveries, replay, usage and billing, under `/api/v1`.

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
- Bounded dispatching (migration 0008): the scheduler dispatches only what an endpoint can accept
  (`concurrency_limit`, counting its queued and in-flight deliveries) and caps each tenant's active deliveries
  (`dispatch_cap`), so a slow endpoint's backlog waits in PostgreSQL instead of filling RabbitMQ or the workers.
  Oldest work goes first, and each tenant gets at most one batch per pass, so one busy tenant cannot starve
  the others. Counting happens under the tenant's dispatch lock, so two schedulers never spend the same slot.
- Circuit breaker per endpoint (`breaker.py`, migration 0009): a rolling failure window in Valkey (one Lua
  script per decision) opens the breaker when the failure rate reaches the threshold with enough volume; the
  endpoint's due deliveries move past the reopen time without using attempts; after the cool-down exactly one
  probe is dispatched, and its result closes the breaker or reopens it with a doubled cool-down (capped).
  Timeouts, connection, DNS and TLS errors, 5xx and 429 count as failures; other 4xx do not. PostgreSQL holds a
  mirror for the scheduler, and a successful probe closes it even if Valkey was lost; without Valkey nothing
  opens. Enabled by `RELAY_VALKEY_URL`; window, volume, threshold and cool-downs are settings.
- Per-tenant ingestion rate limit (`ratelimit.py`): a token bucket in Valkey (`ingest_rate_per_sec`,
  `ingest_burst` per tenant) using Valkey's clock, so API replicas share one bucket. Over the limit: 429 with
  `Retry-After`. Checked after authentication, so unauthenticated traffic cannot spend a tenant's tokens. If
  Valkey is unreachable, requests are allowed and a warning is logged.
- Replay (migration 0010, `delivery.replay_delivery`): a finished delivery is replayed as a new delivery; the
  webhook-id is new by default for a succeeded delivery and reused for a dead one, a replay carries
  `relay-replay` and `relay-replay-of`, and an expired payload cannot be replayed (the expiry is returned).
- Dead-letter queue: the dispatch queue has a delivery limit and dead-letters into `relay.dlq`. A malformed
  message goes there at once; a message whose handling keeps failing is retried until the limit.
- Live updates: after the database records an outcome, the worker publishes it (and breaker openings) on the
  tenant's Valkey channel; the control plane relays the channel as server-sent events.
- Maintenance in the retention job: monthly `delivery.events` partitions three months ahead, dropped only when
  older than the longest retention plus 7 days and no delivery refers to them; outbox rows deleted once their
  dispatch is over; a daily orphan report; daily usage totals recomputed from the source rows.
  `delivery_attempts` is deliberately not partitioned: its unique index on counted attempts would have to
  include the partition key, which would remove the guarantee that an attempt is never counted twice.
- API-key cache in ingestion (30 s by default, `RELAY_API_KEY_CACHE_SECONDS`); a revoked key keeps working for
  up to that long.
- Observability (`observability.py`): Prometheus metrics, `/healthz` and `/readyz` on every process
  (`RELAY_METRICS_PORT`, default 9100; ingestion serves them on its own port), JSON logs with any `*_token`
  field or `key=value` redacted (tracebacks included), and OpenTelemetry traces exported when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Wire-level library loggers never go below INFO, because AMQP frames
  carry message bodies. Grafana dashboard and Prometheus alert rules: `deploy/grafana`.
- Control plane (`services/control-plane`, migrations 0011 and 0013):
  - accounts: registration needs a single-use, expiring invite code and creates a tenant and its owner;
    argon2id passwords; short-lived JWT access tokens;
    rotating refresh tokens in an httpOnly, SameSite=Strict cookie, where reusing an old token revokes the
    whole session family; roles owner, admin and viewer;
  - login throttling in Valkey: after 5 failed logins for one account, or 20 from one IP, within 15 minutes,
    that account or IP gets 429 with `Retry-After` for 15 minutes, even with the right password (settings
    `RELAY_LOGIN_MAX_FAILURES_PER_ACCOUNT`, `RELAY_LOGIN_MAX_FAILURES_PER_IP`, `RELAY_LOGIN_LOCK_SECONDS`).
    Accounts are keyed by a hash of the email. If Valkey is down, login answers 503. `X-Forwarded-For` is
    believed only for `RELAY_TRUSTED_PROXY_HOPS` proxies (default 0), so a client cannot choose its own IP;
  - invite codes are made by the operator, connected as `relay_owner` (`RELAY_OPERATOR_DSN`):
    `npm run create-invite -- --days 7 --note "for a reviewer"` (in the image:
    `node dist/cli.js create-invite --days 7`) prints the code once; only its SHA-256 is stored;
  - endpoints with save-time SSRF checks (URL and current DNS answers; the same corpus as the data plane), the
    plan's endpoint limit, encrypted signing secrets (the data plane's format; each language decrypts the
    other's), rotation with an overlap window, test events and health;
  - event types, subscriptions, API keys (shown once, stored as SHA-256) and users;
  - deliveries with filters, cursor pagination and attempts; payloads hidden past retention; single and bulk
    replay with counts before anything runs;
  - plans, usage and Stripe billing (test mode): checkout sessions and signed, idempotent webhooks that move
    a tenant between plans and copy the plan's limits onto it;
  - `GET /api/v1/stream` (server-sent events from Valkey), `/healthz`, `/readyz`, `/metrics`, OpenAPI at
    `/api/v1/openapi.json`, RFC 9457 errors.
  It connects as its own role, `relay_control`, bound by row-level security like ingestion's `relay_tenant`,
  which stays narrower (no endpoint URLs). Functions that run before a tenant is known (register, login lookup,
  session rotation, Stripe events) are owned by the plain role `relay_auth`. `RELAY_VALKEY_URL` is required.
- Deployment (`deploy/`, `docs/deploy.md`): Helm charts `relay` (the services, an Ingress for `/api` and
  `/ingest`, NetworkPolicies, and a `helm test` egress smoke test) and `relay-datastores` (single-node
  PostgreSQL, RabbitMQ and Valkey); a migration image (`db/migrate.sh`) that applies each new file in one
  transaction before every install and upgrade; Terraform for one Oracle Always Free k3s machine (state in OCI
  Object Storage) and a validate-only AWS equivalent with a billing alert.
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
`postgres:16`, `rabbitmq:3.13` and `valkey/valkey:8.1` containers with testcontainers and removes them
afterwards):

    pip install -r requirements-dev.txt
    python3 -m pytest tests

Or run them against services that are already up, for example the Compose stack:

    docker compose up -d --wait
    RELAY_TEST_PG_DSN="host=127.0.0.1 port=5432" \
    RELAY_TEST_AMQP_URL="amqp://guest:guest@127.0.0.1:5672/" \
    RELAY_TEST_VALKEY_URL="valkey://127.0.0.1:6379/15" python3 -m pytest tests

If Docker or a service is unavailable the tests fail; they never skip.

Control-plane tests (Node 22; the same real PostgreSQL with these migrations, and Valkey):

    cd services/control-plane && npm ci && npm test

### CI/CD

- `ci.yml` (every push to main and every pull request): ruff lint and format check, the full test suite on
  Python 3.12 and 3.13 against real PostgreSQL 16 and RabbitMQ started by testcontainers, and `pip-audit` on
  the pinned dependencies.
- `image.yml`: builds `services/data-plane/Dockerfile` and smoke-tests it on pull requests; on main and on
  `v*.*.*` tags it pushes a linux/amd64 + linux/arm64 image to `ghcr.io/harshithaj28/relay-data-plane` with an
  SBOM and a build-provenance attestation.
- `ci.yml` also runs the control plane's typecheck, Biome lint, tests and `npm audit`, and `image.yml` builds,
  smoke-tests and publishes `ghcr.io/harshithaj28/relay-control-plane` and `ghcr.io/harshithaj28/relay-migrations`
  the same way. Each image is scanned with Trivy before it is pushed, and a fixable HIGH or CRITICAL finding
  fails the build.
- `infra.yml`: `helm lint` and `kubeconform` for both charts; `terraform fmt`, `validate` (no credentials, no
  backend) and `tflint` for the three Terraform stacks; a Trivy configuration scan; and a job that installs real
  k3s on the runner, deploys both charts with images built from the commit, checks the API through Traefik, runs
  the egress smoke test, then repeats it with the NetworkPolicies off and requires it to fail.
- `security.yml`: gitleaks over the full history, CodeQL (Python, TypeScript and the workflows) and OpenSSF
  Scorecard.
- `deploy.yml`: after the images for a commit on main are published, upgrades both releases on the k3s host over
  an SSH tunnel and runs the egress smoke test. Off until `DEPLOY_ENABLED` is set (see `docs/deploy.md`).
- Dependabot opens weekly grouped updates for GitHub Actions (pinned to commit SHAs), pip, npm and the base
  image.

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
- Capacity: an endpoint never has more than its limit active, in-flight work counts, a full endpoint does not
  hold back its neighbours, the tenant cap holds across endpoints, oldest work goes first, and one busy tenant
  cannot take a whole pass. A deterministic two-scheduler test shows the tenant lock is what stops a second
  scheduler from overbooking an endpoint when the ranking changes between count and commit.
- Circuit breaker: the Valkey state machine (volume, threshold, rolling window, ignored late results, doubled
  and capped cool-downs, probe), the PostgreSQL mirror (only a lease holder can open it, the backlog moves
  without attempts, exactly one probe after the cool-down, only a probe success closes it), and end to end: an
  endpoint down for 4 s with 30 deliveries opens the breaker, receives fewer than 60 requests during the outage
  instead of hundreds, and every delivery succeeds after the probe closes the breaker.
- Rate limit: burst, then 429 with `Retry-After`, then refill; separate buckets per tenant; 20 concurrent
  requests cannot overspend a bucket of 5; unauthenticated requests use no tokens; Valkey down lets traffic through.
- Replay: default and explicit message-id modes, active deliveries refused, another tenant's delivery not found,
  an expired payload refused with its expiry, replay headers on the replayed request.
- Dead-letter queue against real RabbitMQ: a malformed message is dead-lettered on its first delivery, and a
  poison message after its first delivery plus two redeliveries (limit 2).
- Outages while the real processes run: the database refusing connections and RabbitMQ stopped, each for 5 s;
  every process stays up, reconnects and every delivery arrives. This found a real bug: a closed AMQP channel
  raised an error the publisher did not treat as a broker error, and the process exited.
- Canary tokens (spec section 3): known token values pushed through every worker path with all libraries at
  DEBUG and tracing on appear in no log line, trace attribute, error or stored row; the real processes at DEBUG
  do not log their real dispatch tokens. This found a real leak: the AMQP library logs raw frames, which
  contain message bodies, at DEBUG.
- Every process serves metrics, health and readiness, its counters reflect its work, and every log line is JSON;
  the dashboard and alert rules reference only exported metrics.
- Control plane (136 tests, real PostgreSQL and Valkey): invite codes (single use, expiry, a taken email
  leaves the code usable, three simultaneous registrations with one code give one tenant, only the operator
  role makes codes), login throttling (account and IP locks, unlock after the lock time, a successful login
  clearing the count, unknown emails locked the same way, spoofed `X-Forwarded-For` ignored, 503 when Valkey
  is unreachable, no email in Valkey), sessions and token rotation with reuse detection,
  tampered, expired, foreign-key and foreign-audience tokens refused, roles, the spec's isolation test (another
  tenant calls every route with this tenant's ids and gets 404), SSRF corpus and DNS checks at save time, plan
  limits, secret rotation, AC-3 payload hiding, replay and bulk replay, pagination that never skips rows created
  in the same millisecond, Stripe signatures and idempotency, and the live stream.
- Mutation checks: removing each token, sequence, status or lease guard, an off-by-one at the retry limit, or
  marking an outbox row before the broker confirms, makes at least one test fail. The same holds for each
  SSRF guard (25 mutants: the address checks, URL checks, redirects, proxies, cookies, body limit and
  the URL-parser cross-check), each secret-encryption guard (26 mutants), and the process rules (ack only after
  recording, no requeue loops, graceful shutdown, every due tenant served, the lease check, the reaper's two jobs),
  ingestion (13 mutants plus each of the 8 tenant policies), retention and transformations (20 mutants),
  bounded dispatching (7 mutants) and the circuit breaker and rate limit (24 mutants; two survivors showed
  redundant code, which was removed), and replay, dead-lettering, live updates, maintenance, the key cache and
  the control plane's guards (about 50 more, plus 9 for invites and login throttling).

### Known limitations

- No performance, throughput or latency numbers exist. None have been measured.
- RabbitMQ ran as a single node. Nothing here supports a high-availability claim.
- The harness and `docker-compose.yml` were run on Linux (Docker 29) only, not yet on macOS or Windows.
- Nothing has been deployed. The Helm charts, Terraform stacks and deploy job exist; the charts were checked with
  `helm lint` and `kubeconform`, and Terraform with `validate` and `tflint`, but `infra.yml`'s k3s job (which
  installs the charts and runs the egress smoke test on a real cluster) has not run yet, and no Terraform stack
  has been applied. The datastores run as single pods on one node.
- The processes have run only as local subprocesses with shrunk timings (1 s request timeout, sub-second
  retries), not in a cluster and not with the production defaults. Outages were 5 s long; longer ones and
  network partitions have not been tested.
- The Grafana dashboard and alert rules are files that have not been imported into Grafana Cloud, and no
  traces have been sent to a collector. Alert thresholds are starting points.
- Billing has never called the real Stripe API: checkout uses a stand-in client in tests, and webhooks are
  checked with Stripe's own signing scheme. Plan limits other than endpoint count, retention, rates and the
  dispatch cap (for example events per month) are shown in usage but not enforced.
- No email verification and no password reset; owners create users with a password. The account lock means
  anyone who knows an email can keep that account locked out (5 tries every 15 minutes); the per-IP lock
  limits how many accounts one IP can do this to, not how many IPs try.
- Usage totals are recomputed from the source tables instead of the spec's Valkey counters.
- The real transformation runner (Node, JSONata) does not exist; AC-2 was tested against an HTTP runner double
  that follows the documented protocol. There is no runner circuit breaker yet.
- The HTTP sender has only sent to a local test receiver, never to a real public endpoint, and only with
  scripted DNS in tests. The NetworkPolicies and the egress smoke test (the second SSRF layer) exist but have not
  yet run on a cluster.
- Master keys are read from the environment or a file; no KMS integration. Re-encrypting stored secrets after a
  master-key change is a library function (`reencrypt`) with no job or command that runs it yet.
- The breaker's defaults (60 s window, 10 results, 50 % failures, 30 s cool-down up to 10 min) and the tenant
  limits (10 per endpoint, 100 per tenant, 100 events/s with a burst of 200) are provisional; the spec calls for
  choosing them from chaos-receiver experiments, which have not been run.
- Not built yet: the console, the transformation runner and authoring flow, and the AI features.
- The publisher confirms one message at a time; its throughput is unmeasured.
- Months that already have rows in the default partition stay there; partitions are created ahead of time
  from then on.
