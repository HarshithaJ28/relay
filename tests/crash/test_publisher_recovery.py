"""AC-1: the publisher process is really killed at each crash
window, against real PostgreSQL and RabbitMQ. No delivery may be lost, a
republish must carry the same token, and a duplicate message may claim at most once."""

import asyncio
import json
import os
import subprocess
import sys
import uuid

import aio_pika
import pytest

from relay_dataplane.claim import claim_from_message
from relay_dataplane.publisher import declare, dlq_name

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def run_publisher(dsn, amqp, queue, crash_at=None, n=1):
    env = {
        **os.environ,
        "RELAY_DSN": dsn + " user=relay_publisher",
        "RELAY_AMQP": amqp,
        "RELAY_QUEUE": queue,
        "PYTHONPATH": os.path.join(ROOT, "services", "data-plane"),
    }
    if crash_at:
        env["RELAY_CRASH_AT"] = crash_at
    procs = [
        subprocess.Popen(
            [sys.executable, "-m", "relay_dataplane.publisher"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        for _ in range(n)
    ]
    return [(p.wait(timeout=60), p.stderr.read().decode()) for p in procs]


def drain(amqp, queue) -> list[dict]:
    async def go():
        conn = await aio_pika.connect_robust(amqp)
        async with conn:
            ch = await conn.channel()
            q = await declare(ch, queue)
            out = []
            while (m := await q.get(fail=False, timeout=5)) is not None:
                out.append(json.loads(m.body))
                await m.ack()
            return out

    return asyncio.run(go())


@pytest.fixture
def queue(rabbit_url):
    name = f"relay.test.{uuid.uuid4().hex[:8]}"
    yield name

    async def rm():
        conn = await aio_pika.connect_robust(rabbit_url)
        async with conn:
            ch = await conn.channel()
            await ch.queue_delete(name)
            await ch.queue_delete(dlq_name(name))

    asyncio.run(rm())


def dispatched(connect, factory, count=1):
    tenant = factory.tenant()
    ids = [factory.delivery(tenant=tenant) for _ in range(count)]
    with connect("relay_scheduler") as c:
        assert c.execute("SELECT delivery.dispatch_batch(%s, 100)", (tenant,)).fetchone()[0] == count
    return ids


def outbox_state(connect):
    with connect("postgres") as c:
        return c.execute(
            "SELECT delivery_id, dispatch_seq, published_at IS NOT NULL, dispatch_token "
            "FROM delivery.outbox ORDER BY id"
        ).fetchall()


def claim_all(connect, messages):
    """Feed every queue message to a worker; return the number of successful claims per delivery."""
    wins = {}
    with connect("relay_worker") as c:
        for m in messages:
            res = claim_from_message(c, json.dumps(m).encode())
            if res:
                wins[m["delivery_id"]] = wins.get(m["delivery_id"], 0) + 1
    return wins


def test_normal_publish_clears_token_after_confirm(connect, factory, pg_dsn, rabbit_url, queue):
    (d,) = dispatched(connect, factory)
    [(code, _)] = run_publisher(pg_dsn, rabbit_url, queue)
    assert code == 0
    [(_did, _seq, published, token)] = outbox_state(connect)
    assert published and token is None  # raw token gone once the broker confirmed
    msgs = drain(rabbit_url, queue)
    assert len(msgs) == 1 and msgs[0]["delivery_id"] == str(d)


def test_crash_before_publish_loses_nothing(connect, factory, pg_dsn, rabbit_url, queue):
    (d,) = dispatched(connect, factory)
    [(code, _)] = run_publisher(pg_dsn, rabbit_url, queue, crash_at="before_publish")
    assert code == 137
    [(_, _, published, token)] = outbox_state(connect)
    assert not published and token is not None  # token must survive for recovery
    assert drain(rabbit_url, queue) == []
    [(code, _)] = run_publisher(pg_dsn, rabbit_url, queue)
    assert code == 0
    assert claim_all(connect, drain(rabbit_url, queue)) == {str(d): 1}


def test_crash_after_confirm_before_mark_republishes_same_token_and_claims_once(
    connect, factory, pg_dsn, rabbit_url, queue
):
    (d,) = dispatched(connect, factory)
    [(code, _)] = run_publisher(pg_dsn, rabbit_url, queue, crash_at="after_publish_before_mark")
    assert code == 137
    [(_, _seq, published, token_before)] = outbox_state(connect)
    assert not published and token_before is not None  # AC-1: cleanup did not clear it
    [(code, _)] = run_publisher(pg_dsn, rabbit_url, queue)
    assert code == 0
    msgs = drain(rabbit_url, queue)
    assert len(msgs) == 2  # at-least-once: a duplicate exists
    assert msgs[0] == msgs[1]  # same delivery, same dispatch_seq, same token
    assert msgs[0]["dispatch_token"] == bytes(token_before).hex()
    assert claim_all(connect, msgs) == {str(d): 1}  # the claim step absorbs the duplicate
    with connect("postgres") as c:
        assert c.execute("SELECT status FROM delivery.deliveries WHERE id=%s", (d,)).fetchone()[0] == "in_flight"
    [(_, _, published, token)] = outbox_state(connect)
    assert published and token is None


def test_crash_mid_batch_loses_no_delivery_and_none_stay_queued_unclaimed(connect, factory, pg_dsn, rabbit_url, queue):
    ids = dispatched(connect, factory, count=5)
    [(code, _)] = run_publisher(pg_dsn, rabbit_url, queue, crash_at="mid_batch")
    assert code == 137
    state = outbox_state(connect)
    assert 0 < sum(1 for r in state if r[2]) < 5  # genuinely partway through
    [(code, _)] = run_publisher(pg_dsn, rabbit_url, queue)
    assert code == 0
    msgs = drain(rabbit_url, queue)
    wins = claim_all(connect, msgs)
    assert set(wins) == {str(i) for i in ids}  # every delivery reached a worker
    assert set(wins.values()) == {1}  # and was claimed exactly once
    assert all(r[2] and r[3] is None for r in outbox_state(connect))
    with connect("postgres") as c:
        assert c.execute("SELECT count(*) FROM delivery.deliveries WHERE status='queued'").fetchone()[0] == 0


def test_two_publishers_at_once_publish_everything(connect, factory, pg_dsn, rabbit_url, queue):
    ids = dispatched(connect, factory, count=30)
    results = run_publisher(pg_dsn, rabbit_url, queue, n=2)
    assert all(code == 0 for code, _ in results), results
    msgs = drain(rabbit_url, queue)
    assert {m["delivery_id"] for m in msgs} == {str(i) for i in ids}
    assert len(msgs) == 30  # SKIP LOCKED: no duplicates in the no-crash case
    assert set(claim_all(connect, msgs).values()) == {1}


def test_full_cycle_with_stalled_worker_after_publisher_crash(connect, factory, pg_dsn, rabbit_url, queue):
    """Publisher crash + duplicate message + stalled worker, end to end."""
    (d,) = dispatched(connect, factory)
    run_publisher(pg_dsn, rabbit_url, queue, crash_at="after_publish_before_mark")
    run_publisher(pg_dsn, rabbit_url, queue)
    m1, m2 = drain(rabbit_url, queue)
    with connect("relay_worker") as c:
        first = claim_from_message(c, json.dumps(m1).encode())
        assert first and claim_from_message(c, json.dumps(m2).encode()) is None
        _row, lease = first
        with connect("postgres") as su:
            su.execute("UPDATE delivery.deliveries SET lease_until = now() - interval '1 minute' WHERE id=%s", (d,))
        with connect("relay_reaper") as r:
            assert r.execute("SELECT delivery.reclaim_expired(10)").fetchone()[0] == 1
        # the stalled worker wakes up: its result is fenced out
        assert (
            c.execute("SELECT delivery.record_attempt(%s,%s,'success',200,NULL,NULL)", (d, lease)).fetchone()[0] is None
        )
    with connect("postgres") as su:
        st = su.execute("SELECT status, attempt_count FROM delivery.deliveries WHERE id=%s", (d,)).fetchone()
    assert st == ("scheduled", 1)
