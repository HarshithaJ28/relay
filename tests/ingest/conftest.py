"""Fixtures for the ingestion API: a tenant with an API key, event types, endpoints and
subscriptions, and a client that talks to the real app over ASGI (no network)."""

import asyncio
import uuid
from dataclasses import dataclass

import httpx
import psycopg
import pytest
import valkey.asyncio
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from relay_dataplane import api_keys
from relay_dataplane.endpoint_secrets import new_entry
from relay_dataplane.ingest import create_app
from relay_dataplane.ratelimit import RateLimiter
from tests.conftest import TEST_KEYRING, TEST_SECRET


@dataclass
class Tenant:
    id: uuid.UUID
    key: str
    subscribed: list[uuid.UUID]  # enabled endpoints subscribed to order.created
    disabled: uuid.UUID
    other_type: uuid.UUID


def add_endpoint(su, tenant_id, status="enabled") -> uuid.UUID:
    ep = uuid.uuid4()
    su.execute(
        "INSERT INTO control.endpoints (id, tenant_id, url, signing_secrets, status) VALUES (%s, %s, %s, %s, %s)",
        (
            ep,
            tenant_id,
            f"https://{ep}.example.com/hook",
            Jsonb([new_entry(TEST_KEYRING, str(ep), "s1", TEST_SECRET)]),
            status,
        ),
    )
    return ep


def subscribe(su, tenant_id, endpoint_id, type_name):
    et = su.execute(
        "INSERT INTO control.event_types (tenant_id, name) VALUES (%s, %s) "
        "ON CONFLICT (tenant_id, name) DO UPDATE SET name = excluded.name RETURNING id",
        (tenant_id, type_name),
    ).fetchone()[0]
    su.execute(
        "INSERT INTO control.subscriptions (tenant_id, endpoint_id, event_type_id) VALUES (%s, %s, %s)",
        (tenant_id, endpoint_id, et),
    )


@pytest.fixture
def make_tenant(pg_dsn, factory):
    def make(scopes=api_keys.SCOPES, retention_days=30) -> Tenant:
        tid = factory.tenant()
        with psycopg.connect(f"{pg_dsn} user=postgres", autocommit=True) as su:
            su.execute("UPDATE control.tenants SET retention_days = %s WHERE id = %s", (retention_days, tid))
            subscribed = [add_endpoint(su, tid), add_endpoint(su, tid)]
            disabled = add_endpoint(su, tid, "disabled")
            other = add_endpoint(su, tid)
            for ep in (*subscribed, disabled):
                subscribe(su, tid, ep, "order.created")
            subscribe(su, tid, other, "user.deleted")
            su.execute("INSERT INTO control.event_types (tenant_id, name) VALUES (%s, 'nobody.listens')", (tid,))
        with psycopg.connect(f"{pg_dsn} user=relay_tenant", autocommit=True) as conn:
            key, _ = api_keys.create(conn, tid, "test", scopes)
        return Tenant(tid, key, subscribed, disabled, other)

    return make


@pytest.fixture
def tenant(make_tenant):
    return make_tenant()


@pytest.fixture
def api(pg_dsn):
    """api(fn, pool_size=4): run `await fn(client)` against the real app; returns its result."""

    def run(fn, pool_size=4, window=None, valkey_url=None, key_cache_ttl=30.0):
        async def go():
            pool = AsyncConnectionPool(
                f"{pg_dsn} user=relay_tenant", min_size=1, max_size=pool_size, kwargs={"autocommit": True}, open=False
            )
            await pool.open()
            limiter = RateLimiter(valkey.asyncio.Valkey.from_url(valkey_url)) if valkey_url else None
            try:
                kwargs = {"limiter": limiter, "key_cache_ttl": key_cache_ttl}
                kwargs |= {"idempotency_window": window} if window is not None else {}
                app = create_app(pool, **kwargs)
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url="http://relay.test") as client:
                    return await fn(client)
            finally:
                await pool.close()
                if limiter is not None:
                    await limiter.aclose()

        return asyncio.run(go())

    return run


def auth(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
