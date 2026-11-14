# Architecture

Relay accepts events from tenants and delivers them as signed webhooks to the tenants'
endpoints, with retries, a circuit breaker per endpoint, replay and a live view. The reasons
behind the main choices are in [`docs/adr`](adr/README.md).

## Components

```mermaid
flowchart LR
  subgraph Clients
    producer["Tenant backend<br/>(API key)"]
    browser["Console in a browser<br/>(access token + refresh cookie)"]
  end

  subgraph DataPlane["Data plane (Python)"]
    ingest["ingest<br/>POST /ingest/v1/events"]
    scheduler["scheduler<br/>dispatch_batch"]
    publisher["publisher<br/>outbox to broker"]
    worker["worker<br/>claim, sign, send, record"]
    reaper["reaper<br/>expired leases, lost messages"]
    retention["retention<br/>partitions, outbox cleanup, usage"]
  end

  subgraph ControlPlane["Control plane (TypeScript)"]
    api["Fastify API /api/v1<br/>accounts, endpoints, deliveries,<br/>replay, billing, SSE stream"]
  end

  pg[("PostgreSQL 16<br/>row-level security,<br/>guarded functions, outbox")]
  mq[["RabbitMQ 3.13<br/>quorum queue + relay.dlq"]]
  vk[("Valkey 8.1<br/>rate limits, breaker,<br/>login limits, live pub/sub")]
  receiver["Tenant endpoint<br/>(public HTTPS)"]
  stripe["Stripe (test mode)"]

  producer --> ingest
  browser --> api
  ingest --> pg
  ingest --> vk
  scheduler --> pg
  publisher --> pg
  publisher --> mq
  mq --> worker
  worker --> pg
  worker --> vk
  worker -->|"signed POST,<br/>SSRF-checked"| receiver
  reaper --> pg
  retention --> pg
  api --> pg
  api --> vk
  stripe -->|"signed webhooks"| api
  api -->|"checkout"| stripe
```

How an event becomes a delivery:

1. **Ingestion** authenticates the API key, applies the tenant's rate limit and the idempotency
   key, and writes the event and one delivery per subscribed endpoint in one transaction.
2. **The scheduler** calls `dispatch_batch` tenant by tenant. It moves due deliveries to `queued`
   within the endpoint's concurrency limit and the tenant's cap, and writes one outbox row per
   delivery in the same transaction.
3. **The publisher** sends outbox rows to RabbitMQ and marks them published once the broker
   confirms them.
4. **A worker** claims the delivery with its dispatch token (`claim_delivery`), checks that its
   lease outlives the request, signs the payload (Standard Webhooks) and sends it through the
   SSRF-checked sender. It records the outcome (`record_attempt`) and only then acknowledges the
   message.
5. **The reaper** reclaims deliveries whose lease expired and requeues queued deliveries whose
   message was lost.
6. **Live updates**: workers publish `delivery` and `breaker` events on `relay:live:<tenant>`,
   and the control plane relays the tenant's own channel as server-sent events at `/api/v1/stream`.

## Delivery states

Every transition is made by a SECURITY DEFINER function that checks the current status and the
caller's dispatch or lease token, and changes nothing when a check fails.

```mermaid
stateDiagram-v2
  [*] --> scheduled: ingest, or replay_delivery
  scheduled --> queued: dispatch_batch (writes the outbox row)
  queued --> in_flight: claim_delivery (dispatch token, event exists)
  queued --> scheduled: requeue_stale (message lost or rejected)
  in_flight --> succeeded: record_attempt (2xx)
  in_flight --> scheduled: record_attempt (retry, full-jitter backoff)
  in_flight --> dead: record_attempt (permanent failure or attempt limit)
  in_flight --> scheduled: reclaim_expired (lease expired)
  in_flight --> scheduled: check_lease / defer_delivery (not counted as an attempt)
  succeeded --> [*]
  dead --> [*]
  cancelled --> [*]
```

Notes:

- `cancelled` is an allowed status in the schema, but no function sets it yet.
- A replay never changes the original delivery. It creates a new delivery that starts in
  `scheduled`: a succeeded delivery's replay gets a new webhook id, a dead one's reuses the
  original id, and a delivery whose payload has passed retention cannot be replayed.
- When an endpoint's breaker opens (`open_breaker`), its scheduled deliveries move past the
  reopen time without using attempts. After the cool-down, one probe delivery decides whether
  the breaker closes.

## Tenant isolation

Each process connects as its own database role. Tenant-scoped tables have forced row-level
security keyed on the transaction setting `app.tenant_id`, and no role is a superuser or has
BYPASSRLS. See [ADR 0003](adr/0003-row-level-security-for-tenant-isolation.md).

## Hosting (planned, not yet deployed)

One k3s node on Oracle Cloud Always Free. Traefik serves a single origin: `/` for the console,
`/api` for the control plane and `/ingest` for ingestion. See
[ADR 0005](adr/0005-oracle-always-free-with-k3s.md) and [ADR 0006](adr/0006-no-vercel.md).
