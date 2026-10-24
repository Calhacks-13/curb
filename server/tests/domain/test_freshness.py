from datetime import UTC, datetime, timedelta

import pytest


NOW = datetime(2026, 10, 24, 1, tzinfo=UTC)


@pytest.mark.parametrize("age,expected", [
    (0, "FRESH"), (90, "FRESH"), (90.001, "AGING"),
    (180, "AGING"), (180.001, "STALE"), (300, "STALE"), (300.001, None),
])
def test_freshness_uses_exact_inclusive_boundaries(age, expected):
    from app.domain.freshness import freshness_for

    assert freshness_for(NOW - timedelta(seconds=age), NOW) == expected


def test_future_observation_does_not_claim_freshness():
    from app.domain.freshness import freshness_for

    assert freshness_for(NOW + timedelta(seconds=1), NOW) is None
