"""Live updates over Valkey pub/sub (spec section 6).

After the database has recorded an outcome, the worker publishes a small JSON event on
the tenant's channel, relay:live:<tenant_id>. The control plane relays the channel to the
console as server-sent events. Publishing is best effort: a lost update only means the
console refreshes from the API a little later; nothing depends on it.

Events never carry payloads, URLs, secrets or tokens:
  {"type": "delivery", "delivery_id", "endpoint_id", "status", "attempt", "error_class", "at"}
  {"type": "breaker", "endpoint_id", "state": "open", "until", "at"}
"""

import json
import logging
import time

log = logging.getLogger("relay.live")


def channel(tenant_id) -> str:
    return f"relay:live:{tenant_id}"


class LivePublisher:
    def __init__(self, client, clock=time.time):
        self._client, self._clock = client, clock

    async def _publish(self, tenant_id, event: dict) -> None:
        event["at"] = round(self._clock(), 3)
        try:
            await self._client.publish(channel(tenant_id), json.dumps(event, separators=(",", ":")))
        except Exception as e:  # best effort: never let a live update affect a delivery
            log.warning("live update not published: %s", type(e).__name__)

    async def delivery(self, tenant_id, delivery_id, endpoint_id, status: str, attempt, error_class) -> None:
        await self._publish(
            tenant_id,
            {
                "type": "delivery",
                "delivery_id": str(delivery_id),
                "endpoint_id": str(endpoint_id),
                "status": status,
                "attempt": attempt,
                "error_class": error_class,
            },
        )

    async def breaker(self, tenant_id, endpoint_id, until) -> None:
        await self._publish(
            tenant_id,
            {"type": "breaker", "endpoint_id": str(endpoint_id), "state": "open", "until": until.isoformat()},
        )
