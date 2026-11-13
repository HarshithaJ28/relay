"""Process settings, read once from the environment.

Every process connects with its own database role: RELAY_DSN must name the
role the process runs as (relay_worker, relay_scheduler, relay_reaper or
relay_publisher). Defaults are the production values from the spec; the
end-to-end tests shrink the timings.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass


def _num(env: Mapping[str, str], name: str, default: float, low: float, high: float) -> float:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {raw!r}") from None
    if not low <= value <= high:
        raise ValueError(f"{name} must be between {low} and {high}, got {value}")
    return value


@dataclass(frozen=True)
class Settings:
    dsn: str
    amqp_url: str
    queue: str = "relay.deliveries"
    # worker
    concurrency: int = 32  # messages handled at once (= RabbitMQ prefetch)
    request_timeout: float = 10.0
    lease_margin: float = 30.0
    retry_base: float = 30.0
    retry_cap: float = 6 * 3600.0
    shutdown_grace: float = 15.0  # how long a stopping worker waits for sends in progress
    transform_url: str = ""  # the transformation runner; empty = none (transformed endpoints are deferred)
    transform_timeout: float = 2.0
    transform_retry_delay: float = 30.0
    max_deferral_age: float = 6 * 3600.0
    # scheduler
    scheduler_tick: float = 1.0  # idle wait between dispatch passes
    dispatch_batch: int = 100
    tenants_per_pass: int = 100
    # reaper
    reaper_interval: float = 5.0
    queue_timeout: float = 600.0  # a published message unclaimed for this long is treated as lost
    reap_batch: int = 500
    # publisher
    publisher_tick: float = 0.5
    publish_batch: int = 100
    # retention
    retention_interval: float = 3600.0  # spec default: physical deletion follows within this interval
    retention_batch: int = 500
    # ingestion API
    ingest_host: str = "0.0.0.0"
    ingest_port: int = 8080
    ingest_pool_size: int = 10
    idempotency_window_hours: float = 24.0

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None, needs_broker: bool = True) -> "Settings":
        env = os.environ if env is None else env
        required = ("RELAY_DSN", "RELAY_AMQP") if needs_broker else ("RELAY_DSN",)
        missing = [n for n in required if not env.get(n)]
        if missing:
            raise ValueError(f"missing required setting(s): {', '.join(missing)}")
        d = cls(env["RELAY_DSN"], env.get("RELAY_AMQP", ""))
        return cls(
            dsn=d.dsn,
            amqp_url=d.amqp_url,
            queue=env.get("RELAY_QUEUE") or d.queue,
            concurrency=int(_num(env, "RELAY_CONCURRENCY", d.concurrency, 1, 1000)),
            request_timeout=_num(env, "RELAY_REQUEST_TIMEOUT", d.request_timeout, 0.1, 300),
            lease_margin=_num(env, "RELAY_LEASE_MARGIN", d.lease_margin, 0.5, 600),
            retry_base=_num(env, "RELAY_RETRY_BASE_SECONDS", d.retry_base, 0.1, 3600),
            retry_cap=_num(env, "RELAY_RETRY_CAP_SECONDS", d.retry_cap, 0.1, 6 * 3600),
            shutdown_grace=_num(env, "RELAY_SHUTDOWN_GRACE", d.shutdown_grace, 0, 600),
            transform_url=env.get("RELAY_TRANSFORM_URL", ""),
            transform_timeout=_num(env, "RELAY_TRANSFORM_TIMEOUT", d.transform_timeout, 0.1, 60),
            transform_retry_delay=_num(env, "RELAY_TRANSFORM_RETRY_DELAY", d.transform_retry_delay, 0, 6 * 3600),
            max_deferral_age=_num(env, "RELAY_MAX_DEFERRAL_AGE", d.max_deferral_age, 1, 7 * 86400),
            scheduler_tick=_num(env, "RELAY_SCHEDULER_TICK", d.scheduler_tick, 0.05, 60),
            dispatch_batch=int(_num(env, "RELAY_DISPATCH_BATCH", d.dispatch_batch, 1, 1000)),
            tenants_per_pass=int(_num(env, "RELAY_TENANTS_PER_PASS", d.tenants_per_pass, 1, 10000)),
            reaper_interval=_num(env, "RELAY_REAPER_INTERVAL", d.reaper_interval, 0.05, 600),
            queue_timeout=_num(env, "RELAY_QUEUE_TIMEOUT", d.queue_timeout, 1, 86400),
            reap_batch=int(_num(env, "RELAY_REAP_BATCH", d.reap_batch, 1, 1000)),
            publisher_tick=_num(env, "RELAY_PUBLISHER_TICK", d.publisher_tick, 0.05, 60),
            publish_batch=int(_num(env, "RELAY_PUBLISH_BATCH", d.publish_batch, 1, 1000)),
            retention_interval=_num(env, "RELAY_RETENTION_INTERVAL", d.retention_interval, 0.05, 86400),
            retention_batch=int(_num(env, "RELAY_RETENTION_BATCH", d.retention_batch, 1, 10000)),
            ingest_host=env.get("RELAY_INGEST_HOST") or d.ingest_host,
            ingest_port=int(_num(env, "RELAY_INGEST_PORT", d.ingest_port, 1, 65535)),
            ingest_pool_size=int(_num(env, "RELAY_INGEST_POOL_SIZE", d.ingest_pool_size, 1, 200)),
            idempotency_window_hours=_num(
                env, "RELAY_IDEMPOTENCY_WINDOW_HOURS", d.idempotency_window_hours, 1, 24 * 30
            ),
        )
