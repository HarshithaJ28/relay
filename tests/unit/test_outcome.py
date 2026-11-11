import pytest

from relay_dataplane.outcome import SendResult, classify


@pytest.mark.parametrize("status", [200, 201, 204, 299])
def test_2xx_is_success(status):
    assert classify(SendResult(status)).outcome == "success"


@pytest.mark.parametrize("status,error", [
    (301, "redirect_not_followed"), (302, "redirect_not_followed"),
    (400, "http_4xx"), (404, "http_4xx"), (410, "http_4xx"),
    (429, "rate_limited"),
    (500, "http_5xx"), (503, "http_5xx"), (599, "http_5xx"),
])
def test_every_other_status_is_retried_with_a_class(status, error):
    c = classify(SendResult(status))
    assert (c.outcome, c.error_class, c.status_code) == ("retry", error, status)


def test_transport_failures_are_retried():
    assert classify(SendResult(None, "timeout")).error_class == "timeout"
    assert classify(SendResult(None)).error_class == "connection_error"
    assert classify(SendResult(None, "timeout")).outcome == "retry"


def test_blocked_destination_is_terminal():
    c = classify(SendResult(None, "blocked_destination"))
    assert (c.outcome, c.error_class) == ("dead", "blocked_destination")
