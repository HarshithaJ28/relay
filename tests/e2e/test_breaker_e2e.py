"""The circuit breaker in the real processes: an endpoint goes down, the breaker opens and
holds its backlog back, the probe after the cool-down finds it healthy again and closes
the breaker, and every delivery still arrives."""

import time

from tests.e2e.conftest import HOST, wait_for
from tests.e2e.test_processes import endpoint_delivery, statuses

OUTAGE = 4.0  # seconds the endpoint answers 503


def test_breaker_opens_during_an_outage_and_closes_after_it(connect, factory, fleet, receiver, valkey_clean):
    down_until = time.time() + OUTAGE
    url = f"https://{HOST}:{receiver.port}/down-until/{down_until}"
    tenant = factory.tenant()
    first = endpoint_delivery(connect, factory, tenant, url)
    endpoint = factory.row(first)["endpoint_id"]
    row = factory.row(first)
    with connect() as c:  # 29 more deliveries to the same endpoint
        ids = [first] + [
            c.execute(
                "INSERT INTO delivery.deliveries (tenant_id, endpoint_id, event_id, event_created_at) "
                "VALUES (%s, %s, %s, %s) RETURNING id",
                (tenant, endpoint, row["event_id"], row["event_created_at"]),
            ).fetchone()[0]
            for _ in range(29)
        ]

    breaker = {
        "RELAY_VALKEY_URL": valkey_clean,
        "RELAY_BREAKER_MIN_VOLUME": "5",
        "RELAY_BREAKER_THRESHOLD": "0.5",
        "RELAY_BREAKER_COOLDOWN": "1",
        "RELAY_BREAKER_MAX_COOLDOWN": "2",
        "RELAY_RETRY_BASE_SECONDS": "0.1",
        "RELAY_RETRY_CAP_SECONDS": "0.2",
    }
    for role in ("scheduler", "publisher", "reaper"):
        fleet.start(role)
    fleet.start("worker", **breaker)

    seen_open = False

    def done():
        nonlocal seen_open
        with connect() as c:
            if c.execute("SELECT status FROM control.endpoints WHERE id = %s", (endpoint,)).fetchone()[0] == (
                "breaker_open"
            ):
                seen_open = True
        return all(s[0] == "succeeded" for s in statuses(connect, ids).values())

    wait_for(done, 60, fleet, "every delivery to succeed after the outage")
    assert seen_open, "the breaker never opened during the outage"
    with connect() as c:
        assert c.execute("SELECT status FROM control.endpoints WHERE id = %s", (endpoint,)).fetchone()[0] == "enabled"
    during = [r for r in receiver.requests if r.at < down_until]
    # 30 deliveries retrying every 0.1-0.2 s for 4 s would be hundreds of requests without the breaker
    assert len(during) < 60, len(during)
