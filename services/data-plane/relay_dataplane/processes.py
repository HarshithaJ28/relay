"""The long-running data-plane processes: worker, scheduler, reaper and publisher.

Each runs until `stop` is set (SIGTERM or SIGINT in production) and survives
database and broker outages by reconnecting with capped backoff. None of them
holds state that matters across a crash: PostgreSQL is the source of truth, so
a killed process loses at most work that the reaper hands out again.

Worker acknowledgement rule: a message is acked only after handle_message has
returned, which means the database has recorded the outcome (or the message was
a duplicate). If handling fails unexpectedly the message is rejected without
requeue, so one bad message cannot loop through the queue; the delivery is not
lost, because the reaper requeues queued deliveries whose message is never
claimed (requeue_stale) and reclaims claimed ones whose lease expires.
"""

import asyncio
import contextlib
import json
import logging
import random
from datetime import timedelta

import aio_pika
import psycopg
import psycopg_pool
from psycopg_pool import AsyncConnectionPool

from . import retention
from .claim import parse_message
from .destination import DestinationPolicy
from .endpoint_secrets import Keyring
from .http_sender import HttpSender
from .publisher import declare, publish_some
from .settings import Settings
from .transform import TransformClient
from .worker import WorkerConfig, handle_message

log = logging.getLogger("relay")

MAX_BACKOFF = 30.0


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
                # Ingestion sends NOTIFY relay_dispatch on commit. Waking on it lowers latency;
                # polling every tick remains the guarantee (a notification can be missed).
                await db.execute("LISTEN relay_dispatch")
                while not stop.is_set():
                    dispatched, tenants = await dispatch_pass(db, s)
                    if dispatched:
                        log.info("scheduler dispatched=%d tenants=%d", dispatched, tenants)
                    else:
                        async for _ in db.notifies(timeout=s.scheduler_tick, stop_after=1):
                            pass
        except (psycopg.OperationalError, OSError) as e:
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
                while not stop.is_set():
                    cur = await db.execute("SELECT delivery.reclaim_expired(%s)", (s.reap_batch,))
                    reclaimed = (await cur.fetchone())[0]
                    cur = await db.execute("SELECT delivery.requeue_stale(%s, %s)", (queue_timeout, s.reap_batch))
                    requeued = (await cur.fetchone())[0]
                    if reclaimed or requeued:
                        log.info("reaper reclaimed=%d requeued=%d", reclaimed, requeued)
                    if reclaimed < s.reap_batch and requeued < s.reap_batch:
                        await wait_or_stop(stop, s.reaper_interval)
        except (psycopg.OperationalError, OSError) as e:
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
                while not stop.is_set():
                    r = await retention.run_pass(db, margin, s.retention_batch)
                    log.info(
                        "retention expired=%d attempts=%d deliveries=%d events=%d keys=%d "
                        "relay_retention_blocked_events=%d relay_retention_lag_seconds=%.0f",
                        r.expired,
                        r.attempts_deleted,
                        r.deliveries_deleted,
                        r.events_deleted,
                        r.keys_deleted,
                        r.blocked_events,
                        r.lag_seconds,
                    )
                    await wait_or_stop(stop, s.retention_interval)
        except (psycopg.OperationalError, OSError) as e:
            log.warning("retention database error, reconnecting: %s", type(e).__name__)
            await wait_or_stop(stop, retry.next())


# ---------------------------------------------------------------- publisher


async def run_publisher(s: Settings, stop: asyncio.Event) -> None:
    """Publish outbox rows with confirms; mark them only after the broker confirms (AC-1)."""
    retry = Backoff()
    while not stop.is_set():
        try:
            connection = await aio_pika.connect_robust(s.amqp_url)
            async with connection:
                channel = await connection.channel(publisher_confirms=True)
                await declare(channel, s.queue)
                with psycopg.connect(s.dsn, autocommit=False) as db:
                    retry.reset()
                    while not stop.is_set():
                        n = await publish_some(channel, db, s.queue, s.publish_batch)
                        if n:
                            log.info("publisher published=%d", n)
                        if n < s.publish_batch:
                            await wait_or_stop(stop, s.publisher_tick)
        except (psycopg.OperationalError, aio_pika.exceptions.AMQPError, OSError) as e:
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
                async with sender, transformer or contextlib.nullcontext():
                    connection = await aio_pika.connect_robust(s.amqp_url)  # reconnects and re-consumes itself
                    async with connection:
                        retry.reset()
                        await _consume(s, stop, connection, pool, sender, keyring, config, transformer)
        except (psycopg.OperationalError, psycopg_pool.PoolTimeout, aio_pika.exceptions.AMQPError, OSError) as e:
            log.warning("worker error, reconnecting: %s", type(e).__name__)
            await wait_or_stop(stop, retry.next())


async def process_message(message, pool, sender, keyring: Keyring, config: WorkerConfig, transformer=None) -> None:
    """Handle one queue message. Ack only after the database holds the outcome."""
    try:
        parse_message(message.body)
    except (ValueError, KeyError, TypeError):
        log.warning("worker dropped a malformed message")
        await message.ack()  # can never be valid; nothing in the database refers to it
        return
    try:
        async with pool.connection() as db:
            handled = await handle_message(db, message.body, sender, keyring, config, transformer=transformer)
    except Exception as e:
        log.error("worker failed to handle a message: %s", type(e).__name__)
        await message.reject(requeue=False)  # the reaper hands the delivery out again
        return
    try:
        await message.ack()  # only now: the database already holds the outcome
    except aio_pika.exceptions.AMQPError:
        # channel lost after the outcome was recorded: the broker redelivers, and the
        # redelivered message is a duplicate that claim_delivery rejects
        log.warning("worker could not ack (channel closed)")
    log.info(
        "worker delivery=%s result=%s attempt=%s error=%s",
        handled.delivery_id,
        handled.result,
        handled.attempt_no,
        handled.error_class,
    )


async def _consume(s, stop, connection, pool: AsyncConnectionPool, sender, keyring, config, transformer) -> None:
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=s.concurrency)
    queue = await declare(channel, s.queue)
    in_flight: set[asyncio.Task] = set()

    async def on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        task = asyncio.current_task()
        in_flight.add(task)
        try:
            await process_message(message, pool, sender, keyring, config, transformer)
        finally:
            in_flight.discard(task)

    tag = await queue.consume(on_message, no_ack=False)
    log.info("worker consuming queue=%s concurrency=%d", s.queue, s.concurrency)
    await stop.wait()

    # Graceful shutdown: stop taking messages, let sends in progress finish and be recorded.
    with contextlib.suppress(Exception):
        await queue.cancel(tag)
    if in_flight:
        log.info("worker waiting for %d message(s) in progress", len(in_flight))
        _, pending = await asyncio.wait(set(in_flight), timeout=s.shutdown_grace)
        for task in pending:  # unacked: the broker redelivers; the lease expires and the reaper reclaims
            task.cancel()


def _log_config(name: str, s: Settings) -> None:
    safe = {k: v for k, v in vars(s).items() if k not in ("dsn", "amqp_url")}
    log.info("%s starting %s", name, json.dumps(safe, sort_keys=True))
