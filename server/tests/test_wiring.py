import pytest
from datetime import UTC, datetime

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.domain.driveways import ActorRole
from app.models.domain import DrivewayState
from app.routes.bookings import router as bookings_router
from app.routes.driveways import get_clock
from app.routes.driveways import router as driveways_router
from app.wiring import build_driveway_service, driveway_from_seed, overlay_driveway_state, resolve_actor

# 18:00 Pacific on a Saturday.
NOW = datetime(2026, 10, 25, 1, 0, tzinfo=UTC)
SERVICE_TOKEN = "service-secret"

SEED = {
    "driveway_demo_1": {
        "id": "driveway_demo_1",
        "owner_id": "owner_demo",
        "location": {"type": "Point", "coordinates": [-122.4468, 37.8017]},
        "photo_url": None,
        "price_usdc": "8",
        "availability_start": "00:00",
        "availability_end": "23:59",
        "state": "AVAILABLE",
        "held_by_user_id": None,
        "version": 1,
    }
}


def build_client():
    service = build_driveway_service(SEED, NOW)
    app = FastAPI()
    app.state.driveway_service = service

    @app.middleware("http")
    async def attach_actor(request: Request, call_next):
        actor = resolve_actor(request.headers.get("authorization"), SERVICE_TOKEN)
        if actor is not None:
            request.state.actor = actor
        return await call_next(request)

    app.include_router(driveways_router)
    app.include_router(bookings_router)
    app.dependency_overrides[get_clock] = lambda: NOW
    return TestClient(app), service


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_resolve_actor_maps_demo_tokens_and_service_token():
    assert resolve_actor("Bearer demo-token-driver_demo", SERVICE_TOKEN).user_id == "driver_demo"
    assert resolve_actor("Bearer demo-token-driver_demo", SERVICE_TOKEN).role == ActorRole.USER
    assert resolve_actor(f"Bearer {SERVICE_TOKEN}", SERVICE_TOKEN).role == ActorRole.SERVICE
    assert resolve_actor("Bearer something-else", SERVICE_TOKEN) is None
    assert resolve_actor("Bearer demo-token-", SERVICE_TOKEN) is None
    assert resolve_actor(None, SERVICE_TOKEN) is None


def test_service_token_is_never_matched_when_unset():
    assert resolve_actor("Bearer ", "") is None
    assert resolve_actor("Bearer anything", "") is None


def test_seed_driveway_gets_todays_pacific_window():
    driveway = driveway_from_seed(SEED["driveway_demo_1"], NOW)
    assert driveway.availability_start <= NOW < driveway.availability_end
    assert driveway.state == DrivewayState.AVAILABLE
    assert str(driveway.photo_url).startswith("https://")


def test_seed_window_rolls_forward_after_it_ends():
    late = datetime(2026, 10, 25, 6, 59, 30, tzinfo=UTC)  # 23:59:30 Pacific
    driveway = driveway_from_seed(SEED["driveway_demo_1"], late)
    assert driveway.availability_start > late


def test_seed_driveway_accepts_contract_utc_timestamps():
    contract_seed = {
        **SEED["driveway_demo_1"],
        "availability_start": "2026-10-24T14:00:00Z",  # 07:00 Pacific
        "availability_end": "2026-10-25T10:00:00Z",  # 03:00 Pacific
    }

    driveway = driveway_from_seed(contract_seed, NOW)

    assert driveway.availability_start <= NOW < driveway.availability_end


def test_overnight_window_opened_yesterday_is_still_available_after_midnight():
    """A window running 17:00 to 17:00 Pacific stays open at 03:00 the next morning."""
    contract_seed = {
        **SEED["driveway_demo_1"],
        "availability_start": "2026-10-25T00:00:00Z",  # 17:00 Pacific
        "availability_end": "2026-10-26T00:00:00Z",  # 17:00 Pacific next day
    }
    early = datetime(2026, 10, 25, 10, 0, tzinfo=UTC)  # 03:00 Pacific

    driveway = driveway_from_seed(contract_seed, early)

    assert driveway.availability_start <= early < driveway.availability_end


