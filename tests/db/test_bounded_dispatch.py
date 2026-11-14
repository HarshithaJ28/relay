"""Bounded dispatching: endpoint concurrency limits, tenant dispatch caps and fairness."""

import asyncio
import threading

import psycopg

from relay_dataplane.processes import dispatch_pass
from relay_dataplane.settings import Settings


def more(connect, factory, d, n, due="now()"):
    """n more scheduled deliveries for the same endpoint and event as d."""
    row = factory.row(d)
    with connect() as c:
        return [
            c.execute(
                "INSERT INTO delivery.deliveries (tenant_id, endpoint_id, event_id, event_created_at, next_attempt_at) "
                f"VALUES (%s, %s, %s, %s, {due}) RETURNING id",
                (row["tenant_id"], row["endpoint_id"], row["event_id"], row["event_created_at"]),
            ).fetchone()[0]
            for _ in range(n)
        ]


def endpoint_of(factory, d):
    return factory.row(d)["endpoint_id"]


def set_endpoint(connect, endpoint, **cols):
    with connect() as c:
        for k, v in cols.items():
            c.execute(f"UPDATE control.endpoints SET {k} = %s WHERE id = %s", (v, endpoint))


def set_tenant(connect, tenant, **cols):
    with connect() as c:
        for k, v in cols.items():
            c.execute(f"UPDATE control.tenants SET {k} = %s WHERE id = %s", (v, tenant))


def dispatch(connect, tenant, limit=100):
    with connect("relay_scheduler") as c:
        return c.execute("SELECT delivery.dispatch_batch(%s, %s)", (tenant, limit)).fetchone()[0]


def statuses(connect, endpoint):
    with connect() as c:
        rows = c.execute(
            "SELECT status, count(*) FROM delivery.deliveries WHERE endpoint_id = %s GROUP BY status", (endpoint,)
        ).fetchall()
    return dict(rows)


def finish_one(connect, endpoint, status="succeeded"):
    """What a worker finishing a delivery does to capacity: one active row becomes terminal."""
    with connect() as c:
        c.execute(
            "UPDATE delivery.deliveries SET status = %s, dispatch_token_hash = NULL WHERE id = ("
            "SELECT id FROM delivery.deliveries WHERE endpoint_id = %s AND status = 'queued' LIMIT 1)",
            (status, endpoint),
        )


def test_an_endpoint_never_has_more_than_its_limit_active(connect, factory):
    d = factory.delivery()
    ep, tenant = endpoint_of(factory, d), factory.row(d)["tenant_id"]
    more(connect, factory, d, 9)
    set_endpoint(connect, ep, concurrency_limit=3)
    assert dispatch(connect, tenant) == 3
    assert dispatch(connect, tenant) == 0  # full: the backlog waits in PostgreSQL
    finish_one(connect, ep)
    assert dispatch(connect, tenant) == 1  # one slot freed, one more dispatched
    assert statuses(connect, ep) == {"queued": 3, "succeeded": 1, "scheduled": 6}


def test_in_flight_deliveries_count_against_the_limit(connect, factory):
    d = factory.delivery()
    ep, tenant = endpoint_of(factory, d), factory.row(d)["tenant_id"]
    more(connect, factory, d, 4)
    set_endpoint(connect, ep, concurrency_limit=2)
    dispatch(connect, tenant)
    with connect() as c:  # one of the two becomes in flight
        c.execute(
            "UPDATE delivery.deliveries SET status = 'in_flight', dispatch_token_hash = NULL, "
            "lease_token_hash = sha256('x'), lease_until = now() + interval '1 minute' WHERE id = ("
            "SELECT id FROM delivery.deliveries WHERE endpoint_id = %s AND status = 'queued' LIMIT 1)",
            (ep,),
        )
    assert dispatch(connect, tenant) == 0


def test_a_full_endpoint_does_not_hold_back_its_neighbours(connect, factory):
    tenant = factory.tenant()
    slow, fast = factory.delivery(tenant=tenant), factory.delivery(tenant=tenant)
    more(connect, factory, slow, 20, due="now() - interval '1 hour'")  # older work, at the front of the line
    set_endpoint(connect, endpoint_of(factory, slow), concurrency_limit=2)
    assert dispatch(connect, tenant) == 3  # 2 for the slow endpoint, and the fast one is not starved
    assert statuses(connect, endpoint_of(factory, fast)) == {"queued": 1}


def test_the_tenant_cap_limits_the_whole_tenant(connect, factory):
    tenant = factory.tenant()
    for _ in range(3):
        more(connect, factory, factory.delivery(tenant=tenant), 3)  # 3 endpoints x 4 due
    set_tenant(connect, tenant, dispatch_cap=5)
    assert dispatch(connect, tenant) == 5
    assert dispatch(connect, tenant) == 0


