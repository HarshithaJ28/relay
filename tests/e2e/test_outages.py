"""Outages while the real processes run: PostgreSQL refusing connections, and RabbitMQ
stopping, each for several seconds in the middle of a delivery run. Every process must
stay up, reconnect on its own, and every delivery must still arrive."""

import asyncio
import time

import aio_pika
import psycopg
import pytest

from tests.conftest import RABBITMQ_IMAGE, _start_container, _stop_container, _wait_until
from tests.e2e.conftest import HOST, wait_for
from tests.e2e.test_processes import endpoint_delivery, statuses

OUTAGE = 5.0


def many(connect, factory, receiver, n):
    tenant = factory.tenant()
    first = endpoint_delivery(connect, factory, tenant, f"https://{HOST}:{receiver.port}/ok")
    row = factory.row(first)
    with connect() as c:
        c.execute("UPDATE control.endpoints SET concurrency_limit = 1000 WHERE id = %s", (row["endpoint_id"],))
        return [first] + [
            c.execute(
                "INSERT INTO delivery.deliveries (tenant_id, endpoint_id, event_id, event_created_at, next_attempt_at) "
                "VALUES (%s, %s, %s, %s, now() + %s * interval '100 milliseconds') RETURNING id",
                (tenant, row["endpoint_id"], row["event_id"], row["event_created_at"], i),
            ).fetchone()[0]
            for i in range(1, n)
        ]


def all_alive(fleet) -> bool:
    return all(p.poll() is None for _, p, _ in fleet.procs)


def test_a_database_outage_mid_run_is_survived(pg_dsn, connect, factory, fleet, receiver):
    ids = many(connect, factory, receiver, 60)  # spread over about 6 s
    fleet.start_all(workers=2)
    wait_for(lambda: len(receiver.requests) >= 5, 30, fleet, "the first deliveries")

    db = psycopg.conninfo.conninfo_to_dict(pg_dsn)["dbname"]
    admin = pg_dsn.replace(f"dbname={db}", "dbname=postgres") + " user=postgres"
    with psycopg.connect(admin, autocommit=True) as c:  # the database goes away: no new connections,
        c.execute(f"ALTER DATABASE {db} ALLOW_CONNECTIONS false")  # and every Relay session is cut
        c.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND usename LIKE 'relay_%%'",
            (db,),
        )
    try:
        time.sleep(OUTAGE)
        assert all_alive(fleet), fleet.logs()
    finally:
        with psycopg.connect(admin, autocommit=True) as c:
            c.execute(f"ALTER DATABASE {db} ALLOW_CONNECTIONS true")

    wait_for(lambda: all(s[0] == "succeeded" for s in statuses(connect, ids).values()), 90, fleet, "recovery")
    assert all_alive(fleet), fleet.logs()
    assert "reconnecting" in fleet.logs()  # the reconnect paths really ran
    assert set(fleet.stop_all().values()) == {0}, fleet.logs()


@pytest.fixture
def own_broker():
    """A RabbitMQ only this test uses, so stopping it affects nothing else."""
    container, host, port = _start_container(RABBITMQ_IMAGE, 5672, {})
    url = f"amqp://guest:guest@{host}:{port}/"

    async def ping():
        conn = await aio_pika.connect(url, timeout=5)
        await conn.close()

    _wait_until("RabbitMQ", lambda: asyncio.run(ping()))
    yield container, url
    _stop_container(container)


def rabbitmqctl(container, *args):
    code, out = container.get_wrapped_container().exec_run(["rabbitmqctl", *args])
    assert code == 0, out


def test_a_broker_outage_mid_run_is_survived(pg_dsn, connect, factory, fleet, receiver, own_broker):
    container, url = own_broker
    fleet.amqp_url = url
    ids = many(connect, factory, receiver, 60)
    fleet.start_all(workers=2)
    wait_for(lambda: len(receiver.requests) >= 5, 30, fleet, "the first deliveries")

    rabbitmqctl(container, "stop_app")  # the broker goes away; connections drop
    time.sleep(OUTAGE)
    assert all_alive(fleet), fleet.logs()
    rabbitmqctl(container, "start_app")

    wait_for(lambda: all(s[0] == "succeeded" for s in statuses(connect, ids).values()), 120, fleet, "recovery")
    assert all_alive(fleet), fleet.logs()
    assert set(fleet.stop_all().values()) == {0}, fleet.logs()
