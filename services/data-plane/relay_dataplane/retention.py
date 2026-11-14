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
    outbox_deleted: int = 0
    partitions_created: int = 0
    partitions_dropped: list = field(default_factory=list)
    partitions_skipped: list = field(default_factory=list)  # old enough, but deliveries still refer to them
    orphans: dict | None = None  # only on passes that ran the orphan report


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

    # An outbox row matters only while its dispatch is the delivery's current one: the publisher
    # needs it until it is published, and requeue_stale reads it after. Once the dispatch is
    # over, the row is useless (publishing it would only send a message the claim rejects), and
    # deleting it also removes any raw token it still holds. Rows of deleted deliveries cascade.
    report.outbox_deleted = await _batched(
        conn,
        "DELETE FROM delivery.outbox WHERE id IN (SELECT o.id FROM delivery.outbox o "
        "JOIN delivery.deliveries d ON d.id = o.delivery_id "
        "WHERE NOT (d.status = 'queued' AND d.dispatch_seq = o.dispatch_seq) "
        "LIMIT %s)",
        (),
        batch,
    )
    return report


USAGE_DAYS = 3  # days of usage recomputed each pass; younger than any retention window (at least 2 days)


async def flush_usage(conn: psycopg.AsyncConnection, days: int = USAGE_DAYS) -> int:
    """Recompute control.usage_daily for the last `days` UTC days from the source rows.

    Idempotent (a recount, not an increment), and run before anything is deleted, so the
    totals are exact; the days it touches are always inside every tenant's retention window."""
    cur = await conn.execute(
        """
        INSERT INTO control.usage_daily (tenant_id, day, events_ingested, attempts, successes)
        SELECT tenant_id, day, sum(events), sum(attempts), sum(successes) FROM (
            SELECT tenant_id, (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS events,
                   0 AS attempts, 0 AS successes
            FROM delivery.events WHERE created_at >= (now() AT TIME ZONE 'UTC')::date - %(days)s::int
            GROUP BY 1, 2
            UNION ALL
            SELECT tenant_id, (created_at AT TIME ZONE 'UTC')::date, 0,
                   count(*) FILTER (WHERE counted), count(*) FILTER (WHERE counted AND outcome = 'success')
            FROM delivery.delivery_attempts
            WHERE tenant_id IS NOT NULL AND created_at >= (now() AT TIME ZONE 'UTC')::date - %(days)s::int
            GROUP BY 1, 2
        ) x GROUP BY 1, 2
        ON CONFLICT (tenant_id, day) DO UPDATE SET
            events_ingested = excluded.events_ingested, attempts = excluded.attempts, successes = excluded.successes
        """,
        {"days": days - 1},
    )
    return cur.rowcount


PARTITION_MONTHS_AHEAD = 3
PARTITION_MARGIN = timedelta(days=7)  # kept past the longest tenant retention before a partition may go


async def maintain_partitions(conn: psycopg.AsyncConnection, report: Report) -> None:
    """Create upcoming monthly event partitions; drop fully expired ones that nothing refers to."""
    cur = await conn.execute("SELECT delivery.ensure_event_partitions(%s)", (PARTITION_MONTHS_AHEAD,))
    report.partitions_created = (await cur.fetchone())[0]
    cur = await conn.execute("SELECT * FROM delivery.drop_expired_event_partitions(%s)", (PARTITION_MARGIN,))
    for name, action in await cur.fetchall():
        (report.partitions_dropped if action == "dropped" else report.partitions_skipped).append(name)


async def orphan_report(conn: psycopg.AsyncConnection) -> dict:
    """Rows that should not exist if every write path is correct. Reported, never repaired."""
    cur = await conn.execute("SELECT * FROM delivery.orphan_report()")
    return {kind: count for kind, count in await cur.fetchall()}


async def check_retention_covers_retries(conn: psycopg.AsyncConnection, margin: timedelta) -> None:
    """Spec section 3: refuse to run if a delivery could outlive the shortest retention window."""
    cur = await conn.execute("SELECT min(retention_days) FROM control.tenants")
    shortest = (await cur.fetchone())[0]
    if shortest is not None and timedelta(days=shortest) - STARTUP_MARGIN <= margin:
        raise ValueError(
            f"the shortest retention window ({shortest} days) minus {STARTUP_MARGIN} does not exceed the longest "
            f"retry window plus deferral age ({margin}); active deliveries could lose their payload"
        )
