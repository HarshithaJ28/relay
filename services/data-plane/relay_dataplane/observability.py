"""Metrics, health, structured logs and traces for every data-plane process (spec section 10).

- Prometheus metrics, served with /healthz and /readyz by a small ops server on
  RELAY_METRICS_PORT (default 9100; the ingestion API serves them on its own port).
  Labels never include tenant or delivery ids, so cardinality stays bounded.
- /healthz (liveness): the process's main loop has run recently. /readyz: the process
  is connected to what it needs.
- JSON logs (RELAY_LOG_FORMAT=json, the default; "text" for local reading). Any field or
  key=value pair whose name ends in _token is redacted before it is written.
- OpenTelemetry traces, exported over OTLP/HTTP only when OTEL_EXPORTER_OTLP_ENDPOINT is
  set. Span attributes whose names end in _token are dropped.
"""

import json
import logging
import os
import re
import time

from aiohttp import web
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult
from prometheus_client import CONTENT_TYPE_LATEST, REGISTRY, Counter, Gauge, Histogram, generate_latest

# ---------------------------------------------------------------- metrics

ATTEMPTS = Counter("relay_attempts", "Recorded delivery attempts", ["outcome", "error_class"])
SEND_SECONDS = Histogram(
    "relay_send_duration_seconds",
    "Duration of one HTTP request to an endpoint",
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30),
)
HANDLED = Counter("relay_messages_handled", "Queue messages handled by workers, by result", ["result"])
DISPATCHED = Counter("relay_dispatched", "Deliveries moved to queued by the scheduler")
PUBLISHED = Counter("relay_published", "Outbox rows published with a broker confirm")
OUTBOX_UNPUBLISHED = Gauge("relay_outbox_unpublished", "Outbox rows waiting to be published")
RECLAIMED = Counter("relay_reaper_reclaimed", "In-flight deliveries whose lease expired")
REQUEUED = Counter("relay_reaper_requeued", "Queued deliveries whose message was lost or rejected")
QUEUE_MESSAGES = Gauge("relay_queue_messages", "Messages waiting in a queue", ["queue"])
BREAKER_OPENED = Counter("relay_breaker_opened", "Circuit breakers opened or reopened")
RETENTION_BLOCKED = Gauge(
    "relay_retention_blocked_events", "Events past retention kept because a delivery is still active"
)
RETENTION_LAG = Gauge("relay_retention_lag_seconds", "Age past expiry of the oldest expired row still stored")
RETENTION_DELETED = Counter("relay_retention_deleted", "Rows deleted by the retention job", ["kind"])
PARTITIONS_SKIPPED = Gauge("relay_partitions_skipped", "Expired partitions that could not be dropped")
ORPHANS = Gauge("relay_orphans", "Rows that should not exist, from the daily orphan report", ["kind"])
INGEST_REQUESTS = Counter("relay_ingest_requests", "Ingestion API responses", ["route", "status"])
LOOP_HEARTBEAT = Gauge("relay_loop_heartbeat_timestamp_seconds", "Last time the process's main loop ran")


def metrics_text() -> bytes:
    return generate_latest(REGISTRY)


# ---------------------------------------------------------------- health


class Health:
    """Liveness from a heartbeat the main loop beats; readiness set by the process."""

    def __init__(self, stale_after: float = 60.0, clock=time.monotonic):
        self.stale_after, self._clock = stale_after, clock
        self._beat = clock()
        self.ready = False

    def beat(self) -> None:
        self._beat = self._clock()
        LOOP_HEARTBEAT.set_to_current_time()

    @property
    def alive(self) -> bool:
        return self._clock() - self._beat < self.stale_after


class OpsServer:
    """/metrics, /healthz and /readyz on a separate port, so probes never queue behind work."""

    def __init__(self, health: Health, port: int, host: str = "0.0.0.0"):
        self.health, self.port, self.host = health, port, host
        self._runner: web.AppRunner | None = None

    async def __aenter__(self) -> "OpsServer":
        app = web.Application()
        app.router.add_get("/metrics", self._metrics)
        app.router.add_get("/healthz", self._healthz)
        app.router.add_get("/readyz", self._readyz)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]  # the real port when 0 was asked for
        return self

    async def __aexit__(self, *exc) -> None:
        if self._runner is not None:
            await self._runner.cleanup()

    async def _metrics(self, _request):
        return web.Response(body=metrics_text(), headers={"Content-Type": CONTENT_TYPE_LATEST})

    async def _healthz(self, _request):
        ok = self.health.alive
        return web.json_response({"status": "ok" if ok else "stalled"}, status=200 if ok else 503)

    async def _readyz(self, _request):
        ok = self.health.ready
        return web.json_response({"status": "ready" if ok else "not ready"}, status=200 if ok else 503)


