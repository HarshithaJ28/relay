"""Turn the result of one HTTP send into a delivery outcome."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class SendResult:
    """What the sender observed. status is None when no HTTP response arrived."""

    status: int | None
    error_class: str | None = None  # e.g. "timeout", "connection_error", "blocked_destination"
    retry_after: float | None = None  # seconds, parsed from a Retry-After header if present


class Sender(Protocol):
    async def send(self, url: str, headers: dict[str, str], body: bytes, timeout: float) -> SendResult: ...


# Failures that retrying cannot fix. Everything else, including every non-2xx
# status, is retried until the attempt budget runs out.
TERMINAL_ERROR_CLASSES = frozenset({"blocked_destination"})


@dataclass(frozen=True)
class Classified:
    outcome: str  # "success" | "retry" | "dead"
    error_class: str | None
    status_code: int | None


def classify(result: SendResult) -> Classified:
    if result.status is not None and 200 <= result.status < 300:
        return Classified("success", None, result.status)
    if result.error_class in TERMINAL_ERROR_CLASSES:
        return Classified("dead", result.error_class, result.status)
    if result.status is None:
        return Classified("retry", result.error_class or "connection_error", None)
    if result.status == 429:
        return Classified("retry", "rate_limited", result.status)
    if 300 <= result.status < 400:
        return Classified("retry", "redirect_not_followed", result.status)
    if 400 <= result.status < 500:
        return Classified("retry", "http_4xx", result.status)
    return Classified("retry", "http_5xx", result.status)
