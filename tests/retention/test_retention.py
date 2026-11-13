"""AC-3 and the retention job, against the real database as the real relay_retention role.

"Advancing the clock" is done by back-dating rows (event created_at and the deliveries'
event_created_at), which is equivalent for every comparison with now()."""

import asyncio
import subprocess
import sys
from datetime import timedelta

import psycopg
import pytest

from relay_dataplane.outcome import SendResult
from relay_dataplane.processes import dispatch_pass
from relay_dataplane.retention import ceiling_margin, check_retention_covers_retries, run_pass
from relay_dataplane.settings import Settings
from tests.ingest.conftest import auth
from tests.worker.test_worker_core import ScriptedSender, queue_message, run

MARGIN = ceiling_margin(timedelta(hours=6))  # 52,290 s of retries + 6 h of deferrals


def test_ceiling_margin_is_the_retry_window_plus_deferral_age():
    assert MARGIN == timedelta(seconds=52_290) + timedelta(hours=6)


def backdate(connect, factory, d, age: timedelta):
    """Make the delivery's event `age` old."""
    event_id = factory.row(d)["event_id"]
    with connect() as c:  # one timestamp for both, as ingestion writes them in one transaction
        ts = c.execute("SELECT now() - %s", (age,)).fetchone()[0]
        c.execute("UPDATE delivery.events SET created_at = %s WHERE id = %s", (ts, event_id))
        c.execute("UPDATE delivery.deliveries SET event_created_at = %s WHERE event_id = %s", (ts, event_id))


def retention_pass(pg_dsn, batch=500):
    async def go():
        async with await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_retention", autocommit=True) as c:
            return await run_pass(c, MARGIN, batch)

    return asyncio.run(go())


def exists(connect, table, column, value) -> bool:
    with connect() as c:
        return c.execute(f"SELECT count(*) FROM {table} WHERE {column} = %s", (value,)).fetchone()[0] > 0


def finish(connect, factory, pg_dsn, d, result=None):
    sender = ScriptedSender(result or SendResult(200))
    return run(pg_dsn, queue_message(connect, factory, d), sender)


# ---------------------------------------------------------------- AC-3 (the spec's test)


def test_ac3_past_the_window_the_api_hides_it_but_it_is_still_delivered(api, pg_dsn, connect, factory, make_tenant):
    tenant = make_tenant(retention_days=30)
    created = api(
        lambda c: c.post(
            "/ingest/v1/events", json={"event_type": "order.created", "payload": {"n": 1}}, headers=auth(tenant.key)
        )
    )
    event_id = created.json()["event_id"]
    with connect() as c:
        [d] = [r[0] for r in c.execute("SELECT id FROM delivery.deliveries WHERE event_id = %s LIMIT 1", (event_id,))]
        c.execute("DELETE FROM delivery.deliveries WHERE event_id = %s AND id <> %s", (event_id, d))
    backdate(connect, factory, d, timedelta(days=30, hours=1))  # past the window, inside the ceiling

    # the API access window has ended, whatever the delivery state
    assert api(lambda c: c.get(f"/ingest/v1/events/{event_id}", headers=auth(tenant.key))).status_code == 404

    # the retention job keeps the payload of an active delivery, and reports it as blocked
    report = retention_pass(pg_dsn)
    assert factory.row(d)["status"] == "scheduled" and exists(connect, "delivery.events", "id", event_id)
    assert report.blocked_events == 1 and 3500 < report.lag_seconds < 3700

    # the delivery is still dispatched and sent: the commitment to deliver outlives the display window
    assert finish(connect, factory, pg_dsn, d).result == "succeeded"

    # now terminal: the next pass deletes attempts, delivery and event
    report = retention_pass(pg_dsn)
    assert (report.attempts_deleted, report.deliveries_deleted, report.events_deleted) == (1, 1, 1)
    assert not exists(connect, "delivery.events", "id", event_id)
    assert report.blocked_events == 0


