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
from datetime import UTC, datetime, timedelta

import psycopg
from opentelemetry import trace

from . import backoff, signing
from . import observability as obs
from .breaker import CircuitBreaker, counts_as_failure
from .claim import CLAIM_SQL, parse_message
from .endpoint_secrets import Keyring, SecretUnavailable, active_secrets
from .live import LivePublisher
from .outcome import Sender, SendResult, classify
from .transform import TransformClient, TransformResult


def new_lease_token() -> bytes:
    """128 random bits. Only its SHA-256 is stored; the token itself lives only in this call."""
    return os.urandom(16)


@dataclass(frozen=True)
class WorkerConfig:
    request_timeout: float = 10.0  # seconds for one HTTP request
    lease_margin: float = 30.0  # lease = timeout + margin, so a live send never outlives its lease
    retry_base: float = backoff.BASE_SECONDS  # first retry delay bound; tests use seconds, not 30 s
    retry_cap: float = backoff.CAP_SECONDS
    transform_retry_delay: float = 30.0  # how long a delivery waits after the runner was unavailable
    max_deferral_age: float = 6 * 3600.0  # spec default; after this, deferrals count as attempts

    @property
    def lease_for(self) -> timedelta:
        return timedelta(seconds=self.request_timeout + self.lease_margin)


@dataclass(frozen=True)
class Handled:
    result: str  # "duplicate" | "succeeded" | "retry" | "dead" | "fenced" | "deferred"
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
    keyring: Keyring,
    config: WorkerConfig = WorkerConfig(),
    rng: Callable[[], float] = random.random,
    clock: Callable[[], float] = time.time,
    transformer: TransformClient | None = None,
    breaker: CircuitBreaker | None = None,
    live: LivePublisher | None = None,
) -> Handled:
    msg = parse_message(body)
    lease_token = new_lease_token()

    cur = await conn.execute(
        CLAIM_SQL, (msg.delivery_id, msg.dispatch_seq, msg.dispatch_token, lease_token, config.lease_for)
    )
    rows = await cur.fetchall()
    if not rows:
        obs.HANDLED.labels("duplicate").inc()
        return Handled("duplicate", msg.delivery_id)  # stale or duplicate: nothing to do, caller acks
    row = rows[0]
    attempt_no, endpoint_id, tenant_id = row[1], row[7], row[10]  # the claim's column order
    with obs.tracer.start_as_current_span("relay.deliver") as span:
        span.set_attribute("relay.delivery_id", msg.delivery_id)
        span.set_attribute("relay.attempt", attempt_no)
        handled = await _deliver(
            conn, msg, lease_token, sender, keyring, config, rng, clock, transformer, breaker, live, row
        )
        span.set_attribute("relay.result", handled.result)
        if handled.error_class:
            span.set_attribute("relay.error_class", handled.error_class)
    obs.HANDLED.labels(handled.result).inc()
    if live is not None and handled.result in LIVE_STATUS:  # the database already holds this outcome
        await live.delivery(
            tenant_id, msg.delivery_id, endpoint_id, LIVE_STATUS[handled.result], attempt_no, handled.error_class
        )
    return handled


# What a console should show after each kind of result (fenced and duplicate change nothing).
LIVE_STATUS = {"succeeded": "succeeded", "retry": "scheduled", "deferred": "scheduled", "dead": "dead"}


