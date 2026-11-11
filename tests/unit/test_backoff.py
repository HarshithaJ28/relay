from hypothesis import given, strategies as st
import pytest

from relay_dataplane import backoff


def test_documented_schedule_and_total_window():
    # The values in the spec, recomputed here rather than trusted.
    assert backoff.schedule_bounds() == [30, 60, 120, 240, 480, 960, 1920, 3840, 7680, 15360, 21600]
    assert sum(backoff.schedule_bounds()) == 52_290          # 14.5 hours at the worst case


def test_delay_is_capped_at_six_hours():
    assert backoff.upper_bound(11) == 21_600
    assert backoff.upper_bound(50) == 21_600


def test_invalid_attempt_number_is_rejected():
    with pytest.raises(ValueError):
        backoff.upper_bound(0)


def test_deterministic_with_seeded_rng():
    assert backoff.next_delay(3, rng=lambda: 0.5) == 60.0
    assert backoff.next_delay(3, rng=lambda: 0.0) == 0.0
    assert backoff.next_delay(3, rng=lambda: 1.0) == 120.0


@given(n=st.integers(1, 200), r=st.floats(0.0, 1.0))
def test_delay_always_within_bounds(n, r):
    d = backoff.next_delay(n, rng=lambda: r)
    assert 0.0 <= d <= backoff.CAP_SECONDS
    assert d <= backoff.upper_bound(n)


@given(n=st.integers(1, 100))
def test_upper_bound_never_decreases(n):
    assert backoff.upper_bound(n + 1) >= backoff.upper_bound(n)