@pytest.mark.parametrize("state", ["scheduled", "queued", "in_flight"])
def test_ac3_past_the_ceiling_an_active_delivery_is_dead_and_its_payload_deleted(pg_dsn, connect, factory, state):
    d = factory.delivery()
    lease = None
    if state in ("queued", "in_flight"):
        body = queue_message(connect, factory, d)
        if state == "in_flight":
            import json

            m = json.loads(body)
            lease = b"L" * 16
            with connect("relay_worker") as c:
                c.execute(
                    "SELECT * FROM delivery.claim_delivery(%s,%s,%s,%s,'1 hour')",
                    (d, m["dispatch_seq"], bytes.fromhex(m["dispatch_token"]), lease),
                )
    assert factory.row(d)["status"] == state
    event_id = factory.row(d)["event_id"]
    backdate(connect, factory, d, timedelta(days=30) + MARGIN + timedelta(minutes=5))

    report = retention_pass(pg_dsn)
    assert report.expired == 1
    assert not exists(connect, "delivery.deliveries", "id", d)  # dead, then deleted in the same pass
    assert not exists(connect, "delivery.events", "id", event_id)
    if lease:  # a worker still holding the old lease can no longer record anything
        with connect("relay_worker") as c:
            assert (
                c.execute("SELECT delivery.record_attempt(%s,%s,'success',200,NULL,NULL)", (d, lease)).fetchone()[0]
                is None
            )


# ---------------------------------------------------------------- deletion rules


def test_only_expired_terminal_data_is_deleted(pg_dsn, connect, factory):
    old_done, old_active, new_done = factory.delivery(), factory.delivery(), factory.delivery()
    finish(connect, factory, pg_dsn, old_done)
    finish(connect, factory, pg_dsn, old_active, SendResult(503))  # scheduled for retry: still active
    finish(connect, factory, pg_dsn, new_done)
    for d in (old_done, old_active):
        backdate(connect, factory, d, timedelta(days=31) - MARGIN + timedelta(hours=1))
    backdate(connect, factory, old_done, timedelta(days=31))

    retention_pass(pg_dsn)
    assert not exists(connect, "delivery.deliveries", "id", old_done)
    assert not exists(connect, "delivery.delivery_attempts", "delivery_id", old_done)
    assert exists(connect, "delivery.deliveries", "id", new_done)
    assert exists(connect, "delivery.delivery_attempts", "delivery_id", old_active)  # active: attempts kept
    assert factory.row(old_active)["status"] == "scheduled"


def test_each_tenant_uses_its_own_window(pg_dsn, connect, factory):
    short, long_ = factory.delivery(), factory.delivery()
    with connect() as c:
        c.execute("UPDATE control.tenants SET retention_days = 90 WHERE id = %s", (factory.row(long_)["tenant_id"],))
    for d in (short, long_):
        finish(connect, factory, pg_dsn, d)
        backdate(connect, factory, d, timedelta(days=45))
    retention_pass(pg_dsn)
    assert not exists(connect, "delivery.deliveries", "id", short)
    assert exists(connect, "delivery.deliveries", "id", long_)


def test_an_event_waits_for_all_its_deliveries(pg_dsn, connect, factory):
    d1 = factory.delivery()
    row = factory.row(d1)
    with connect() as c:  # a second delivery of the same event, still active
        d2 = c.execute(
            "INSERT INTO delivery.deliveries (tenant_id, endpoint_id, event_id, event_created_at) "
            "VALUES (%s, %s, %s, %s) RETURNING id",
            (row["tenant_id"], row["endpoint_id"], row["event_id"], row["event_created_at"]),
        ).fetchone()[0]
    finish(connect, factory, pg_dsn, d1)
    backdate(connect, factory, d1, timedelta(days=30, hours=2))
    retention_pass(pg_dsn)
    assert not exists(connect, "delivery.deliveries", "id", d1)
    assert exists(connect, "delivery.deliveries", "id", d2)
    assert exists(connect, "delivery.events", "id", row["event_id"])


