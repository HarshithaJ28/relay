# Live stream events

`GET /api/v1/stream` sends server-sent events for the caller's tenant. Workers publish them on
the Valkey channel `relay:live:<tenant_id>` after the database has recorded an outcome
(`services/data-plane/relay_dataplane/live.py`); the control plane relays them unchanged.

Delivery is best effort and missed events are not replayed: after a reconnect, a client must
refetch what it shows. Events never carry payloads, URLs, secrets or tokens.

## Framing

```
: connected            sent once when the stream opens (a comment line)
: ping                 sent every 15 s to keep proxies from closing the stream (a comment line)
event: <type>          the event type, one of the types below
data: <json>           one line of JSON; the same object as below
                       (a blank line ends each event)
```

The stream authenticates with the `Authorization: Bearer` header, so browsers read it with
`fetch`, not `EventSource`.

## Event types

The block below is checked by `tests/unit/test_live_contract.py`: a field added, removed or
retyped in `live.py` without updating this file fails the test.

```json contract
{
  "delivery": {
    "type": "string: always \"delivery\"",
    "delivery_id": "string: uuid",
    "endpoint_id": "string: uuid",
    "status": "string: the delivery's new status (succeeded, scheduled, dead, ...)",
    "attempt": "integer: the attempt number just recorded",
    "error_class": "string or null: why the attempt failed, null on success",
    "at": "number: Unix time in seconds, three decimals"
  },
  "breaker": {
    "type": "string: always \"breaker\"",
    "endpoint_id": "string: uuid",
    "state": "string: \"open\" (the only state published today)",
    "until": "string: ISO 8601 time when the endpoint is tried again",
    "at": "number: Unix time in seconds, three decimals"
  }
}
```

There is no event when a breaker closes: a client learns it from the endpoint's health
(`GET /api/v1/endpoints/{id}/health`) or from the next `delivery` event for that endpoint.
