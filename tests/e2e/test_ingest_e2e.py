"""The ingestion API as a real process: create a key with the CLI, send an event over
HTTP, and watch it reach the chaos receiver through scheduler, publisher and worker."""

import json
import subprocess
import sys
import time

import httpx
import psycopg
import pytest

from tests.e2e.conftest import HOST, Fleet, free_port, wait_for
from tests.ingest.conftest import add_endpoint, subscribe


@pytest.fixture
def ingest_setup(pg_dsn, factory, receiver):
    tenant = factory.tenant()
    with psycopg.connect(f"{pg_dsn} user=postgres", autocommit=True) as su:
        ep = add_endpoint(su, tenant)
        su.execute("UPDATE control.endpoints SET url = %s WHERE id = %s", (f"https://{HOST}:{receiver.port}/ok", ep))
        subscribe(su, tenant, ep, "order.created")
    return tenant


def test_event_sent_over_http_is_delivered_signed(fleet: Fleet, receiver, ingest_setup):
    cli = subprocess.run(
        [sys.executable, "-m", "relay_dataplane", "create-api-key", "--tenant", str(ingest_setup), "--name", "e2e"],
        env=fleet.env("tenant"),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert cli.returncode == 0, cli.stderr
    key = cli.stdout.strip()
    assert key.startswith("rly_") and key not in cli.stderr  # printed once, never logged

    port = free_port()
    ingest = fleet.start("ingest", RELAY_DSN=fleet.env("tenant")["RELAY_DSN"], RELAY_INGEST_PORT=str(port))
    fleet.start("scheduler", RELAY_SCHEDULER_TICK="10")  # only NOTIFY can make delivery fast
    for role in ("publisher", "reaper", "worker"):
        fleet.start(role)
    base = f"http://127.0.0.1:{port}"
    wait_for(lambda: _ready(base), 30, fleet, "ingest readiness")

    payload = {"order": 42, "price": "19.99", "items": [{"sku": "A-1", "qty": 2}]}
    sent_at = time.time()
    r = httpx.post(
        f"{base}/ingest/v1/events",
        json={"event_type": "order.created", "payload": payload},
        headers={"Authorization": f"Bearer {key}", "Idempotency-Key": "e2e-1"},
    )
    assert r.status_code == 202, r.text
    event_id = r.json()["event_id"]
    wait_for(lambda: len(receiver.requests) == 1, 20, fleet, "delivery")
    [seen] = receiver.requests
    assert seen.signature_ok and json.loads(seen.body) == payload
    assert seen.at - sent_at < 3, "scheduler did not wake on NOTIFY"

    again = httpx.post(  # a client retry after a timeout: same event, nothing sent twice
        f"{base}/ingest/v1/events",
        json={"event_type": "order.created", "payload": payload},
        headers={"Authorization": f"Bearer {key}", "Idempotency-Key": "e2e-1"},
    )
    assert again.json()["event_id"] == event_id and again.headers["idempotent-replayed"] == "true"
    time.sleep(1)
    assert len(receiver.requests) == 1

    ingest.terminate()
    assert ingest.wait(15) == 0, fleet.logs()


def _ready(base: str) -> bool:
    try:
        return httpx.get(f"{base}/readyz", timeout=1).status_code == 200
    except httpx.HTTPError:
        return False