def test_a_replay_survives_deletion_of_its_original(pg_dsn, connect, factory):
    original = factory.delivery()
    finish(connect, factory, pg_dsn, original)
    row = factory.row(original)
    with connect() as c:
        replay = c.execute(
            "INSERT INTO delivery.deliveries (tenant_id, endpoint_id, event_id, event_created_at, replay_of) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (row["tenant_id"], row["endpoint_id"], row["event_id"], row["event_created_at"], original),
        ).fetchone()[0]
    finish(connect, factory, pg_dsn, replay)
    with connect() as c:  # only the original is old enough
        c.execute(
            "UPDATE delivery.deliveries SET event_created_at = now() - interval '31 days' WHERE id = %s", (original,)
        )
    retention_pass(pg_dsn)
    assert not exists(connect, "delivery.deliveries", "id", original)
    assert factory.row(replay)["replay_of"] is None


def test_work_is_done_in_batches_until_finished(pg_dsn, connect, factory):
    tenant = factory.tenant()
    ids = [factory.delivery(tenant=tenant) for _ in range(7)]
    for d in ids:
        finish(connect, factory, pg_dsn, d)
        backdate(connect, factory, d, timedelta(days=31))
    report = retention_pass(pg_dsn, batch=2)
    assert (report.attempts_deleted, report.deliveries_deleted, report.events_deleted) == (7, 7, 7)


def test_expired_idempotency_keys_are_deleted(pg_dsn, connect, factory):
    tenant = factory.tenant()
    with connect() as c:
        for key, expires in (("old", "now() - interval '1 minute'"), ("new", "now() + interval '1 day'")):
            c.execute(
                "INSERT INTO delivery.idempotency_keys (tenant_id, key, event_id, event_created_at, payload_sha256, "
                f"expires_at) VALUES (%s, %s, gen_random_uuid(), now(), sha256('x'), {expires})",
                (tenant, key),
            )
    assert retention_pass(pg_dsn).keys_deleted == 1
    with connect() as c:
        assert [r[0] for r in c.execute("SELECT key FROM delivery.idempotency_keys")] == ["new"]


def test_dispatch_still_works_for_expired_but_active_deliveries(pg_dsn, connect, factory):
    d = factory.delivery()
    backdate(connect, factory, d, timedelta(days=30, hours=1))

    async def go():
        async with await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_scheduler", autocommit=True) as c:
            return await dispatch_pass(c, Settings("x", "y"))

    assert asyncio.run(go())[0] == 1


# ---------------------------------------------------------------- the role and the startup check


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT payload FROM delivery.events",
        "SELECT url FROM control.endpoints",
        "SELECT signing_secrets FROM control.endpoints",
        "INSERT INTO delivery.events (id, tenant_id, event_type, payload, payload_sha256) "
        "VALUES (gen_random_uuid(), gen_random_uuid(), 'x', '{}', sha256('x'))",
        "DELETE FROM control.tenants",
        "UPDATE delivery.deliveries SET attempt_count = 0",
    ],
)
def test_retention_role_cannot_read_payloads_or_change_anything_else(connect, sql):
    with connect("relay_retention") as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
        c.execute(sql)


@pytest.mark.parametrize(("days", "ok"), [(1, False), (2, True), (30, True)])
def test_startup_refuses_a_retention_window_shorter_than_the_retry_window(pg_dsn, factory, connect, days, ok):
    tenant = factory.tenant()
    with connect() as c:
        c.execute("UPDATE control.tenants SET retention_days = %s WHERE id = %s", (days, tenant))

    async def go():
        async with await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_retention", autocommit=True) as c:
            await check_retention_covers_retries(c, MARGIN)

    if ok:
        asyncio.run(go())
    else:
        with pytest.raises(ValueError, match="retention window"):
            asyncio.run(go())


def test_retention_process_exits_2_when_retention_is_too_short(pg_dsn, factory, connect):
    tenant = factory.tenant()
    with connect() as c:
        c.execute("UPDATE control.tenants SET retention_days = 1 WHERE id = %s", (tenant,))
    from tests.conftest import ROOT

    p = subprocess.run(
        [sys.executable, "-m", "relay_dataplane", "retention"],
        env={"PYTHONPATH": str(ROOT / "services" / "data-plane"), "RELAY_DSN": f"{pg_dsn} user=relay_retention"},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert p.returncode == 2 and "retention window" in p.stderr
