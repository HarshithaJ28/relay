# 0002. PostgreSQL as the source of truth, with a transactional outbox

Status: Accepted

## Context

An accepted event must never be lost, and a delivery's state (scheduled, queued, in flight,
succeeded, dead, cancelled) must stay correct when processes crash, messages are duplicated or
the broker is unavailable. Writing to the database and publishing to the broker in two separate
steps can leave either one without the other.

## Decision

- PostgreSQL 16 holds tenants, endpoints, events, deliveries and attempts.
- Every state change goes through a SECURITY DEFINER function (`dispatch_batch`, `claim_delivery`,
  `record_attempt`, `reclaim_expired` and others). Each one checks the current status, dispatch
  sequence, dispatch token and lease token, and changes nothing when a check fails.
- Dispatching writes an `outbox` row in the same transaction that moves a delivery to `queued`.
  A separate publisher sends outbox rows to RabbitMQ and marks them published after the broker
  confirms them.
- A reaper reclaims expired leases and requeues queued deliveries whose message was lost.

## Alternatives considered

- **Publish directly from the transaction that schedules the delivery.** A crash between
  commit and publish loses the message; a publish before commit can deliver work that never existed.
- **Change data capture (for example Debezium).** It removes the outbox table, but adds a
  connector and Kafka Connect to run and operate, which is more than the problem needs.

## Consequences

- Publishing is at least once. Duplicate messages are expected, and `claim_delivery` turns them
  into no-ops.
- The outbox needs cleanup: the retention job deletes rows whose delivery has moved past that dispatch.
- Throughput is bounded by the database. The publisher's throughput has not been measured.
