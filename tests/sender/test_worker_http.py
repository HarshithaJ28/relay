"""Worker + real HTTP sender + real PostgreSQL: the whole attempt path, with the
signature checked by the receiver and the database deciding the final state."""

import asyncio

import psycopg
from aiohttp import web

from relay_dataplane import signing
from relay_dataplane.http_sender import HttpSender
from relay_dataplane.worker import handle_message
from tests.conftest import TEST_KEYRING
from tests.conftest import TEST_SECRET as SECRET
from tests.sender.conftest import HOST
from tests.sender.test_http_sender import Dns, policy, receiver
from tests.worker.test_worker_core import queue_message


def deliver(pg_dsn, server_ssl, client_ssl, connect, factory, handler, *, private=True, dns_answer="127.0.0.1"):
    async def go():
        async with receiver(server_ssl, handler) as rec:
            d = factory.delivery()
            with connect("postgres") as su:
                su.execute(
                    "UPDATE control.endpoints SET url = %s WHERE id = %s",
                    (f"https://{HOST}:{rec.port}/hook", factory.row(d)["endpoint_id"]),
                )
            body = queue_message(connect, factory, d)
            sender = HttpSender(policy(rec.port, private), lookup=Dns({HOST: [dns_answer]}), ssl_context=client_ssl)
            async with (
                sender,
                await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_worker", autocommit=True) as conn,
            ):
                handled = await handle_message(conn, body, sender, TEST_KEYRING)
            return d, handled, rec

    return asyncio.run(go())


def test_delivery_reaches_the_receiver_signed_and_succeeds(pg_dsn, server_ssl, client_ssl, connect, factory):
    async def verify(request):
        body = await request.read()
        if not signing.verify(SECRET, request.headers, body):
            return web.Response(status=401)
        return web.Response(status=204)

    d, handled, rec = deliver(pg_dsn, server_ssl, client_ssl, connect, factory, verify)
    assert handled.result == "succeeded"
    assert len(rec.requests) == 1
    assert factory.row(d)["status"] == "succeeded"


def test_receiver_error_schedules_a_retry(pg_dsn, server_ssl, client_ssl, connect, factory):
    async def fail(_request):
        return web.Response(status=500)

    d, handled, _ = deliver(pg_dsn, server_ssl, client_ssl, connect, factory, fail)
    assert (handled.result, handled.error_class) == ("retry", "http_5xx")
    assert factory.row(d)["status"] == "scheduled"


def test_blocked_destination_goes_to_dead_without_a_request(pg_dsn, server_ssl, client_ssl, connect, factory):
    async def never(_request):
        raise AssertionError("must not be reached")

    d, handled, rec = deliver(pg_dsn, server_ssl, client_ssl, connect, factory, never, private=False)
    assert (handled.result, handled.error_class) == ("dead", "blocked_destination")
    assert rec.requests == []
    assert factory.row(d)["status"] == "dead"
