"""Milestone 1 gate: stale, duplicated or unauthorized operations cannot change
delivery state. Every test connects as the real role under test."""
import hashlib
import os
import threading
import uuid

import psycopg
import pytest

LEASE = "30 seconds"


def tok() -> bytes:
    return os.urandom(16)


def dispatch(connect, factory, delivery_id):
    """Run the scheduler function for the delivery's tenant; return (seq, raw_token)."""
    row = factory.row(delivery_id)
    with connect("relay_scheduler") as c:
        n = c.execute("SELECT delivery.dispatch_batch(%s, 10)", (row["tenant_id"],)).fetchone()[0]
    assert n >= 1
    with connect("postgres") as su:
        seq, raw = su.execute("SELECT dispatch_seq, dispatch_token FROM delivery.outbox "
                              "WHERE delivery_id = %s ORDER BY dispatch_seq DESC LIMIT 1",
                              (delivery_id,)).fetchone()
    return seq, bytes(raw)


def claim(connect, delivery_id, seq, dtok, ltok):
    with connect("relay_worker") as c:
        return c.execute("SELECT * FROM delivery.claim_delivery(%s,%s,%s,%s,%s::interval)",
                         (delivery_id, seq, dtok, ltok, LEASE)).fetchall()


def record_status(connect, delivery_id, ltok, outcome="success", code=200, err=None, retry="10 seconds"):
    """The resulting status, or None when the call was rejected."""
    with connect("relay_worker") as c:
        return c.execute("SELECT delivery.record_attempt(%s,%s,%s,%s,%s,%s::interval)",
                         (delivery_id, ltok, outcome, code, err, retry)).fetchone()[0]


def record(connect, *args, **kwargs):
    return record_status(connect, *args, **kwargs) is not None


def attempts(factory, delivery_id):
    with factory._su() as c:
        return c.execute("SELECT attempt_no, counted, outcome FROM delivery.delivery_attempts "
                         "WHERE delivery_id = %s ORDER BY id", (delivery_id,)).fetchall()


# ------------------------------------------------------------ roles and grants

def test_no_role_is_superuser_or_bypasses_rls(connect):
    with connect() as c:
        rows = c.execute("SELECT rolname FROM pg_roles WHERE rolname LIKE 'relay\\_%' "
                         "AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)").fetchall()
    assert rows == []


def test_public_has_no_execute_on_any_function(connect):
    with connect() as c:
        rows = c.execute(
            "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname = 'delivery' AND has_function_privilege('public', p.oid, 'EXECUTE')").fetchall()
    assert rows == []


def test_functions_are_hardened(connect):
    with connect() as c:
        rows = c.execute(
            "SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner), p.proconfig "
            "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'delivery'").fetchall()
    assert len(rows) == 4
    for name, secdef, owner, cfg in rows:
        assert secdef, name
        assert owner == "relay_claims", name
        assert cfg and any(x.startswith("search_path=pg_catalog") for x in cfg), name


@pytest.mark.parametrize("table", ["delivery.deliveries", "delivery.delivery_attempts", "delivery.events",
                                   "delivery.outbox", "control.endpoints", "control.tenants"])
def test_worker_has_no_table_privileges(connect, table):
    with connect("relay_worker") as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
        c.execute(f"SELECT 1 FROM {table} LIMIT 1")


def test_each_role_can_only_execute_its_own_functions(connect, factory):
    d = factory.delivery()
    tenant = factory.row(d)["tenant_id"]
    forbidden = [
        ("relay_worker", "SELECT delivery.dispatch_batch(%s, 1)", (tenant,)),
        ("relay_worker", "SELECT delivery.reclaim_expired(1)", ()),
        ("relay_scheduler", "SELECT * FROM delivery.claim_delivery(%s,1,%s,%s,'1 minute')", (d, tok(), tok())),
        ("relay_scheduler", "SELECT delivery.record_attempt(%s,%s,'success',200,NULL,NULL)", (d, tok())),
        ("relay_reaper", "SELECT delivery.dispatch_batch(%s, 1)", (tenant,)),
        ("relay_publisher", "SELECT delivery.reclaim_expired(1)", ()),
        ("relay_tenant", "SELECT delivery.reclaim_expired(1)", ()),
    ]
    for role, sql, args in forbidden:
        with connect(role) as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute(sql, args)


