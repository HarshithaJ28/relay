"""SSRF checks on URLs and resolved addresses (no network). The corpus covers the
bypass forms the spec lists: decimal, hex and octal IPv4, IPv6 forms that embed or
translate to IPv4, metadata addresses, credentials and scheme or port tricks."""

import ipaddress

import pytest

from relay_dataplane.destination import BlockedDestination, DestinationPolicy, check_ip, check_url

STRICT = DestinationPolicy()
PRIVATE_OK = DestinationPolicy(allow_private=True)


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/hook",
        "https://example.com:443/hook?x=1",
        "https://EXAMPLE.com./hook",
        "https://bücher.de/hook",
        "https://8.8.8.8/hook",
        "https://[2606:4700:4700::1111]/hook",
        "https://api.123.example.com/hook",  # numeric labels are fine when the TLD is not numeric
    ],
)
def test_public_https_urls_are_allowed(url):
    check_url(url, STRICT)


def test_check_url_normalises_the_host():
    t = check_url("https://BÜCHER.de./x", STRICT)
    assert (t.scheme, t.host, t.port, t.ip) == ("https", "xn--bcher-kva.de", 443, None)


@pytest.mark.parametrize(
    "url",
    [
        # scheme
        "http://example.com/",
        "ftp://example.com/",
        "file:///etc/passwd",
        "gopher://example.com/",
        "//example.com/",
        "example.com/hook",
        # port and credentials
        "https://example.com:8443/",
        "https://example.com:22/",
        "https://example.com:0/",
        "https://example.com:99999/",
        "https://user:pass@example.com/",
        "https://user@example.com/",
        "https://example.com@127.0.0.1/",
        # loopback, private, metadata as literals
        "https://127.0.0.1/",
        "https://127.255.255.254/",
        "https://10.0.0.1/",
        "https://172.16.0.1/",
        "https://192.168.1.1/",
        "https://100.64.0.1/",
        "https://169.254.169.254/latest/meta-data/",
        "https://0.0.0.0/",
        "https://255.255.255.255/",
        "https://224.0.0.1/",
        # numeric IPv4 forms that inet_aton-style parsers accept
        "https://2130706433/",
        "https://0x7f000001/",
        "https://0x7f.0.0.1/",
        "https://0177.0.0.1/",
        "https://017700000001/",
        "https://127.1/",
        "https://127.0.1/",
        "https://10.1/",
        "https://169.254.43518/",
        # IPv6
        "https://[::1]/",
        "https://[::]/",
        "https://[0:0:0:0:0:0:0:1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://[::ffff:7f00:1]/",
        "https://[::ffff:169.254.169.254]/",
        "https://[::127.0.0.1]/",
        "https://[64:ff9b::7f00:1]/",
        "https://[64:ff9b::a9fe:a9fe]/",
        "https://[2002:7f00:1::]/",
        "https://[2001:0:4136:e378:8000:63bf:80ff:fffe]/",
        "https://[fe80::1]/",
        "https://[fe80::1%25eth0]/",
        "https://[2606:4700:4700::1111%25eth0]/",  # scoped, even though the address is public
        "https://[fc00::1]/",
        "https://[fd00:ec2::254]/",
        "https://[ff02::1]/",
        # malformed hosts
        "https:///hook",
        "https://exa mple.com/",
        "https://-bad-.com/",
        "https://exa_mple.com/",
        "https://[not-an-ip]/",
    ],
)
def test_bypass_corpus_is_blocked(url):
    with pytest.raises(BlockedDestination):
        check_url(url, STRICT)


def test_http_and_extra_ports_need_explicit_flags():
    dev = DestinationPolicy(allow_http=True, allowed_ports=frozenset({80, 443, 8080}))
    check_url("http://example.com/", dev)
    check_url("https://example.com:8080/", dev)
    with pytest.raises(BlockedDestination):
        check_url("https://example.com:8081/", dev)


@pytest.mark.parametrize("addr", ["10.0.0.1", "127.0.0.1", "192.168.0.10", "100.64.1.1", "::1", "fd12::1"])
def test_private_addresses_need_the_flag(addr):
    ip = ipaddress.ip_address(addr)
    with pytest.raises(BlockedDestination):
        check_ip(ip, STRICT)
    check_ip(ip, PRIVATE_OK)


@pytest.mark.parametrize(
    "addr",
    [
        "169.254.169.254",
        "fd00:ec2::254",
        "0.0.0.0",
        "::",
        "::ffff:127.0.0.1",
        "::ffff:8.8.8.8",  # mapped forms are rejected even when the embedded address is public
        "64:ff9b::808:808",
        "2002:808:808::1",
        "2001::1",
        "fe80::1",
        "ff02::1",
        "224.0.0.251",
        "240.0.0.1",
        "192.0.2.1",
        "2001:2::1",  # benchmarking; caught only by the is_global backstop
        "2001:10::1",  # ORCHID; caught only by the is_global backstop
    ],
)
def test_never_allowed_even_with_private_targets(addr):
    with pytest.raises(BlockedDestination):
        check_ip(ipaddress.ip_address(addr), PRIVATE_OK)


@pytest.mark.parametrize("addr", ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001::64"])
def test_public_addresses_pass(addr):
    check_ip(ipaddress.ip_address(addr), STRICT)


def test_policy_from_env():
    assert DestinationPolicy.from_env({}) == DestinationPolicy()
    p = DestinationPolicy.from_env({"RELAY_ALLOW_HTTP": "true", "RELAY_ALLOW_PRIVATE_TARGETS": "1"})
    assert p.allow_http and p.allow_private and p.allowed_ports == frozenset({80, 443})
    assert DestinationPolicy.from_env({"RELAY_ALLOWED_PORTS": "443,8443"}).allowed_ports == frozenset({443, 8443})
    with pytest.raises(ValueError):
        DestinationPolicy.from_env({"RELAY_ALLOW_PRIVATE_TARGETS": "maybe"})
    with pytest.raises(ValueError):
        DestinationPolicy.from_env({"RELAY_ALLOWED_PORTS": "0"})
