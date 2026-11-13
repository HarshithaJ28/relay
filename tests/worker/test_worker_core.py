"""Worker core against real PostgreSQL, with a scripted sender standing in for HTTP.
The real HTTP sender is tested with the worker in tests/sender/test_worker_http.py."""

import asyncio
import base64
import json
import uuid
from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from relay_dataplane import signing
from relay_dataplane.endpoint_secrets import Keyring, new_entry
from relay_dataplane.outcome import SendResult
from relay_dataplane.worker import WorkerConfig, handle_message
from tests.conftest import TEST_KEYRING
from tests.conftest import TEST_SECRET as SECRET


class ScriptedSender:
    """Returns queued results and records every request it was asked to make."""

    def __init__(self, *results, on_send=None):
        self.results = list(results)
        self.calls = []
        self.on_send = on_send

    async def send(self, url, headers, body, timeout):
        self.calls.append((url, headers, body, timeout))
        if self.on_send:
            self.on_send()
        r = self.results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def queue_message(connect, factory, delivery_id) -> bytes:
    row = factory.row(delivery_id)
    with connect("relay_scheduler") as c:
        c.execute("SELECT delivery.dispatch_batch(%s, 10)", (row["tenant_id"],))
    with connect("postgres") as su:
        seq, raw = su.execute(
            "SELECT dispatch_seq, dispatch_token FROM delivery.outbox WHERE delivery_id=%s "
            "ORDER BY dispatch_seq DESC LIMIT 1",
            (delivery_id,),
        ).fetchone()
    return json.dumps(
        {"delivery_id": str(delivery_id), "dispatch_seq": seq, "dispatch_token": bytes(raw).hex()}
    ).encode()


def run(pg_dsn, body, sender, **kw):
    async def go():
        async with await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_worker", autocommit=True) as conn:
            return await handle_message(conn, body, sender, kw.pop("keyring", TEST_KEYRING), **kw)

    return asyncio.run(go())


def test_success_signs_the_request_and_finishes_the_delivery(connect, factory, pg_dsn):
    d = factory.delivery()
    body = queue_message(connect, factory, d)
    sender = ScriptedSender(SendResult(200))
    h = run(pg_dsn, body, sender)
    assert (h.result, h.attempt_no) == ("succeeded", 1)
    row = factory.row(d)
    assert row["status"] == "succeeded"
    ((url, headers, sent_body, timeout),) = sender.calls
    assert url == "https://example.invalid/hook" and timeout == 10.0
    assert json.loads(sent_body) == {"k": 1} and sent_body == b'{"k":1}'
    assert signing.verify(SECRET, headers, sent_body)  # a receiver could verify it
    assert headers["webhook-id"] == str(row["message_id"])
    assert headers["relay-delivery-id"] == str(d)
    assert headers["relay-event-id"] == str(row["event_id"])


def test_server_error_schedules_a_jittered_retry(connect, factory, pg_dsn):
    d = factory.delivery()
    h = run(pg_dsn, queue_message(connect, factory, d), ScriptedSender(SendResult(503)), rng=lambda: 0.5)
    assert (h.result, h.error_class) == ("retry", "http_5xx")
    with factory._su() as c:
        delay = c.execute(
            "SELECT extract(epoch FROM next_attempt_at - now()) FROM delivery.deliveries WHERE id=%s", (d,)
        ).fetchone()[0]
    assert 13 < delay <= 15  # 0.5 * 30 s bound for the first failure
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["last_error_class"]) == ("scheduled", 1, "http_5xx")


def test_retry_after_header_extends_the_delay(connect, factory, pg_dsn):
    d = factory.delivery()
    run(pg_dsn, queue_message(connect, factory, d), ScriptedSender(SendResult(429, retry_after=3600)), rng=lambda: 0.0)
    with factory._su() as c:
        delay = c.execute(
            "SELECT extract(epoch FROM next_attempt_at - now()) FROM delivery.deliveries WHERE id=%s", (d,)
        ).fetchone()[0]
    assert 3590 < delay <= 3600


@pytest.mark.parametrize(
    "res,cls", [(SendResult(None, "timeout"), "timeout"), (RuntimeError("sender bug"), "internal_error")]
)
def test_transport_failure_and_sender_exceptions_are_retried_not_lost(connect, factory, pg_dsn, res, cls):
    d = factory.delivery()
    h = run(pg_dsn, queue_message(connect, factory, d), ScriptedSender(res))
    assert (h.result, h.error_class) == ("retry", cls)
    assert factory.row(d)["status"] == "scheduled"


def test_blocked_destination_goes_straight_to_dead(connect, factory, pg_dsn):
    d = factory.delivery()
    h = run(pg_dsn, queue_message(connect, factory, d), ScriptedSender(SendResult(None, "blocked_destination")))
    assert h.result == "dead"
    assert factory.row(d)["status"] == "dead"


def test_duplicate_message_is_acked_without_sending(connect, factory, pg_dsn):
    d = factory.delivery()
    body = queue_message(connect, factory, d)
    first, second = ScriptedSender(SendResult(200)), ScriptedSender(SendResult(200))
    assert run(pg_dsn, body, first).result == "succeeded"
    assert run(pg_dsn, body, second).result == "duplicate"
    assert second.calls == []  # no second external request
    assert len(first.calls) == 1


