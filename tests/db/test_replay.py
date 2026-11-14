"""Replay (spec sections 3 and 5): a finished delivery is replayed as a new delivery, with the
webhook-id chosen by the documented defaults, and never once its payload has expired."""

from datetime import timedelta

import psycopg
import pytest

from relay_dataplane.outcome import SendResult
from tests.worker.test_worker_core import ScriptedSender, queue_message, run


def finish(connect, factory, pg_dsn, d, result):
    run(pg_dsn, queue_message(connect, factory, d), ScriptedSender(result))


def replay(pg_dsn, tenant, delivery_id, mode=None):
    with psycopg.connect(f"{pg_dsn} user=relay_tenant") as c:
        if tenant is not None:
            c.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant),))
        row = c.execute("SELECT * FROM delivery.replay_delivery(%s, %s)", (delivery_id, mode)).fetchone()
        c.commit()
        return row


@pytest.fixture
def succeeded(pg_dsn, connect, factory):
    d = factory.delivery()
    finish(connect, factory, pg_dsn, d, SendResult(200))
    return d


@pytest.fixture
def dead(pg_dsn, connect, factory):
    d = factory.delivery()
    finish(connect, factory, pg_dsn, d, SendResult(None, "blocked_destination"))
    return d


def test_replaying_a_succeeded_delivery_uses_a_new_message_id(pg_dsn, factory, succeeded):
    original = factory.row(succeeded)
    new_id, message_id, mode = replay(pg_dsn, original["tenant_id"], succeeded)
    assert mode == "new" and message_id != original["message_id"]
    new = factory.row(new_id)
    assert (new["status"], new["replay_of"], new["endpoint_id"], new["event_id"]) == (
        "scheduled",
        succeeded,
        original["endpoint_id"],
        original["event_id"],
    )
    assert factory.row(succeeded) == original  # history is never changed


def test_replaying_a_dead_delivery_reuses_the_message_id(pg_dsn, factory, dead):
    original = factory.row(dead)
    _, message_id, mode = replay(pg_dsn, original["tenant_id"], dead)
    assert (mode, message_id) == ("reuse", original["message_id"])


@pytest.mark.parametrize(("which", "mode"), [("succeeded", "reuse"), ("dead", "new")])
def test_an_explicit_mode_overrides_the_default(pg_dsn, factory, request, which, mode):
    d = request.getfixturevalue(which)
    original = factory.row(d)
    _, message_id, used = replay(pg_dsn, original["tenant_id"], d, mode)
    assert used == mode
    assert (message_id == original["message_id"]) is (mode == "reuse")


@pytest.mark.parametrize("state", ["scheduled", "queued"])
def test_an_active_delivery_cannot_be_replayed(pg_dsn, connect, factory, state):
    d = factory.delivery()
    if state == "queued":
        queue_message(connect, factory, d)
    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
        replay(pg_dsn, factory.row(d)["tenant_id"], d)


def test_another_tenant_or_no_tenant_sees_not_found(pg_dsn, factory, succeeded):
    for tenant in (factory.tenant(), None):
        with pytest.raises(psycopg.errors.NoDataFound):
            replay(pg_dsn, tenant, succeeded)


def test_an_expired_payload_cannot_be_replayed_and_the_error_says_when_it_expired(pg_dsn, connect, factory, succeeded):
    row = factory.row(succeeded)
    with connect() as c:
        ts = c.execute("SELECT now() - interval '31 days'").fetchone()[0]
        c.execute("UPDATE delivery.events SET created_at = %s WHERE id = %s", (ts, row["event_id"]))
        c.execute("UPDATE delivery.deliveries SET event_created_at = %s WHERE id = %s", (ts, succeeded))
    with pytest.raises(psycopg.Error) as e:
        replay(pg_dsn, row["tenant_id"], succeeded)
    assert e.value.sqlstate == "RL410"
    expected = (ts + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")
    assert e.value.diag.message_detail.startswith(expected)


def test_a_bad_mode_is_rejected(pg_dsn, factory, succeeded):
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        replay(pg_dsn, factory.row(succeeded)["tenant_id"], succeeded, "sometimes")


def test_a_replay_can_itself_be_replayed(pg_dsn, connect, factory, succeeded):
    tenant = factory.row(succeeded)["tenant_id"]
    first, _, _ = replay(pg_dsn, tenant, succeeded)
    finish(connect, factory, pg_dsn, first, SendResult(200))
    second, _, _ = replay(pg_dsn, tenant, first)
    assert factory.row(second)["replay_of"] == first


def test_the_replayed_request_carries_the_replay_headers(pg_dsn, connect, factory, dead):
    original = factory.row(dead)
    new_id, _, _ = replay(pg_dsn, original["tenant_id"], dead)
    sender = ScriptedSender(SendResult(200))
    run(pg_dsn, queue_message(connect, factory, new_id), sender)
    ((_, headers, _, _),) = sender.calls
    assert headers["relay-replay"] == "true" and headers["relay-replay-of"] == str(dead)
    assert headers["webhook-id"] == str(original["message_id"])  # reuse: the receiver can deduplicate
    assert headers["relay-delivery-id"] == str(new_id)


def test_an_ordinary_delivery_has_no_replay_headers(pg_dsn, connect, factory):
    d = factory.delivery()
    sender = ScriptedSender(SendResult(200))
    run(pg_dsn, queue_message(connect, factory, d), sender)
    assert not any(h.startswith("relay-replay") for h in sender.calls[0][1])


def test_replay_wakes_the_scheduler(pg_dsn, factory, succeeded):
    with psycopg.connect(f"{pg_dsn} user=relay_scheduler", autocommit=True) as listener:
        listener.execute("LISTEN relay_dispatch")
        replay(pg_dsn, factory.row(succeeded)["tenant_id"], succeeded)
        assert [n.channel for n in listener.notifies(timeout=5, stop_after=1)] == ["relay_dispatch"]
