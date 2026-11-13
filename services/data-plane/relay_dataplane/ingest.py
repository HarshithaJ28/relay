"""Ingestion API (spec section 4): POST /ingest/v1/events and GET /ingest/v1/events/{id}.

An event is durable when the API returns 202: the idempotency key, the event and one
delivery per subscribed endpoint are written in ONE transaction, so they exist together
or not at all, and a failed request can be retried with the same key.

Idempotency: the first request with a key inserts it. A concurrent request with the same
key waits on the unique index until the first commits or rolls back, then either returns
the original event (same body: 202 with Idempotent-Replayed: true) or is rejected (different
body: 422). Bodies are compared by the SHA-256 of their jsonb form, so whitespace and key
order do not matter.

The database role is relay_tenant with row-level security: each transaction sets
app.tenant_id after authenticating the key, and the policies hide every other tenant.

Error responses use RFC 9457 problem details (application/problem+json).
"""

import contextlib
import logging
import os
import re
import time
import uuid
from datetime import timedelta

import psycopg
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from psycopg_pool import AsyncConnectionPool, PoolTimeout
from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import api_keys

log = logging.getLogger("relay.ingest")

MAX_BODY_BYTES = 256 * 1024
IDEMPOTENCY_KEY = re.compile(r"^[\x21-\x7e]{1,255}$")
EVENT_TYPE_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
PROBLEM = "application/problem+json"


def uuid7() -> uuid.UUID:
    """A time-ordered UUID (RFC 9562 version 7): 48-bit Unix milliseconds, then random bits."""
    ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")
    value = (ms & ((1 << 48) - 1)) << 80 | 0x7 << 76 | (rand >> 68) << 64 | 0b10 << 62 | (rand & ((1 << 62) - 1))
    return uuid.UUID(int=value)


# ---------------------------------------------------------------- models (also the OpenAPI contract)


class EventIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_type: str = Field(pattern=EVENT_TYPE_PATTERN, description="A registered event type of the tenant")
    payload: JsonValue = Field(description="Any JSON value; delivered to subscribers as is")


# Written out for the OpenAPI document (pydantic's version uses $defs, which an embedded
# request body cannot reference). Kept in step with EventIn by a test.
EVENT_IN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["event_type", "payload"],
    "properties": {
        "event_type": {"type": "string", "pattern": EVENT_TYPE_PATTERN, "description": "A registered event type"},
        "payload": {"description": "Any JSON value; delivered to subscribers as is"},
    },
}


class Accepted(BaseModel):
    event_id: uuid.UUID
    deliveries: int = Field(description="Deliveries created, one per subscribed endpoint")


class EventOut(BaseModel):
    id: uuid.UUID
    event_type: str
    created_at: str
    payload: JsonValue


class Problem(BaseModel):
    type: str
    title: str
    status: int
    detail: str | None = None


def problem(status: int, slug: str, title: str, detail: str | None = None, headers=None) -> JSONResponse:
    body = {"type": f"/problems/{slug}", "title": title, "status": status}
    if detail:
        body["detail"] = detail
    return JSONResponse(body, status_code=status, media_type=PROBLEM, headers=headers)


ERRORS = {
    400: {"model": Problem, "description": "Malformed header"},
    401: {"model": Problem, "description": "Missing or invalid API key"},
    403: {"model": Problem, "description": "The key lacks the required scope"},
    413: {"model": Problem, "description": "Body larger than 256 KB"},
    415: {"model": Problem, "description": "Body is not application/json"},
    422: {"model": Problem, "description": "Invalid event, unknown event type, or idempotency key reused"},
    503: {"model": Problem, "description": "Database unavailable"},
}


class LimitBody:
    """ASGI middleware: read the whole body first, refusing it once it passes the limit.

    Checked by Content-Length and again while streaming (a chunked upload has no length).
    The app then gets the buffered body, so a too-large body never reaches its parser."""

    def __init__(self, app, limit: int = MAX_BODY_BYTES):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        too_large = problem(413, "body-too-large", "Request body too large")
        for name, value in scope.get("headers", []):
            if name == b"content-length" and value.isdigit() and int(value) > self.limit:
                return await too_large(scope, receive, send)
        chunks, size, more = [], 0, True
        while more:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > self.limit:
                return await too_large(scope, receive, send)
            chunks.append(chunk)
            more = message.get("more_body", False)
        body, delivered = b"".join(chunks), False

        async def replay():
            nonlocal delivered
            if delivered:
                return await receive()  # after the body: wait for disconnect, as the server would
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)


# ---------------------------------------------------------------- app


