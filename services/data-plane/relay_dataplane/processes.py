"""The long-running data-plane processes: worker, scheduler, reaper and publisher.

Each runs until `stop` is set (SIGTERM or SIGINT in production) and survives
database and broker outages by reconnecting with capped backoff. None of them
holds state that matters across a crash: PostgreSQL is the source of truth, so
a killed process loses at most work that the reaper hands out again.

Worker acknowledgement rule: a message is acked only after handle_message has
returned, which means the database has recorded the outcome (or the message was
a duplicate). If handling fails unexpectedly the message is requeued; the queue's
delivery limit dead-letters one that keeps failing, so a poison message cannot
loop forever. A malformed message goes straight to the dead-letter queue. The
delivery is never lost either way: the reaper requeues queued deliveries whose
message is never claimed (requeue_stale) and reclaims claimed ones whose lease expires.
"""

import asyncio
import contextlib
import json
import logging
import random
import time
from datetime import timedelta

import aio_pika
import aiormq.exceptions
import psycopg
import psycopg_pool
import valkey.asyncio
from psycopg_pool import AsyncConnectionPool

from . import observability as obs
from . import retention
from .breaker import BreakerConfig, CircuitBreaker
from .claim import parse_message
from .destination import DestinationPolicy
from .endpoint_secrets import Keyring
from .http_sender import HttpSender
from .live import LivePublisher
from .publisher import declare, dlq_name, publish_some
from .settings import Settings
from .transform import TransformClient
from .worker import WorkerConfig, handle_message

log = logging.getLogger("relay")

MAX_BACKOFF = 30.0
HEALTH = obs.Health()  # one per process: the main loop beats it, connections set readiness

# Everything a broker call can raise when the broker or the channel goes away. aio-pika
# reports a closed channel as ChannelInvalidStateError, a RuntimeError, not an AMQPError.
BROKER_ERRORS = (aio_pika.exceptions.AMQPError, aiormq.exceptions.ChannelInvalidStateError)


async def wait_or_stop(stop: asyncio.Event, seconds: float) -> bool:
    """Sleep up to `seconds`; return True if stop was set meanwhile."""
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
        return True
    except TimeoutError:
        return False


class Backoff:
    """Capped exponential backoff with jitter for reconnect loops."""

    def __init__(self, first: float = 0.5, cap: float = MAX_BACKOFF):
        self.first, self.cap, self.current = first, cap, first

    def next(self) -> float:
        delay = random.uniform(self.current / 2, self.current)
        self.current = min(self.cap, self.current * 2)
        return delay

    def reset(self) -> None:
        self.current = self.first


# ---------------------------------------------------------------- scheduler


async def dispatch_pass(db: psycopg.AsyncConnection, s: Settings) -> tuple[int, int]:
    """One pass over every tenant with due work (up to tenants_per_pass). Returns (dispatched, tenants)."""
    cur = await db.execute("SELECT * FROM delivery.due_tenants(%s)", (s.tenants_per_pass,))
    tenants = [r[0] for r in await cur.fetchall()]
    dispatched = 0
    for tenant in tenants:
        cur = await db.execute("SELECT delivery.dispatch_batch(%s, %s)", (tenant, s.dispatch_batch))
        dispatched += (await cur.fetchone())[0]
    return dispatched, len(tenants)


async def run_scheduler(s: Settings, stop: asyncio.Event) -> None:
    """Move due deliveries to queued, tenant by tenant (dispatch_batch locks one tenant at a time)."""
    retry = Backoff()
    while not stop.is_set():
        try:
            async with await psycopg.AsyncConnection.connect(s.dsn, autocommit=True) as db:
                retry.reset()
                HEALTH.ready = True
                # Ingestion sends NOTIFY relay_dispatch on commit. Waking on it lowers latency;
                # polling every tick remains the guarantee (a notification can be missed).
                await db.execute("LISTEN relay_dispatch")
                while not stop.is_set():
                    HEALTH.beat()
                    dispatched, tenants = await dispatch_pass(db, s)
                    obs.DISPATCHED.inc(dispatched)
                    if dispatched:
                        log.info("scheduler dispatched=%d tenants=%d", dispatched, tenants)
                    else:
                        async for _ in db.notifies(timeout=s.scheduler_tick, stop_after=1):
                            pass
        except (psycopg.OperationalError, OSError) as e:
            HEALTH.ready = False
            log.warning("scheduler database error, reconnecting: %s", type(e).__name__)
            await wait_or_stop(stop, retry.next())


