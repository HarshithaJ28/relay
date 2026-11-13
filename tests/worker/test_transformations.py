"""AC-2: transformation failures, with a real HTTP runner double and the real database.

- The runner confirms the expression failed (expression_error, limit_exceeded): dead, nothing sent.
- The runner is unavailable in any way (hangs past the RPC timeout, refuses, resets, 5xx,
  malformed or unattributable answers): deferred, no attempt used, nothing sent, never dead.
- After the runner recovers, the same delivery is transformed and delivered.
- A deferral run longer than the maximum deferral age starts counting as attempts.
"""

import asyncio
import contextlib
import json
import socket
from datetime import timedelta

import psycopg
import pytest
from aiohttp import web

from relay_dataplane import signing
from relay_dataplane.outcome import SendResult
from relay_dataplane.transform import TransformClient
from relay_dataplane.worker import WorkerConfig, handle_message
from tests.conftest import TEST_KEYRING, TEST_SECRET
from tests.worker.test_worker_core import ScriptedSender, queue_message

EXPRESSION = '{"wrapped": $}'


class Runner:
    """Plays the transformation runner; `mode` picks the behaviour."""

    def __init__(self, mode="ok"):
        self.mode, self.calls = mode, []

    async def handle(self, request: web.Request) -> web.StreamResponse:
        body = await request.json()
        self.calls.append(body)
        m = self.mode
        if m == "ok":
            return web.json_response({"output": {"wrapped": body["input"]}})
        if m in ("expression_error", "limit_exceeded"):
            return web.json_response({"error": {"kind": m, "message": "x"}}, status=422)
        if m == "hang":
            await asyncio.sleep(1.5)  # longer than the 0.5 s RPC timeout the tests use
        if m == "503":
            return web.json_response({"error": {"kind": "overloaded"}}, status=503)
        if m == "garbage":
            return web.Response(status=200, text="<html>proxy error</html>")
        if m == "unknown_kind":
            return web.json_response({"error": {"kind": "something_new"}}, status=422)
        if m == "422_without_kind":
            return web.json_response({"detail": "validation"}, status=422)
        if m == "no_output":
            return web.json_response({"result": 1})
        if m == "reset":
            request.transport.close()
            await asyncio.sleep(1)
        return web.Response(status=500)


@contextlib.asynccontextmanager
async def running(runner: Runner):
    app = web.Application()
    app.router.add_post("/v1/transform", runner.handle)
    app_runner = web.AppRunner(app)
    await app_runner.setup()
    site = web.TCPSite(app_runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        await app_runner.cleanup()


def transformed_delivery(connect, factory, expression=EXPRESSION):
    d = factory.delivery()
    with connect() as c:
        tenant, endpoint = factory.row(d)["tenant_id"], factory.row(d)["endpoint_id"]
        tr = c.execute(
            "INSERT INTO control.transformations (tenant_id, expression) VALUES (%s, %s) RETURNING id",
            (tenant, expression),
        ).fetchone()[0]
        c.execute("UPDATE control.endpoints SET transformation_id = %s WHERE id = %s", (tr, endpoint))
    return d


CONFIG = WorkerConfig(transform_retry_delay=0, max_deferral_age=3600)


def deliver(pg_dsn, body, sender, runner: Runner | None, *, url=None, config=CONFIG, timeout=0.5):
    async def go():
        async with contextlib.AsyncExitStack() as stack:
            transformer = None
            if runner is not None or url is not None:
                base = url or await stack.enter_async_context(running(runner))
                transformer = await stack.enter_async_context(TransformClient(base, timeout))
            conn = await stack.enter_async_context(
                await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_worker", autocommit=True)
            )
            return await handle_message(conn, body, sender, TEST_KEYRING, config, transformer=transformer)

    return asyncio.run(go())


def attempts(connect, d):
    with connect() as c:
        return c.execute(
            "SELECT counted, outcome, error_class FROM delivery.delivery_attempts WHERE delivery_id = %s ORDER BY id",
            (d,),
        ).fetchall()


def test_output_of_the_runner_is_what_is_signed_and_sent(pg_dsn, connect, factory):
    d = transformed_delivery(connect, factory)
    sender, runner = ScriptedSender(SendResult(200)), Runner("ok")
    h = deliver(pg_dsn, queue_message(connect, factory, d), sender, runner)
    assert h.result == "succeeded"
    assert runner.calls == [{"expression": EXPRESSION, "input": {"k": 1}}]
    ((_, headers, body, _),) = sender.calls
    assert json.loads(body) == {"wrapped": {"k": 1}}
    assert signing.verify(TEST_SECRET, headers, body)  # the signature covers the transformed body


@pytest.mark.parametrize("kind", ["limit_exceeded", "expression_error"])
def test_a_failure_confirmed_by_the_runner_is_dead_and_nothing_is_sent(pg_dsn, connect, factory, kind):
    d = transformed_delivery(connect, factory)
    sender = ScriptedSender()
    h = deliver(pg_dsn, queue_message(connect, factory, d), sender, Runner(kind))
    assert (h.result, h.error_class) == ("dead", "transform_error")
    assert sender.calls == []
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["last_error_class"]) == ("dead", 1, "transform_error")


