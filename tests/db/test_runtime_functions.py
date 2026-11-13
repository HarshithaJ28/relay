"""Migration 0005: due_tenants (scheduler), requeue_stale (reaper) and check_lease (worker)."""

from datetime import timedelta

import psycopg
import pytest

from tests.db.test_guarded_functions import attempts, claim, claimed, dispatch, record_status, tok

# ---------------------------------------------------------------- due_tenants


def due(connect, limit=100):
    with connect("relay_scheduler") as c:
        return [r[0] for r in c.execute("SELECT * FROM delivery.due_tenants(%s)", (limit,))]


def test_due_tenants_lists_only_tenants_with_due_scheduled_work(connect, factory):
    with_due, only_future, only_queued = factory.tenant(), factory.tenant(), factory.tenant()
    factory.delivery(tenant=with_due)
    factory.delivery(tenant=only_future, next_attempt_at="2999-01-01T00:00:00Z")
    d = factory.delivery(tenant=only_queued)
    dispatch(connect, factory, d)
    assert due(connect) == [with_due]


def test_due_tenants_puts_the_longest_waiting_tenant_first(connect, factory):
    late, early = factory.tenant(), factory.tenant()
    factory.delivery(tenant=late)
    factory.delivery(tenant=early, next_attempt_at="2000-01-01T00:00:00Z")
    assert due(connect) == [early, late]
    assert due(connect, limit=1) == [early]


@pytest.mark.parametrize("limit", [0, 10001])
def test_due_tenants_rejects_bad_limits(connect, limit):
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        due(connect, limit)


# ---------------------------------------------------------------- requeue_stale


def publish(factory, d, ago="1 hour"):
    """What the publisher does after a confirm, back-dated."""
    with factory._su() as c:
        c.execute(
            "UPDATE delivery.outbox SET published_at = now() - %s::interval, dispatch_token = NULL "
            "WHERE delivery_id = %s AND published_at IS NULL",
            (ago, d),
        )


def requeue(connect, older_than="10 minutes", limit=100):
    with connect("relay_reaper") as c:
        return c.execute("SELECT delivery.requeue_stale(%s::interval, %s)", (older_than, limit)).fetchone()[0]


def test_lost_message_goes_back_to_scheduled_without_using_an_attempt(connect, factory):
    d = factory.delivery()
    seq, dtok = dispatch(connect, factory, d)
    publish(factory, d)
    assert requeue(connect) == 1
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["last_error_class"]) == ("scheduled", 0, "queue_timeout")
    assert row["dispatch_token_hash"] is None
    assert attempts(factory, d) == [(1, False, "deferred")]
    # the redispatch bumps the sequence, so the lost message can never claim if it turns up
    new_seq, new_tok = dispatch(connect, factory, d)
    assert new_seq == seq + 1
    assert claim(connect, d, seq, dtok, tok()) == []
    assert len(claim(connect, d, new_seq, new_tok, tok())) == 1


def test_recent_unpublished_or_claimed_deliveries_are_left_alone(connect, factory):
    recent, unpublished, claimed_one = factory.delivery(), factory.delivery(), None
    dispatch(connect, factory, recent)
    publish(factory, recent, ago="1 second")
    dispatch(connect, factory, unpublished)  # the publisher has not sent it yet: not lost
    claimed_one, _ltok = claimed(connect, factory)
    publish(factory, claimed_one)
    assert requeue(connect) == 0
    assert [factory.row(x)["status"] for x in (recent, unpublished, claimed_one)] == ["queued", "queued", "in_flight"]


def test_only_the_current_dispatch_counts(connect, factory):
    """An old, long-published outbox row for a previous sequence must not requeue the current dispatch."""
    d = factory.delivery()
    dispatch(connect, factory, d)
    publish(factory, d)
    assert requeue(connect) == 1
    dispatch(connect, factory, d)  # sequence 2, not yet published
    assert requeue(connect) == 0
    assert factory.row(d)["status"] == "queued"


@pytest.mark.parametrize(
    ("older_than", "limit"), [("0 seconds", 10), ("2 days", 10), ("1 minute", 0), ("1 minute", 1001)]
)
def test_requeue_rejects_bad_arguments(connect, older_than, limit):
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        requeue(connect, older_than, limit)


# ---------------------------------------------------------------- check_lease


def check(connect, d, ltok, min_remaining=timedelta(seconds=10)):
    with connect("relay_worker") as c:
        return c.execute("SELECT delivery.check_lease(%s, %s, %s)", (d, ltok, min_remaining)).fetchone()[0]


def set_lease(factory, d, remaining):
    with factory._su() as c:
        c.execute("UPDATE delivery.deliveries SET lease_until = now() + %s::interval WHERE id = %s", (remaining, d))


def test_enough_lease_left_changes_nothing(connect, factory):
    d, ltok = claimed(connect, factory)  # 30 s lease
    before = factory.row(d)
    assert check(connect, d, ltok) is True
    assert factory.row(d) == before


def test_too_little_lease_gives_the_delivery_back_without_an_attempt(connect, factory):
    d, ltok = claimed(connect, factory)
    set_lease(factory, d, "2 seconds")
    assert check(connect, d, ltok) is False
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["last_error_class"]) == ("scheduled", 0, "lease_too_short")
    assert row["lease_token_hash"] is None and row["lease_until"] is None
    assert attempts(factory, d) == [(1, False, "deferred")]
    # the worker that was told no cannot record a result afterwards
    assert record_status(connect, d, ltok) is None


def test_boundary_exactly_enough_is_allowed(connect, factory):
    d, ltok = claimed(connect, factory)
    set_lease(factory, d, "1 hour")
    assert check(connect, d, ltok, timedelta(hours=1) - timedelta(seconds=5)) is True


def test_wrong_token_or_finished_delivery_returns_false_and_changes_nothing(connect, factory):
    d, ltok = claimed(connect, factory)
    set_lease(factory, d, "1 second")
    before = factory.row(d)
    assert check(connect, d, tok()) is False
    assert factory.row(d) == before  # a stranger cannot release someone else's claim
    assert record_status(connect, d, ltok) == "succeeded"
    assert check(connect, d, ltok) is False
    assert factory.row(d)["status"] == "succeeded"


@pytest.mark.parametrize(("token", "remaining"), [(b"short", timedelta(seconds=1)), (None, timedelta(seconds=1))])
def test_check_lease_rejects_bad_tokens(connect, factory, token, remaining):
    d, _ = claimed(connect, factory)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        check(connect, d, token, remaining)


@pytest.mark.parametrize("remaining", [timedelta(seconds=-1), timedelta(hours=2)])
def test_check_lease_rejects_bad_intervals(connect, factory, remaining):
    d, ltok = claimed(connect, factory)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        check(connect, d, ltok, remaining)
