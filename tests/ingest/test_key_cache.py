"""The API-key cache: fewer database round trips, at the documented cost that a revoked key
keeps working until its cache entry expires."""

import asyncio

from relay_dataplane.ingest import KeyCache
from tests.ingest.conftest import auth

EVENTS = "/ingest/v1/events"
BODY = {"event_type": "order.created", "payload": {"n": 1}}


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_entries_expire_after_the_ttl():
    clock = Clock()
    cache = KeyCache(30, clock=clock)
    cache.put(b"k", ("tenant", ("events:write",)))
    clock.t = 29.9
    assert cache.get(b"k") == ("tenant", ("events:write",))
    clock.t = 30.0
    assert cache.get(b"k") is None


def test_a_zero_ttl_caches_nothing():
    cache = KeyCache(0)
    cache.put(b"k", ("tenant", ()))
    assert cache._entries == {}  # not even stored, so a disabled cache cannot grow
    assert cache.get(b"k") is None


def test_the_cache_is_bounded():
    clock = Clock()
    cache = KeyCache(30, max_entries=3, clock=clock)
    for i in range(10):
        clock.t = i
        cache.put(bytes([i]), ("t", ()))
    assert len(cache._entries) == 3
    assert cache.get(bytes([9])) is not None and cache.get(bytes([0])) is None  # the oldest went first


def revoke(connect, tenant):
    with connect() as c:
        c.execute("UPDATE control.api_keys SET revoked_at = now() WHERE tenant_id = %s", (tenant.id,))


def test_a_revoked_key_stops_working_once_its_entry_expires(api, connect, tenant):
    async def go(c):
        first = await c.post(EVENTS, json=BODY, headers=auth(tenant.key))
        revoke(connect, tenant)
        cached = await c.post(EVENTS, json=BODY, headers=auth(tenant.key))  # within the ttl
        await asyncio.sleep(0.6)
        expired = await c.post(EVENTS, json=BODY, headers=auth(tenant.key))
        return first, cached, expired

    first, cached, expired = api(go, key_cache_ttl=0.5)
    assert (first.status_code, cached.status_code, expired.status_code) == (202, 202, 401)


def test_without_the_cache_revocation_is_immediate(api, connect, tenant):
    async def go(c):
        first = await c.post(EVENTS, json=BODY, headers=auth(tenant.key))
        revoke(connect, tenant)
        return first, await c.post(EVENTS, json=BODY, headers=auth(tenant.key))

    first, second = api(go, key_cache_ttl=0)
    assert (first.status_code, second.status_code) == (202, 401)


def test_a_cached_key_still_gets_its_own_tenant_context(api, connect, make_tenant):
    """The cache must never mix tenants: each request still sets its own app.tenant_id."""
    a, b = make_tenant(), make_tenant()

    async def go(c):
        for _ in range(3):
            for t in (a, b):
                assert (await c.post(EVENTS, json=BODY, headers=auth(t.key))).status_code == 202

    api(go)
    with connect() as c:
        rows = dict(c.execute("SELECT tenant_id, count(*) FROM delivery.events GROUP BY tenant_id").fetchall())
    assert rows == {a.id: 3, b.id: 3}
