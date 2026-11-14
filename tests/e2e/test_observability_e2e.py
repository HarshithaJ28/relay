"""Every real process serves /metrics, /healthz and /readyz on its own port, the counters
reflect the work it did, and every log line is a JSON object."""

import json
import re

import httpx

from tests.e2e.conftest import HOST, wait_for
from tests.e2e.test_processes import endpoint_delivery, statuses


def scrape(port: int, path: str) -> httpx.Response:
    return httpx.get(f"http://127.0.0.1:{port}{path}", timeout=5)


def value(metrics: str, name: str, **labels) -> float:
    """Sum of every sample of `name` whose labels include `labels`."""
    total = 0.0
    for line in metrics.splitlines():
        m = re.match(rf"^{name}(\{{(.*)\}})? ([0-9.e+-]+)$", line)
        if m and all(f'{k}="{v}"' in (m.group(2) or "") for k, v in labels.items()):
            total += float(m.group(3))
    return total


def test_each_process_reports_health_and_its_own_work(connect, factory, fleet, receiver):
    ids = [
        endpoint_delivery(connect, factory, factory.tenant(), f"https://{HOST}:{receiver.port}/ok") for _ in range(3)
    ]
    fleet.start_all(workers=1)
    wait_for(lambda: all(s[0] == "succeeded" for s in statuses(connect, ids).values()), 60, fleet, "delivery")
    roles = [role for role, _, _ in fleet.procs]
    ports = dict(zip(roles, fleet.metrics_ports, strict=True))

    def all_ready():
        try:
            return all(scrape(p, "/readyz").status_code == 200 for p in ports.values())
        except httpx.HTTPError:
            return False

    wait_for(all_ready, 30, fleet, "every process to be ready")
    for role, port in ports.items():
        assert scrape(port, "/healthz").status_code == 200, role
        assert value(scrape(port, "/metrics").text, "relay_loop_heartbeat_timestamp_seconds") > 0, role

    metrics = {role: scrape(port, "/metrics").text for role, port in ports.items()}
    assert value(metrics["scheduler"], "relay_dispatched_total") >= 3
    assert value(metrics["publisher"], "relay_published_total") >= 3
    assert value(metrics["worker"], "relay_attempts_total", outcome="succeeded", error_class="none") == 3
    assert value(metrics["worker"], "relay_send_duration_seconds_count") == 3
    assert value(metrics["worker"], "relay_messages_handled_total", result="succeeded") == 3
    assert f'relay_queue_messages{{queue="{fleet.queue}"}}' in metrics["worker"]

    codes = fleet.stop_all()
    assert set(codes.values()) == {0}  # the ops server does not get in the way of a clean shutdown
    for line in fleet.logs(limit=None).splitlines():
        if line and not line.startswith("----- "):
            entry = json.loads(line)  # every line is one JSON object
            assert {"ts", "level", "logger", "msg"} <= set(entry)


def test_a_taken_metrics_port_is_a_configuration_error(fleet):
    import socket
    import subprocess
    import sys

    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        port = busy.getsockname()[1]
        env = fleet.env("scheduler") | {"RELAY_METRICS_PORT": str(port)}
        p = subprocess.run(
            [sys.executable, "-m", "relay_dataplane", "scheduler"], env=env, capture_output=True, text=True, timeout=30
        )
    assert p.returncode == 2 and "cannot serve metrics" in p.stderr
