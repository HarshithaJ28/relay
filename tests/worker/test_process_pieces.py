"""Pieces of the long-running processes tested directly: the worker's ack rule and
one scheduler pass. (tests/e2e runs the whole processes.)"""

import asyncio
import contextlib

import psycopg

from relay_dataplane.outcome import SendResult
from relay_dataplane.processes import dispatch_pass, process_message
from relay_dataplane.settings import Settings
from relay_dataplane.worker import WorkerConfig
from tests.conftest import TEST_KEYRING
from tests.worker.test_worker_core import ScriptedSender, queue_message


class FakeMessage:
    """Records ack/reject, and the delivery's status in the database at the moment of each call."""

    def __init__(self, body, status_of=None):
        self.body, self.status_of, self.calls = body, status_of, []

    async def ack(self):
        self.calls.append(("ack", self.status_of() if self.status_of else None))

    async def reject(self, requeue=True):
        self.calls.append(("reject", requeue))


class OnePool:
    def __init__(self, dsn, fail=False):
        self.dsn, self.fail = dsn, fail

    @contextlib.asynccontextmanager
    async def connection(self):
        if self.fail:
            raise psycopg.OperationalError("database unavailable")
        async with await psycopg.AsyncConnection.connect(self.dsn, autocommit=True) as conn:
            yield conn


def test_ack_happens_only_after_the_outcome_is_recorded(pg_dsn, connect, factory):
    d = factory.delivery()
    msg = FakeMessage(queue_message(connect, factory, d), status_of=lambda: factory.row(d)["status"])
    sender = ScriptedSender(SendResult(200))
    asyncio.run(process_message(msg, OnePool(f"{pg_dsn} user=relay_worker"), sender, TEST_KEYRING, WorkerConfig()))
    assert msg.calls == [("ack", "succeeded")]  # at ack time the database already said succeeded


def test_a_failure_is_requeued_and_never_acked(pg_dsn, connect, factory):
    d = factory.delivery()
    msg = FakeMessage(queue_message(connect, factory, d))
    pool = OnePool(f"{pg_dsn} user=relay_worker", fail=True)
    asyncio.run(process_message(msg, pool, ScriptedSender(), TEST_KEYRING, WorkerConfig()))
    assert msg.calls == [("reject", True)]  # retried; the queue's delivery limit dead-letters a poison message
    assert factory.row(d)["status"] == "queued"  # untouched; the reaper's queue timeout takes it from here


def test_a_malformed_message_goes_to_the_dead_letter_queue(pg_dsn):
    for body in (b"not json", b"{}", b'{"delivery_id": "x", "dispatch_seq": 1, "dispatch_token": "zz"}'):
        msg = FakeMessage(body)
        sender = ScriptedSender()
        asyncio.run(process_message(msg, OnePool(pg_dsn, fail=True), sender, TEST_KEYRING, WorkerConfig()))
        assert msg.calls == [("reject", False)] and sender.calls == []


def test_one_scheduler_pass_serves_every_tenant_with_due_work(pg_dsn, factory):
    tenants = [factory.tenant() for _ in range(3)]
    for t in tenants:
        factory.delivery(tenant=t)
        factory.delivery(tenant=t)

    async def go():
        async with await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_scheduler", autocommit=True) as db:
            return await dispatch_pass(db, Settings("x", "y")), await dispatch_pass(db, Settings("x", "y"))

    first, second = asyncio.run(go())
    assert first == (6, 3)
    assert second == (0, 0)


# ---------------------------------------------------------------- dead-letter queue, against real RabbitMQ


def test_dead_letter_queue_receives_malformed_and_poison_messages(pg_dsn, rabbit_url):
    import uuid

    import aio_pika

    from relay_dataplane.publisher import declare, dlq_name

    name = f"relay.test.{uuid.uuid4().hex[:8]}"
    poison = b'{"delivery_id": "00000000-0000-0000-0000-000000000001", "dispatch_seq": 1, "dispatch_token": "00"}'

    async def go():
        conn = await aio_pika.connect_robust(rabbit_url)
        async with conn:
            ch = await conn.channel()
            q = await declare(ch, name, delivery_limit=2)
            for body in (b"not json", poison):
                await ch.default_exchange.publish(aio_pika.Message(body), routing_key=name)
            deliveries = 0
            broken = OnePool(pg_dsn, fail=True)  # every attempt to handle the poison message fails
            while deliveries < 10 and (m := await q.get(fail=False, timeout=5)) is not None:
                deliveries += 1  # bounded: without a delivery limit the poison message would loop forever
                await process_message(m, broken, ScriptedSender(), TEST_KEYRING, WorkerConfig())
                await asyncio.sleep(0.2)
            dlq = await ch.declare_queue(dlq_name(name), passive=True)
            dead = []
            while (m := await dlq.get(fail=False, timeout=5)) is not None:
                dead.append(m.body)
                await m.ack()
            await ch.queue_delete(name)
            await ch.queue_delete(dlq_name(name))
            return deliveries, dead

    deliveries, dead = asyncio.run(go())
    assert sorted(dead) == sorted([b"not json", poison])  # nothing is lost, nothing loops forever
    assert deliveries == 1 + 3  # malformed once; poison first delivery plus 2 redeliveries, then dead-lettered
