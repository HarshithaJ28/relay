"""Retry delay: exponential backoff with full jitter.

delay_n = uniform(0, min(cap, base * 2**(n-1))), n = the attempt that just failed.

Defaults: base 30 s, cap 6 h, 12 attempts. After the 12th failed attempt there is
no further retry (the delivery goes to `dead`), so only delays for n = 1..11 are used.
"""

import random
from collections.abc import Callable

BASE_SECONDS = 30
CAP_SECONDS = 6 * 60 * 60
MAX_ATTEMPTS = 12


def upper_bound(n: int, base: int = BASE_SECONDS, cap: int = CAP_SECONDS) -> int:
    """Largest possible delay after failed attempt n (1-based)."""
    if n < 1:
        raise ValueError("attempt number starts at 1")
    return min(cap, base * 2 ** (n - 1))


def next_delay(
    n: int, rng: Callable[[], float] = random.random, base: int = BASE_SECONDS, cap: int = CAP_SECONDS
) -> float:
    """A random delay in seconds, uniform over [0, upper_bound(n)]."""
    return rng() * upper_bound(n, base, cap)


def schedule_bounds(max_attempts: int = MAX_ATTEMPTS, base: int = BASE_SECONDS, cap: int = CAP_SECONDS) -> list[int]:
    """Upper bounds for every retry delay a delivery can experience."""
    return [upper_bound(n, base, cap) for n in range(1, max_attempts)]
