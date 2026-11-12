"""Worker core: claim a delivery, send it, record the result.

The only database access is the two guarded functions, so even a compromised
worker cannot touch any delivery it was not handed a valid token for.

Known limit (documented in the spec): if the lease expires while a send is in
progress and the reaper reclaims it, this worker's result is rejected, but the
external request may already have reached the receiver. Receivers de-duplicate on
the `webhook-id` header, which stays the same for every attempt of one delivery.
"""

import json
import os
import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

import psycopg

from . import backoff, signing
from .claim import CLAIM_SQL, parse_message
from .outcome import Sender, SendResult, classify


@dataclass(frozen=True)
class WorkerConfig:
    request_timeout: float = 10.0  # seconds for one HTTP request
    lease_margin: float = 30.0  # lease = timeout + margin, so a live send never outlives its lease

    @property
    def lease_for(self) -> timedelta:
        return timedelta(seconds=self.request_timeout + self.lease_margin)


@dataclass(frozen=True)
class Handled:
    result: str  # "duplicate" | "succeeded" | "retry" | "dead" | "fenced"
    delivery_id: str
    attempt_no: int | None = None
    error_class: str | None = None


def canonical_body(payload) -> bytes:
    """Stable bytes for the stored JSON. jsonb does not keep whitespace or key order, so Relay
    defines the body as compact JSON of the stored value; this is what receivers verify."""
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()


async def handle_message(
    conn: psycopg.AsyncConnection,
    body: bytes,
    sender: Sender,
    decrypt_secrets: Callable[[bytes], list[str]],
    config: WorkerConfig = WorkerConfig(),
    rng: Callable[[], float] = random.random,
    clock: Callable[[], float] = time.time,
) -> Handled:
    msg = parse_message(body)
    lease_token = os.urandom(16)

    cur = await conn.execute(
        CLAIM_SQL, (msg.delivery_id, msg.dispatch_seq, msg.dispatch_token, lease_token, config.lease_for)
    )
    rows = await cur.fetchall()
    if not rows:
        return Handled("duplicate", msg.delivery_id)  # stale or duplicate: nothing to do, caller acks
    _, attempt_no, message_id, event_id, url, secret_blob, payload = rows[0]

    payload_bytes = canonical_body(payload)
    headers = signing.signed_headers(decrypt_secrets(bytes(secret_blob)), str(message_id), int(clock()), payload_bytes)
    headers |= {
        "content-type": "application/json",
        "relay-event-id": str(event_id),
        "relay-delivery-id": msg.delivery_id,
    }

    try:
        sent = await sender.send(url, headers, payload_bytes, config.request_timeout)
    except Exception:  # a sender bug must not strand the delivery
        sent = SendResult(status=None, error_class="internal_error")

    verdict = classify(sent)
    retry_after = None
    if verdict.outcome == "retry":
        delay = backoff.next_delay(attempt_no, rng)
        if sent.retry_after:
            delay = max(delay, sent.retry_after)  # honour the receiver's Retry-After
        retry_after = timedelta(seconds=delay)

    cur = await conn.execute(
        "SELECT delivery.record_attempt(%s, %s, %s, %s, %s, %s)",
        (msg.delivery_id, lease_token, verdict.outcome, verdict.status_code, verdict.error_class, retry_after),
    )
    new_status = (await cur.fetchone())[0]
    if new_status is None:  # lease lost: the database rejected our result
        return Handled("fenced", msg.delivery_id, attempt_no, verdict.error_class)
    # The database decides the final state (for example, a 12th failure becomes dead).
    result = {"succeeded": "succeeded", "scheduled": "retry", "dead": "dead"}[new_status]
    return Handled(result, msg.delivery_id, attempt_no, verdict.error_class)