def create_app(pool: AsyncConnectionPool, idempotency_window: timedelta = timedelta(hours=24)):
    @contextlib.asynccontextmanager
    async def lifespan(_app):
        # the pool belongs to the event loop that serves requests, so it opens here
        await pool.open()
        try:
            yield
        finally:
            await pool.close()

    app = FastAPI(
        lifespan=lifespan,
        title="Relay ingestion API",
        version="1",
        description="Send events to Relay. Authenticate with `Authorization: Bearer <API key>`.",
        openapi_url="/ingest/v1/openapi.json",
        docs_url=None,
        redoc_url=None,
    )

    @app.exception_handler(RequestValidationError)
    async def invalid(_request, exc: RequestValidationError):
        return problem(422, "invalid-request", "Invalid request", _first_error(exc.errors()))

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_request, exc: StarletteHTTPException):
        slug = {404: "not-found", 405: "method-not-allowed"}.get(exc.status_code, "error")
        return problem(exc.status_code, slug, str(exc.detail), headers=getattr(exc, "headers", None))

    async def authenticate(conn: psycopg.AsyncConnection, request: Request, scope: str):
        """Inside the request transaction: check the key, then set the tenant for row-level security."""
        header = request.headers.get("authorization", "")
        key = header[7:].strip() if header[:7].lower() == "bearer " else ""
        if not api_keys.looks_valid(key):
            return None, problem(
                401, "unauthorized", "Missing or invalid API key", headers={"WWW-Authenticate": "Bearer"}
            )
        cur = await conn.execute("SELECT * FROM control.authenticate_api_key(%s)", (api_keys.key_hash(key),))
        row = await cur.fetchone()
        if row is None:
            return None, problem(
                401, "unauthorized", "Missing or invalid API key", headers={"WWW-Authenticate": "Bearer"}
            )
        _, tenant_id, scopes = row
        if scope not in scopes:
            return None, problem(403, "forbidden", f"The API key lacks the {scope} scope")
        await conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
        return tenant_id, None

    @app.post(
        "/ingest/v1/events",
        status_code=202,
        response_model=Accepted,
        responses=ERRORS,
        summary="Send an event",
        openapi_extra={
            "parameters": [
                {
                    "name": "Idempotency-Key",
                    "in": "header",
                    "required": False,
                    "schema": {"type": "string", "pattern": IDEMPOTENCY_KEY.pattern},
                    "description": "Retry-safe key: the same key and body return the original event",
                }
            ],
            "requestBody": {
                "required": True,
                "content": {"application/json": {"schema": EVENT_IN_SCHEMA}},
            },
        },
    )
    async def ingest(request: Request):
        # Order matters: who is calling is checked before anything about the body is revealed.
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            return problem(415, "unsupported-media-type", "Body must be application/json")
        try:
            async with pool.connection() as conn, conn.transaction():
                tenant_id, denied = await authenticate(conn, request, "events:write")
                if denied:
                    return denied
                idem = request.headers.get("idempotency-key")
                if idem is not None and not IDEMPOTENCY_KEY.match(idem):
                    return problem(
                        400, "invalid-idempotency-key", "Idempotency-Key must be 1-255 visible ASCII characters"
                    )
                body = await request.body()
                try:
                    event = EventIn.model_validate_json(body)
                except ValidationError as e:
                    return problem(422, "invalid-event", "Invalid event", _first_error(e.errors()))
                return await _store(conn, tenant_id, event, body.decode(), idem, idempotency_window)
        except _Rollback as r:
            return r.response
        except psycopg.errors.DataError:
            # PostgreSQL's jsonb parser is the authority on what can be stored: it rejects
            # NaN, Infinity, numbers out of range and \u0000, which Python's parser accepts.
            return problem(422, "invalid-event", "Invalid event", "payload is not storable JSON")
        except (psycopg.OperationalError, PoolTimeout):
            return problem(503, "unavailable", "Service unavailable, retry later", headers={"Retry-After": "1"})

    @app.get(
        "/ingest/v1/events/{event_id}",
        response_model=EventOut,
        responses={k: v for k, v in ERRORS.items() if k in (401, 403, 503)} | {404: {"model": Problem}},
        summary="Read an event within the tenant's retention window",
    )
    async def read_event(event_id: str, request: Request):
        try:
            async with pool.connection() as conn, conn.transaction():
                _, denied = await authenticate(conn, request, "events:read")
                if denied:
                    return denied
                try:
                    wanted = uuid.UUID(event_id)
                except ValueError:
                    return problem(404, "event-not-found", "Event not found")
                # AC-3: access ends at the retention boundary, whatever state the deliveries are in.
                cur = await conn.execute(
                    "SELECT e.id, e.event_type, e.created_at, e.payload FROM delivery.events e "
                    "JOIN control.tenants t ON t.id = e.tenant_id "
                    "WHERE e.id = %s AND e.created_at >= now() - make_interval(days => t.retention_days)",
                    (wanted,),
                )
                row = await cur.fetchone()
        except (psycopg.OperationalError, PoolTimeout):
            return problem(503, "unavailable", "Service unavailable, retry later", headers={"Retry-After": "1"})
        if row is None:  # never existed, another tenant's, or past retention: indistinguishable
            return problem(404, "event-not-found", "Event not found")
        return EventOut(id=row[0], event_type=row[1], created_at=row[2].isoformat(), payload=row[3])

    def openapi():
        """FastAPI's document, corrected: bearer auth, and problem+json for every error response."""
        if app.openapi_schema:
            return app.openapi_schema
        doc = get_openapi(title=app.title, version=app.version, description=app.description, routes=app.routes)
        doc.setdefault("components", {})["securitySchemes"] = {
            "apiKey": {"type": "http", "scheme": "bearer", "description": "A Relay API key: rly_<prefix>_<secret>"}
        }
        doc["security"] = [{"apiKey": []}]
        problem_ref = {"schema": {"$ref": "#/components/schemas/Problem"}}
        for path in doc["paths"].values():
            for operation in path.values():
                responses = operation.get("responses", {})
                if operation["operationId"].startswith("read_event"):
                    responses.pop("422", None)  # a malformed id is simply not found (404)
                for status, response in responses.items():
                    if status[0] in "45":  # every error body is RFC 9457 problem details
                        response["content"] = {PROBLEM: problem_ref}
        doc["components"]["schemas"].pop("HTTPValidationError", None)
        doc["components"]["schemas"].pop("ValidationError", None)
        app.openapi_schema = doc
        return doc

    app.openapi = openapi

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        return {"status": "ok"}

    @app.get("/readyz", include_in_schema=False)
    async def readyz():
        try:
            async with pool.connection(timeout=2) as conn:
                await conn.execute("SELECT 1")
        except (psycopg.OperationalError, PoolTimeout):
            return problem(503, "unavailable", "Database unavailable")
        return {"status": "ready"}

    return LimitBody(app)


