from datetime import datetime

from app.models.domain import Freshness


def freshness_for(observed_at: datetime, now: datetime) -> Freshness | None:
    age = (now - observed_at).total_seconds()
    if age < 0 or age > 300:
        return None
    if age <= 90:
        return Freshness.FRESH
    if age <= 180:
        return Freshness.AGING
    return Freshness.STALE
