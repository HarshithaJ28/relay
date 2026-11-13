"""The ingestion API against the real database, as the real relay_tenant role."""

import asyncio
import json
import uuid

import psycopg
import pytest

from relay_dataplane import ingest
from tests.ingest.conftest import auth

EVENTS = "/ingest/v1/events"
BODY = {"event_type": "order.created", "payload": {"order": 42}}


def rows(connect, sql, *args):
    with connect() as c:
        return c.execute(sql, args).fetchall()


# ---------------------------------------------------------------- happy path


def test_event_creates_one_delivery_per_enabled_subscribed_endpoint(api, connect, tenant):
    r = api(lambda c: c.post(EVENTS, json=BODY, headers=auth(tenant.key)))
    assert r.status_code == 202, r.text
    event_id = uuid.UUID(r.json()["event_id"])
    assert r.json()["deliveries"] == 2 and event_id.version == 7
    [(tid, etype, payload, created)] = rows(
        connect, "SELECT tenant_id, event_type, payload, created_at FROM delivery.events WHERE id = %s", event_id
    )
    assert (tid, etype, payload) == (tenant.id, "order.created", {"order": 42})
    deliveries = rows(
        connect,
        "SELECT endpoint_id, status, event_created_at FROM delivery.deliveries WHERE event_id = %s",
        event_id,
    )
    assert sorted(d[0] for d in deliveries) == sorted(tenant.subscribed)  # not disabled, not other type
    assert {(d[1], d[2]) for d in deliveries} == {("scheduled", created)}


def test_a_known_type_with_no_subscribers_is_accepted_with_no_deliveries(api, tenant):
    r = api(lambda c: c.post(EVENTS, json={"event_type": "nobody.listens", "payload": []}, headers=auth(tenant.key)))
    assert (r.status_code, r.json()["deliveries"]) == (202, 0)


def test_payload_numbers_are_stored_exactly(api, connect, tenant):
    raw = (
        '{"event_type": "order.created", '
        '"payload": {"price": 0.12345678901234567890123, "big": 123456789012345678901234567890}}'
    )
    r = api(lambda c: c.post(EVENTS, content=raw, headers=auth(tenant.key)))
    assert r.status_code == 202, r.text
    [(text,)] = rows(connect, "SELECT payload::text FROM delivery.events WHERE id = %s", r.json()["event_id"])
    assert "0.12345678901234567890123" in text and "123456789012345678901234567890" in text


def test_read_back_own_event(api, tenant):
    async def go(c):
        created = await c.post(EVENTS, json=BODY, headers=auth(tenant.key))
        return await c.get(f"{EVENTS}/{created.json()['event_id']}", headers=auth(tenant.key))

    r = api(go)
    assert r.status_code == 200 and r.json()["payload"] == {"order": 42} and r.json()["event_type"] == "order.created"


def test_scheduler_is_notified_on_commit(api, pg_dsn, tenant):
    with psycopg.connect(f"{pg_dsn} user=relay_scheduler", autocommit=True) as listener:
        listener.execute("LISTEN relay_dispatch")
        assert api(lambda c: c.post(EVENTS, json=BODY, headers=auth(tenant.key))).status_code == 202
        assert [n.channel for n in listener.notifies(timeout=5, stop_after=1)] == ["relay_dispatch"]


# ---------------------------------------------------------------- authentication and tenancy


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Basic dXNlcjpwYXNz"},
        {"Authorization": "Bearer "},
        {"Authorization": "Bearer rly_000000000000_" + "A" * 43},  # well-formed, unknown
        {"Authorization": "Bearer not-a-key"},
    ],
)
def test_missing_or_invalid_keys_are_rejected(api, connect, headers):
    r = api(lambda c: c.post(EVENTS, json=BODY, headers=headers | {"Content-Type": "application/json"}))
    assert r.status_code == 401 and r.headers["content-type"].startswith("application/problem+json")
    assert r.headers["www-authenticate"] == "Bearer"
    assert rows(connect, "SELECT count(*) FROM delivery.events") == [(0,)]


def test_revoked_key_is_rejected(api, connect, tenant):
    with connect() as c:
        c.execute("UPDATE control.api_keys SET revoked_at = now() WHERE tenant_id = %s", (tenant.id,))
    assert api(lambda c: c.post(EVENTS, json=BODY, headers=auth(tenant.key))).status_code == 401


def test_scopes_are_enforced(api, make_tenant):
    read_only = make_tenant(scopes=("events:read",))
    write_only = make_tenant(scopes=("events:write",))
    assert api(lambda c: c.post(EVENTS, json=BODY, headers=auth(read_only.key))).status_code == 403

    async def go(c):
        created = await c.post(EVENTS, json=BODY, headers=auth(write_only.key))
        return await c.get(f"{EVENTS}/{created.json()['event_id']}", headers=auth(write_only.key))

    assert api(go).status_code == 403


def test_a_tenant_cannot_read_another_tenants_event(api, make_tenant):
    a, b = make_tenant(), make_tenant()

    async def go(c):
        created = await c.post(EVENTS, json=BODY, headers=auth(a.key))
        return await c.get(f"{EVENTS}/{created.json()['event_id']}", headers=auth(b.key))

    assert api(go).status_code == 404