def test_twelfth_failure_is_dead(connect, factory, pg_dsn):
    d = factory.delivery(attempt_count=11)
    h = run(pg_dsn, queue_message(connect, factory, d), ScriptedSender(SendResult(500)))
    assert h.result == "dead"
    row = factory.row(d)
    assert (row["status"], row["last_error_class"]) == ("dead", "max_attempts")


def test_lease_lost_during_send_is_fenced_and_the_documented_duplicate_window_is_real(connect, factory, pg_dsn):
    """The reaper reclaims the lease while the request is in flight. The worker's result is rejected, so
    state stays consistent; the request itself still went out (the documented at-least-once window)."""
    d = factory.delivery()

    def stall():
        with factory._su() as su:
            su.execute("UPDATE delivery.deliveries SET lease_until = now() - interval '1 minute' WHERE id=%s", (d,))
        with connect("relay_reaper") as r:
            assert r.execute("SELECT delivery.reclaim_expired(10)").fetchone()[0] == 1

    sender = ScriptedSender(SendResult(200), on_send=stall)
    h = run(pg_dsn, queue_message(connect, factory, d), sender)
    assert h.result == "fenced"
    assert len(sender.calls) == 1  # the receiver did get the request
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["last_error_class"]) == ("scheduled", 1, "lease_expired")


def test_lease_is_longer_than_the_request_timeout():
    cfg = WorkerConfig(request_timeout=10, lease_margin=30)
    assert cfg.lease_for.total_seconds() > cfg.request_timeout


# ---------------------------------------------------------------- signing secrets (encrypted at rest)

NEW_SECRET = "whsec_" + base64.b64encode(b"a-brand-new-secret-for-rotation!").decode()


def test_during_rotation_the_request_verifies_with_either_secret(connect, factory, pg_dsn):
    d = factory.delivery(
        signing_secrets=lambda ep: [
            new_entry(TEST_KEYRING, str(ep), "s1", SECRET, expires_at=datetime.now(UTC) + timedelta(days=1)),
            new_entry(TEST_KEYRING, str(ep), "s2", NEW_SECRET),
        ]
    )
    sender = ScriptedSender(SendResult(200))
    run(pg_dsn, queue_message(connect, factory, d), sender)
    ((_, headers, sent_body, _),) = sender.calls
    assert len(headers["webhook-signature"].split()) == 2
    assert signing.verify(SECRET, headers, sent_body)  # receiver not yet switched
    assert signing.verify(NEW_SECRET, headers, sent_body)  # receiver already switched


def test_an_expired_secret_is_no_longer_used(connect, factory, pg_dsn):
    d = factory.delivery(
        signing_secrets=lambda ep: [
            new_entry(TEST_KEYRING, str(ep), "s1", SECRET, expires_at=datetime.now(UTC) - timedelta(seconds=1)),
            new_entry(TEST_KEYRING, str(ep), "s2", NEW_SECRET),
        ]
    )
    sender = ScriptedSender(SendResult(200))
    run(pg_dsn, queue_message(connect, factory, d), sender)
    ((_, headers, sent_body, _),) = sender.calls
    assert len(headers["webhook-signature"].split()) == 1
    assert signing.verify(NEW_SECRET, headers, sent_body)
    assert not signing.verify(SECRET, headers, sent_body)


@pytest.mark.parametrize(
    "keyring",
    [
        pytest.param(Keyring({"other": bytes(32)}, "other"), id="master key missing"),
        pytest.param(Keyring({"test-k1": bytes(32)}, "test-k1"), id="wrong master key"),
    ],
)
def test_undecryptable_secret_sends_nothing_and_is_retried(connect, factory, pg_dsn, keyring):
    d = factory.delivery()
    sender = ScriptedSender()
    h = run(pg_dsn, queue_message(connect, factory, d), sender, keyring=keyring)
    assert sender.calls == []  # an unsigned or wrongly signed request is never sent
    assert (h.result, h.error_class) == ("retry", "secret_unavailable")
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["last_error_class"]) == ("scheduled", 1, "secret_unavailable")


def test_ciphertext_moved_to_another_endpoint_is_not_used(connect, factory, pg_dsn):
    foreign = uuid.uuid4()  # encrypted for a different endpoint, then copied here
    d = factory.delivery(signing_secrets=lambda _ep: [new_entry(TEST_KEYRING, str(foreign), "s1", SECRET)])
    sender = ScriptedSender()
    h = run(pg_dsn, queue_message(connect, factory, d), sender)
    assert sender.calls == [] and h.error_class == "secret_unavailable"


def test_a_lease_shorter_than_the_request_timeout_sends_nothing(connect, factory, pg_dsn):
    """Spec section 5: if the lease cannot outlive the request, give the delivery back unused."""
    d = factory.delivery()
    sender = ScriptedSender()
    h = run(pg_dsn, queue_message(connect, factory, d), sender, config=WorkerConfig(request_timeout=5, lease_margin=-4))
    assert sender.calls == []
    assert (h.result, h.error_class) == ("deferred", "lease_too_short")
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["last_error_class"]) == ("scheduled", 0, "lease_too_short")
