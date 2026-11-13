"""The real aiohttp sender against a real local HTTPS receiver.

The receiver listens on 127.0.0.1 with a certificate from a throwaway test CA
for receiver.relay.test. A scripted lookup plays DNS (including hostile DNS),
so the tests also prove the sender connects to the address it checked while
verifying TLS against the original hostname."""

import asyncio
import contextlib
import socket
import ssl
import time

import aiohttp
import pytest
from aiohttp import web

from relay_dataplane.destination import DestinationPolicy
from relay_dataplane.http_sender import HttpSender, parse_retry_after
from tests.sender.conftest import HOST


class Receiver:
    """Records every request; handlers are set per test."""

    def __init__(self):
        self.requests: list[tuple[str, dict[str, str], bytes]] = []
        self.handler = None

    async def handle(self, request: web.Request) -> web.StreamResponse:
        self.requests.append((request.path, dict(request.headers), await request.read()))
        return await self.handler(request)


@contextlib.asynccontextmanager
async def receiver(server_ssl, handler):
    rec = Receiver()
    rec.handler = handler
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", rec.handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0, ssl_context=server_ssl)
    await site.start()
    rec.port = site._server.sockets[0].getsockname()[1]
    try:
        yield rec
    finally:
        await runner.cleanup()


class Dns:
    """Scripted DNS: name -> list of addresses (or an exception). Counts lookups."""

    def __init__(self, answers):
        self.answers = answers
        self.calls: list[str] = []

    async def __call__(self, host, port):
        self.calls.append(host)
        answer = self.answers[host]
        if isinstance(answer, Exception):
            raise answer
        return answer


def policy(port, private=True):
    return DestinationPolicy(allow_private=private, allowed_ports=frozenset({443, port}))


async def ok(_request):
    return web.Response(status=200, text="ok")


def send(server_ssl, client_ssl, handler, *, url=None, dns=None, private=True, headers=None, timeout=5.0, sends=1):
    """Start a receiver, send `sends` requests, return (results, receiver, dns)."""

    async def go():
        async with receiver(server_ssl, handler) as rec:
            d = dns or Dns({HOST: ["127.0.0.1"]})
            target = (url or "https://{host}:{port}/hook").format(host=HOST, port=rec.port)
            async with HttpSender(policy(rec.port, private), lookup=d, ssl_context=client_ssl) as s:
                results = [await s.send(target, headers or {"x-test": "1"}, b'{"k":1}', timeout) for _ in range(sends)]
            return results, rec, d

    return asyncio.run(go())


def test_success_delivers_body_and_headers_over_verified_tls(server_ssl, client_ssl):
    [r], rec, dns = send(
        server_ssl, client_ssl, ok, headers={"webhook-id": "msg_1", "content-type": "application/json"}
    )
    assert (r.status, r.error_class) == (200, None)
    [(path, headers, body)] = rec.requests
    assert path == "/hook" and body == b'{"k":1}'
    assert headers["webhook-id"] == "msg_1"
    assert headers["Host"] == f"{HOST}:{rec.port}"  # original host, not the IP
    assert headers["User-Agent"].startswith("Relay-Webhooks/")
    assert dns.calls == [HOST]


def test_certificate_is_checked_against_the_original_hostname(server_ssl, client_ssl):
    # DNS points other.relay.test at the receiver, whose certificate only names receiver.relay.test.
    dns = Dns({"other.relay.test": ["127.0.0.1"]})
    [r], rec, _ = send(server_ssl, client_ssl, ok, url="https://other.relay.test:{port}/hook", dns=dns)
    assert (r.status, r.error_class) == (None, "tls")
    assert rec.requests == []


def test_untrusted_certificate_is_rejected(server_ssl):
    [r], rec, _ = send(server_ssl, ssl.create_default_context(), ok)  # system trust store only
    assert r.error_class == "tls" and rec.requests == []


