"""Row-level security for relay_tenant, table by table: with app.tenant_id set, only that
tenant's rows are visible or writable; without it, nothing is."""

import uuid

import psycopg
import pytest

from relay_dataplane import api_keys
from tests.ingest.conftest import add_endpoint, subscribe

TABLES = [  # (table, tenant column)
    ("control.tenants", "id"),
    ("control.endpoints", "tenant_id"),
    ("control.api_keys", "tenant_id"),
    ("control.event_types", "tenant_id"),
    ("control.subscriptions", "tenant_id"),
    ("delivery.events", "tenant_id"),
    ("delivery.deliveries", "tenant_id"),
    ("delivery.idempotency_keys", "tenant_id"),
]


@pytest.fixture
def two_tenants(pg_dsn, factory):
    ids = []
    for _ in range(2):
        d = factory.delivery()
        tid = factory.row(d)["tenant_id"]
        with psycopg.connect(f"{pg_dsn} user=postgres", autocommit=True) as su:
            subscribe(su, tid, add_endpoint(su, tid), "order.created")
            ev = factory.row(d)["event_id"]
            su.execute(
                "INSERT INTO delivery.idempotency_keys (tenant_id, key, event_id, event_created_at, payload_sha256, "
                "expires_at) VALUES (%s, 'k', %s, now(), sha256('x'), now() + interval '1 day')",
                (tid, ev),
            )
        with psycopg.connect(f"{pg_dsn} user=relay_tenant", autocommit=True) as c:
            api_keys.create(c, tid)
        ids.append(tid)
    return ids


def visible(pg_dsn, tenant, table, column):
    with psycopg.connect(f"{pg_dsn} user=relay_tenant") as c:
        if tenant is not None:
            c.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant),))
        return {r[0] for r in c.execute(f"SELECT {column} FROM {table}")}


@pytest.mark.parametrize(("table", "column"), TABLES)
def test_each_tenant_sees_only_its_own_rows(pg_dsn, two_tenants, table, column):
    a, b = two_tenants
    assert visible(pg_dsn, a, table, column) == {a}
    assert visible(pg_dsn, b, table, column) == {b}


@pytest.mark.parametrize(("table", "column"), TABLES)
def test_without_a_tenant_nothing_is_visible(pg_dsn, two_tenants, table, column):
    assert visible(pg_dsn, None, table, column) == set()


def test_a_tenant_cannot_insert_rows_for_another_tenant(pg_dsn, two_tenants):
    a, b = two_tenants
    with psycopg.connect(f"{pg_dsn} user=relay_tenant") as c:
        c.execute("SELECT set_config('app.tenant_id', %s, true)", (str(a),))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):  # row-level security policy violation
            c.execute(
                "INSERT INTO delivery.events (id, tenant_id, event_type, payload, payload_sha256) "
                "VALUES (%s, %s, 'order.created', '{}', sha256('{}'))",
                (uuid.uuid4(), b),
            )


def test_tenant_role_cannot_read_endpoint_urls_or_secrets(pg_dsn, two_tenants):
    a, _ = two_tenants
    for column in ("url", "signing_secrets"):
        with psycopg.connect(f"{pg_dsn} user=relay_tenant") as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT set_config('app.tenant_id', %s, true)", (str(a),))
            c.execute(f"SELECT {column} FROM control.endpoints")


def test_tenant_role_cannot_read_key_hashes(pg_dsn, two_tenants):
    a, _ = two_tenants
    with psycopg.connect(f"{pg_dsn} user=relay_tenant") as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
        c.execute("SELECT set_config('app.tenant_id', %s, true)", (str(a),))
        c.execute("SELECT key_hash FROM control.api_keys")


def test_no_application_role_bypasses_row_level_security(connect):
    with connect() as c:
        bypass = c.execute(
            "SELECT rolname FROM pg_roles WHERE rolname LIKE 'relay_%%' AND (rolbypassrls OR rolsuper)"
        ).fetchall()
    assert bypass == []