# ---------------------------------------------------------------- reaper


async def run_reaper(s: Settings, stop: asyncio.Event) -> None:
    """Reclaim expired leases and requeue deliveries whose message was lost."""
    retry = Backoff()
    queue_timeout = timedelta(seconds=s.queue_timeout)
    while not stop.is_set():
        try:
            async with await psycopg.AsyncConnection.connect(s.dsn, autocommit=True) as db:
                retry.reset()
                HEALTH.ready = True
                while not stop.is_set():
                    cur = await db.execute("SELECT delivery.reclaim_expired(%s)", (s.reap_batch,))
                    HEALTH.beat()
                    reclaimed = (await cur.fetchone())[0]
                    obs.RECLAIMED.inc(reclaimed)
                    cur = await db.execute("SELECT delivery.requeue_stale(%s, %s)", (queue_timeout, s.reap_batch))
                    requeued = (await cur.fetchone())[0]
                    obs.REQUEUED.inc(requeued)
                    if reclaimed or requeued:
                        log.info("reaper reclaimed=%d requeued=%d", reclaimed, requeued)
                    if reclaimed < s.reap_batch and requeued < s.reap_batch:
                        await wait_or_stop(stop, s.reaper_interval)
        except (psycopg.OperationalError, OSError) as e:
            HEALTH.ready = False
            log.warning("reaper database error, reconnecting: %s", type(e).__name__)
            await wait_or_stop(stop, retry.next())


# ---------------------------------------------------------------- retention


async def run_retention(s: Settings, stop: asyncio.Event) -> None:
    """Delete expired data per tenant; enforce the AC-3 ceiling. Raises ValueError at start if unsafe."""
    margin = retention.ceiling_margin(timedelta(seconds=s.max_deferral_age))
    async with await psycopg.AsyncConnection.connect(s.dsn, autocommit=True) as db:
        await retention.check_retention_covers_retries(db, margin)  # configuration error: do not start
    retry = Backoff()
    while not stop.is_set():
        try:
            async with await psycopg.AsyncConnection.connect(s.dsn, autocommit=True) as db:
                retry.reset()
                HEALTH.ready = True
                last_orphan_check = 0.0
                while not stop.is_set():
                    HEALTH.beat()
                    await retention.flush_usage(db)  # before anything is deleted
                    r = await retention.run_pass(db, margin, s.retention_batch)
                    await retention.maintain_partitions(db, r)
                    if time.monotonic() - last_orphan_check >= s.orphan_interval:
                        r.orphans = await retention.orphan_report(db)
                        last_orphan_check = time.monotonic()
                    log.info(
                        "retention expired=%d attempts=%d deliveries=%d events=%d keys=%d outbox=%d "
                        "partitions_created=%d partitions_dropped=%s "
                        "relay_retention_blocked_events=%d relay_retention_lag_seconds=%.0f",
                        r.expired,
                        r.attempts_deleted,
                        r.deliveries_deleted,
                        r.events_deleted,
                        r.keys_deleted,
                        r.outbox_deleted,
                        r.partitions_created,
                        r.partitions_dropped,
                        r.blocked_events,
                        r.lag_seconds,
                    )
                    record_retention_metrics(r)
                    if r.partitions_skipped:
                        log.warning(
                            "retention could not drop expired partitions %s: deliveries still refer to them",
                            r.partitions_skipped,
                        )
                    if r.orphans and any(r.orphans.values()):
                        log.warning("orphan report found rows that should not exist: %s", r.orphans)
                    await wait_or_stop(stop, s.retention_interval)
        except (psycopg.OperationalError, OSError) as e:
            HEALTH.ready = False
            log.warning("retention database error, reconnecting: %s", type(e).__name__)
            await wait_or_stop(stop, retry.next())


# ---------------------------------------------------------------- publisher


