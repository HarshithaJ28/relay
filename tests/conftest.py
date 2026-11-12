"""Test harness: a real PostgreSQL 16 server and a real RabbitMQ broker.

Nothing here is mocked. Migrations are applied exactly as deploy would apply
them (as a superuser), and every assertion connects as the real least-privilege
role it is testing.

Where the services come from (per service, chosen by environment variable):

- Default: testcontainers starts throwaway `postgres:16` and `rabbitmq:3.13`
  containers on random host ports and removes them afterwards. Needs a running
  Docker daemon (Docker Desktop on macOS/Windows, dockerd on Linux).
- RELAY_TEST_PG_DSN="host=127.0.0.1 port=5432": use an already-running server,
  for example `docker compose up -d postgres`. Give libpq keywords without
  user or dbname; the superuser must be `postgres`, and the server must use
  trust authentication (the login roles have no passwords). A fresh database
  with a random name is created for the session and dropped at the end.
- RELAY_TEST_AMQP_URL="amqp://guest:guest@127.0.0.1:5672/": use an
  already-running RabbitMQ (each test uses its own queue and deletes it).

If a service cannot be started or reached, the tests fail. They never skip.
"""
import asyncio
import os
import pathlib
import time
import uuid

import aio_pika
import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIGRATIONS = sorted((ROOT / "db" / "migrations").glob("*.sql"))
PG_IMAGE = "postgres:16"
RABBITMQ_IMAGE = "rabbitmq:3.13"
LOGIN_ROLES = ["relay_owner", "relay_tenant", "relay_scheduler", "relay_publisher",
               "relay_worker", "relay_reaper", "relay_retention"]
DOCKER_HELP = ("start Docker, or point the tests at running services with RELAY_TEST_PG_DSN "
               "and RELAY_TEST_AMQP_URL (see tests/conftest.py)")


def _start_container(image: str, port: int, env: dict[str, str]):
    """Start a throwaway container with testcontainers; fail loudly if Docker is not usable."""
    try:
        from testcontainers.core.container import DockerContainer
        container = DockerContainer(image).with_exposed_ports(port).with_envs(**env)
        container.start()
    except Exception as e:  # docker not installed, daemon down, image pull failed, ...
        pytest.fail(f"could not start {image} with testcontainers ({type(e).__name__}: {e}); {DOCKER_HELP}")
    return container, container.get_container_host_ip(), int(container.get_exposed_port(port))


def _wait_until(what: str, attempt, timeout: float = 120):
    """Call attempt() until it stops raising; fail the session (never skip) on timeout."""
    deadline = time.time() + timeout
    while True:
        try:
            return attempt()
        except Exception as e:
            if time.time() > deadline:
                pytest.fail(f"{what} not reachable after {timeout:.0f} s: {type(e).__name__}: {e}")
            time.sleep(1)


@pytest.fixture(scope="session")
def pg_dsn():
    external = os.environ.get("RELAY_TEST_PG_DSN")
    container = None
    if external:
        given = conninfo_to_dict(external)
        if given.keys() & {"user", "dbname"}:
            pytest.fail("RELAY_TEST_PG_DSN must not set user or dbname; the harness picks them")
        server = external
    else:
        # trust auth: this server lives only for the test session and listens on a random port
        container, host, port = _start_container(
            PG_IMAGE, 5432, {"POSTGRES_HOST_AUTH_METHOD": "trust"})
        server = f"host={host} port={port}"

    # The image restarts the server once after init; only the final server accepts TCP.
    _wait_until("PostgreSQL", lambda: psycopg.connect(f"{server} dbname=postgres user=postgres",
                                                      connect_timeout=5).close())
    db = f"relay_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(f"{server} dbname=postgres user=postgres", autocommit=True) as c:
        version = c.execute("SHOW server_version_num").fetchone()[0]
        if int(version) // 10000 != 16:
            pytest.fail(f"PostgreSQL 16 required, server is {version}")
        c.execute(f"CREATE DATABASE {db}")
    dsn = f"{server} dbname={db}"
    with psycopg.connect(f"{dsn} user=postgres", autocommit=True) as c:
        for m in MIGRATIONS:
            sql = m.read_text().split("-- migrate:up", 1)[1].split("-- migrate:down", 1)[0]
            c.execute(sql)
        for r in LOGIN_ROLES:
            c.execute(f"ALTER ROLE {r} LOGIN")
    try:
        psycopg.connect(f"{dsn} user=relay_worker", connect_timeout=5).close()
    except psycopg.OperationalError as e:
        pytest.fail(f"cannot log in as relay_worker without a password; the test server needs trust auth: {e}")
    yield dsn
    if container is not None:
        container.stop()
    else:
        with psycopg.connect(f"{server} dbname=postgres user=postgres", autocommit=True) as c:
            c.execute(f"DROP DATABASE IF EXISTS {db} WITH (FORCE)")


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

async def _amqp_ping(url: str):
    conn = await aio_pika.connect(url, timeout=5)
    await conn.close()


@pytest.fixture(scope="session")
def rabbit_url():
    url = os.environ.get("RELAY_TEST_AMQP_URL")
    container = None
    if not url:
        # the official image lets guest/guest connect from outside the container
        container, host, port = _start_container(RABBITMQ_IMAGE, 5672, {})
        url = f"amqp://guest:guest@{host}:{port}/"
    # the node takes a while to boot; a successful AMQP handshake is the readiness check
    _wait_until("RabbitMQ", lambda: asyncio.run(_amqp_ping(url)))
    yield url
    if container is not None:
        container.stop()
