"""Maintenance done by the retention job: published outbox cleanup, monthly event partitions,
and the orphan report. Run as the real relay_retention role."""

import asyncio
import uuid

import psycopg
import pytest

from relay_dataplane.retention import Report, maintain_partitions, orphan_report, run_pass
from tests.retention.test_retention import MARGIN, finish
from tests.worker.test_worker_core import queue_message


def as_retention(pg_dsn, fn):
    async def go():
        async with await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_retention", autocommit=True) as c:
            return await fn(c)

    return asyncio.run(go())


def outbox(connect, d):
    with connect() as c:
        return c.execute(
            "SELECT dispatch_seq, published_at IS NOT NULL FROM delivery.outbox WHERE delivery_id = %s ORDER BY 1",
            (d,),
        ).fetchall()


def publish(connect, d):
    with connect() as c:
        c.execute(
            "UPDATE delivery.outbox SET published_at = now(), dispatch_token = NULL "
            "WHERE delivery_id = %s AND published_at IS NULL",
            (d,),
        )


# ---------------------------------------------------------------- outbox cleanup


def test_published_rows_go_once_their_dispatch_is_over(pg_dsn, connect, factory):
    done, waiting, unpublished = factory.delivery(), factory.delivery(), factory.delivery()
    finish(connect, factory, pg_dsn, done)  # dispatched, published by the test, delivered
    queue_message(connect, factory, waiting)
    publish(connect, waiting)  # current dispatch, published, not yet claimed
    queue_message(connect, factory, unpublished)  # current dispatch, not yet published
    publish(connect, done)
    report = as_retention(pg_dsn, lambda c: run_pass(c, MARGIN))
    assert report.outbox_deleted == 1
    assert outbox(connect, done) == []
    assert outbox(connect, waiting) == [(1, True)]  # requeue_stale still needs it
    assert outbox(connect, unpublished) == [(1, False)]  # the publisher still needs it


def test_an_unpublished_row_whose_dispatch_is_over_goes_too(pg_dsn, connect, factory):
    """Its delivery reached the retention ceiling before the publisher got to it."""
    d = factory.delivery()
    queue_message(connect, factory, d)
    with connect() as c:
        c.execute("UPDATE delivery.deliveries SET status = 'dead', dispatch_token_hash = NULL WHERE id = %s", (d,))
    assert outbox(connect, d) == [(1, False)]
    as_retention(pg_dsn, lambda c: run_pass(c, MARGIN))
    assert outbox(connect, d) == []  # no stale publish, and the raw token is gone


def test_a_previous_dispatch_row_goes_while_the_current_one_stays(pg_dsn, connect, factory):
    d = factory.delivery()
    queue_message(connect, factory, d)
    publish(connect, d)
    with connect("relay_reaper") as c:  # the message was lost: back to scheduled, then dispatched again
        with connect() as su:
            su.execute(
                "UPDATE delivery.outbox SET published_at = now() - interval '1 hour' WHERE delivery_id = %s", (d,)
            )
        c.execute("SELECT delivery.requeue_stale('1 minute', 10)")
    queue_message(connect, factory, d)
    publish(connect, d)
    as_retention(pg_dsn, lambda c: run_pass(c, MARGIN))
    assert outbox(connect, d) == [(2, True)]


# ---------------------------------------------------------------- partitions


def partitions(connect):
    with connect() as c:
        return sorted(
            r[0]
            for r in c.execute(
                "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid "
                "WHERE i.inhparent = 'delivery.events'::regclass"
            )
        )


@pytest.fixture
def no_monthly_partitions(connect):
    def drop():
        with connect() as c:
            for name in partitions(connect):
                if name != "events_default":
                    c.execute(f"DROP TABLE delivery.{name}")

    drop()
    yield
    drop()


def month_name(connect, months_from_now):
    with connect() as c:
        return c.execute(
            "SELECT 'events_y' || to_char(d, 'YYYY') || 'm' || to_char(d, 'MM') "
            "FROM (SELECT date_trunc('month', now()) + make_interval(months => %s) AS d) s",
            (months_from_now,),
        ).fetchone()[0]


def test_upcoming_months_get_partitions_and_it_is_idempotent(pg_dsn, connect, no_monthly_partitions):
    report = Report()
    as_retention(pg_dsn, lambda c: maintain_partitions(c, report))
    assert report.partitions_created == 4  # this month and three ahead
    assert partitions(connect) == sorted(["events_default", *(month_name(connect, m) for m in range(4))])
    again = Report()
    as_retention(pg_dsn, lambda c: maintain_partitions(c, again))
    assert again.partitions_created == 0


def test_a_month_with_rows_in_the_default_partition_is_left_alone(pg_dsn, connect, factory, no_monthly_partitions):
    factory.delivery()  # an event this month, in the default partition
    report = Report()
    as_retention(pg_dsn, lambda c: maintain_partitions(c, report))
    assert report.partitions_created == 3
    assert month_name(connect, 0) not in partitions(connect)