def test_redirects_are_not_followed(server_ssl, client_ssl):
    async def redirect(_request):
        return web.Response(status=302, headers={"Location": "https://169.254.169.254/latest/meta-data/"})

    [r], rec, _ = send(server_ssl, client_ssl, redirect)
    assert (r.status, r.error_class) == (302, None)
    assert len(rec.requests) == 1


def test_retry_after_is_reported(server_ssl, client_ssl):
    async def busy(_request):
        return web.Response(status=503, headers={"Retry-After": "120"})

    [r], _, _ = send(server_ssl, client_ssl, busy)
    assert (r.status, r.retry_after) == (503, 120.0)


def test_only_the_start_of_an_endless_body_is_read(server_ssl, client_ssl):
    async def endless(request):
        resp = web.StreamResponse(status=200)
        await resp.prepare(request)
        chunk = b"x" * 65536
        with contextlib.suppress(ConnectionError):
            while True:  # never ends: a client that reads the whole body can only time out
                await resp.write(chunk)
        return resp

    started = time.monotonic()
    [r], _, _ = send(server_ssl, client_ssl, endless, timeout=3)
    assert (r.status, r.error_class) == (200, None)
    assert time.monotonic() - started < 3


def test_slow_receiver_times_out(server_ssl, client_ssl):
    async def slow(_request):
        await asyncio.sleep(5)
        return web.Response(status=200)

    [r], _, _ = send(server_ssl, client_ssl, slow, timeout=0.5)
    assert (r.status, r.error_class) == (None, "timeout")


def test_dns_failure_is_reported_as_dns(server_ssl, client_ssl):
    dns = Dns({HOST: socket.gaierror(socket.EAI_NONAME, "Name or service not known")})
    [r], rec, _ = send(server_ssl, client_ssl, ok, dns=dns)
    assert (r.status, r.error_class) == (None, "dns") and rec.requests == []


def test_refused_connection_is_reported_as_connect(client_ssl):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]  # nothing listens here once the socket closes

    async def go():
        async with HttpSender(policy(port), lookup=Dns({HOST: ["127.0.0.1"]}), ssl_context=client_ssl) as snd:
            return await snd.send(f"https://{HOST}:{port}/", {}, b"", 5)

    r = asyncio.run(go())
    assert (r.status, r.error_class) == (None, "connect")


# ---------------------------------------------------------------- hostile DNS and blocked targets


@pytest.mark.parametrize(
    "answer",
    [
        ["127.0.0.1"],  # name pointing at loopback
        ["10.0.0.7"],
        ["8.8.8.8", "127.0.0.1"],  # one bad address rejects the whole host
        ["::1"],
    ],
)
def test_private_answers_are_blocked_without_the_flag(server_ssl, client_ssl, answer):
    [r], rec, _ = send(server_ssl, client_ssl, ok, dns=Dns({HOST: answer}), private=False)
    assert (r.status, r.error_class) == (None, "blocked_destination")
    assert rec.requests == []


@pytest.mark.parametrize("answer", [["169.254.169.254"], ["::ffff:127.0.0.1"], ["64:ff9b::7f00:1"], ["0.0.0.0"]])
def test_metadata_and_tunnelled_answers_are_blocked_even_with_the_flag(server_ssl, client_ssl, answer):
    [r], rec, _ = send(server_ssl, client_ssl, ok, dns=Dns({HOST: answer}), private=True)
    assert r.error_class == "blocked_destination" and rec.requests == []


def test_dns_rebinding_cannot_reach_a_checked_out_address(server_ssl, client_ssl):
    """A name that answers differently on each lookup: the sender resolves once per
    connection and connects only to that checked answer, never to a later one."""

    class Rebinding(Dns):
        async def __call__(self, host, port):
            self.calls.append(host)
            return ["127.0.0.1"] if len(self.calls) % 2 else ["169.254.169.254"]

    dns = Rebinding({})
    results, rec, _ = send(server_ssl, client_ssl, ok, dns=dns, sends=2)
    assert [r.status for r in results] == [200, 200]
    assert len(rec.requests) == 2
    # the keep-alive connection was reused, so no second, hostile answer was ever used
    assert dns.calls == [HOST]