async def run_publisher(s: Settings, stop: asyncio.Event) -> None:
    """Publish outbox rows with confirms; mark them only after the broker confirms (AC-1)."""
    retry = Backoff()
    backlog_sampled = 0.0
    while not stop.is_set():
        try:
            connection = await aio_pika.connect_robust(s.amqp_url)
            async with connection:
                channel = await connection.channel(publisher_confirms=True)
                await declare(channel, s.queue)
                with psycopg.connect(s.dsn, autocommit=False) as db:
                    retry.reset()
                    HEALTH.ready = True
                    while not stop.is_set():
                        HEALTH.beat()
                        n = await publish_some(channel, db, s.queue, s.publish_batch)
                        obs.PUBLISHED.inc(n)
                        if time.monotonic() - backlog_sampled >= 10:
                            obs.OUTBOX_UNPUBLISHED.set(
                                db.execute(
                                    "SELECT count(*) FROM delivery.outbox WHERE published_at IS NULL"
                                ).fetchone()[0]
                            )
                            db.commit()
                            backlog_sampled = time.monotonic()
                        if n:
                            log.info("publisher published=%d", n)
                        if n < s.publish_batch:
                            await wait_or_stop(stop, s.publisher_tick)
        except (psycopg.OperationalError, *BROKER_ERRORS, OSError) as e:
            HEALTH.ready = False
            log.warning("publisher error, reconnecting: %s", type(e).__name__)
            await wait_or_stop(stop, retry.next())


# ---------------------------------------------------------------- worker


async def run_worker(
    s: Settings,
    stop: asyncio.Event,
    keyring: Keyring,
    policy: DestinationPolicy,
    sender_factory=None,  # tests may pass one; production uses HttpSender with the system trust store
) -> None:
    config = WorkerConfig(
        request_timeout=s.request_timeout,
        lease_margin=s.lease_margin,
        retry_base=s.retry_base,
        retry_cap=s.retry_cap,
        transform_retry_delay=s.transform_retry_delay,
        max_deferral_age=s.max_deferral_age,
    )
    retry = Backoff()
    while not stop.is_set():
        try:
            # one connection per concurrent message; the pool checks and replaces broken ones
            async with AsyncConnectionPool(
                s.dsn,
                min_size=s.concurrency,
                max_size=s.concurrency,
                kwargs={"autocommit": True},
                check=AsyncConnectionPool.check_connection,
                open=False,
            ) as pool:
                await pool.wait(timeout=30)
                sender = sender_factory() if sender_factory else HttpSender(policy, max_connections=s.concurrency)
                transformer = TransformClient(s.transform_url, s.transform_timeout) if s.transform_url else None
                breaker, live = make_breaker(s)
                async with sender, transformer or contextlib.nullcontext():
                    connection = await aio_pika.connect_robust(s.amqp_url)  # reconnects and re-consumes itself
                    async with connection:
                        retry.reset()
                        HEALTH.ready = True
                        await _consume(s, stop, connection, pool, sender, keyring, config, transformer, breaker, live)
        except (psycopg.OperationalError, psycopg_pool.PoolTimeout, *BROKER_ERRORS, OSError) as e:
            HEALTH.ready = False
            log.warning("worker error, reconnecting: %s", type(e).__name__)
            await wait_or_stop(stop, retry.next())


async def process_message(
    message, pool, sender, keyring: Keyring, config: WorkerConfig, transformer=None, breaker=None, live=None
) -> None:
    """Handle one queue message. Ack only after the database holds the outcome."""
    try:
        parse_message(message.body)
    except (ValueError, KeyError, TypeError):
        log.warning("worker dead-lettered a malformed message")
        await _settle(message.reject(requeue=False))  # can never be valid: to the dead-letter queue
        return
    try:
        async with pool.connection() as db:
            handled = await handle_message(
                db, message.body, sender, keyring, config, transformer=transformer, breaker=breaker, live=live
            )
    except Exception as e:
        log.error("worker failed to handle a message: %s", type(e).__name__)
        # Try again (another worker, or after the database recovers). A message that keeps
        # failing passes the queue's delivery limit and is dead-lettered; the delivery itself
        # is still safe in PostgreSQL, where the reaper returns it to scheduled.
        await _settle(message.reject(requeue=True))
        return
    # Only now: the database already holds the outcome. If the channel is gone the broker
    # redelivers the message, and the redelivered copy is a duplicate that the claim rejects.
    await _settle(message.ack())
    log.info(
        "worker delivery=%s result=%s attempt=%s error=%s",
        handled.delivery_id,
        handled.result,
        handled.attempt_no,
        handled.error_class,
    )


