"""End to end: the real worker, scheduler, reaper and publisher processes against real
PostgreSQL, real RabbitMQ and a real HTTPS chaos receiver, with faults injected by
killing or stopping processes at chosen moments.

Timings are shrunk (1 s request timeout, 2 s lease, sub-second retries) so a full
retry budget fits in a test; the code paths are the production ones."""

import asyncio
import signal
import subprocess
import sys
import time

import aio_pika
import pytest

from relay_dataplane.publisher import declare
from tests.e2e.conftest import HOST, wait_for


def endpoint_delivery(connect, factory, tenant, url):
    d = factory.delivery(tenant=tenant)
    with connect() as c:
        c.execute("UPDATE control.endpoints SET url = %s WHERE id = %s", (url, factory.row(d)["endpoint_id"]))
    return d


def statuses(connect, ids):
    with connect() as c:
        rows = c.execute(
            "SELECT id, status, attempt_count, last_error_class FROM delivery.deliveries WHERE id = ANY(%s)",
            (list(ids),),
        ).fetchall()
    return {r[0]: (r[1], r[2], r[3]) for r in rows}


def attempt_rows(connect, d):
    with connect() as c:
        return c.execute(
            "SELECT attempt_no, counted, outcome, error_class FROM delivery.delivery_attempts "
            "WHERE delivery_id = %s ORDER BY id",
            (d,),
        ).fetchall()


TERMINAL = {"succeeded", "dead"}


def test_all_processes_deliver_through_chaos(connect, factory, fleet, receiver):
    base = f"https://{HOST}:{receiver.port}"
    tenants = [factory.tenant() for _ in range(3)]
    plan = {}  # delivery id -> scenario

    def add(kind, path, n=1):
        for i in range(n):
            d = endpoint_delivery(connect, factory, tenants[i % len(tenants)], base + path)
            plan[d] = kind

    add("ok", "/ok", 12)
    add("flaky", "/flaky/2", 3)
    add("slow", "/slow-once", 2)
    add("retry_after", "/retry-after", 2)
    add("always_500", "/always/500")
    add("always_410", "/always/410")
    with connect() as c:  # a URL that passed endpoint validation once, but resolves to metadata now
        d = factory.delivery(tenant=tenants[0])
        c.execute(
            "UPDATE control.endpoints SET url = 'https://169.254.169.254/latest' WHERE id = %s",
            (factory.row(d)["endpoint_id"],),
        )
        plan[d] = "blocked"

    fleet.start_all(workers=2)
    wait_for(lambda: all(s[0] in TERMINAL for s in statuses(connect, plan).values()), 90, fleet, "all deliveries")
    final = statuses(connect, plan)
    codes = fleet.stop_all()

    expected = {
        "ok": ("succeeded", 1, None),
        "flaky": ("succeeded", 3, None),
        "slow": ("succeeded", 2, None),
        "retry_after": ("succeeded", 2, None),
        "always_500": ("dead", 12, "max_attempts"),
        "always_410": ("dead", 12, "max_attempts"),
        "blocked": ("dead", 1, "blocked_destination"),
    }
    for d, kind in plan.items():
        assert final[d] == expected[kind], (kind, final[d], fleet.logs())
        seen = receiver.for_delivery(str(d))
        # healthy run: every counted attempt reached the receiver exactly once, all signed correctly
        assert len(seen) == (0 if kind == "blocked" else final[d][1]), kind
        assert all(s.signature_ok for s in seen)
        assert len({s.message_id for s in seen}) <= 1  # one webhook-id across retries
    retry_after = [d for d, k in plan.items() if k == "retry_after"]
    for d in retry_after:
        first, second = receiver.for_delivery(str(d))
        assert second.at - first.at >= 0.9  # Retry-After: 1 was honoured
    assert set(codes.values()) == {0}, fleet.logs()  # every process shut down cleanly on SIGTERM