async def _deliver(conn, msg, lease_token, sender, keyring, config, rng, clock, transformer, breaker, live, row):
    """Everything after a successful claim: transform, sign, check the lease, send, record."""
    (
        _,
        attempt_no,
        message_id,
        event_id,
        url,
        signing_secrets,
        payload,
        endpoint_id,
        transformation,
        replay_of,
        tenant_id,
    ) = row

    if transformation is not None:
        result = (
            await transformer.transform(transformation, payload)
            if transformer is not None
            else TransformResult("unavailable", detail="no transformation runner configured")
        )
        if result.kind == "error":  # the runner confirmed the expression fails: retrying cannot help
            return await _record(conn, msg, lease_token, attempt_no, "dead", None, "transform_error", None)
        if result.kind == "unavailable":  # unknown outcome: give it back, no attempt used (AC-2)
            cur = await conn.execute(
                "SELECT delivery.defer_delivery(%s, %s, %s, %s, 'transform_unavailable')",
                (
                    msg.delivery_id,
                    lease_token,
                    timedelta(seconds=config.transform_retry_delay),
                    timedelta(seconds=config.max_deferral_age),
                ),
            )
            status = (await cur.fetchone())[0]
            result_name = {None: "fenced", "scheduled": "deferred", "dead": "dead"}[status]
            return Handled(result_name, msg.delivery_id, attempt_no, "transform_unavailable")
        payload = result.output

    payload_bytes = canonical_body(payload)
    now = clock()
    try:
        secrets = active_secrets(keyring, str(endpoint_id), signing_secrets, datetime.fromtimestamp(now, UTC))
    except SecretUnavailable:
        # An operator problem (missing master key, corrupted or expired secrets), not the
        # receiver's: nothing is sent, and the attempt is retried so a fix lets it through.
        sent = SendResult(status=None, error_class="secret_unavailable")
    else:
        headers = signing.signed_headers(secrets, str(message_id), int(now), payload_bytes)
        headers |= {
            "content-type": "application/json",
            "relay-event-id": str(event_id),
            "relay-delivery-id": msg.delivery_id,
        }
        if replay_of is not None:  # spec section 5: a replay says so, and of what
            headers |= {"relay-replay": "true", "relay-replay-of": str(replay_of)}
        # Spec section 5: right before sending, confirm by the database clock that the lease
        # outlives the whole request. If not (a slow claim, a stalled process), give the
        # delivery back without using an attempt rather than risk a send nobody can record.
        cur = await conn.execute(
            "SELECT delivery.check_lease(%s, %s, %s)",
            (msg.delivery_id, lease_token, timedelta(seconds=config.request_timeout)),
        )
        if not (await cur.fetchone())[0]:
            return Handled("deferred", msg.delivery_id, attempt_no, "lease_too_short")
        started = time.monotonic()
        try:
            sent = await sender.send(url, headers, payload_bytes, config.request_timeout)
        except Exception:  # a sender bug must not strand the delivery
            sent = SendResult(status=None, error_class="internal_error")
        obs.SEND_SECONDS.observe(time.monotonic() - started)
        if sent.status is not None:
            trace.get_current_span().set_attribute("http.response.status_code", sent.status)

    verdict = classify(sent)
    if breaker is not None:
        await _update_breaker(conn, breaker, msg, lease_token, endpoint_id, verdict, live, tenant_id)
    retry_after = None
    if verdict.outcome == "retry":
        delay = backoff.next_delay(attempt_no, rng, config.retry_base, config.retry_cap)
        if sent.retry_after:
            delay = max(delay, sent.retry_after)  # honour the receiver's Retry-After
        retry_after = timedelta(seconds=delay)

    return await _record(
        conn, msg, lease_token, attempt_no, verdict.outcome, verdict.status_code, verdict.error_class, retry_after
    )


async def _update_breaker(conn, breaker: CircuitBreaker, msg, lease_token, endpoint_id, verdict, live, tenant_id):
    """Feed the result to the endpoint's breaker; mirror an opening while we still hold the lease."""
    failed = counts_as_failure(verdict)
    if failed is None:
        return
    decision = await breaker.record(str(endpoint_id), failed)
    if decision.opens:
        obs.BREAKER_OPENED.inc()
        try:
            await conn.execute(
                "SELECT delivery.open_breaker(%s, %s, %s, %s)",
                (msg.delivery_id, lease_token, decision.until, timedelta(seconds=breaker.jitter)),
            )
        except psycopg.errors.InvalidParameterValue:
            # the reopen time is already past by the database clock (clock skew): nothing to mirror
            return
        if live is not None:
            await live.breaker(tenant_id, endpoint_id, decision.until)


async def _record(conn, msg, lease_token, attempt_no, outcome, status_code, error_class, retry_after) -> Handled:
    cur = await conn.execute(
        "SELECT delivery.record_attempt(%s, %s, %s, %s, %s, %s)",
        (msg.delivery_id, lease_token, outcome, status_code, error_class, retry_after),
    )
    new_status = (await cur.fetchone())[0]
    if new_status is None:  # lease lost: the database rejected our result
        return Handled("fenced", msg.delivery_id, attempt_no, error_class)
    # The database decides the final state (for example, a 12th failure becomes dead).
    result = {"succeeded": "succeeded", "scheduled": "retry", "dead": "dead"}[new_status]
    obs.ATTEMPTS.labels(result, error_class or "none").inc()
    return Handled(result, msg.delivery_id, attempt_no, error_class)