def test_publisher_cannot_change_delivery_identity_columns(connect, factory):
    d = factory.delivery()
    dispatch(connect, factory, d)
    with connect("relay_publisher") as c:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("UPDATE delivery.outbox SET delivery_id = gen_random_uuid()")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("UPDATE delivery.deliveries SET status = 'succeeded'")


# ------------------------------------------------------------ dispatch

def test_dispatch_queues_due_deliveries_and_writes_outbox_atomically(connect, factory):
    d = factory.delivery()
    seq, raw = dispatch(connect, factory, d)
    row = factory.row(d)
    assert (row["status"], row["dispatch_seq"], seq) == ("queued", 1, 1)
    assert len(raw) == 16
    assert bytes(row["dispatch_token_hash"]) == hashlib.sha256(raw).digest()  # DB keeps only the hash


def test_dispatch_skips_not_yet_due_and_is_not_repeated(connect, factory):
    due = factory.delivery()
    later = factory.delivery(tenant=factory.row(due)["tenant_id"], next_attempt_at="2099-01-01")
    dispatch(connect, factory, due)
    with connect("relay_scheduler") as c:
        assert c.execute("SELECT delivery.dispatch_batch(%s, 10)", (factory.row(due)["tenant_id"],)).fetchone()[0] == 0
    assert factory.row(later)["status"] == "scheduled"
    assert factory.row(due)["dispatch_seq"] == 1


def test_scheduler_skips_a_tenant_another_replica_holds(connect, factory):
    d = factory.delivery()
    tenant = factory.row(d)["tenant_id"]
    holder = connect("postgres", autocommit=False)
    holder.execute("INSERT INTO delivery.dispatch_locks (tenant_id) VALUES (%s)", (tenant,))
    holder.execute("SELECT 1 FROM delivery.dispatch_locks WHERE tenant_id = %s FOR UPDATE", (tenant,))
    holder.commit()
    holder.execute("SELECT 1 FROM delivery.dispatch_locks WHERE tenant_id = %s FOR UPDATE", (tenant,))  # keep lock open
    with connect("relay_scheduler") as c:
        assert c.execute("SELECT delivery.dispatch_batch(%s, 10)", (tenant,)).fetchone()[0] == 0
    assert factory.row(d)["status"] == "scheduled"
    holder.rollback()
    with connect("relay_scheduler") as c:
        assert c.execute("SELECT delivery.dispatch_batch(%s, 10)", (tenant,)).fetchone()[0] == 1