def _first_error(errors) -> str:
    first = errors[0] if errors else {}
    where = ".".join(str(x) for x in first.get("loc", ()) if x != "body")
    return f"{where}: {first.get('msg', 'invalid')}".strip(": ")


class _Rollback(Exception):
    """Return this response after rolling the transaction back."""

    def __init__(self, response: JSONResponse):
        self.response = response


async def _store(conn, tenant_id, event: EventIn, raw: str, idem: str | None, window: timedelta):
    # Parse the body with PostgreSQL and hash its normalized form (key order, whitespace).
    cur = await conn.execute("SELECT sha256(convert_to(%s::jsonb::text, 'UTF8'))", (raw,))
    body_hash = bytes((await cur.fetchone())[0])

    cur = await conn.execute("SELECT id FROM control.event_types WHERE name = %s", (event.event_type,))
    if await cur.fetchone() is None:
        raise _Rollback(problem(422, "unknown-event-type", "Unknown event type", event.event_type))

    event_id = uuid7()
    created = None
    if idem is not None:
        cur = await conn.execute(
            "INSERT INTO delivery.idempotency_keys "
            "(tenant_id, key, event_id, event_created_at, payload_sha256, expires_at) "
            "VALUES (%s, %s, %s, now(), %s, now() + %s) "
            "ON CONFLICT (tenant_id, key) DO NOTHING RETURNING event_created_at",
            (tenant_id, idem, event_id, body_hash, window),
        )
        row = await cur.fetchone()
        if row is None:  # the key exists (the unique index made us wait for its transaction)
            cur = await conn.execute(
                "SELECT event_id, payload_sha256 FROM delivery.idempotency_keys WHERE tenant_id = %s AND key = %s",
                (tenant_id, idem),
            )
            original_id, original_hash = await cur.fetchone()
            if bytes(original_hash) != body_hash:
                raise _Rollback(
                    problem(422, "idempotency-key-reused", "Idempotency-Key was used with a different body")
                )
            cur = await conn.execute("SELECT count(*) FROM delivery.deliveries WHERE event_id = %s", (original_id,))
            count = (await cur.fetchone())[0]
            return JSONResponse(
                {"event_id": str(original_id), "deliveries": count},
                status_code=202,
                headers={"Idempotent-Replayed": "true"},
            )
        created = row[0]

    cur = await conn.execute(
        "INSERT INTO delivery.events (id, tenant_id, event_type, payload, payload_sha256, created_at) "
        "VALUES (%s, %s, %s, %s::jsonb -> 'payload', %s, coalesce(%s, now())) RETURNING created_at",
        (event_id, tenant_id, event.event_type, raw, body_hash, created),
    )
    created = (await cur.fetchone())[0]
    cur = await conn.execute(
        "INSERT INTO delivery.deliveries (tenant_id, endpoint_id, event_id, event_created_at) "
        "SELECT %s, s.endpoint_id, %s, %s FROM control.subscriptions s "
        "JOIN control.event_types et ON et.id = s.event_type_id "
        "JOIN control.endpoints ep ON ep.id = s.endpoint_id "
        "WHERE et.name = %s AND ep.status <> 'disabled'",
        (tenant_id, event_id, created, event.event_type),
    )
    count = cur.rowcount
    if count:
        await conn.execute("SELECT pg_notify('relay_dispatch', '')")  # sent on commit; wakes the scheduler early
    return JSONResponse({"event_id": str(event_id), "deliveries": count}, status_code=202)