def test_oldest_due_work_goes_first(connect, factory):
    d = factory.delivery()
    ep, tenant = endpoint_of(factory, d), factory.row(d)["tenant_id"]
    [old] = more(connect, factory, d, 1, due="now() - interval '1 day'")
    set_endpoint(connect, ep, concurrency_limit=1)
    dispatch(connect, tenant)
    assert factory.row(old)["status"] == "queued" and factory.row(d)["status"] == "scheduled"


def test_disabled_and_breaker_open_endpoints_are_not_dispatched(connect, factory):
    tenant = factory.tenant()
    disabled, tripped = factory.delivery(tenant=tenant), factory.delivery(tenant=tenant)
    set_endpoint(connect, endpoint_of(factory, disabled), status="disabled")
    with connect() as c:
        c.execute(
            "UPDATE control.endpoints SET status = 'breaker_open', breaker_until = now() + interval '1 minute' "
            "WHERE id = %s",
            (endpoint_of(factory, tripped),),
        )
    assert dispatch(connect, tenant) == 0


def test_one_busy_tenant_cannot_take_the_whole_pass(pg_dsn, connect, factory):
    busy, quiet = factory.tenant(), factory.tenant()
    d = factory.delivery(tenant=busy)
    more(connect, factory, d, 300, due="now() - interval '1 hour'")  # the busy tenant is also older
    set_endpoint(connect, endpoint_of(factory, d), concurrency_limit=1000)
    set_tenant(connect, busy, dispatch_cap=1000)
    q = factory.delivery(tenant=quiet)

    async def go():
        async with await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_scheduler", autocommit=True) as c:
            return await dispatch_pass(c, Settings("x", "y", dispatch_batch=100))

    dispatched, tenants = asyncio.run(go())
    assert tenants == 2 and dispatched == 101  # the busy tenant is held to one batch per pass
    assert factory.row(q)["status"] == "queued"


def test_concurrent_schedulers_never_exceed_the_limit(connect, factory):
    d = factory.delivery()
    ep, tenant = endpoint_of(factory, d), factory.row(d)["tenant_id"]
    more(connect, factory, d, 49)
    set_endpoint(connect, ep, concurrency_limit=7)
    results = []

    def run():
        for _ in range(5):
            results.append(dispatch(connect, tenant))

    threads = [threading.Thread(target=run) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(results) == 7
    assert statuses(connect, ep)["queued"] == 7


def test_under_the_tenant_cap_the_oldest_work_across_endpoints_wins(connect, factory):
    tenant = factory.tenant()
    newer, older = factory.delivery(tenant=tenant), factory.delivery(tenant=tenant)
    with connect() as c:
        c.execute("UPDATE delivery.deliveries SET next_attempt_at = now() - interval '1 hour' WHERE id = %s", (older,))
    set_tenant(connect, tenant, dispatch_cap=1)
    dispatch(connect, tenant)
    assert factory.row(older)["status"] == "queued" and factory.row(newer)["status"] == "scheduled"


def test_a_second_scheduler_cannot_count_capacity_another_is_using(pg_dsn, connect, factory):
    """Deterministic version of the race the tenant lock prevents. A fills the endpoint and has
    not committed. Meanwhile an older delivery for the same endpoint arrives, so B would rank
    it first, find it unlocked, and (not seeing A's rows) count the endpoint as empty. The
    tenant lock makes B skip the tenant instead."""
    d = factory.delivery()
    ep, tenant = endpoint_of(factory, d), factory.row(d)["tenant_id"]
    more(connect, factory, d, 3)
    set_endpoint(connect, ep, concurrency_limit=2)
    with connect() as c:  # the tenant has been dispatched before, so its lock row exists
        c.execute("INSERT INTO delivery.dispatch_locks (tenant_id) VALUES (%s)", (tenant,))
    with psycopg.connect(f"{pg_dsn} user=relay_scheduler") as a, psycopg.connect(f"{pg_dsn} user=relay_scheduler") as b:
        assert a.execute("SELECT delivery.dispatch_batch(%s, 100)", (tenant,)).fetchone()[0] == 2  # not committed
        more(connect, factory, d, 1, due="now() - interval '1 day'")  # committed, older than everything
        assert b.execute("SELECT delivery.dispatch_batch(%s, 100)", (tenant,)).fetchone()[0] == 0
        b.commit()
        a.commit()
    assert statuses(connect, ep)["queued"] == 2