def test_unauthenticated_hold_is_rejected():
    client, _ = build_client()
    response = client.post("/v1/driveways/driveway_demo_1/holds", json={"expected_version": 1})
    assert response.status_code == 401


def test_driver_holds_and_payment_service_finalizes():
    client, _ = build_client()
    hold = client.post(
        "/v1/driveways/driveway_demo_1/holds",
        json={"expected_version": 1},
        headers=bearer("demo-token-driver_demo"),
    )
    assert hold.status_code in (200, 201), hold.text
    booking = hold.json()
    booking = booking.get("booking", booking)

    as_driver = client.post(
        f"/v1/bookings/{booking['id']}/payment-processing",
        json={"expected_booking_version": booking["version"]},
        headers=bearer("demo-token-driver_demo"),
    )
    assert as_driver.status_code == 403

    processing = client.post(
        f"/v1/bookings/{booking['id']}/payment-processing",
        json={"expected_booking_version": booking["version"]},
        headers=bearer(SERVICE_TOKEN),
    )
    assert processing.status_code == 200, processing.text

    confirmed = client.post(
        f"/v1/bookings/{booking['id']}/finalize",
        json={
            "idempotency_key": booking["idempotency_key"],
            "transaction_hash": "0xabc",
            "expected_booking_version": processing.json()["version"],
        },
        headers=bearer(SERVICE_TOKEN),
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["state"] == "CONFIRMED"


@pytest.mark.asyncio
async def test_nearby_overlay_reports_the_hold():
    client, service = build_client()
    client.post(
        "/v1/driveways/driveway_demo_1/holds",
        json={"expected_version": 1},
        headers=bearer("demo-token-driver_demo"),
    )
    view = {"id": "driveway_demo_1", "state": "AVAILABLE", "held_by_user_id": None, "version": 1}
    overlaid = await overlay_driveway_state(view, service, NOW)
    assert overlaid["state"] == "HELD"
    assert overlaid["held_by_user_id"] == "driver_demo"
    assert overlaid["version"] == 2
    assert overlaid["active_booking"]["state"] == "PENDING_PAYMENT"


def test_owner_cannot_reserve_their_own_driveway():
    client, _ = build_client()
    response = client.post(
        "/v1/driveways/driveway_demo_1/holds",
        json={"expected_version": 1},
        headers=bearer("demo-token-owner_demo"),
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_nearby_overlay_reports_owner_edits():
    client, service = build_client()
    response = client.patch(
        "/v1/driveways/driveway_demo_1",
        json={
            "expected_version": 1,
            "available": True,
            "price_usdc": "1.25",
            "availability_start": "2026-10-24T15:00:00Z",  # 08:00 Pacific
            "availability_end": "2026-10-25T05:00:00Z",  # 22:00 Pacific
        },
        headers=bearer("demo-token-owner_demo"),
    )
    assert response.status_code == 200, response.text
    view = {"id": "driveway_demo_1", "price_usdc": "8", "availability_start": "00:00", "availability_end": "23:59"}
    overlaid = await overlay_driveway_state(view, service, NOW)
    assert overlaid["price_usdc"] == "1.25"
    assert overlaid["availability_start"] == "08:00"
    assert overlaid["availability_end"] == "22:00"


def test_non_owner_cannot_edit_listing():
    client, _ = build_client()
    response = client.patch(
        "/v1/driveways/driveway_demo_1",
        json={
            "expected_version": 1,
            "available": False,
            "price_usdc": "1.00",
            "availability_start": "2026-10-24T15:00:00Z",
            "availability_end": "2026-10-25T05:00:00Z",
        },
        headers=bearer("demo-token-driver_demo"),
    )
    assert response.status_code == 403
