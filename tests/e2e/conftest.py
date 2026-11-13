"""Shared harness for end-to-end tests: TLS material, the chaos receiver, and Fleet,
which runs the real data-plane processes as subprocesses."""

import asyncio
import base64
import os
import signal
import ssl
import subprocess
import sys
import time
import uuid

import aio_pika
import pytest
import trustme

from tests.conftest import ROOT, TEST_KEYRING, TEST_SECRET
from tests.e2e.chaos import ChaosReceiver

HOST = "localhost"  # resolved by the system resolver inside the worker process


@pytest.fixture(scope="module")
def tls(tmp_path_factory):
    ca = trustme.CA()
    server = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ca.issue_cert(HOST).configure_cert(server)
    ca_file = tmp_path_factory.mktemp("tls") / "ca.pem"
    ca.cert_pem.write_to_path(str(ca_file))
    return server, str(ca_file)


@pytest.fixture
def receiver(tls):
    r = ChaosReceiver(tls[0], TEST_SECRET).start()
    yield r
    r.stop()


class Fleet:
    """Starts data-plane processes as real subprocesses and tears them down."""

    def __init__(self, pg_dsn, amqp_url, receiver, ca_file, logdir):
        self.pg_dsn, self.amqp_url, self.receiver, self.ca_file, self.logdir = (
            pg_dsn,
            amqp_url,
            receiver,
            ca_file,
            logdir,
        )
        self.queue = f"relay.e2e.{uuid.uuid4().hex[:8]}"
        self.procs: list[tuple[str, subprocess.Popen, object]] = []

    def env(self, role: str) -> dict[str, str]:
        key_id, key = next(iter(TEST_KEYRING.keys.items()))
        env = {k: v for k, v in os.environ.items() if not k.upper().endswith("_PROXY")}
        return env | {
            "PYTHONPATH": str(ROOT / "services" / "data-plane"),
            "RELAY_DSN": f"{self.pg_dsn} user=relay_{'tenant' if role == 'ingest' else role}",
            "RELAY_AMQP": self.amqp_url,
            "RELAY_QUEUE": self.queue,
            "RELAY_SECRET_KEYS": f"{key_id}:{base64.b64encode(key).decode()}",
            "RELAY_ALLOW_PRIVATE_TARGETS": "true",
            "RELAY_ALLOWED_PORTS": f"443,{self.receiver.port}",
            "SSL_CERT_FILE": self.ca_file,  # trust the test CA (process-wide, not per endpoint)
            "RELAY_CONCURRENCY": "8",
            "RELAY_REQUEST_TIMEOUT": "1",
            "RELAY_LEASE_MARGIN": "1",
            "RELAY_RETRY_BASE_SECONDS": "0.2",
            "RELAY_RETRY_CAP_SECONDS": "0.4",
            "RELAY_SHUTDOWN_GRACE": "5",
            "RELAY_SCHEDULER_TICK": "0.1",
            "RELAY_REAPER_INTERVAL": "0.2",
            "RELAY_QUEUE_TIMEOUT": "3",
            "RELAY_PUBLISHER_TICK": "0.1",
            "RELAY_LOG_LEVEL": "INFO",
        }

    def start(self, role: str, **extra) -> subprocess.Popen:
        log = open(self.logdir / f"{role}-{len(self.procs)}.log", "w")
        p = subprocess.Popen(
            [sys.executable, "-m", "relay_dataplane", role],
            env=self.env(role) | extra,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        self.procs.append((role, p, log))
        return p

    def start_all(self, workers: int = 1) -> None:
        for role in ("scheduler", "publisher", "reaper"):
            self.start(role)
        for _ in range(workers):
            self.start("worker")

    def logs(self) -> str:
        out = []
        for role, p, log in self.procs:
            log.flush()
            out.append(f"----- {role} pid={p.pid} rc={p.poll()}\n{open(log.name).read()[-3000:]}")
        return "\n".join(out)

    def stop_all(self, timeout: float = 15) -> dict[str, int]:
        codes = {}
        for _, p, _ in self.procs:
            if p.poll() is None:
                p.send_signal(signal.SIGTERM)
        deadline = time.time() + timeout
        for role, p, log in self.procs:
            try:
                codes[f"{role}:{p.pid}"] = p.wait(max(0.1, deadline - time.time()))
            except subprocess.TimeoutExpired:
                p.kill()
                codes[f"{role}:{p.pid}"] = p.wait()
            log.close()
        return codes


@pytest.fixture
def fleet(pg_dsn, rabbit_url, receiver, tls, tmp_path):
    f = Fleet(pg_dsn, rabbit_url, receiver, tls[1], tmp_path)
    yield f
    f.stop_all()

    async def drop():
        conn = await aio_pika.connect_robust(rabbit_url)
        async with conn:
            ch = await conn.channel()
            await ch.queue_delete(f.queue)

    asyncio.run(drop())


def wait_for(predicate, timeout, fleet, what):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    pytest.fail(f"timed out after {timeout} s waiting for {what}\n{fleet.logs()}")