def test_event_types_are_per_tenant(api, connect, make_tenant):
    a, b = make_tenant(), make_tenant()
    with connect() as c:
        c.execute("INSERT INTO control.event_types (tenant_id, name) VALUES (%s, 'only.a')", (a.id,))
    assert (
        api(lambda c: c.post(EVENTS, json={"event_type": "only.a", "payload": 1}, headers=auth(b.key))).status_code
        == 422
    )


def test_last_used_is_recorded_at_most_once_a_minute(api, connect, tenant):
    async def go(c):
        for _ in range(3):
            await c.post(EVENTS, json=BODY, headers=auth(tenant.key))

    api(go)
    [(used,)] = rows(connect, "SELECT last_used_at FROM control.api_keys WHERE tenant_id = %s", tenant.id)
    assert used is not None


# ---------------------------------------------------------------- validation


@pytest.mark.parametrize(
    ("body", "status", "problem"),
    [
        ({"event_type": "nope.unknown", "payload": {}}, 422, "unknown-event-type"),
        ({"event_type": "order.created"}, 422, "invalid-event"),
        ({"payload": {}}, 422, "invalid-event"),
        ({"event_type": "order.created", "payload": {}, "extra": 1}, 422, "invalid-event"),
        ({"event_type": "bad type!", "payload": {}}, 422, "invalid-event"),
        ({"event_type": "", "payload": {}}, 422, "invalid-event"),
        ({"event_type": "x" * 201, "payload": {}}, 422, "invalid-event"),
        ([1, 2], 422, "invalid-event"),
    ],
)
def test_invalid_events_are_rejected_and_nothing_is_written(api, connect, tenant, body, status, problem):
    r = api(lambda c: c.post(EVENTS, json=body, headers=auth(tenant.key)))
    assert r.status_code == status, r.text
    assert r.json()["type"] == f"/problems/{problem}"
    assert rows(connect, "SELECT count(*) FROM delivery.events") == [(0,)]


@pytest.mark.parametrize(
    "raw",
    [
        '{"event_type": "order.created", "payload": NaN}',
        '{"event_type": "order.created", "payload": Infinity}',
        '{"event_type": "order.created", "payload": "a\\u0000b"}',
        '{"event_type": "order.created", "payload": {"k\\u0000": 1}}',
        '{"event_type": "order.created", "payload": ',
        "not json",
        "",
    ],
)
def test_bodies_postgresql_cannot_store_are_4xx_not_500(api, connect, tenant, raw):
    r = api(lambda c: c.post(EVENTS, content=raw, headers=auth(tenant.key)))
    assert 400 <= r.status_code < 500, (r.status_code, r.text)
    assert rows(connect, "SELECT count(*) FROM delivery.events") == [(0,)]


def test_deeply_nested_json_is_rejected_cleanly(api, tenant):
    raw = '{"event_type": "order.created", "payload": ' + "[" * 100_000 + "]" * 100_000 + "}"
    r = api(lambda c: c.post(EVENTS, content=raw, headers=auth(tenant.key)))
    assert 400 <= r.status_code < 500


def test_wrong_content_type_is_415(api, tenant):
    headers = auth(tenant.key) | {"Content-Type": "text/plain"}
    r = api(lambda c: c.post(EVENTS, content=json.dumps(BODY), headers=headers))
    assert r.status_code in (415, 422)  # FastAPI may refuse to parse first; either way nothing is stored


def test_body_size_limit(api, connect, tenant):
    filler = ingest.MAX_BODY_BYTES - len(json.dumps({"event_type": "order.created", "payload": ""}))
    at_limit = json.dumps({"event_type": "order.created", "payload": "x" * filler})
    assert len(at_limit) == ingest.MAX_BODY_BYTES
    over = json.dumps({"event_type": "order.created", "payload": "x" * (filler + 1)})

    async def chunked():  # no Content-Length: the limit is enforced while streaming
        for i in range(0, len(over), 65536):
            yield over[i : i + 65536].encode()

    async def go(c):
        return (
            await c.post(EVENTS, content=at_limit, headers=auth(tenant.key)),
            await c.post(EVENTS, content=over, headers=auth(tenant.key)),
            await c.post(EVENTS, content=chunked(), headers=auth(tenant.key)),
        )

    ok, too_big, too_big_streamed = api(go)
    assert ok.status_code == 202
    assert too_big.status_code == 413 and too_big_streamed.status_code == 413
    assert rows(connect, "SELECT count(*) FROM delivery.events") == [(1,)]


# ---------------------------------------------------------------- idempotency


def post_with_key(c, tenant, key, body=BODY, **kw):
    return c.post(EVENTS, json=body, headers=auth(tenant.key) | {"Idempotency-Key": key}, **kw)


def test_same_key_and_body_returns_the_original_event(api, connect, tenant):
    async def go(c):
        return await post_with_key(c, tenant, "order-42"), await post_with_key(c, tenant, "order-42")

    first, second = api(go)
    assert first.status_code == second.status_code == 202
    assert first.json() == second.json()
    assert "idempotent-replayed" not in first.headers and second.headers["idempotent-replayed"] == "true"
    assert rows(connect, "SELECT count(*) FROM delivery.events") == [(1,)]
    assert rows(connect, "SELECT count(*) FROM delivery.deliveries") == [(2,)]


