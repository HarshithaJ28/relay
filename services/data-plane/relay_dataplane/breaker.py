"""Per-endpoint circuit breaker with its state in Valkey (spec section 6).

Closed: every send result goes into a rolling window (time buckets). When the failure
rate reaches the threshold with at least `min_volume` results, the breaker opens for the
base cool-down. Open: results that arrive before the cool-down ends were already in
flight and are ignored. The first result after the cool-down is the half-open probe
(the scheduler allows exactly one): success closes the breaker, failure reopens it with
the cool-down doubled, up to the maximum.

Each decision is one Lua script, so concurrent workers cannot interleave updates.
The caller mirrors an opening into PostgreSQL (delivery.open_breaker); closing is
mirrored by record_attempt itself. If Valkey is unreachable, results are not counted
and nothing opens: losing Valkey resets every breaker to closed, which is safe.

The defaults are provisional. The spec calls for tuning them with chaos-receiver
experiments, which have not been run.
"""

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime

from .outcome import Classified

log = logging.getLogger("relay.breaker")

# Error classes that say the endpoint is unhealthy. A 4xx other than 429 means the
# endpoint answered and rejected this request, which is not an availability problem;
# blocked destinations, secret and transformation problems are not the endpoint's fault.
FAILURES = frozenset(
    {"http_5xx", "timeout", "connect", "dns", "tls", "rate_limited", "connection_error", "redirect_not_followed"}
)

RECORD = """
local state, window = KEYS[1], KEYS[2]
local now, failed = tonumber(ARGV[1]), tonumber(ARGV[2])
local window_ms, bucket_ms = tonumber(ARGV[3]), tonumber(ARGV[4])
local min_volume, threshold = tonumber(ARGV[5]), tonumber(ARGV[6])
local base, max = tonumber(ARGV[7]), tonumber(ARGV[8])
local ttl = math.ceil((window_ms + max) / 1000) * 2

local open_until = tonumber(redis.call('HGET', state, 'until') or '0')
if open_until > 0 then
  if now < open_until then
    return {'open', open_until}                     -- result from before the breaker opened
  end
  if failed == 1 then                               -- the probe failed: reopen, longer
    local cooldown = tonumber(redis.call('HGET', state, 'cooldown') or base)
    cooldown = math.min(math.max(cooldown * 2, base), max)
    open_until = now + cooldown
    redis.call('HSET', state, 'until', open_until, 'cooldown', cooldown)
    redis.call('EXPIRE', state, ttl)
    return {'reopened', open_until}
  end
  redis.call('DEL', state)                          -- the probe succeeded: close (the window was cleared on opening)
  return {'closed_after_probe', 0}
end

local bucket = math.floor(now / bucket_ms) * bucket_ms
redis.call('HINCRBY', window, bucket .. ':t', 1)
if failed == 1 then redis.call('HINCRBY', window, bucket .. ':f', 1) end
redis.call('EXPIRE', window, ttl)

local total, failures = 0, 0
local fields = redis.call('HGETALL', window)
for i = 1, #fields, 2 do
  local start, kind = string.match(fields[i], '^(%d+):(%a)$')
  start = tonumber(start)
  if start == nil or start <= now - window_ms then
    redis.call('HDEL', window, fields[i])           -- outside the window
  elseif kind == 't' then
    total = total + tonumber(fields[i + 1])
  else
    failures = failures + tonumber(fields[i + 1])
  end
end

if total >= min_volume and failures / total >= threshold then
  open_until = now + base
  redis.call('HSET', state, 'until', open_until, 'cooldown', base)
  redis.call('EXPIRE', state, ttl)
  redis.call('DEL', window)
  return {'opened', open_until}
end
return {'closed', 0}
"""


@dataclass(frozen=True)
class BreakerConfig:
    window: float = 60.0  # seconds of results considered
    bucket: float = 5.0  # window resolution
    min_volume: int = 10  # results needed before the breaker may open
    threshold: float = 0.5  # failure rate that opens it
    base_cooldown: float = 30.0
    max_cooldown: float = 600.0
    jitter: float = 10.0  # spread of deliveries pushed past the reopen time


@dataclass(frozen=True)
class Decision:
    state: str  # closed | opened | open | reopened | closed_after_probe | unknown
    until: datetime | None = None

    @property
    def opens(self) -> bool:
        return self.state in ("opened", "reopened")


def counts_as_failure(verdict: Classified) -> bool | None:
    """True or False for results that say something about the endpoint's health, else None."""
    if verdict.outcome == "success":
        return False
    if verdict.error_class not in FAILURES:  # includes http_4xx: the endpoint answered
        return None
    return True


class CircuitBreaker:
    def __init__(self, client, config: BreakerConfig = BreakerConfig(), clock=time.time):
        self._client, self._config, self._clock = client, config, clock
        self._script = client.register_script(RECORD)

    @property
    def jitter(self) -> float:
        return self._config.jitter

    async def record(self, endpoint_id: str, failed: bool) -> Decision:
        c = self._config
        now_ms = int(self._clock() * 1000)
        try:
            state, until_ms = await self._script(
                keys=[f"relay:breaker:{endpoint_id}:state", f"relay:breaker:{endpoint_id}:window"],
                args=[
                    now_ms,
                    1 if failed else 0,
                    int(c.window * 1000),
                    int(c.bucket * 1000),
                    c.min_volume,
                    c.threshold,
                    int(c.base_cooldown * 1000),
                    int(c.max_cooldown * 1000),
                ],
            )
        except Exception as e:  # Valkey unreachable or erroring: fail safe, i.e. closed
            log.warning("breaker state unavailable, treating endpoint as closed: %s", type(e).__name__)
            return Decision("unknown")
        state = state.decode() if isinstance(state, bytes) else state
        until = datetime.fromtimestamp(int(until_ms) / 1000, UTC) if int(until_ms) else None
        return Decision(state, until)
