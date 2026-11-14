"""Live updates: after the database records an outcome, the worker publishes it on the
tenant's Valkey channel. Best effort, and never with payloads, URLs, secrets or tokens."""

import asyncio
import json
import time

import psycopg
import valkey.asyncio

from relay_dataplane.breaker import CircuitBreaker
from relay_dataplane.live import LivePublisher, channel
from relay_dataplane.outcome import SendResult
from relay_dataplane.worker import WorkerConfig, handle_message
from tests.conftest import TEST_KEYRING
from tests.worker.test_breaker import CONFIG
from tests.worker.test_worker_core import ScriptedSender, queue_message


def deliver_and_listen(pg_dsn, url, tenant, bodies_and_senders, config=WorkerConfig(), breaker=False):
    """Run each (body, sender) through the worker with live updates; return the events received."""

    async def go():
        listener = valkey.asyncio.Valkey.from_url(url)
        publisher = valkey.asyncio.Valkey.from_url(url)
        pubsub = listener.pubsub()
        await pubsub.subscribe(channel(tenant))
        await pubsub.get_message(timeout=1)  # the subscribe confirmation
        live = LivePublisher(publisher)
        brk = CircuitBreaker(publisher, CONFIG) if breaker else None
        try:
            async with await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_worker", autocommit=True) as conn:
                for body, sender in bodies_and_senders:
                    await handle_message(conn, body, sender, TEST_KEYRING, config, live=live, breaker=brk)
            events = []
            while (m := await pubsub.get_message(ignore_subscribe_messages=True, timeout=1)) is not None:
                events.append(json.loads(m["data"]))
            return events
        finally:
            await pubsub.aclose()
            await listener.aclose()
            await publisher.aclose()

    return asyncio.run(go())


def test_each_recorded_outcome_is_published(pg_dsn, connect, factory, valkey_clean):
    tenant = factory.tenant()
    ok, retry, dead = (factory.delivery(tenant=tenant) for _ in range(3))
    events = deliver_and_listen(
        pg_dsn,
        valkey_clean,
        tenant,
        [
            (queue_message(connect, factory, ok), ScriptedSender(SendResult(200))),
            (queue_message(connect, factory, retry), ScriptedSender(SendResult(503))),
            (queue_message(connect, factory, dead), ScriptedSender(SendResult(None, "blocked_destination"))),
        ],
    )
    assert [(e["delivery_id"], e["status"], e["attempt"], e["error_class"]) for e in events] == [
        (str(ok), "succeeded", 1, None),
        (str(retry), "scheduled", 1, "http_5xx"),
        (str(dead), "dead", 1, "blocked_destination"),
    ]
    assert all(e["type"] == "delivery" and e["endpoint_id"] and e["at"] > 0 for e in events)


def test_events_never_carry_payloads_urls_secrets_or_tokens(pg_dsn, connect, factory, valkey_clean):
    d = factory.delivery()
    body = queue_message(connect, factory, d)
    [event] = deliver_and_listen(
        pg_dsn, valkey_clean, factory.row(d)["tenant_id"], [(body, ScriptedSender(SendResult(200)))]
    )
    token = json.loads(body)["dispatch_token"]
    text = json.dumps(event)
    assert set(event) == {"type", "delivery_id", "endpoint_id", "status", "attempt", "error_class", "at"}
    assert token not in text and "example.invalid" not in text and "whsec_" not in text and '"k"' not in text


def test_a_delivery_given_back_unused_is_published_as_scheduled(pg_dsn, connect, factory, valkey_clean):
    d = factory.delivery()
    short_lease = WorkerConfig(request_timeout=5, lease_margin=-4)
    [event] = deliver_and_listen(
        pg_dsn,
        valkey_clean,
        factory.row(d)["tenant_id"],
        [(queue_message(connect, factory, d), ScriptedSender())],
        config=short_lease,
    )
    assert (event["status"], event["error_class"]) == ("scheduled", "lease_too_short")


def test_duplicates_publish_nothing(pg_dsn, connect, factory, valkey_clean):
    d = factory.delivery()
    body = queue_message(connect, factory, d)
    events = deliver_and_listen(
        pg_dsn,
        valkey_clean,
        factory.row(d)["tenant_id"],
        [(body, ScriptedSender(SendResult(200))), (body, ScriptedSender())],  # the same message twice
    )
    assert [e["status"] for e in events] == ["succeeded"]


def test_other_tenants_hear_nothing(pg_dsn, connect, factory, valkey_clean):
    d = factory.delivery()
    events = deliver_and_listen(
        pg_dsn, valkey_clean, factory.tenant(), [(queue_message(connect, factory, d), ScriptedSender(SendResult(200)))]
    )
    assert events == []


def test_a_breaker_opening_is_published(pg_dsn, connect, factory, valkey_clean):
    from tests.db.test_bounded_dispatch import more

    d = factory.delivery()
    tenant = factory.row(d)["tenant_id"]
    ids = [d, *more(connect, factory, d, 3)]
    events = deliver_and_listen(
        pg_dsn,
        valkey_clean,
        tenant,
        [(queue_message(connect, factory, x), ScriptedSender(SendResult(503))) for x in ids],
        breaker=True,
    )
    [opened] = [e for e in events if e["type"] == "breaker"]
    assert opened["state"] == "open" and opened["endpoint_id"] == str(factory.row(d)["endpoint_id"])
    assert opened["until"]


def test_an_unreachable_valkey_does_not_affect_delivery(pg_dsn, connect, factory):
    d = factory.delivery()

    async def go():
        live = LivePublisher(valkey.asyncio.Valkey.from_url("valkey://127.0.0.1:1/0", socket_connect_timeout=1))
        async with await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_worker", autocommit=True) as conn:
            return await handle_message(
                conn, queue_message(connect, factory, d), ScriptedSender(SendResult(200)), TEST_KEYRING, live=live
            )

    started = time.monotonic()
    assert asyncio.run(go()).result == "succeeded"
    assert factory.row(d)["status"] == "succeeded" and time.monotonic() - started < 10


def test_a_fenced_result_is_not_published(pg_dsn, connect, factory, valkey_clean):
    """The lease is lost mid-send and the reaper takes the delivery back: the database rejected
    this worker's result, so publishing it would show the console something that never happened."""
    d = factory.delivery()

    def lose_lease():
        with connect() as c:
            c.execute("UPDATE delivery.deliveries SET lease_until = now() - interval '1 second' WHERE id = %s", (d,))
        with connect("relay_reaper") as c:
            c.execute("SELECT delivery.reclaim_expired(10)")

    events = deliver_and_listen(
        pg_dsn,
        valkey_clean,
        factory.row(d)["tenant_id"],
        [(queue_message(connect, factory, d), ScriptedSender(SendResult(200), on_send=lose_lease))],
    )
    assert events == []