def test_worker_killed_mid_send_is_recovered_by_the_reaper(connect, factory, fleet, receiver):
    d = endpoint_delivery(connect, factory, factory.tenant(), f"https://{HOST}:{receiver.port}/hold/0.6")
    for role in ("scheduler", "publisher", "reaper"):
        fleet.start(role)
    victim = fleet.start("worker")
    assert receiver.arrived.wait(30), fleet.logs()
    victim.kill()  # SIGKILL while the request is in flight: no cleanup, no ack, nothing recorded
    victim.wait()
    receiver.arrived.clear()
    fleet.start("worker")  # a fresh worker picks up the reclaimed delivery
    wait_for(lambda: statuses(connect, [d])[d][0] in TERMINAL, 60, fleet, "recovery")

    assert statuses(connect, [d])[d] == ("succeeded", 2, None)
    outcomes = [(r[2], r[3]) for r in attempt_rows(connect, d)]
    assert outcomes == [("lease_expired", "lease_expired"), ("success", None)]
    # the documented at-least-once window: the receiver saw the same message twice
    seen = receiver.for_delivery(str(d))
    assert len(seen) == 2 and seen[0].message_id == seen[1].message_id


def test_sigterm_lets_a_send_in_progress_finish_and_be_recorded(connect, factory, fleet, receiver):
    d = endpoint_delivery(connect, factory, factory.tenant(), f"https://{HOST}:{receiver.port}/hold/0.7")
    for role in ("scheduler", "publisher", "reaper"):
        fleet.start(role)
    worker = fleet.start("worker")
    assert receiver.arrived.wait(30), fleet.logs()
    worker.send_signal(signal.SIGTERM)
    started = time.time()
    assert worker.wait(10) == 0, fleet.logs()
    assert time.time() - started < 5
    assert statuses(connect, [d])[d] == ("succeeded", 1, None)
    assert len(receiver.for_delivery(str(d))) == 1  # finished, not abandoned and re-sent


def test_a_lost_message_is_requeued_and_delivered(connect, factory, fleet, receiver, rabbit_url):
    d = endpoint_delivery(connect, factory, factory.tenant(), f"https://{HOST}:{receiver.port}/ok")
    for role in ("scheduler", "publisher", "reaper"):
        fleet.start(role)

    def published():
        with connect() as c:
            return c.execute(
                "SELECT count(*) FROM delivery.outbox WHERE delivery_id = %s AND published_at IS NOT NULL", (d,)
            ).fetchone()[0]

    wait_for(lambda: published() >= 1, 30, fleet, "first publish")

    async def purge():  # the broker loses the message
        conn = await aio_pika.connect_robust(rabbit_url)
        async with conn:
            q = await declare(await conn.channel(), fleet.queue)
            await q.purge()

    asyncio.run(purge())
    wait_for(lambda: published() >= 2, 30, fleet, "requeue and republish")  # after the 3 s queue timeout
    fleet.start("worker")
    wait_for(lambda: statuses(connect, [d])[d][0] in TERMINAL, 30, fleet, "delivery")

    assert statuses(connect, [d])[d] == ("succeeded", 1, None)  # the lost message used no attempt
    assert [(r[2], r[3]) for r in attempt_rows(connect, d)] == [("deferred", "queue_timeout"), ("success", None)]
    assert len(receiver.for_delivery(str(d))) == 1


@pytest.mark.parametrize(
    ("role", "drop", "add"),
    [
        ("worker", "RELAY_SECRET_KEYS", {}),
        ("scheduler", "RELAY_DSN", {}),
        ("worker", None, {"RELAY_ALLOW_PRIVATE_TARGETS": "perhaps"}),
        ("reaper", None, {"RELAY_QUEUE_TIMEOUT": "0"}),
    ],
)
def test_bad_configuration_exits_with_code_2(fleet, role, drop, add):
    env = fleet.env(role) | add
    env.pop(drop or "", None)
    p = subprocess.run(
        [sys.executable, "-m", "relay_dataplane", role], env=env, capture_output=True, text=True, timeout=30
    )
    assert p.returncode == 2, p.stderr
    assert "configuration error" in p.stderr