def test_concurrent_schedulers_do_not_double_dispatch(connect, factory):
    tenant = factory.tenant()
    ids = [factory.delivery(tenant=tenant) for _ in range(20)]
    results = []

    def run():
        with connect("relay_scheduler") as c:
            results.append(c.execute("SELECT delivery.dispatch_batch(%s, 100)", (tenant,)).fetchone()[0])

    ts = [threading.Thread(target=run) for _ in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sum(results) == 20
    with connect() as c:
        assert c.execute("SELECT count(*) FROM delivery.outbox").fetchone()[0] == 20
        assert c.execute("SELECT max(dispatch_seq) FROM delivery.deliveries").fetchone()[0] == 1


# ------------------------------------------------------------ claim

def test_claim_succeeds_with_correct_token_and_returns_payload(connect, factory):
    d = factory.delivery()
    seq, dtok = dispatch(connect, factory, d)
    rows = claim(connect, d, seq, dtok, tok())
    assert len(rows) == 1
    assert rows[0][0] == d and rows[0][1] == 1 and rows[0][6] == {"k": 1}
    assert factory.row(d)["status"] == "in_flight"


def test_claim_rejects_wrong_token_wrong_seq_and_wrong_status(connect, factory):
    d = factory.delivery()
    seq, dtok = dispatch(connect, factory, d)
    before = factory.row(d)
    assert claim(connect, d, seq, tok(), tok()) == []          # wrong token
    assert claim(connect, d, seq + 1, dtok, tok()) == []       # wrong dispatch_seq
    assert claim(connect, uuid.uuid4(), seq, dtok, tok()) == []  # unknown delivery
    assert factory.row(d) == before                              # nothing changed
    sched = factory.delivery()
    assert claim(connect, sched, 0, tok(), tok()) == []        # not queued


def test_duplicate_message_cannot_claim_twice(connect, factory):
    d = factory.delivery()
    seq, dtok = dispatch(connect, factory, d)
    first = tok()
    assert len(claim(connect, d, seq, dtok, first)) == 1
    mid = factory.row(d)
    assert claim(connect, d, seq, dtok, tok()) == []            # duplicate publish
    after = factory.row(d)
    assert after["lease_token_hash"] == mid["lease_token_hash"]  # first lease intact
    assert after["lease_until"] == mid["lease_until"]


def test_concurrent_claims_have_exactly_one_winner(connect, factory):
    d = factory.delivery()
    seq, dtok = dispatch(connect, factory, d)
    wins = []

    def run():
        wins.append(len(claim(connect, d, seq, dtok, tok())))

    ts = [threading.Thread(target=run) for _ in range(10)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sorted(wins) == [0] * 9 + [1]


def test_claim_rejects_bad_lease_and_short_tokens(connect, factory):
    d = factory.delivery()
    seq, dtok = dispatch(connect, factory, d)
    with connect("relay_worker") as c:
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            c.execute("SELECT * FROM delivery.claim_delivery(%s,%s,%s,%s,'2 hours')", (d, seq, dtok, tok()))
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            c.execute("SELECT * FROM delivery.claim_delivery(%s,%s,%s,%s,'0 seconds')", (d, seq, dtok, tok()))
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            c.execute("SELECT * FROM delivery.claim_delivery(%s,%s,%s,%s,'1 minute')", (d, seq, b"x", tok()))
    assert factory.row(d)["status"] == "queued"


# ------------------------------------------------------------ record_attempt

def claimed(connect, factory):
    d = factory.delivery()
    seq, dtok = dispatch(connect, factory, d)
    ltok = tok()
    assert len(claim(connect, d, seq, dtok, ltok)) == 1
    return d, ltok


def test_record_reports_the_resulting_status(connect, factory):
    d, ltok = claimed(connect, factory)
    assert record_status(connect, d, ltok, "retry", 500, "http_5xx") == "scheduled"
    with factory._su() as su:                                        # skip the backoff wait
        su.execute("UPDATE delivery.deliveries SET next_attempt_at = now() WHERE id = %s", (d,))
    seq, dtok = dispatch(connect, factory, d)
    l2 = tok()
    assert len(claim(connect, d, seq, dtok, l2)) == 1
    assert record_status(connect, d, l2, "success") == "succeeded"
    assert record_status(connect, d, l2, "success") is None          # rejected: nothing to report


def test_twelfth_failure_reports_dead(connect, factory):
    d = factory.delivery(attempt_count=11)
    seq, dtok = dispatch(connect, factory, d)
    ltok = tok()
    assert len(claim(connect, d, seq, dtok, ltok)) == 1
    assert record_status(connect, d, ltok, "retry", 500, "http_5xx") == "dead"


def test_record_success_finishes_delivery(connect, factory):
    d, ltok = claimed(connect, factory)
    assert record(connect, d, ltok) is True
    row = factory.row(d)
    assert (row["status"], row["attempt_count"]) == ("succeeded", 1)
    assert row["lease_token_hash"] is None and row["dispatch_token_hash"] is None
    assert attempts(factory, d) == [(1, True, "success")]


def test_record_with_wrong_lease_token_changes_nothing(connect, factory):
    d, ltok = claimed(connect, factory)
    before = factory.row(d)
    assert record(connect, d, tok()) is False
    assert factory.row(d) == before
    assert attempts(factory, d) == []


def test_record_twice_second_is_rejected(connect, factory):
    d, ltok = claimed(connect, factory)
    assert record(connect, d, ltok) is True
    assert record(connect, d, ltok, outcome="dead") is False   # replayed result cannot flip a terminal state
    assert factory.row(d)["status"] == "succeeded"
    assert len(attempts(factory, d)) == 1


def test_retry_schedules_with_capped_delay_and_clears_lease(connect, factory):
    d, ltok = claimed(connect, factory)
    assert record(connect, d, ltok, "retry", 503, "http_5xx", "1000 hours") is True
    with factory._su() as c:
        row = c.execute("SELECT status, attempt_count, lease_token_hash, "
                        "next_attempt_at - now() <= interval '6 hours 1 minute' FROM delivery.deliveries WHERE id=%s",
                        (d,)).fetchone()
    assert row == ("scheduled", 1, None, True)


def test_twelfth_failure_becomes_dead(connect, factory):
    d = factory.delivery(attempt_count=11)
    seq, dtok = dispatch(connect, factory, d)
    ltok = tok()
    assert len(claim(connect, d, seq, dtok, ltok)) == 1
    assert record(connect, d, ltok, "retry", 500, "http_5xx") is True
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["last_error_class"]) == ("dead", 12, "max_attempts")


def test_invalid_outcome_is_rejected(connect, factory):
    d, ltok = claimed(connect, factory)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        record(connect, d, ltok, "cancelled")
    assert factory.row(d)["status"] == "in_flight"


# ------------------------------------------------------------ reaper and fencing

def expire_lease(factory, d):
    with factory._su() as c:
        c.execute("UPDATE delivery.deliveries SET lease_until = now() - interval '1 minute' WHERE id = %s", (d,))


def test_reaper_reclaims_expired_and_fences_the_stalled_worker(connect, factory):
    d, stalled = claimed(connect, factory)
    expire_lease(factory, d)
    with connect("relay_reaper") as c:
        assert c.execute("SELECT delivery.reclaim_expired(10)").fetchone()[0] == 1
    row = factory.row(d)
    assert (row["status"], row["attempt_count"], row["lease_token_hash"]) == ("scheduled", 1, None)
    # The stalled worker finally returns: its result must be rejected.
    assert record(connect, d, stalled) is False
    assert factory.row(d)["attempt_count"] == 1
    # Redelivery: a new dispatch gets a new token, and the old token still fails.
    seq, dtok = dispatch(connect, factory, d)
    new = tok()
    assert len(claim(connect, d, seq, dtok, new)) == 1
    assert record(connect, d, stalled) is False
    assert record(connect, d, new) is True
    assert factory.row(d)["status"] == "succeeded"
    assert [a[2] for a in attempts(factory, d)] == ["lease_expired", "success"]


def test_reaper_leaves_live_leases_alone(connect, factory):
    d, ltok = claimed(connect, factory)
    with connect("relay_reaper") as c:
        assert c.execute("SELECT delivery.reclaim_expired(10)").fetchone()[0] == 0
    assert factory.row(d)["status"] == "in_flight"
    assert record(connect, d, ltok) is True


def test_reaper_and_record_race_has_one_winner(connect, factory):
    for _ in range(15):
        d, ltok = claimed(connect, factory)
        expire_lease(factory, d)
        out = {}

        def reap():
            with connect("relay_reaper") as c:
                out["reap"] = c.execute("SELECT delivery.reclaim_expired(10)").fetchone()[0]

        def rec():
            out["rec"] = record(connect, d, ltok)

        ts = [threading.Thread(target=reap), threading.Thread(target=rec)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        row = factory.row(d)
        assert row["attempt_count"] == 1                         # exactly one counted attempt
        assert len(attempts(factory, d)) == 1
        # Exactly one side wins: reaper reclaimed it, or the worker's result landed first.
        assert (out["reap"], out["rec"]) in [(1, False), (0, True)]
        assert row["status"] in ("scheduled", "succeeded")


# ------------------------------------------------------------ database-level invariants

@pytest.mark.parametrize("sql", [
    "UPDATE delivery.deliveries SET status='queued', dispatch_token_hash=NULL",
    "UPDATE delivery.deliveries SET status='in_flight', lease_token_hash=NULL",
    "UPDATE delivery.deliveries SET status='succeeded', lease_token_hash='\\x01', lease_until=now()",
    "UPDATE delivery.deliveries SET status='bogus'",
    "UPDATE delivery.deliveries SET attempt_count=13",
])
def test_database_refuses_impossible_states(connect, factory, sql):
    factory.delivery()
    with connect("postgres") as c, pytest.raises(psycopg.errors.CheckViolation):
        c.execute(sql)


def test_outbox_token_cleared_only_with_published_at(connect, factory):
    d = factory.delivery()
    dispatch(connect, factory, d)
    with connect("relay_publisher") as c:
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("UPDATE delivery.outbox SET dispatch_token = NULL")          # cleared but not published
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("UPDATE delivery.outbox SET published_at = now()")           # published but token kept
        c.execute("UPDATE delivery.outbox SET published_at = now(), dispatch_token = NULL")


def test_counted_attempt_numbers_are_unique(connect, factory):
    d, ltok = claimed(connect, factory)
    record(connect, d, ltok, "retry")
    with connect("postgres") as c, pytest.raises(psycopg.errors.UniqueViolation):
        c.execute("INSERT INTO delivery.delivery_attempts (delivery_id, attempt_no, counted, outcome) "
                  "VALUES (%s, 1, true, 'retry')", (d,))
