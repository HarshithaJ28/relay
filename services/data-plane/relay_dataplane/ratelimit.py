"""Per-tenant ingestion rate limit: a token bucket in Valkey (spec section 4).

Each tenant's bucket holds up to `burst` tokens and refills at `rate` tokens per second.
A request takes one token; with none left it is refused with the time until the next
token, which the API returns as Retry-After. The bucket uses Valkey's clock (TIME), so
several API replicas share one consistent bucket per tenant.

If Valkey is unreachable the request is allowed and a warning is logged: rate limiting
protects capacity, and refusing all traffic during a Valkey outage would be worse.
"""

import logging
import math
from dataclasses import dataclass

log = logging.getLogger("relay.ratelimit")

TAKE = """
local key = KEYS[1]
local rate, burst = tonumber(ARGV[1]), tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens, ts = tonumber(state[1]), tonumber(state[2])
if tokens == nil then tokens, ts = burst, now end
tokens = math.min(burst, tokens + math.max(0, now - ts) * rate / 1000)
local allowed, wait_ms = 0, 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait_ms = math.ceil((1 - tokens) * 1000 / rate)
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', key, math.ceil(burst / rate * 1000) + 1000)
return {allowed, wait_ms}
"""


@dataclass(frozen=True)
class Verdict:
    allowed: bool
    retry_after: int = 0  # whole seconds, at least 1 when refused


class RateLimiter:
    def __init__(self, client):
        self._client = client
        self._script = client.register_script(TAKE)

    async def take(self, tenant_id, rate: int, burst: int) -> Verdict:
        try:
            allowed, wait_ms = await self._script(keys=[f"relay:rate:{tenant_id}"], args=[rate, burst])
        except Exception as e:  # Valkey unreachable: allow, and say so
            log.warning("rate limit unavailable, allowing the request: %s", type(e).__name__)
            return Verdict(True)
        if int(allowed):
            return Verdict(True)
        return Verdict(False, max(1, math.ceil(int(wait_ms) / 1000)))

    async def aclose(self) -> None:
        await self._client.aclose()