def test_ip_literal_urls_are_checked_without_dns(server_ssl, client_ssl):
    dns = Dns({})
    [r], rec, _ = send(server_ssl, client_ssl, ok, url="https://127.0.0.1:{port}/hook", dns=dns, private=False)
    assert r.error_class == "blocked_destination" and rec.requests == [] and dns.calls == []


@pytest.mark.parametrize(
    "url",
    ["http://{host}:{port}/", "https://user:pw@{host}:{port}/", "https://{host}:1/", "https://2130706433:{port}/"],
)
def test_bad_urls_never_leave_the_process(server_ssl, client_ssl, url):
    dns = Dns({HOST: ["127.0.0.1"]})
    [r], rec, _ = send(server_ssl, client_ssl, ok, url=url, dns=dns)
    assert r.error_class == "blocked_destination" and rec.requests == [] and dns.calls == []


def test_proxy_environment_variables_are_ignored(server_ssl, client_ssl, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")  # would fail if used
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:9")
    [r], _, _ = send(server_ssl, client_ssl, ok)
    assert r.status == 200


def test_cookies_are_not_carried_between_requests(server_ssl, client_ssl):
    async def set_cookie(_request):
        resp = web.Response(status=200)
        resp.set_cookie("session", "tenant-a-secret")
        return resp

    _, rec, _ = send(server_ssl, client_ssl, set_cookie, sends=2)
    assert all("Cookie" not in headers for _, headers, _ in rec.requests)


def test_sender_must_be_opened_first():
    async def go():
        await HttpSender(DestinationPolicy()).send("https://example.com/", {}, b"", 1)

    with pytest.raises(RuntimeError):
        asyncio.run(go())


# ---------------------------------------------------------------- Retry-After parsing


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, None),
        ("", None),
        ("0", None),
        ("30", 30.0),
        ("999999", 6 * 3600.0),  # capped
        ("-5", None),
        ("soon", None),
        ("Wed, 21 Oct 2015 07:28:00 GMT", None),  # in the past
    ],
)
def test_parse_retry_after(value, expected):
    assert parse_retry_after(value) == expected


def test_parse_retry_after_http_date():
    now = 1_700_000_000.0
    assert parse_retry_after("Tue, 14 Nov 2023 22:15:20 GMT", now=lambda: now) == 120.0


def test_aiohttp_is_new_enough_to_reject_numeric_hosts():
    # The sender relies on aiohttp refusing non-canonical IPv4 hosts before resolution.
    major, minor, *_ = (int(x) for x in aiohttp.__version__.split(".")[:2])
    assert (major, minor) >= (3, 13)


# ---------------------------------------------------------------- URL parser differentials


@pytest.mark.parametrize(
    "url",
    [
        "https://{host}\\@127.0.0.1:{port}/",
        "https://127.0.0.1\\.{host}:{port}/",
        "https://{host}:{port}\\@127.0.0.1/",
        "https://{host}%2f@127.0.0.1:{port}/",
        "https://ex­{host}:{port}/",
    ],
)
def test_urls_the_two_parsers_read_differently_are_blocked(server_ssl, client_ssl, url):
    dns = Dns({HOST: ["127.0.0.1"]})
    [r], rec, _ = send(server_ssl, client_ssl, ok, url=url, dns=dns, private=False)
    assert r.error_class == "blocked_destination" and rec.requests == [] and dns.calls == []


def test_same_target_requires_scheme_host_and_port_to_match():
    from relay_dataplane.destination import Target
    from relay_dataplane.http_sender import _same_target

    t = Target("https", "a.example.com", 443, None)
    assert _same_target("https://A.example.com./x", t)
    assert not _same_target("https://b.example.com/x", t)
    assert not _same_target("https://a.example.com:8443/x", t)
    assert not _same_target("http://a.example.com:443/x", t)
    assert not _same_target("https://u@a.example.com/x", t)
    assert not _same_target("https://a.example.com\\@b.example.com/", t)
