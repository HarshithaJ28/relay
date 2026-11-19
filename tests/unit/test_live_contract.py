"""docs/stream-events.md is the contract for the live stream: these tests fail when
live.py publishes a field the document does not list (or the reverse), or a field's
JSON type no longer matches what the document says."""

import asyncio
import datetime as dt
import json
import pathlib
import re
import uuid

from relay_dataplane.live import LivePublisher

DOC = pathlib.Path(__file__).resolve().parents[2] / "docs" / "stream-events.md"


def contract() -> dict:
    match = re.search(r"```json contract\n(.*?)```", DOC.read_text(), re.S)
    assert match, "docs/stream-events.md has no ```json contract block"
    return json.loads(match.group(1))


class Capture:
    def __init__(self):
        self.messages = []

    async def publish(self, channel, message):
        self.messages.append((channel, json.loads(message)))


def published() -> dict:
    client = Capture()
    live = LivePublisher(client, clock=lambda: 1_700_000_000.1234)
    tenant = uuid.uuid4()

    async def run():
        await live.delivery(tenant, uuid.uuid4(), uuid.uuid4(), "scheduled", 2, "http_5xx")
        await live.breaker(tenant, uuid.uuid4(), dt.datetime(2026, 1, 1, tzinfo=dt.UTC))

    asyncio.run(run())
    assert all(ch == f"relay:live:{tenant}" for ch, _ in client.messages)
    return {msg["type"]: msg for _, msg in client.messages}


JSON_TYPES = {"string": (str,), "integer": (int,), "number": (int, float)}


def test_every_published_event_type_is_documented_and_no_more():
    assert set(published()) == set(contract())


def test_fields_match_the_document_exactly():
    events, doc = published(), contract()
    for name, event in events.items():
        assert set(event) == set(doc[name]), f"{name}: fields differ from docs/stream-events.md"


def test_field_types_match_the_document():
    events, doc = published(), contract()
    for name, event in events.items():
        for field, description in doc[name].items():
            kind = description.split(":", 1)[0]
            allowed = JSON_TYPES[kind.split(" or ")[0]] + ((type(None),) if "or null" in kind else ())
            assert isinstance(event[field], allowed) and not isinstance(event[field], bool), (
                f"{name}.{field} is {event[field]!r}, document says {kind}"
            )


def test_success_has_a_null_error_class():
    client = Capture()

    async def run():
        await LivePublisher(client).delivery(uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), "succeeded", 1, None)

    asyncio.run(run())
    assert client.messages[0][1]["error_class"] is None