# ---------------------------------------------------------------- logs

REDACTED = "[redacted]"
_TOKEN_PAIR = re.compile(r"\b(\w*_token)=(\S+)", re.IGNORECASE)
_STANDARD = set(vars(logging.makeLogRecord({}))) | {"message", "asctime"}


def redact_text(text: str) -> str:
    return _TOKEN_PAIR.sub(lambda m: f"{m.group(1)}={REDACTED}", text)


def _redact_value(key: str, value):
    return REDACTED if key.lower().endswith("_token") else value


class RedactTokens(logging.Filter):
    """Redact anything named *_token: dict args, extra fields, and key=value text in messages."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, dict):
            record.args = {k: _redact_value(k, v) for k, v in record.args.items()}
        for key in list(vars(record)):
            if key not in _STANDARD and key.lower().endswith("_token"):
                setattr(record, key, REDACTED)
        message = record.getMessage()
        redacted = redact_text(message)
        if redacted != message:
            record.msg, record.args = redacted, None
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": round(record.created, 3),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        span = trace.get_current_span().get_span_context()
        if span.is_valid:
            entry["trace_id"] = format(span.trace_id, "032x")
        for key, value in vars(record).items():
            if key not in _STANDARD and not key.startswith("_"):
                entry[key] = value
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)

    def formatException(self, ei) -> str:
        return redact_text(super().formatException(ei))


class TextFormatter(logging.Formatter):
    def formatException(self, ei) -> str:
        return redact_text(super().formatException(ei))


# Libraries that log raw wire data (AMQP frames include message bodies, and so dispatch
# tokens) at DEBUG. They never go below INFO, whatever RELAY_LOG_LEVEL says (spec section 3:
# queue message bodies are never logged).
WIRE_LOGGERS = ("aiormq", "aio_pika", "pamqp", "hpack", "httpcore", "urllib3")


def setup_logging(level: str = "INFO", fmt: str | None = None) -> None:
    fmt = (fmt or os.environ.get("RELAY_LOG_FORMAT", "json")).lower()
    handler = logging.StreamHandler()
    handler.addFilter(RedactTokens())
    handler.setFormatter(
        JsonFormatter() if fmt == "json" else TextFormatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for name in WIRE_LOGGERS:
        logging.getLogger(name).setLevel(max(logging.INFO, root.level))


# ---------------------------------------------------------------- traces


class DropTokenAttributes(SpanExporter):
    """Wraps an exporter: every span leaves without attributes named *_token.

    Span attributes are frozen when a span ends, so filtering happens on export, where a
    filtered copy of each span is handed to the real exporter (defence in depth: Relay's
    own code never sets such attributes)."""

    def __init__(self, inner: SpanExporter):
        self.inner = inner

    def export(self, spans) -> SpanExportResult:
        return self.inner.export([_without_tokens(span) for span in spans])

    def shutdown(self) -> None:
        self.inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self.inner.force_flush(timeout_millis)


def _without_tokens(span: ReadableSpan) -> ReadableSpan:
    attributes = span.attributes or {}
    if not any(k.lower().endswith("_token") for k in attributes):
        return span
    return ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes={k: v for k, v in attributes.items() if not k.lower().endswith("_token")},
        events=span.events,
        links=span.links,
        kind=span.kind,
        status=span.status,
        start_time=span.start_time,
        end_time=span.end_time,
        instrumentation_scope=span.instrumentation_scope,
    )


def setup_tracing(service: str, exporter: SpanExporter | None = None) -> TracerProvider:
    """Install a tracer provider. Spans are exported only if an OTLP endpoint is configured
    (or an exporter is given, as tests do)."""
    provider = TracerProvider(resource=Resource.create({"service.name": f"relay-{service}"}))
    if exporter is None and os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        exporter = OTLPSpanExporter()
    if exporter is not None:
        provider.add_span_processor(BatchSpanProcessor(DropTokenAttributes(exporter)))
    trace.set_tracer_provider(provider)
    return provider


tracer = trace.get_tracer("relay")
