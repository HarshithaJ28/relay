"""Test harness: a real PostgreSQL 16 cluster (and RabbitMQ for crash tests).

Nothing here is mocked. Migrations are applied exactly as deploy would apply
them (as a superuser), and every assertion connects as the real least-privilege
role it is testing.
"""
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import uuid

import psycopg
import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIGRATIONS = sorted((ROOT / "db" / "migrations").glob("*.sql"))
PG_BIN = "/usr/lib/postgresql/16/bin"
PG_PORT = 54329
LOGIN_ROLES = ["relay_owner", "relay_tenant", "relay_scheduler", "relay_publisher",
               "relay_worker", "relay_reaper", "relay_retention"]


def _sh(cmd: str, user: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    full = ["su", user, "-s", "/bin/bash", "-c", cmd] if user else ["bash", "-c", cmd]
    return subprocess.run(full, capture_output=True, text=True, check=check)


@pytest.fixture(scope="session")
def pg_dsn():
    data = tempfile.mkdtemp(prefix="relay-pg-")
    shutil.chown(data, "postgres", "postgres")
    _sh(f"{PG_BIN}/initdb -D {data}/d -A trust -U postgres >/dev/null", "postgres")
    _sh(f"{PG_BIN}/pg_ctl -D {data}/d -o '-p {PG_PORT} -k {data} -c listen_addresses=127.0.0.1' "
        f"-w -l {data}/log start >/dev/null", "postgres")
    base = f"host=127.0.0.1 port={PG_PORT} dbname=postgres"
    with psycopg.connect(f"{base} user=postgres", autocommit=True) as c:
        c.execute("CREATE DATABASE relay")
    dsn = f"host=127.0.0.1 port={PG_PORT} dbname=relay"
    with psycopg.connect(f"{dsn} user=postgres", autocommit=True) as c:
        for m in MIGRATIONS:
            sql = m.read_text().split("-- migrate:up", 1)[1].split("-- migrate:down", 1)[0]
            c.execute(sql)
        for r in LOGIN_ROLES:
            c.execute(f"ALTER ROLE {r} LOGIN")
    yield dsn
    _sh(f"{PG_BIN}/pg_ctl -D {data}/d -m immediate stop >/dev/null", "postgres", check=False)
    shutil.rmtree(data, ignore_errors=True)


@pytest.fixture
def connect(pg_dsn):
    opened = []

    def _connect(role: str = "postgres", autocommit: bool = True) -> psycopg.Connection:
        c = psycopg.connect(f"{pg_dsn} user={role}", autocommit=autocommit)
        opened.append(c)
        return c

    yield _connect
    for c in opened:
        try:
            c.close()
        except Exception:
            pass


@pytest.fixture(autouse=True)
def clean(pg_dsn):
    """Empty all tables before each test (superuser; tests themselves use real roles)."""
    with psycopg.connect(f"{pg_dsn} user=postgres", autocommit=True) as c:
        c.execute("TRUNCATE delivery.outbox, delivery.delivery_attempts, delivery.deliveries, "
                  "delivery.dispatch_locks, delivery.events, control.endpoints, control.tenants CASCADE")
    yield


class Factory:
    """Seeds synthetic rows as superuser. Synthetic data only."""

    def __init__(self, dsn):
        self.dsn = dsn

    def _su(self):
        return psycopg.connect(f"{self.dsn} user=postgres", autocommit=True)

    def tenant(self) -> uuid.UUID:
        with self._su() as c:
            return c.execute("INSERT INTO control.tenants (name) VALUES ('t') RETURNING id").fetchone()[0]

    def delivery(self, tenant=None, status="scheduled", **cols) -> uuid.UUID:
        tenant = tenant or self.tenant()
        with self._su() as c:
            ep = c.execute("INSERT INTO control.endpoints (tenant_id, url, secret_ciphertext) "
                           "VALUES (%s, 'https://example.invalid/hook', '\\x00') RETURNING id",
                           (tenant,)).fetchone()[0]
            ev = uuid.uuid4()
            created = c.execute("INSERT INTO delivery.events (id, tenant_id, payload) "
                                "VALUES (%s, %s, '{\"k\": 1}') RETURNING created_at", (ev, tenant)).fetchone()[0]
            cols = {"status": status, **cols}
            names = ", ".join(cols)
            ph = ", ".join(["%s"] * len(cols))
            return c.execute(
                f"INSERT INTO delivery.deliveries (tenant_id, endpoint_id, event_id, event_created_at, {names}) "
                f"VALUES (%s, %s, %s, %s, {ph}) RETURNING id",
                (tenant, ep, ev, created, *cols.values())).fetchone()[0]

    def row(self, delivery_id) -> dict:
        with self._su() as c:
            cur = c.execute("SELECT * FROM delivery.deliveries WHERE id = %s", (delivery_id,))
            names = [d.name for d in cur.description]
            return dict(zip(names, cur.fetchone()))


@pytest.fixture
def factory(pg_dsn):
    return Factory(pg_dsn)


# ---------------- RabbitMQ (crash-recovery tests only) ----------------

@pytest.fixture(scope="session")
def rabbit_url():
    if shutil.which("rabbitmq-server") is None:
        pytest.fail("rabbitmq-server not installed (crash-recovery tests must run, not skip)")
    _sh("rabbitmq-server -detached", "rabbitmq", check=False)
    deadline = time.time() + 120
    while True:  # the node takes a while to boot and await_startup errors if it is not up yet
        r = _sh("rabbitmqctl await_startup --timeout 10", "rabbitmq", check=False)
        if r.returncode == 0:
            break
        if time.time() > deadline:
            pytest.fail(f"RabbitMQ failed to start: {r.stderr[-300:]}")  # fail loudly, never skip silently
        time.sleep(2)
    yield "amqp://guest:guest@127.0.0.1:5672/"
    _sh("rabbitmqctl stop", "rabbitmq", check=False)
