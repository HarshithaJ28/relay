"""Circuit breaker: the Valkey state machine (real Valkey, Lua), the PostgreSQL mirror and
dispatch rules (real database), and the worker feeding results into both."""

import asyncio
from datetime import timedelta

import psycopg
import pytest
import valkey.asyncio

from relay_dataplane.breaker import BreakerConfig, CircuitBreaker, counts_as_failure
from relay_dataplane.outcome import Classified, SendResult
from tests.db.test_bounded_dispatch import dispatch, endpoint_of, more, set_endpoint
from tests.worker.test_worker_core import ScriptedSender, queue_message, run

CONFIG = BreakerConfig(window=60, bucket=5, min_volume=4, threshold=0.5, base_cooldown=30, max_cooldown=100)


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


def record_all(url, results, clock, endpoint="ep-1", config=CONFIG):
    """Feed (failed: bool) results in order; return the decisions."""

    async def go():
        client = valkey.asyncio.Valkey.from_url(url)
        try:
            breaker = CircuitBreaker(client, config, clock)
            return [await breaker.record(endpoint, failed) for failed in results]
        finally:
            await client.aclose()

    return asyncio.run(go())


# ---------------------------------------------------------------- the state machine in Valkey


def test_below_minimum_volume_it_never_opens(valkey_clean):
    assert [d.state for d in record_all(valkey_clean, [True] * 3, Clock())] == ["closed"] * 3


def test_opens_at_the_threshold_with_enough_volume(valkey_clean):
    clock = Clock()
    decisions = record_all(valkey_clean, [False, False, True, True], clock)
    assert [d.state for d in decisions] == ["closed", "closed", "closed", "opened"]
    assert decisions[-1].until.timestamp() == clock.t + 30
    assert decisions[-1].opens


def test_a_healthy_endpoint_stays_closed(valkey_clean):
    assert {d.state for d in record_all(valkey_clean, [False, False, False, True] * 5, Clock())} == {"closed"}


def test_results_already_in_flight_when_it_opened_are_ignored(valkey_clean):
    decisions = record_all(valkey_clean, [True] * 4 + [False, True, False], Clock())
    assert [d.state for d in decisions[4:]] == ["open"] * 3


def test_failed_probe_reopens_with_a_longer_cooldown_up_to_the_maximum(valkey_clean):
    clock = Clock()
    record_all(valkey_clean, [True] * 4, clock)  # open for 30 s
    cooldowns = []
    for _ in range(3):
        start = clock.t = clock.t + 1000  # well past the cool-down: the next result is the probe
        [d] = record_all(valkey_clean, [True], clock)
        assert d.state == "reopened"
        cooldowns.append(d.until.timestamp() - start)
    assert cooldowns == [60, 100, 100]  # doubled, then capped


def test_successful_probe_closes_and_resets_the_window(valkey_clean):
    clock = Clock()
    record_all(valkey_clean, [True] * 4, clock)
    clock.t += 31
    [probe] = record_all(valkey_clean, [False], clock)
    assert probe.state == "closed_after_probe"
    # the old failures are gone: three new failures are below the minimum volume again
    assert [d.state for d in record_all(valkey_clean, [True] * 3, clock)] == ["closed"] * 3


def test_only_the_rolling_window_counts(valkey_clean):
    clock = Clock()
    record_all(valkey_clean, [True] * 3, clock)
    clock.t += 61  # those three failures have left the window
    assert [d.state for d in record_all(valkey_clean, [True] * 3, clock)] == ["closed"] * 3


def test_endpoints_are_independent(valkey_clean):
    clock = Clock()
    record_all(valkey_clean, [True] * 4, clock, endpoint="a")
    assert record_all(valkey_clean, [True], clock, endpoint="b")[0].state == "closed"


def test_unreachable_valkey_means_closed_never_open():
    decisions = record_all("valkey://127.0.0.1:1/0", [True] * 10, Clock())
    assert {d.state for d in decisions} == {"unknown"} and not any(d.opens for d in decisions)


@pytest.mark.parametrize(
    ("verdict", "expected"),
    [
        (Classified("success", None, 200), False),
        (Classified("retry", "http_5xx", 503), True),
        (Classified("retry", "timeout", None), True),
        (Classified("retry", "rate_limited", 429), True),
        (Classified("retry", "http_4xx", 404), None),  # the endpoint answered: not an availability failure
        (Classified("dead", "blocked_destination", None), None),
        (Classified("retry", "secret_unavailable", None), None),
        (Classified("retry", "internal_error", None), None),
    ],
)
def test_which_results_count(verdict, expected):
    assert counts_as_failure(verdict) is expected


# ---------------------------------------------------------------- the PostgreSQL mirror


def claim(connect, factory, d, lease=b"L" * 16):
    import json

    m = json.loads(queue_message(connect, factory, d))
    with connect("relay_worker") as c:
        c.execute(
            "SELECT * FROM delivery.claim_delivery(%s,%s,%s,%s,'1 minute')",
            (d, m["dispatch_seq"], bytes.fromhex(m["dispatch_token"]), lease),
        )
    return lease


def open_breaker(connect, d, lease, seconds=60, jitter=timedelta(seconds=10)):
    with connect("relay_worker") as c:
        return c.execute(
            "SELECT delivery.open_breaker(%s, %s, now() + %s, %s)", (d, lease, timedelta(seconds=seconds), jitter)
        ).fetchone()[0]


