"""SSRF checks on URLs and resolved addresses (no network). The corpus covers the
bypass forms the spec lists: decimal, hex and octal IPv4, IPv6 forms that embed or
translate to IPv4, metadata addresses, credentials and scheme or port tricks."""

import ipaddress
import json
import pathlib

import pytest

from relay_dataplane.destination import BlockedDestination, DestinationPolicy, check_ip, check_url

# The corpus is shared with the control plane's save-time checks (services/control-plane/test).
CORPUS = json.loads((pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "ssrf_corpus.json").read_text())

STRICT = DestinationPolicy()
PRIVATE_OK = DestinationPolicy(allow_private=True)


@pytest.mark.parametrize("url", CORPUS["allowed_urls"])
def test_public_https_urls_are_allowed(url):
    check_url(url, STRICT)


def test_check_url_normalises_the_host():
    t = check_url("https://BÜCHER.de./x", STRICT)
    assert (t.scheme, t.host, t.port, t.ip) == ("https", "xn--bcher-kva.de", 443, None)


@pytest.mark.parametrize("url", CORPUS["blocked_urls"])
def test_bypass_corpus_is_blocked(url):
    with pytest.raises(BlockedDestination):
        check_url(url, STRICT)


def test_http_and_extra_ports_need_explicit_flags():
    dev = DestinationPolicy(allow_http=True, allowed_ports=frozenset({80, 443, 8080}))
    check_url("http://example.com/", dev)
    check_url("https://example.com:8080/", dev)
    with pytest.raises(BlockedDestination):
        check_url("https://example.com:8081/", dev)


@pytest.mark.parametrize("addr", CORPUS["private_ips"])
def test_private_addresses_need_the_flag(addr):
    ip = ipaddress.ip_address(addr)
    with pytest.raises(BlockedDestination):
        check_ip(ip, STRICT)
    check_ip(ip, PRIVATE_OK)


@pytest.mark.parametrize("addr", CORPUS["always_blocked_ips"])
def test_never_allowed_even_with_private_targets(addr):
    with pytest.raises(BlockedDestination):
        check_ip(ipaddress.ip_address(addr), PRIVATE_OK)


@pytest.mark.parametrize("addr", CORPUS["public_ips"])
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
