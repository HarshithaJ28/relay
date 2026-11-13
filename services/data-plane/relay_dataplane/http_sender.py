"""The real HTTP sender: one POST per attempt, with SSRF protection.

How a request reaches only an allowed address:

- check_url() rejects the URL before any network activity. The URL is then
  parsed again by yarl, the parser aiohttp uses, and must give the same
  scheme, host and port, so a disagreement between two URL parsers cannot
  send the request somewhere the check did not see.
- aiohttp asks ValidatingResolver for the host's addresses. It resolves the
  name itself, checks every address, and rejects the host if any address is
  forbidden. aiohttp then connects only to the addresses it returned; nothing
  resolves the name a second time, so DNS rebinding has no second answer to
  exploit. aiohttp does not call the resolver for IP literals, which is why
  check_url() checks those.
- TLS still uses the original hostname for SNI and certificate verification
  (aiohttp does this when it connects to a resolved address). Verification
  uses the default trust store and cannot be turned off per endpoint.
- Redirects are never followed, proxy environment variables are ignored, no
  cookies are kept, and at most 1 KB of the response body is read.
"""

import asyncio
import email.utils
import ipaddress
import socket
import ssl
import time
from collections.abc import Awaitable, Callable

import aiohttp
from aiohttp.abc import AbstractResolver, ResolveResult
from yarl import URL

from .destination import BlockedDestination, DestinationPolicy, Target, check_ip, check_url
from .outcome import SendResult

MAX_BODY_READ = 1024  # bytes of response body read per attempt
MAX_RETRY_AFTER = 6 * 3600.0  # seconds; matches the backoff cap
USER_AGENT = "Relay-Webhooks/0.0.1"

# (host, port) -> IP address strings. Replaceable in tests (hostile DNS).
Lookup = Callable[[str, int], Awaitable[list[str]]]


async def system_lookup(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


class ValidatingResolver(AbstractResolver):
    def __init__(self, policy: DestinationPolicy, lookup: Lookup = system_lookup):
        self._policy = policy
        self._lookup = lookup

    async def resolve(
        self, host: str, port: int = 0, family: socket.AddressFamily = socket.AF_INET
    ) -> list[ResolveResult]:
        try:
            raw = await self._lookup(host, port)
        except OSError:
            raise
        except Exception as e:  # a broken lookup is a DNS failure, never a pass
            raise OSError(f"lookup failed: {e}") from e
        if not raw:
            raise OSError(f"no addresses for {host}")
        results: list[ResolveResult] = []
        for text in dict.fromkeys(raw):  # keep order, drop duplicates
            ip = ipaddress.ip_address(text)
            check_ip(ip, self._policy)  # any forbidden address rejects the whole host
            results.append(
                {
                    "hostname": host,
                    "host": str(ip),
                    "port": port,
                    "family": socket.AF_INET6 if ip.version == 6 else socket.AF_INET,
                    "proto": 0,
                    "flags": socket.AI_NUMERICHOST,
                }
            )
        return results

    async def close(self) -> None:
        pass


def parse_retry_after(value: str | None, now: Callable[[], float] = time.time) -> float | None:
    """Seconds to wait from a Retry-After header (delta-seconds or HTTP-date), capped at 6 h."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        seconds = float(value)
    else:
        try:
            when = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        if when.tzinfo is None:  # HTTP-dates are GMT
            return None
        seconds = when.timestamp() - now()
    if seconds <= 0:
        return None
    return min(seconds, MAX_RETRY_AFTER)


def _same_target(url: str, target: Target) -> bool:
    try:
        u = URL(url)
    except (TypeError, ValueError):
        return False
    host = (u.raw_host or "").lower().rstrip(".")
    return (
        u.scheme == target.scheme
        and u.port == target.port
        and u.user is None
        and u.password is None
        and host == target.host.lower()
    )


class HttpSender:
    """Sender for the worker. Use as an async context manager; one instance per worker process."""

    def __init__(
        self,
        policy: DestinationPolicy,
        *,
        lookup: Lookup = system_lookup,
        ssl_context: ssl.SSLContext | None = None,  # tests pass one trusting a test CA
        max_connections: int = 100,
    ):
        self._policy = policy
        self._lookup = lookup
        self._ssl = ssl_context or ssl.create_default_context()
        self._max_connections = max_connections
        self._session: aiohttp.ClientSession | None = None

    async def __aenter__(self) -> "HttpSender":
        connector = aiohttp.TCPConnector(
            resolver=ValidatingResolver(self._policy, self._lookup),
            use_dns_cache=False,  # every new connection resolves and checks again
            ssl=self._ssl,
            limit=self._max_connections,
        )
        self._session = aiohttp.ClientSession(
            connector=connector,
            trust_env=False,  # a proxy would resolve the name itself and bypass the checks
            cookie_jar=aiohttp.DummyCookieJar(),  # never carry one receiver's cookies to another
            auto_decompress=False,
            headers={"user-agent": USER_AGENT},
        )
        return self

    async def __aexit__(self, *exc) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def send(self, url: str, headers: dict[str, str], body: bytes, timeout: float) -> SendResult:
        if self._session is None:
            raise RuntimeError("HttpSender used outside 'async with'")
        try:
            target = check_url(url, self._policy)
            if not _same_target(url, target):
                raise BlockedDestination("URL parsers disagree about the destination")
            async with self._session.post(
                url,
                data=body,
                headers=headers,
                allow_redirects=False,
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                await resp.content.read(MAX_BODY_READ)
                return SendResult(resp.status, retry_after=parse_retry_after(resp.headers.get("retry-after")))
        except BlockedDestination:
            return SendResult(None, "blocked_destination")
        except TimeoutError:
            return SendResult(None, "timeout")
        except (aiohttp.ClientConnectorCertificateError, aiohttp.ClientSSLError):
            return SendResult(None, "tls")
        except aiohttp.ClientConnectorDNSError:
            return SendResult(None, "dns")
        except (aiohttp.ClientError, OSError):
            return SendResult(None, "connect")