def endpoint(connect, ep):
    with connect() as c:
        return c.execute("SELECT status, breaker_until FROM control.endpoints WHERE id = %s", (ep,)).fetchone()


def test_opening_pushes_due_deliveries_past_the_reopen_time_without_attempts(connect, factory):
    d = factory.delivery()
    lease = claim(connect, factory, d)
    waiting = more(connect, factory, d, 5)  # due, but not yet dispatched
    assert open_breaker(connect, d, lease) == 5
    status, until = endpoint(connect, endpoint_of(factory, d))
    assert status == "breaker_open"
    for w in waiting:
        row = factory.row(w)
        assert until <= row["next_attempt_at"] <= until + timedelta(seconds=10)
        assert (row["status"], row["attempt_count"]) == ("scheduled", 0)


def test_only_the_lease_holder_can_open_it(connect, factory):
    d = factory.delivery()
    claim(connect, factory, d)
    assert open_breaker(connect, d, b"W" * 16) is None
    assert endpoint(connect, endpoint_of(factory, d)) == ("enabled", None)


def test_a_disabled_endpoint_stays_disabled(connect, factory):
    d = factory.delivery()
    lease = claim(connect, factory, d)
    set_endpoint(connect, endpoint_of(factory, d), status="disabled")
    open_breaker(connect, d, lease)
    assert endpoint(connect, endpoint_of(factory, d)) == ("disabled", None)


@pytest.mark.parametrize(("seconds", "jitter"), [(-1, 0), (0, 0), (2 * 86400, 0), (60, -1), (60, 7200)])
def test_open_breaker_rejects_bad_arguments(connect, factory, seconds, jitter):
    d = factory.delivery()
    lease = claim(connect, factory, d)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        open_breaker(connect, d, lease, seconds, timedelta(seconds=jitter))


def trip(connect, ep, until="now() + interval '1 minute'"):
    with connect() as c:
        c.execute(f"UPDATE control.endpoints SET status = 'breaker_open', breaker_until = {until} WHERE id = %s", (ep,))


def test_while_open_nothing_is_dispatched_and_after_the_cooldown_exactly_one_probe(connect, factory):
    d = factory.delivery()
    ep, tenant = endpoint_of(factory, d), factory.row(d)["tenant_id"]
    more(connect, factory, d, 9)
    trip(connect, ep)
    assert dispatch(connect, tenant) == 0
    trip(connect, ep, until="now() - interval '1 second'")  # cool-down over: half-open
    assert dispatch(connect, tenant) == 1
    assert dispatch(connect, tenant) == 0  # the probe is still out


def test_a_successful_probe_closes_the_mirror(pg_dsn, connect, factory):
    d = factory.delivery()
    ep = endpoint_of(factory, d)
    trip(connect, ep, until="now() - interval '1 second'")
    assert run(pg_dsn, queue_message(connect, factory, d), ScriptedSender(SendResult(200))).result == "succeeded"
    assert endpoint(connect, ep) == ("enabled", None)


@pytest.mark.parametrize(
    ("until", "result", "stays_open"),
    [
        ("now() + interval '1 minute'", SendResult(200), True),  # a late success from before it opened
        ("now() - interval '1 second'", SendResult(503), True),  # a failed probe
    ],
)
def test_other_results_do_not_close_the_mirror(pg_dsn, connect, factory, until, result, stays_open):
    d = factory.delivery()
    ep = endpoint_of(factory, d)
    body = queue_message(connect, factory, d)  # dispatched before the breaker opened
    trip(connect, ep, until=until)
    run(pg_dsn, body, ScriptedSender(result))
    assert endpoint(connect, ep)[0] == "breaker_open"


# ---------------------------------------------------------------- the worker feeds the breaker


def test_repeated_failures_open_the_breaker_and_hold_back_the_backlog(pg_dsn, connect, factory, valkey_clean):
    d = factory.delivery()
    ep, tenant = endpoint_of(factory, d), factory.row(d)["tenant_id"]
    sent = [d, *more(connect, factory, d, 3)]
    backlog = more(connect, factory, d, 5, due="now() + interval '1 second'")

    async def failing():
        client = valkey.asyncio.Valkey.from_url(valkey_clean)
        try:
            breaker = CircuitBreaker(client, CONFIG)
            async with await psycopg.AsyncConnection.connect(f"{pg_dsn} user=relay_worker", autocommit=True) as conn:
                from relay_dataplane.worker import handle_message
                from tests.conftest import TEST_KEYRING

                return [
                    await handle_message(
                        conn,
                        queue_message(connect, factory, x),
                        ScriptedSender(SendResult(503)),
                        TEST_KEYRING,
                        breaker=breaker,
                    )
                    for x in sent
                ]
        finally:
            await client.aclose()

    assert [h.result for h in asyncio.run(failing())] == ["retry"] * 4
    status, until = endpoint(connect, ep)
    assert status == "breaker_open"
    for b in backlog:  # pushed past the reopen time, no attempt used
        assert factory.row(b)["next_attempt_at"] >= until and factory.row(b)["attempt_count"] == 0
    assert dispatch(connect, tenant) == 0
