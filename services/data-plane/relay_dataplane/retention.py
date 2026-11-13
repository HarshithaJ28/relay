"""Retention job (spec section 3, AC-3). Runs as relay_retention.

For each tenant, with cutoff = now - retention_days:

1. Ceiling: a delivery still not terminal after cutoff - ceiling_margin (the longest
   retry window plus the maximum deferral age) becomes dead with retention_expired, so a
   long outage cannot keep payloads forever.
2. Delete attempts of terminal deliveries whose event is older than the cutoff.
3. Delete those terminal deliveries (their outbox rows go with them).
4. Delete events older than the cutoff that no delivery refers to any more.
5. Delete expired idempotency keys.

Rows of non-terminal deliveries are never deleted, so an active delivery keeps its
payload; the ingestion API already stops showing it at the cutoff (AC-3). Every step
works in batches so it never holds long locks.

Reported per pass: relay_retention_blocked_events (events past the cutoff that cannot be
deleted yet because a delivery is still active) and relay_retention_lag_seconds (how long
ago the oldest expired row that still exists expired).
"""

import logging
from dataclasses import dataclass, field
from datetime import timedelta

import psycopg

from . import backoff

log = logging.getLogger("relay.retention")

TERMINAL = ("succeeded", "dead", "cancelled")
ACTIVE = ("scheduled", "queued", "in_flight")
STARTUP_MARGIN = timedelta(days=1)


def ceiling_margin(max_deferral_age: timedelta) -> timedelta:
    """The longest a delivery can legitimately stay active: every retry delay at its bound, plus deferrals."""
    return timedelta(seconds=sum(backoff.schedule_bounds())) + max_deferral_age


@dataclass
class Report:
    expired: int = 0
    attempts_deleted: int = 0
    deliveries_deleted: int = 0
    events_deleted: int = 0
    keys_deleted: int = 0
    blocked_events: int = 0
    lag_seconds: float = 0.0
    tenants: int = 0
    per_tenant_blocked: dict = field(default_factory=dict)


async def _batched(conn: psycopg.AsyncConnection, sql: str, args: tuple, batch: int) -> int:
    total = 0
    while True:
        cur = await conn.execute(sql, (*args, batch))
        total += cur.rowcount
        if cur.rowcount < batch:
            return total


async def run_pass(conn: psycopg.AsyncConnection, margin: timedelta, batch: int = 500) -> Report:
    report = Report()
    cur = await conn.execute("SELECT id, retention_days FROM control.tenants ORDER BY id")
    tenants = await cur.fetchall()
    report.tenants = len(tenants)
    for tenant_id, days in tenants:
        window = timedelta(days=days)
        report.expired += await _batched(
            conn,
            "UPDATE delivery.deliveries SET status = 'dead', last_error_class = 'retention_expired', "
            "lease_token_hash = NULL, lease_until = NULL, dispatch_token_hash = NULL, updated_at = now() "
            "WHERE id IN (SELECT id FROM delivery.deliveries WHERE tenant_id = %s AND status = ANY(%s) "
            "AND event_created_at < now() - %s - %s LIMIT %s FOR UPDATE SKIP LOCKED)",
            (tenant_id, list(ACTIVE), window, margin),
            batch,
        )
        expired_terminal = (
            "SELECT t.id FROM delivery.deliveries t WHERE t.tenant_id = %s AND t.status = ANY(%s) "
            "AND t.event_created_at < now() - %s"
        )
        report.attempts_deleted += await _batched(
            conn,
            "DELETE FROM delivery.delivery_attempts WHERE id IN ("
            f"SELECT a.id FROM delivery.delivery_attempts a WHERE a.delivery_id IN ({expired_terminal}) LIMIT %s)",
            (tenant_id, list(TERMINAL), window),
            batch,
        )
        report.deliveries_deleted += await _batched(
            conn,
            f"DELETE FROM delivery.deliveries WHERE id IN ({expired_terminal} "
            "AND NOT EXISTS (SELECT 1 FROM delivery.delivery_attempts a WHERE a.delivery_id = t.id) LIMIT %s)",
            (tenant_id, list(TERMINAL), window),
            batch,
        )
        report.events_deleted += await _batched(
            conn,
            "DELETE FROM delivery.events WHERE (id, created_at) IN ("
            "SELECT e.id, e.created_at FROM delivery.events e WHERE e.tenant_id = %s AND e.created_at < now() - %s "
            "AND NOT EXISTS (SELECT 1 FROM delivery.deliveries d WHERE d.event_id = e.id) LIMIT %s)",
            (tenant_id, window),
            batch,
        )
        report.keys_deleted += await _batched(
            conn,
            "DELETE FROM delivery.idempotency_keys WHERE (tenant_id, key) IN ("
            "SELECT tenant_id, key FROM delivery.idempotency_keys "
            "WHERE tenant_id = %s AND expires_at < now() LIMIT %s)",
            (tenant_id,),
            batch,
        )
        cur = await conn.execute(
            "SELECT count(*), coalesce(extract(epoch FROM now() - %s - min(e.created_at)), 0) "
            "FROM delivery.events e WHERE e.tenant_id = %s AND e.created_at < now() - %s",
            (window, tenant_id, window),
        )
        blocked, lag = await cur.fetchone()
        if blocked:
            report.per_tenant_blocked[str(tenant_id)] = blocked
        report.blocked_events += blocked
        report.lag_seconds = max(report.lag_seconds, float(lag))
    return report


async def check_retention_covers_retries(conn: psycopg.AsyncConnection, margin: timedelta) -> None:
    """Spec section 3: refuse to run if a delivery could outlive the shortest retention window."""
    cur = await conn.execute("SELECT min(retention_days) FROM control.tenants")
    shortest = (await cur.fetchone())[0]
    if shortest is not None and timedelta(days=shortest) - STARTUP_MARGIN <= margin:
        raise ValueError(
            f"the shortest retention window ({shortest} days) minus {STARTUP_MARGIN} does not exceed the longest "
            f"retry window plus deferral age ({margin}); active deliveries could lose their payload"
        )
