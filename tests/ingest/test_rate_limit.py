"""Per-tenant ingestion rate limits: a token bucket in real Valkey."""

import asyncio
import time

import pytest

from tests.ingest.conftest import auth

EVENTS = "/ingest/v1/events"
BODY = {"event_type": "order.created", "payload": {"n": 1}}


def limits(connect, tenant, rate, burst):
    with connect() as c:
        c.execute(
            "UPDATE control.tenants SET ingest_rate_per_sec = %s, ingest_burst = %s WHERE id = %s",
            (rate, burst, tenant.id),
        )


def count_events(connect, tenant):
    with connect() as c:
        return c.execute("SELECT count(*) FROM delivery.events WHERE tenant_id = %s", (tenant.id,)).fetchone()[0]


def test_burst_then_429_with_retry_after_then_refill(api, connect, tenant, valkey_clean):
    limits(connect, tenant, rate=2, burst=3)

    async def go(c):
        burst = [await c.post(EVENTS, json=BODY, headers=auth(tenant.key)) for _ in range(4)]
        await asyncio.sleep(0.6)  # 2 tokens per second: one more after half a second
        return burst, await c.post(EVENTS, json=BODY, headers=auth(tenant.key))

    burst, refilled = api(go, valkey_url=valkey_clean)
    assert [r.status_code for r in burst] == [202, 202, 202, 429]
    refused = burst[-1]
    assert refused.json()["type"] == "/problems/rate-limited"
    assert refused.headers["retry-after"] == "1"
    assert refused.headers["content-type"].startswith("application/problem+json")
    assert refilled.status_code == 202
    assert count_events(connect, tenant) == 4  # the refused request wrote nothing


def test_tenants_have_separate_buckets(api, connect, make_tenant, valkey_clean):
    a, b = make_tenant(), make_tenant()
    limits(connect, a, rate=1, burst=1)

    async def go(c):
        return [(await c.post(EVENTS, json=BODY, headers=auth(t.key))).status_code for t in (a, a, b, b, b)]

    assert api(go, valkey_url=valkey_clean) == [202, 429, 202, 202, 202]


def test_unauthenticated_requests_do_not_use_a_tenants_tokens(api, connect, tenant, valkey_clean):
    limits(connect, tenant, rate=1, burst=2)

    async def go(c):
        bad = [await c.post(EVENTS, json=BODY, headers={"Content-Type": "application/json"}) for _ in range(10)]
        good = [await c.post(EVENTS, json=BODY, headers=auth(tenant.key)) for _ in range(2)]
        return bad, good

    bad, good = api(go, valkey_url=valkey_clean)
    assert {r.status_code for r in bad} == {401} and [r.status_code for r in good] == [202, 202]


def test_concurrent_requests_cannot_overspend_the_bucket(api, connect, tenant, valkey_clean):
    limits(connect, tenant, rate=1, burst=5)

    async def go(c):
        return await asyncio.gather(*(c.post(EVENTS, json=BODY, headers=auth(tenant.key)) for _ in range(20)))

    codes = [r.status_code for r in api(go, pool_size=20, valkey_url=valkey_clean)]
    assert codes.count(202) == 5 and codes.count(429) == 15


@pytest.mark.parametrize("rate", [1, 50])
def test_retry_after_is_whole_seconds_and_at_least_one(api, connect, tenant, valkey_clean, rate):
    limits(connect, tenant, rate=rate, burst=1)

    async def go(c):
        await c.post(EVENTS, json=BODY, headers=auth(tenant.key))
        return await c.post(EVENTS, json=BODY, headers=auth(tenant.key))

    r = api(go, valkey_url=valkey_clean)
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1


def test_unreachable_valkey_lets_requests_through(api, tenant, connect):
    limits(connect, tenant, rate=1, burst=1)
    started = time.monotonic()

    async def go(c):
        return [(await c.post(EVENTS, json=BODY, headers=auth(tenant.key))).status_code for _ in range(3)]

    assert api(go, valkey_url="valkey://127.0.0.1:1/0") == [202, 202, 202]
    assert time.monotonic() - started < 10
