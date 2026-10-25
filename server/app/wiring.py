"""
Startup wiring for the driveway marketplace: builds the DrivewayService from the
seeded demo driveways, publishes its events on the realtime feed, and resolves
the caller (demo user or payment service) from the Authorization header.
"""

import hmac
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.azure import signalr
from app.domain.driveways import (
    Actor,
    ActorRole,
    Driveway,
    DrivewayService,
    InMemoryDrivewayRepository,
)

LA = ZoneInfo("America/Los_Angeles")
DEMO_TOKEN_PREFIX = "demo-token-"
PAYMENT_SERVICE_USER = "payment_service"
PLACEHOLDER_PHOTO = "https://placehold.co/640x400?text=Driveway"


def _local_time(value: str) -> time:
    """Accept seed HH:MM values and contract UTC timestamps at one boundary."""
    if "T" not in value:
        return time.fromisoformat(value)
    instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if instant.tzinfo is None:
        raise ValueError("driveway availability timestamp requires an offset")
    return instant.astimezone(LA).time().replace(tzinfo=None)


def _window(start_hhmm: str, end_hhmm: str, now: datetime) -> tuple[datetime, datetime]:
    """Today's Pacific window for HH:MM bounds, rolled forward once it has ended."""
    today = now.astimezone(LA).date()
    start = datetime.combine(today, _local_time(start_hhmm), LA)
    end = datetime.combine(today, _local_time(end_hhmm), LA)
    if end <= start:
        end += timedelta(days=1)  # overnight window
    if now >= end:
        start, end = start + timedelta(days=1), end + timedelta(days=1)
    return start.astimezone(UTC), end.astimezone(UTC)


def driveway_from_seed(doc: dict, now: datetime) -> Driveway:
    start, end = _window(doc.get("availability_start", "00:00"), doc.get("availability_end", "23:59"), now)
    return Driveway(
        id=doc["id"],
        owner_id=doc["owner_id"],
        location=doc["location"],
        photo_url=doc.get("photo_url") or PLACEHOLDER_PHOTO,
        price_usdc=str(doc.get("price_usdc", "0")),
        availability_start=start,
        availability_end=end,
        state="AVAILABLE",
        held_by_user_id=None,
        active_booking_id=None,
        version=int(doc.get("version", 1)),
    )


class RealtimeFeedPublisher:
    """Sends DrivewayService events to Web PubSub and the polling log."""

    async def publish(self, event) -> None:
        body = event.model_dump(mode="json")
        await signalr.broadcast_realtime_event(
            body["type"], body["entity_id"], body["payload"], body["entity_version"]
        )


def build_driveway_service(seed_docs: dict[str, dict], now: datetime) -> DrivewayService:
    repository = InMemoryDrivewayRepository(driveway_from_seed(d, now) for d in seed_docs.values())
    return DrivewayService(repository, RealtimeFeedPublisher())


def resolve_actor(authorization: str | None, payment_service_token: str) -> Actor | None:
    """`Bearer demo-token-<user>` is that demo user; the configured service token is the payment service."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization[7:].strip()
    if payment_service_token and hmac.compare_digest(token, payment_service_token):
        return Actor(user_id=PAYMENT_SERVICE_USER, role=ActorRole.SERVICE)
    if token.startswith(DEMO_TOKEN_PREFIX) and len(token) > len(DEMO_TOKEN_PREFIX):
        return Actor(user_id=token[len(DEMO_TOKEN_PREFIX):], role=ActorRole.USER)
    return None


async def overlay_driveway_state(view: dict, service: DrivewayService, now: datetime) -> dict:
    """Nearby reads seed docs; the service owns hold state and owner edits, so its fields win."""
    try:
        live = await service.get_driveway(view["id"], now)
    except Exception:
        return view
    return {
        **view,
        "price_usdc": live.price_usdc,
        # Nearby keeps the seed's LA "HH:MM" shape that the app reads.
        "availability_start": live.availability_start.astimezone(LA).strftime("%H:%M"),
        "availability_end": live.availability_end.astimezone(LA).strftime("%H:%M"),
        "state": live.state.value if hasattr(live.state, "value") else live.state,
        "held_by_user_id": live.held_by_user_id,
        "active_booking": live.active_booking.model_dump(mode="json") if live.active_booking else None,
        "version": live.version,
    }