async def _sample_queues(channel, name: str, every: float = 15.0) -> None:
    """Heartbeat for the worker, and how many messages wait in its queue and dead-letter queue."""
    while True:
        HEALTH.beat()
        for queue in (name, dlq_name(name)):
            try:
                declared = await channel.declare_queue(queue, passive=True)
                obs.QUEUE_MESSAGES.labels(queue).set(declared.declaration_result.message_count)
            except BROKER_ERRORS:
                pass
        await asyncio.sleep(every)


def record_retention_metrics(r) -> None:
    obs.RETENTION_BLOCKED.set(r.blocked_events)
    obs.RETENTION_LAG.set(r.lag_seconds)
    obs.PARTITIONS_SKIPPED.set(len(r.partitions_skipped))
    for kind, n in (
        ("attempts", r.attempts_deleted),
        ("deliveries", r.deliveries_deleted),
        ("events", r.events_deleted),
        ("idempotency_keys", r.keys_deleted),
        ("outbox", r.outbox_deleted),
        ("expired_to_dead", r.expired),
    ):
        obs.RETENTION_DELETED.labels(kind).inc(n)
    for kind, n in (r.orphans or {}).items():
        obs.ORPHANS.labels(kind).set(n)


async def _settle(call) -> None:
    """Ack or reject; a channel that closed meanwhile is not an error (the broker redelivers)."""
    try:
        await call
    except BROKER_ERRORS:
        log.warning("worker could not settle a message (channel closed); the broker will redeliver it")


async def _consume(
    s, stop, connection, pool: AsyncConnectionPool, sender, keyring, config, transformer, breaker, live
) -> None:
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=s.concurrency)
    queue = await declare(channel, s.queue)
    in_flight: set[asyncio.Task] = set()

    async def on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        task = asyncio.current_task()
        in_flight.add(task)
        try:
            await process_message(message, pool, sender, keyring, config, transformer, breaker, live)
        finally:
            in_flight.discard(task)

    tag = await queue.consume(on_message, no_ack=False)
    sampler = asyncio.ensure_future(_sample_queues(channel, s.queue))
    log.info("worker consuming queue=%s concurrency=%d", s.queue, s.concurrency)
    await stop.wait()
    sampler.cancel()

    # Graceful shutdown: stop taking messages, let sends in progress finish and be recorded.
    with contextlib.suppress(Exception):
        await queue.cancel(tag)
    if in_flight:
        log.info("worker waiting for %d message(s) in progress", len(in_flight))
        _, pending = await asyncio.wait(set(in_flight), timeout=s.shutdown_grace)
        for task in pending:  # unacked: the broker redelivers; the lease expires and the reaper reclaims
            task.cancel()


def make_breaker(s: Settings) -> tuple[CircuitBreaker | None, LivePublisher | None]:
    """The circuit breaker and live updates; both need Valkey and are off without it."""
    if not s.valkey_url:
        return None, None
    client = valkey.asyncio.Valkey.from_url(s.valkey_url, socket_timeout=1, socket_connect_timeout=1)
    breaker = CircuitBreaker(
        client,
        BreakerConfig(
            window=s.breaker_window,
            bucket=max(s.breaker_window / 12, 0.1),
            min_volume=s.breaker_min_volume,
            threshold=s.breaker_threshold,
            base_cooldown=s.breaker_cooldown,
            max_cooldown=max(s.breaker_max_cooldown, s.breaker_cooldown),
        ),
    )
    return breaker, LivePublisher(client)


def _log_config(name: str, s: Settings) -> None:
    safe = {k: v for k, v in vars(s).items() if k not in ("dsn", "amqp_url", "valkey_url")}
    log.info("%s starting %s", name, json.dumps(safe, sort_keys=True))
