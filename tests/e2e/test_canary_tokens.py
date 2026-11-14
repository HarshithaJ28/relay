"""Spec section 3: tokens never appear in logs, traces, error output or stored rows.

Known canary values are used as dispatch and lease tokens and pushed through every worker
path with every library logging at DEBUG and tracing on; then all output is searched for
them in every encoding. A second test runs the real processes and searches their output for
the real dispatch tokens."""

import asyncio
import base64
import hashlib
import io
import json
import logging

import pytest
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from relay_dataplane import observability as obs
from relay_dataplane import worker as worker_module
from relay_dataplane.endpoint_secrets import Keyring
from relay_dataplane.outcome import SendResult
from relay_dataplane.processes import process_message
from relay_dataplane.worker import WorkerConfig
from tests.conftest import TEST_KEYRING
from tests.e2e.conftest import HOST, wait_for
from tests.e2e.test_processes import endpoint_delivery, statuses
from tests.worker.test_process_pieces import FakeMessage, OnePool
from tests.worker.test_worker_core import ScriptedSender, queue_message

CANARY_DISPATCH = b"canary-dispatch!"  # 16 bytes, like a real token
CANARY_LEASE = b"canary-lease-tok"


def forms(raw: bytes) -> list[str]:
    """Every way a token could leak into text."""
    found = [
        raw.hex(),
        raw.hex().upper(),
        base64.b64encode(raw).decode(),
        base64.urlsafe_b64encode(raw).decode().rstrip("="),
        repr(raw),
    ]
    try:
        found.append(raw.decode())  # readable canaries; random tokens usually are not text
    except UnicodeDecodeError:
        pass
    return found


def leaks(text: str, tokens) -> list[str]:
    return [f for t in tokens for f in forms(t) if f in text]


@pytest.fixture
def everything_logged():
    """Root logger at DEBUG with the production handler, so every library's output is captured."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.addFilter(obs.RedactTokens())
    handler.setFormatter(obs.JsonFormatter())
    root = logging.getLogger()
    saved = (root.handlers[:], root.level)
    root.handlers[:] = [handler]
    root.setLevel(logging.DEBUG)
    yield stream
    root.handlers[:], root.level = saved


@pytest.fixture
def spans():
    exporter = InMemorySpanExporter()
    provider = obs.setup_tracing("canary", exporter=exporter)
    yield lambda: (provider.force_flush(), exporter.get_finished_spans())[1]


def canary_message(connect, factory, d) -> bytes:
    """A real dispatch whose token is replaced by the canary."""
    seq = json.loads(queue_message(connect, factory, d))["dispatch_seq"]
    with connect() as c:
        c.execute(
            "UPDATE delivery.deliveries SET dispatch_token_hash = %s WHERE id = %s",
            (hashlib.sha256(CANARY_DISPATCH).digest(), d),
        )
    return json.dumps({"delivery_id": str(d), "dispatch_seq": seq, "dispatch_token": CANARY_DISPATCH.hex()}).encode()


class ExplodingSender:
    """A sender bug whose error message includes everything it was given."""

    async def send(self, url, headers, body, timeout):
        raise RuntimeError(f"failed {url} {headers} {body!r}")


def test_no_token_leaks_from_any_worker_path(pg_dsn, connect, factory, everything_logged, spans, monkeypatch):
    monkeypatch.setattr(worker_module, "new_lease_token", lambda: CANARY_LEASE)
    pool = OnePool(f"{pg_dsn} user=relay_worker")

    def lose_lease(d):
        def act():
            with connect() as c:
                c.execute("UPDATE delivery.deliveries SET lease_until = now() - interval '1 s' WHERE id = %s", (d,))
            with connect("relay_reaper") as c:
                c.execute("SELECT delivery.reclaim_expired(10)")

        return act

    scenarios = []
    for sender_for in (
        lambda d: ScriptedSender(SendResult(200)),
        lambda d: ScriptedSender(SendResult(503)),
        lambda d: ExplodingSender(),
        lambda d: ScriptedSender(SendResult(200), on_send=lose_lease(d)),
    ):
        d = factory.delivery()
        scenarios.append((FakeMessage(canary_message(connect, factory, d)), sender_for(d), TEST_KEYRING, pool))
    d = factory.delivery()  # a signing secret that cannot be decrypted
    scenarios.append(
        (FakeMessage(canary_message(connect, factory, d)), ScriptedSender(), Keyring({"x": bytes(32)}, "x"), pool)
    )
    d = factory.delivery()  # the same message twice: the second is a duplicate
    body = canary_message(connect, factory, d)
    scenarios += [(FakeMessage(body), ScriptedSender(SendResult(200)), TEST_KEYRING, pool)] * 2
    scenarios.append(  # malformed, but carrying the canary
        (
            FakeMessage(b'{"dispatch_token": "' + CANARY_DISPATCH.hex().encode() + b'"'),
            ScriptedSender(),
            TEST_KEYRING,
            pool,
        )
    )
    d = factory.delivery()  # the database is unreachable while handling
    scenarios.append(
        (FakeMessage(canary_message(connect, factory, d)), ScriptedSender(), TEST_KEYRING, OnePool(pg_dsn, fail=True))
    )

    async def go():
        for message, sender, keyring, p in scenarios:
            await process_message(message, p, sender, keyring, WorkerConfig())

    asyncio.run(go())

    logged = everything_logged.getvalue()
    assert "relay.deliver" in str([s.name for s in spans()])  # tracing really ran
    assert len(logged) > 1000  # and so did DEBUG logging, from the libraries too
    assert leaks(logged, [CANARY_DISPATCH, CANARY_LEASE]) == []
    traced = json.dumps([dict(s.attributes or {}) for s in spans()] + [s.name for s in spans()])
    assert leaks(traced, [CANARY_DISPATCH, CANARY_LEASE]) == []
    with connect() as c:  # the database keeps only hashes
        stored = c.execute("SELECT string_agg(row_to_json(d)::text, ' ') FROM delivery.deliveries d").fetchone()[
            0
        ] + str(c.execute("SELECT array_agg(a) FROM delivery.delivery_attempts a").fetchone()[0])
    assert leaks(stored, [CANARY_DISPATCH, CANARY_LEASE]) == []


def test_no_dispatch_token_leaks_from_the_real_processes(connect, factory, fleet, receiver):
    ids = [
        endpoint_delivery(connect, factory, factory.tenant(), f"https://{HOST}:{receiver.port}/ok") for _ in range(3)
    ]
    ids.append(endpoint_delivery(connect, factory, factory.tenant(), f"https://{HOST}:{receiver.port}/flaky/1"))
    fleet.start("scheduler", RELAY_LOG_LEVEL="DEBUG")

    def outbox_tokens():
        with connect() as c:
            return [
                bytes(r[0])
                for r in c.execute("SELECT dispatch_token FROM delivery.outbox WHERE dispatch_token IS NOT NULL")
            ]

    wait_for(lambda: len(outbox_tokens()) == len(ids), 30, fleet, "dispatch")
    tokens = outbox_tokens()  # the real raw tokens, read before anything publishes them
    for role in ("publisher", "worker", "reaper"):
        fleet.start(role, RELAY_LOG_LEVEL="DEBUG")
    wait_for(lambda: all(s[0] == "succeeded" for s in statuses(connect, ids).values()), 60, fleet, "delivery")
    fleet.stop_all()
    logs = fleet.logs(limit=None)
    assert "DEBUG" in logs  # the processes really logged at DEBUG
    assert leaks(logs, tokens) == []
