"""Where a webhook may be sent (SSRF protection).

Two checks, both applied on every attempt (and by the control plane when an
endpoint is saved):

1. check_url(): the URL itself. HTTPS only (plain HTTP needs a development
   flag), allowed ports only, no credentials in the URL, and no host that is an
   IP address in a forbidden range or a numeric form some resolvers turn into
   one (2130706433, 0x7f.1, 0177.0.0.1, 127.1).
2. check_ip(): every address a hostname resolves to. The HTTP sender resolves
   DNS itself, checks every address, and connects only to checked addresses,
   so a DNS answer that changes between check and connect (rebinding) cannot
   reach a forbidden address.

The network policy in the cluster is a second layer; this module does not rely
on it, and it does not rely on this module.
"""

import ipaddress
import os
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class BlockedDestination(Exception):
    """The destination is not allowed. Retrying cannot fix this, so the delivery goes to dead.

    Deliberately not an OSError: the HTTP client must never mistake it for a DNS
    or connection failure, which would be retried."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _nets(*cidrs: str) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    return tuple(ipaddress.ip_network(c) for c in cidrs)


# Never allowed, not even with allow_private: none of these is a real receiver.
# Link-local holds the cloud metadata service (169.254.169.254); the IPv6
# metadata address is inside unique-local space, so it is listed here as well
# to stay blocked when private targets are allowed.
ALWAYS_BLOCKED = _nets(
    "0.0.0.0/8",  # "this network"; 0.0.0.0 reaches localhost on Linux
    "169.254.0.0/16",  # IPv4 link-local, cloud metadata
    "192.0.0.0/24",  # IETF protocol assignments
    "192.0.2.0/24",  # documentation
    "198.18.0.0/15",  # benchmarking
    "198.51.100.0/24",  # documentation
    "203.0.113.0/24",  # documentation
    "224.0.0.0/4",  # multicast
    "240.0.0.0/4",  # reserved, includes 255.255.255.255
    "::/128",  # unspecified
    "::ffff:0:0/96",  # IPv4-mapped: the real target is the embedded IPv4 address
    "64:ff9b::/96",  # NAT64 well-known prefix: translates to any IPv4 address
    "64:ff9b:1::/48",  # NAT64 local-use prefix
    "100::/64",  # discard-only
    "2001::/32",  # Teredo: tunnels to an embedded IPv4 address
    "2001:db8::/32",  # documentation
    "2002::/16",  # 6to4: tunnels to an embedded IPv4 address
    "fe80::/10",  # IPv6 link-local
    "fec0::/10",  # site-local (deprecated)
    "ff00::/8",  # multicast
    "fd00:ec2::254/128",  # AWS metadata over IPv6
)

# Private, loopback and shared address space: blocked unless allow_private is set
# (tests and benchmark setups with a receiver on a private network).
PRIVATE = _nets(
    "10.0.0.0/8",
    "100.64.0.0/10",  # carrier-grade NAT
    "127.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "::1/128",
    "fc00::/7",  # unique-local
)

DEFAULT_PORTS = frozenset({443})
DEV_HTTP_PORTS = frozenset({80})


@dataclass(frozen=True)
class DestinationPolicy:
    allow_http: bool = False  # development only
    allow_private: bool = False  # RELAY_ALLOW_PRIVATE_TARGETS; never set in the public demo
    allowed_ports: frozenset[int] = field(default=DEFAULT_PORTS)

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "DestinationPolicy":
        env = os.environ if env is None else env

        def flag(name: str) -> bool:
            value = env.get(name, "").strip().lower()
            if value in ("", "0", "false", "no"):
                return False
            if value in ("1", "true", "yes"):
                return True
            raise ValueError(f"{name} must be true or false, got {value!r}")

        allow_http = flag("RELAY_ALLOW_HTTP")
        ports = env.get("RELAY_ALLOWED_PORTS", "").strip()
        if ports:
            allowed = frozenset(int(p) for p in ports.split(","))
            if not all(0 < p < 65536 for p in allowed):
                raise ValueError("RELAY_ALLOWED_PORTS must list ports between 1 and 65535")
        else:
            allowed = DEFAULT_PORTS | (DEV_HTTP_PORTS if allow_http else frozenset())
        return cls(allow_http=allow_http, allow_private=flag("RELAY_ALLOW_PRIVATE_TARGETS"), allowed_ports=allowed)


@dataclass(frozen=True)
class Target:
    scheme: str  # "https" or "http"
    host: str  # lower-case; IDNA (punycode) for names, unbracketed for IPv6 literals
    port: int
    ip: IPAddress | None  # set when the URL host is an IP literal


def check_ip(ip: IPAddress, policy: DestinationPolicy) -> None:
    """Raise BlockedDestination unless ip is a public unicast address (or private and allowed)."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.scope_id is not None:
        raise BlockedDestination(f"scoped IPv6 address {ip}")
    if isinstance(ip, ipaddress.IPv6Address) and 1 < int(ip) < 2**32:
        # IPv4-compatible (::a.b.c.d, deprecated): the real target is the embedded IPv4 address.
        # Checked by value so that ::1 (loopback) and :: are handled by the lists.
        raise BlockedDestination(f"IPv4-compatible address {ip}")
    if any(ip in net for net in ALWAYS_BLOCKED if net.version == ip.version):
        raise BlockedDestination(f"address {ip} is in a blocked range")
    if any(ip in net for net in PRIVATE if net.version == ip.version):
        if policy.allow_private:
            return
        raise BlockedDestination(f"address {ip} is private, loopback or shared")
    if not ip.is_global:  # anything the lists above missed that is not globally routable
        raise BlockedDestination(f"address {ip} is not globally routable")


# A label made only of digits, or a 0x hex number: inet_aton() style parsers read
# such hosts as IPv4 addresses (2130706433, 0x7f.1, 0177.0.0.1, 127.1).
_NUMERIC_LABEL = re.compile(r"^(0x[0-9a-f]*|[0-9]+)$")
_HOSTNAME_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")


def check_url(url: str, policy: DestinationPolicy) -> Target:
    """Parse and check a destination URL. No DNS lookup happens here."""
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError as e:
        raise BlockedDestination(f"invalid URL: {e}") from None
    scheme = parts.scheme.lower()
    if scheme != "https" and not (scheme == "http" and policy.allow_http):
        raise BlockedDestination(f"scheme {scheme or '(none)'!r} is not allowed")
    if parts.username is not None or parts.password is not None:
        raise BlockedDestination("credentials in the URL are not allowed")
    host = parts.hostname  # lower-cased, IPv6 brackets removed
    if not host:
        raise BlockedDestination("URL has no host")
    if port is None:
        port = 443 if scheme == "https" else 80
    if port not in policy.allowed_ports:
        raise BlockedDestination(f"port {port} is not allowed")

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        check_ip(ip, policy)
        return Target(scheme, host, port, ip)

    try:
        ascii_host = host.rstrip(".").encode("idna").decode("ascii")
    except UnicodeError:
        raise BlockedDestination("host is not a valid domain name") from None
    labels = ascii_host.split(".")
    if not all(_HOSTNAME_LABEL.match(label) for label in labels) or len(ascii_host) > 253:
        raise BlockedDestination("host is not a valid domain name")
    if _NUMERIC_LABEL.match(labels[-1]):  # no real top-level domain is numeric
        raise BlockedDestination(f"host {host!r} is a numeric IPv4 form")
    return Target(scheme, ascii_host, port, None)
