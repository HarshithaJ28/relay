# Architecture decision records

Each record states one decision, why it was made, and what it costs. Records are not
rewritten; a changed decision gets a new record that supersedes the old one.

| No. | Decision | Status |
| --- | --- | --- |
| [0001](0001-rabbitmq-over-kafka-and-nats.md) | RabbitMQ quorum queues as the delivery queue, not Kafka or NATS | Accepted |
| [0002](0002-postgresql-with-a-transactional-outbox.md) | PostgreSQL as the source of truth, with a transactional outbox | Accepted |
| [0003](0003-row-level-security-for-tenant-isolation.md) | Row-level security and least-privilege roles for tenant isolation | Accepted |
| [0004](0004-python-data-plane-typescript-control-plane.md) | Python for the data plane, TypeScript for the control plane | Accepted |
| [0005](0005-oracle-always-free-with-k3s.md) | One k3s node on Oracle Cloud Always Free for hosting | Accepted, not yet deployed |
| [0006](0006-no-vercel.md) | The console is served from the same cluster, not Vercel | Accepted, not yet built |
