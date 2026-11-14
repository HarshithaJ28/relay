# 0001. RabbitMQ quorum queues as the delivery queue, not Kafka or NATS

Status: Accepted

## Context

Every webhook delivery is an independent unit of work. A worker takes one, sends one HTTP
request, records the outcome and acknowledges it. Deliveries for one endpoint may be slow or
fail while others succeed, retries are scheduled per delivery, and a message that keeps
failing must be set aside instead of blocking anything behind it. The queue does not need to
keep history: PostgreSQL already holds every delivery and attempt (ADR 0002).

## Decision

Use RabbitMQ 3.13 with a quorum queue for dispatched deliveries:

- publisher confirms, so the outbox publisher marks a row published only after the broker has it;
- manual acknowledgements with a prefetch limit, so a worker acks only after the outcome is recorded;
- a delivery limit and the `relay.dlq` dead-letter queue, so a message that keeps being returned stops
  circulating.

## Alternatives considered

- **Kafka.** A partitioned log is built for ordered, replayable streams. Here, one slow message
  holds up its whole partition (head-of-line blocking), per-message retry and dead-lettering
  must be built on top, and replay is already served from PostgreSQL.
- **NATS JetStream.** It has per-message acks, redelivery limits and a small footprint, and
  would also have worked. It was dropped to keep one broker with well-known quorum semantics
  and tooling, not because of a measured shortcoming.

## Consequences

- Ordering is not guaranteed between deliveries, and the design does not depend on it: the
  database functions reject duplicate and stale messages with dispatch sequence numbers and tokens.
- The broker holds only in-flight work. If it loses messages, the reaper requeues deliveries
  from the database.
- RabbitMQ has run as a single node only. The planned three-node test shows quorum behaviour; it
  is not a high-availability claim.
