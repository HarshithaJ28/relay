"""Model-based property test: random sequences of valid and invalid operations are
run against the real database and compared with an independent model of the
delivery state machine. Hypothesis shrinks any failing sequence to a minimal one."""

import os

import psycopg
import pytest
from hypothesis import HealthCheck, settings
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, initialize, invariant, rule

MAX_ATTEMPTS = 12
TERMINAL = {"succeeded", "dead"}


class DeliveryMachine(RuleBasedStateMachine):
    dsn = None  # set by the fixture below

    def connect(self, role):
        c = psycopg.connect(f"{self.dsn} user={role}", autocommit=True)
        self.conns.append(c)
        return c

    @initialize()
    def setup(self):
        self.conns = []
        self.su = self.connect("postgres")
        self.su.execute(
            "TRUNCATE delivery.outbox, delivery.delivery_attempts, delivery.deliveries, "
            "delivery.dispatch_locks, delivery.events, control.endpoints, control.tenants CASCADE"
        )
        self.tenant = self.su.execute("INSERT INTO control.tenants (name) VALUES ('t') RETURNING id").fetchone()[0]
        self.endpoint = self.su.execute(
            "INSERT INTO control.endpoints (tenant_id, url, secret_ciphertext) "
            "VALUES (%s, 'https://example.invalid', '\\x00') RETURNING id",
            (self.tenant,),
        ).fetchone()[0]
        self.sched = self.connect("relay_scheduler")
        self.worker = self.connect("relay_worker")
        self.reaper = self.connect("relay_reaper")
        self.model = {}  # delivery_id -> dict(status, attempts, start, seq, dtok, ltok)
        self.old_dtoks = []  # tokens that were valid once and must never work again
        self.old_ltoks = []

    def teardown(self):
        for c in getattr(self, "conns", []):
            c.close()

    # ---------------------------------------------------------------- operations
    @rule(start=st.sampled_from([0, 1, MAX_ATTEMPTS - 2, MAX_ATTEMPTS - 1]))  # boundary-heavy
    def new_delivery(self, start):
        ev = self.su.execute("SELECT gen_random_uuid()").fetchone()[0]
        created = self.su.execute(
            "INSERT INTO delivery.events (id, tenant_id, payload) VALUES (%s, %s, '{}') RETURNING created_at",
            (ev, self.tenant),
        ).fetchone()[0]
        d = self.su.execute(
            "INSERT INTO delivery.deliveries (tenant_id, endpoint_id, event_id, event_created_at, "
            "attempt_count) VALUES (%s,%s,%s,%s,%s) RETURNING id",
            (self.tenant, self.endpoint, ev, created, start),
        ).fetchone()[0]
        self.model[d] = {"status": "scheduled", "attempts": start, "start": start, "seq": 0, "dtok": None, "ltok": None}

    @rule()
    def dispatch(self):
        self.su.execute("UPDATE delivery.deliveries SET next_attempt_at = now() WHERE status = 'scheduled'")
        self.sched.execute("SELECT delivery.dispatch_batch(%s, 1000)", (self.tenant,))
        for d, m in self.model.items():
            if m["status"] == "scheduled":
                m["seq"] += 1
                m["status"] = "queued"
                m["dtok"] = bytes(
                    self.su.execute(
                        "SELECT dispatch_token FROM delivery.outbox WHERE delivery_id=%s AND dispatch_seq=%s",
                        (d, m["seq"]),
                    ).fetchone()[0]
                )

    def _claim(self, d, seq, dtok):
        return self.worker.execute(
            "SELECT * FROM delivery.claim_delivery(%s,%s,%s,%s,'1 minute')", (d, seq, dtok, os.urandom(16))
        ).fetchall()

    @rule(data=st.data())
    def claim_with_valid_token(self, data):
        queued = [d for d, m in self.model.items() if m["status"] == "queued"]
        if not queued:
            return
        d = data.draw(st.sampled_from(queued))
        m = self.model[d]
        ltok = os.urandom(16)
        rows = self.worker.execute(
            "SELECT * FROM delivery.claim_delivery(%s,%s,%s,%s,'1 minute')", (d, m["seq"], m["dtok"], ltok)
        ).fetchall()
        assert len(rows) == 1
        self.old_dtoks.append(m["dtok"])
        m["status"], m["ltok"] = "in_flight", ltok

    @rule(data=st.data())
    def claim_with_invalid_token(self, data):
        if not self.model:
            return
        d = data.draw(st.sampled_from(list(self.model)))
        m = self.model[d]
        kind = data.draw(st.sampled_from(["random", "wrong_seq", "stale"]))
        if kind == "stale" and self.old_dtoks:
            dtok, seq = data.draw(st.sampled_from(self.old_dtoks)), m["seq"]
        elif kind == "wrong_seq" and m["dtok"]:
            dtok, seq = m["dtok"], m["seq"] + 1
        else:
            dtok, seq = os.urandom(16), m["seq"]
        if m["status"] == "queued" and dtok == m["dtok"] and seq == m["seq"]:
            return  # that would be the valid claim
        assert self._claim(d, seq, dtok) == []

    @rule(data=st.data(), outcome=st.sampled_from(["success", "retry", "dead"]))
    def record_with_valid_lease(self, data, outcome):
        live = [d for d, m in self.model.items() if m["status"] == "in_flight"]
        if not live:
            return
        d = data.draw(st.sampled_from(live))
        m = self.model[d]
        got = self.worker.execute(
            "SELECT delivery.record_attempt(%s,%s,%s,200,NULL,'1 second')", (d, m["ltok"], outcome)
        ).fetchone()[0]
        m["attempts"] += 1
        if outcome == "success":
            expected = "succeeded"
        elif outcome == "dead" or m["attempts"] >= MAX_ATTEMPTS:
            expected = "dead"
        else:
            expected = "scheduled"
        assert got == expected
        self.old_ltoks.append(m["ltok"])
        m["status"], m["ltok"], m["dtok"] = ("scheduled" if expected == "scheduled" else expected), None, None

    @rule(data=st.data(), outcome=st.sampled_from(["success", "retry", "dead"]))
    def record_with_invalid_lease(self, data, outcome):
        if not self.model:
            return
        d = data.draw(st.sampled_from(list(self.model)))
        pool = [*self.old_ltoks, os.urandom(16)]
        ltok = data.draw(st.sampled_from(pool))
        if self.model[d]["status"] == "in_flight" and ltok == self.model[d]["ltok"]:
            return
        assert (
            self.worker.execute(
                "SELECT delivery.record_attempt(%s,%s,%s,200,NULL,'1 second')", (d, ltok, outcome)
            ).fetchone()[0]
            is None
        )

    @rule()
    def lease_expires_and_reaper_runs(self):
        self.su.execute(
            "UPDATE delivery.deliveries SET lease_until = now() - interval '1 minute' WHERE status = 'in_flight'"
        )
        self.reaper.execute("SELECT delivery.reclaim_expired(1000)")
        for m in self.model.values():
            if m["status"] == "in_flight":
                m["attempts"] += 1
                self.old_ltoks.append(m["ltok"])
                m["status"] = "dead" if m["attempts"] >= MAX_ATTEMPTS else "scheduled"
                m["ltok"], m["dtok"] = None, None

    # ---------------------------------------------------------------- invariants
    @invariant()
    def database_matches_the_model(self):
        for d, m in self.model.items():
            status, count, seq = self.su.execute(
                "SELECT status, attempt_count, dispatch_seq FROM delivery.deliveries WHERE id=%s", (d,)
            ).fetchone()
            assert (status, count, seq) == (m["status"], m["attempts"], m["seq"]), (d, m)
            counted = self.su.execute(
                "SELECT count(*) FROM delivery.delivery_attempts WHERE delivery_id=%s AND counted", (d,)
            ).fetchone()[0]
            assert counted == count - m["start"]  # exactly one counted attempt row per attempt made
            assert count <= MAX_ATTEMPTS

    @invariant()
    def terminal_deliveries_hold_no_tokens(self):
        rows = self.su.execute(
            "SELECT count(*) FROM delivery.deliveries WHERE status IN ('succeeded','dead') "
            "AND (lease_token_hash IS NOT NULL OR dispatch_token_hash IS NOT NULL)"
        ).fetchone()[0]
        assert rows == 0


@pytest.fixture(scope="module", autouse=True)
def _bind_dsn(pg_dsn):
    DeliveryMachine.dsn = pg_dsn


DeliveryMachine.TestCase.settings = settings(
    max_examples=150, stateful_step_count=40, deadline=None, suppress_health_check=list(HealthCheck)
)
TestDeliveryStateMachine = DeliveryMachine.TestCase
