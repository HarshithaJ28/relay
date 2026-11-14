"""Structured logs, token redaction, health and the ops server."""

import asyncio
import io
import json
import logging

import aiohttp
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from relay_dataplane import observability as obs


def capture(fn, fmt="json"):
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.addFilter(obs.RedactTokens())
    handler.setFormatter(obs.JsonFormatter() if fmt == "json" else obs.TextFormatter("%(message)s"))
    logger = logging.getLogger(f"test.obs.{id(stream)}")
    logger.handlers[:] = [handler]
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    fn(logger)
    return stream.getvalue()


def test_json_lines_with_standard_fields():
    out = capture(lambda log: log.info("delivered %s", "d-1", extra={"delivery_id": "d-1"}))
    entry = json.loads(out)
    assert entry["msg"] == "delivered d-1" and entry["level"] == "INFO" and entry["delivery_id"] == "d-1"
    assert isinstance(entry["ts"], float)


def test_fields_named_token_are_redacted_everywhere():
    out = capture(
        lambda log: (
            log.info("claim %(lease_token)s for %(delivery_id)s", {"lease_token": "SECRET1", "delivery_id": "d"}),
            log.info("with extra", extra={"dispatch_token": "SECRET2"}),
            log.info("inline dispatch_token=SECRET3 lease_token=SECRET4 next"),
        )
    )
    assert "SECRET" not in out
    assert out.count(obs.REDACTED) == 4
    assert "for d" in out and "next" in out


def test_other_text_is_untouched():
    out = capture(lambda log: log.info("token count=%d tokenizer=%s", 3, "x"), fmt="text")
    assert out.strip() == "token count=3 tokenizer=x"


def test_the_trace_id_is_attached_inside_a_span():
    provider = obs.setup_tracing("test", exporter=InMemorySpanExporter())
    tracer = provider.get_tracer("t")
    with tracer.start_as_current_span("s") as span:
        out = capture(lambda log: log.info("inside"))
    assert json.loads(out)["trace_id"] == format(span.get_span_context().trace_id, "032x")


def test_exceptions_are_kept_but_still_redacted():
    def boom(log):
        try:
            raise RuntimeError("lease_token=SECRET5 broke")
        except RuntimeError:
            log.exception("failed with dispatch_token=SECRET6")

    for fmt in ("json", "text"):
        out = capture(boom, fmt=fmt)
        assert "SECRET" not in out and "RuntimeError" in out


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_health_goes_stale_without_a_heartbeat():
    clock = Clock()
    health = obs.Health(stale_after=60, clock=clock)
    assert health.alive
    clock.t = 61
    assert not health.alive
    health.beat()
    assert health.alive


def test_ops_server_reports_liveness_readiness_and_metrics():
    async def go():
        clock = Clock()
        health = obs.Health(stale_after=60, clock=clock)
        async with obs.OpsServer(health, 0, host="127.0.0.1") as ops, aiohttp.ClientSession() as http:
            base = f"http://127.0.0.1:{ops.port}"

            async def status(path):
                async with http.get(base + path) as r:
                    return r.status, await r.text()

            not_ready = await status("/readyz")
            health.ready = True
            ready = await status("/readyz")
            clock.t = 120
            stalled = await status("/healthz")
            health.beat()
            alive = await status("/healthz")
            metrics = await status("/metrics")
            return not_ready, ready, stalled, alive, metrics

    not_ready, ready, stalled, alive, metrics = asyncio.run(go())
    assert (not_ready[0], ready[0], stalled[0], alive[0]) == (503, 200, 503, 200)
    assert metrics[0] == 200 and "relay_attempts_total" in metrics[1] and "relay_loop_heartbeat" in metrics[1]


def test_metric_labels_never_hold_ids():
    from prometheus_client import REGISTRY

    for family in REGISTRY.collect():
        if family.name.startswith("relay_"):
            for sample in family.samples:
                assert not ({"tenant_id", "delivery_id", "endpoint_id", "event_id"} & set(sample.labels)), family.name