def test_new_events_land_in_their_month_and_stay_tenant_isolated(pg_dsn, connect, factory, no_monthly_partitions):
    as_retention(pg_dsn, lambda c: maintain_partitions(c, Report()))
    d = factory.delivery()
    event = factory.row(d)["event_id"]
    with connect() as c:
        where = c.execute("SELECT tableoid::regclass::text FROM delivery.events WHERE id = %s", (event,)).fetchone()[0]
    assert where == f"delivery.{month_name(connect, 0)}"
    with psycopg.connect(f"{pg_dsn} user=relay_tenant") as c:
        c.execute("SELECT set_config('app.tenant_id', %s, true)", (str(factory.tenant()),))
        assert c.execute("SELECT count(*) FROM delivery.events").fetchone()[0] == 0


def old_partition(connect, name="events_y2000m01"):
    with connect() as c:
        c.execute(
            f"CREATE TABLE delivery.{name} PARTITION OF delivery.events "
            "FOR VALUES FROM ('2000-01-01') TO ('2000-02-01')"
        )


def test_an_expired_partition_nothing_refers_to_is_dropped(pg_dsn, connect, no_monthly_partitions):
    old_partition(connect)
    report = Report()
    as_retention(pg_dsn, lambda c: maintain_partitions(c, report))
    assert report.partitions_dropped == ["events_y2000m01"] and "events_y2000m01" not in partitions(connect)


def test_a_partition_with_deliveries_left_is_skipped_and_reported(pg_dsn, connect, factory, no_monthly_partitions):
    old_partition(connect)
    d = factory.delivery()
    with connect() as c:
        c.execute("UPDATE delivery.deliveries SET event_created_at = '2000-01-15', status = 'dead' WHERE id = %s", (d,))
    report = Report()
    as_retention(pg_dsn, lambda c: maintain_partitions(c, report))
    assert report.partitions_skipped == ["events_y2000m01"] and "events_y2000m01" in partitions(connect)


def test_a_partition_inside_the_longest_retention_is_kept(pg_dsn, connect, factory, no_monthly_partitions):
    old_partition(connect)
    with connect() as c:  # one tenant keeps data for a very long time
        c.execute("UPDATE control.tenants SET retention_days = 20000 WHERE id = %s", (factory.tenant(),))
    report = Report()
    as_retention(pg_dsn, lambda c: maintain_partitions(c, report))
    assert report.partitions_dropped == [] and "events_y2000m01" in partitions(connect)


def test_partitions_not_named_by_the_job_are_never_touched(pg_dsn, connect, no_monthly_partitions):
    old_partition(connect, name="events_archive_2000")
    report = Report()
    as_retention(pg_dsn, lambda c: maintain_partitions(c, report))
    assert "events_archive_2000" in partitions(connect)


# ---------------------------------------------------------------- orphan report and privileges


def test_the_orphan_report_finds_deliveries_whose_event_is_gone(pg_dsn, connect, factory):
    d = factory.delivery()
    assert as_retention(pg_dsn, orphan_report) == {"deliveries_without_event": 0, "idempotency_keys_without_event": 0}
    with connect() as c:
        c.execute("DELETE FROM delivery.events WHERE id = %s", (factory.row(d)["event_id"],))
        c.execute(
            "INSERT INTO delivery.idempotency_keys (tenant_id, key, event_id, event_created_at, payload_sha256, "
            "expires_at) VALUES (%s, 'k', %s, now(), sha256('x'), now() + interval '1 day')",
            (factory.row(d)["tenant_id"], uuid.uuid4()),
        )
    assert as_retention(pg_dsn, orphan_report) == {"deliveries_without_event": 1, "idempotency_keys_without_event": 1}


@pytest.mark.parametrize("role", ["relay_worker", "relay_scheduler", "relay_tenant", "relay_publisher", "relay_reaper"])
@pytest.mark.parametrize(
    "sql",
    [
        "SELECT delivery.ensure_event_partitions(1)",
        "SELECT * FROM delivery.drop_expired_event_partitions('7 days')",
        "SELECT * FROM delivery.orphan_report()",
    ],
)
def test_only_the_retention_role_runs_maintenance(connect, role, sql):
    with connect(role) as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
        c.execute(sql)


@pytest.mark.parametrize(("arg", "fn"), [(-1, "ensure_event_partitions"), (25, "ensure_event_partitions")])
def test_maintenance_rejects_bad_arguments(connect, arg, fn):
    with connect("relay_retention") as c, pytest.raises(psycopg.errors.InvalidParameterValue):
        c.execute(f"SELECT delivery.{fn}(%s)", (arg,))


# ---------------------------------------------------------------- usage


def test_usage_is_counted_per_tenant_and_day_and_recounting_is_idempotent(pg_dsn, connect, factory):
    from relay_dataplane.outcome import SendResult
    from relay_dataplane.retention import flush_usage
    from tests.worker.test_worker_core import ScriptedSender, run

    a, b = factory.tenant(), factory.tenant()
    done = [factory.delivery(tenant=a) for _ in range(2)]
    failed = factory.delivery(tenant=a)
    factory.delivery(tenant=b)
    for d in done:
        run(pg_dsn, queue_message(connect, factory, d), ScriptedSender(SendResult(200)))
    run(pg_dsn, queue_message(connect, factory, failed), ScriptedSender(SendResult(503)))

    for _ in range(2):  # running twice must not double anything
        as_retention(pg_dsn, flush_usage)
    with connect() as c:
        rows = dict(
            (r[0], r[1:])
            for r in c.execute("SELECT tenant_id, events_ingested, attempts, successes FROM control.usage_daily")
        )
    assert rows == {a: (3, 3, 2), b: (1, 0, 0)}