@pytest.mark.parametrize(
    "mode", ["hang", "503", "garbage", "unknown_kind", "422_without_kind", "no_output", "reset", "500"]
)
def test_an_unavailable_runner_defers_without_an_attempt_and_never_kills(pg_dsn, connect, factory, mode):
    d = transformed_delivery(connect, factory)
    sender = ScriptedSender()
    h = deliver(pg_dsn, queue_message(connect, factory, d), sender, Runner(mode))
    assert (h.result, h.error_class) == ("deferred", "transform_unavailable")
    assert sender.calls == []
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["last_error_class"]) == ("scheduled", 0, "transform_unavailable")
    assert row["first_deferred_at"] is not None and row["lease_token_hash"] is None
    assert attempts(connect, d) == [(False, "deferred", "transform_unavailable")]


def test_a_runner_that_refuses_connections_is_unavailable(pg_dsn, connect, factory):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        closed = f"http://127.0.0.1:{s.getsockname()[1]}"
    d = transformed_delivery(connect, factory)
    h = deliver(pg_dsn, queue_message(connect, factory, d), ScriptedSender(), None, url=closed)
    assert h.result == "deferred" and factory.row(d)["attempt_count"] == 0


def test_no_runner_configured_defers(pg_dsn, connect, factory):
    d = transformed_delivery(connect, factory)
    h = deliver(pg_dsn, queue_message(connect, factory, d), ScriptedSender(), None)
    assert h.result == "deferred" and factory.row(d)["status"] == "scheduled"


def test_after_the_runner_recovers_the_same_delivery_succeeds(pg_dsn, connect, factory):
    d = transformed_delivery(connect, factory)
    for _ in range(3):  # a hanging runner, three times: still never dead, still no attempt used
        assert (
            deliver(pg_dsn, queue_message(connect, factory, d), ScriptedSender(), Runner("hang")).result == "deferred"
        )
    assert factory.row(d)["attempt_count"] == 0
    sender = ScriptedSender(SendResult(200))
    h = deliver(pg_dsn, queue_message(connect, factory, d), sender, Runner("ok"))
    assert h.result == "succeeded"
    assert json.loads(sender.calls[0][2]) == {"wrapped": {"k": 1}}
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["first_deferred_at"]) == ("succeeded", 1, None)
    assert [a[0] for a in attempts(connect, d)] == [False, False, False, True]


def test_past_the_maximum_deferral_age_a_deferral_counts(pg_dsn, connect, factory):
    d = transformed_delivery(connect, factory)
    deliver(pg_dsn, queue_message(connect, factory, d), ScriptedSender(), Runner("503"))
    with connect() as c:  # the runner has now been down longer than the maximum deferral age
        c.execute("UPDATE delivery.deliveries SET first_deferred_at = now() - interval '2 hours' WHERE id = %s", (d,))
    deliver(pg_dsn, queue_message(connect, factory, d), ScriptedSender(), Runner("503"))
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["last_error_class"]) == ("scheduled", 1, "transform_unavailable")
    assert attempts(connect, d)[-1] == (True, "retry", "transform_unavailable")


def test_the_twelfth_counted_deferral_is_dead(pg_dsn, connect, factory):
    d = transformed_delivery(connect, factory)
    with connect() as c:
        c.execute(
            "UPDATE delivery.deliveries SET attempt_count = 11, first_deferred_at = now() - interval '2 hours' "
            "WHERE id = %s",
            (d,),
        )
    h = deliver(pg_dsn, queue_message(connect, factory, d), ScriptedSender(), Runner("hang"))
    assert h.result == "dead"
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["last_error_class"]) == ("dead", 12, "max_attempts")


# ---------------------------------------------------------------- defer_delivery guards


def claimed(connect, factory, d):
    body = json.loads(queue_message(connect, factory, d))
    lease = b"L" * 16
    with connect("relay_worker") as c:
        c.execute(
            "SELECT * FROM delivery.claim_delivery(%s,%s,%s,%s,'1 minute')",
            (d, body["dispatch_seq"], bytes.fromhex(body["dispatch_token"]), lease),
        )
    return lease


def defer(connect, d, lease, delay=timedelta(0), max_age=timedelta(hours=1), cls="transform_unavailable"):
    with connect("relay_worker") as c:
        return c.execute("SELECT delivery.defer_delivery(%s,%s,%s,%s,%s)", (d, lease, delay, max_age, cls)).fetchone()[
            0
        ]


def test_defer_with_a_wrong_lease_changes_nothing(connect, factory):
    d = factory.delivery()
    claimed(connect, factory, d)
    before = factory.row(d)
    assert defer(connect, d, b"W" * 16) is None
    assert factory.row(d) == before


@pytest.mark.parametrize(
    ("delay", "max_age", "cls"),
    [
        (timedelta(seconds=-1), timedelta(hours=1), "x"),
        (timedelta(hours=7), timedelta(hours=1), "x"),
        (timedelta(0), timedelta(0), "x"),
        (timedelta(0), timedelta(days=8), "x"),
        (timedelta(0), timedelta(hours=1), "Bad Class!"),
    ],
)
def test_defer_rejects_bad_arguments(connect, factory, delay, max_age, cls):
    d = factory.delivery()
    lease = claimed(connect, factory, d)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        defer(connect, d, lease, delay, max_age, cls)