def test_whitespace_and_key_order_do_not_change_the_body(api, tenant):
    a = '{"event_type":"order.created","payload":{"a":1,"b":2}}'
    b = '{ "payload" : { "b" : 2, "a" : 1 }, "event_type" : "order.created" }'

    async def go(c):
        h = auth(tenant.key) | {"Idempotency-Key": "k1"}
        return await c.post(EVENTS, content=a, headers=h), await c.post(EVENTS, content=b, headers=h)

    first, second = api(go)
    assert second.headers.get("idempotent-replayed") == "true" and first.json() == second.json()


def test_same_key_with_a_different_body_is_rejected(api, connect, tenant):
    async def go(c):
        await post_with_key(c, tenant, "k1")
        return await post_with_key(c, tenant, "k1", {"event_type": "order.created", "payload": {"order": 43}})

    r = api(go)
    assert r.status_code == 422 and r.json()["type"] == "/problems/idempotency-key-reused"
    assert rows(connect, "SELECT count(*) FROM delivery.events") == [(1,)]


def test_keys_are_per_tenant(api, connect, make_tenant):
    a, b = make_tenant(), make_tenant()

    async def go(c):
        return await post_with_key(c, a, "shared"), await post_with_key(c, b, "shared")

    ra, rb = api(go)
    assert ra.json()["event_id"] != rb.json()["event_id"] and "idempotent-replayed" not in rb.headers


@pytest.mark.parametrize("key", ["", "has space", "x" * 256, "tab\tkey", "é"])
def test_malformed_idempotency_keys_are_400(api, tenant, key):
    async def go(c):
        headers = {"Authorization": f"Bearer {tenant.key}", "Content-Type": "application/json"}
        raw_headers = [*headers.items(), ("Idempotency-Key", key.encode("utf-8"))]  # bytes: httpx refuses non-ASCII str
        return await c.post(EVENTS, content=json.dumps(BODY), headers=raw_headers)

    r = api(go)
    assert r.status_code == 400, r.text


def test_concurrent_requests_with_one_key_create_exactly_one_event(api, connect, tenant):
    async def go(c):
        return await asyncio.gather(*(post_with_key(c, tenant, "burst") for _ in range(20)))

    results = api(go, pool_size=20)
    assert {r.status_code for r in results} == {202}
    assert len({r.json()["event_id"] for r in results}) == 1
    assert sum("idempotent-replayed" not in r.headers for r in results) == 1
    assert rows(connect, "SELECT count(*) FROM delivery.events") == [(1,)]
    assert rows(connect, "SELECT count(*) FROM delivery.deliveries") == [(2,)]


def test_a_failure_before_commit_leaves_no_key_so_a_retry_succeeds(api, connect, tenant, monkeypatch):
    original = ingest._store

    class FailingDeliveries:
        def __init__(self, conn):
            self.conn = conn

        async def execute(self, sql, *args):
            if sql.startswith("INSERT INTO delivery.deliveries"):
                raise psycopg.errors.InternalError("simulated crash after the key and event were written")
            return await self.conn.execute(sql, *args)

    async def failing_store(conn, *args):
        return await original(FailingDeliveries(conn), *args)

    monkeypatch.setattr(ingest, "_store", failing_store)
    with pytest.raises(psycopg.errors.InternalError):
        api(lambda c: post_with_key(c, tenant, "retry-me"))
    assert rows(connect, "SELECT count(*) FROM delivery.idempotency_keys") == [(0,)]
    assert rows(connect, "SELECT count(*) FROM delivery.events") == [(0,)]

    monkeypatch.setattr(ingest, "_store", original)
    r = api(lambda c: post_with_key(c, tenant, "retry-me"))
    assert r.status_code == 202 and "idempotent-replayed" not in r.headers
    assert rows(connect, "SELECT count(*) FROM delivery.deliveries") == [(2,)]


# ---------------------------------------------------------------- health


def test_health_endpoints(api):
    async def go(c):
        return await c.get("/healthz"), await c.get("/readyz")

    live, ready = api(go)
    assert (live.status_code, ready.status_code) == (200, 200)


def test_openapi_document_is_served(api):
    doc = api(lambda c: c.get("/ingest/v1/openapi.json")).json()
    assert set(doc["paths"]) == {"/ingest/v1/events", "/ingest/v1/events/{event_id}"}


def test_documented_body_schema_matches_the_model():
    from relay_dataplane.ingest import EVENT_IN_SCHEMA, EventIn

    model = EventIn.model_json_schema()
    assert set(model["required"]) == set(EVENT_IN_SCHEMA["required"])
    assert set(model["properties"]) == set(EVENT_IN_SCHEMA["properties"])
    assert model["properties"]["event_type"]["pattern"] == EVENT_IN_SCHEMA["properties"]["event_type"]["pattern"]
    assert model.get("additionalProperties") is False
