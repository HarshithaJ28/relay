"""Standard Webhooks request signing.

signed content = "{webhook-id}.{webhook-timestamp}.{raw body}"
signature      = "v1," + base64(HMAC-SHA256(key, signed content))
key            = base64-decoded part of the secret after the "whsec_" prefix

During secret rotation several signatures may be sent, space-separated.
"""

import base64
import hashlib
import hmac
import time
from collections.abc import Mapping, Sequence

SECRET_PREFIX = "whsec_"
TOLERANCE_SECONDS = 300


def _key(secret: str) -> bytes:
    if not secret.startswith(SECRET_PREFIX):
        raise ValueError("secret must start with 'whsec_'")
    return base64.b64decode(secret[len(SECRET_PREFIX) :], validate=True)


def sign(secret: str, message_id: str, timestamp: int, body: bytes) -> str:
    content = f"{message_id}.{timestamp}.".encode() + body
    digest = hmac.new(_key(secret), content, hashlib.sha256).digest()
    return "v1," + base64.b64encode(digest).decode()


def signed_headers(secrets: Sequence[str], message_id: str, timestamp: int, body: bytes) -> dict[str, str]:
    """Headers for one delivery attempt. Pass more than one secret while rotating."""
    if not secrets:
        raise ValueError("at least one signing secret is required")
    return {
        "webhook-id": message_id,
        "webhook-timestamp": str(timestamp),
        "webhook-signature": " ".join(sign(s, message_id, timestamp, body) for s in secrets),
    }


def verify(
    secret: str, headers: Mapping[str, str], body: bytes, now: float | None = None, tolerance: int = TOLERANCE_SECONDS
) -> bool:
    """Receiver-side check (used by tests and the chaos receiver)."""
    try:
        message_id = headers["webhook-id"]
        timestamp = int(headers["webhook-timestamp"])
        candidates = headers["webhook-signature"].split(" ")
    except (KeyError, ValueError):
        return False
    if abs((time.time() if now is None else now) - timestamp) > tolerance:
        return False
    expected = sign(secret, message_id, timestamp, body)
    return any(hmac.compare_digest(expected, c) for c in candidates)
