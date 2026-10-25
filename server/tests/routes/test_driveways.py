from datetime import UTC, datetime, timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.domain.driveways import (
    Actor,
    ActorRole,
    Driveway,
    DrivewayService,
    InMemoryDrivewayRepository,
)
from app.models.domain import DrivewayState
from app.routes.bookings import router as bookings_router
from app.routes.driveways import router as driveways_router
from app.routes.driveways import get_actor, get_clock, get_driveway_service


NOW = datetime(2026, 10, 24, 1, 0, tzinfo=UTC)


class RecordingPublisher:
    def __init__(self):
        self.events = []

    async def publish(self, event):
        self.events.append(event)


class ActorProvider:
    actor = Actor(user_id="owner_demo", role=ActorRole.USER)

    def __call__(self):
        return self.actor


def build_client():
    driveway = Driveway(
        id="driveway_demo_1",
        owner_id="owner_demo",
        location={"type": "Point", "coordinates": [-122.4192, 37.7751]},
        photo_url="https://assets.example.test/driveway_demo_1.jpg",
        price_usdc="8.00",
        availability_start=NOW - timedelta(hours=1),
        availability_end=NOW + timedelta(hours=5),
        availability_timezone="America/Los_Angeles",
        state=DrivewayState.AVAILABLE,
        held_by_user_id=None,
        active_booking_id=None,
        version=1,
    )
    repository = InMemoryDrivewayRepository([driveway])
    publisher = RecordingPublisher()
    service = DrivewayService(repository, publisher)
    actors = ActorProvider()

    app = FastAPI()
    app.include_router(driveways_router)
    app.include_router(bookings_router)
    app.dependency_overrides[get_driveway_service] = lambda: service
    app.dependency_overrides[get_actor] = actors
    app.dependency_overrides[get_clock] = lambda: NOW
    return TestClient(app), actors, repository, publisher


def test_owner_updates_driveway_and_stale_version_returns_409():
    client, _, _, publisher = build_client()
    payload = {
        "expected_version": 1,
        "available": False,
        "price_usdc": "9.00",
        "availability_start": "2026-10-24T00:00:00Z",
        "availability_end": "2026-10-24T08:00:00Z",
    }

    response = client.patch("/v1/driveways/driveway_demo_1", json=payload)
    stale = client.patch("/v1/driveways/driveway_demo_1", json=payload)

    assert response.status_code == 200
    assert response.json()["state"] == "UNAVAILABLE"
    assert response.json()["version"] == 2
    assert stale.status_code == 409
    assert [event.type for event in publisher.events] == ["driveway.updated"]


def test_non_owner_cannot_update_or_recover_driveway():
    client, actors, _, _ = build_client()
    actors.actor = Actor(user_id="driver_demo", role=ActorRole.USER)
    update = {
        "expected_version": 1,
        "available": False,
        "price_usdc": "9.00",
        "availability_start": "2026-10-24T00:00:00Z",
        "availability_end": "2026-10-24T08:00:00Z",
    }

    assert client.patch("/v1/driveways/driveway_demo_1", json=update).status_code == 403
    assert client.post(
        "/v1/driveways/driveway_demo_1/recover", json={"expected_version": 1}
    ).status_code == 403


def test_hold_failure_cancel_and_booking_receipt_flow():
    client, actors, _, publisher = build_client()
    actors.actor = Actor(user_id="driver_demo", role=ActorRole.USER)

    held = client.post(
        "/v1/driveways/driveway_demo_1/holds", json={"expected_version": 1}
    )
    assert held.status_code == 201
    booking = held.json()
    assert booking["state"] == "PENDING_PAYMENT"
    assert "expires_at" not in booking

    second = client.post(
        "/v1/driveways/driveway_demo_1/holds", json={"expected_version": 2}
    )
    assert second.status_code == 409

    actors.actor = Actor(user_id="payment_service", role=ActorRole.SERVICE)
    processing = client.post(
        f"/v1/bookings/{booking['id']}/payment-processing",
        json={"expected_booking_version": 1},
    )
    assert processing.status_code == 200
    assert processing.json()["state"] == "PROCESSING"

    failed = client.post(
        f"/v1/bookings/{booking['id']}/payment-failed",
        json={
            "expected_booking_version": processing.json()["version"],
            "code": "FACILITATOR_UNAVAILABLE",
            "retryable": True,
        },
    )
    assert failed.status_code == 200
    assert failed.json()["state"] == "PENDING_PAYMENT"
    assert failed.json()["payment_status"] == "FAILED"

    actors.actor = Actor(user_id="driver_demo", role=ActorRole.USER)
    released = client.delete(f"/v1/driveways/driveway_demo_1/holds/{booking['id']}")
    assert released.status_code == 200
    assert released.json()["state"] == "AVAILABLE"

    repeated = client.delete(f"/v1/driveways/driveway_demo_1/holds/{booking['id']}")
    assert repeated.status_code == 200
    assert repeated.json()["state"] == "AVAILABLE"

    receipt = client.get(f"/v1/bookings/{booking['id']}")
    assert receipt.status_code == 200
    assert receipt.json()["state"] == "CANCELLED"
    assert [event.type for event in publisher.events] == [
        "driveway.held",
        "driveway.held",
        "driveway.held",
        "payment.failed",
        "driveway.released",
    ]


def test_owner_recovery_is_disabled_while_payment_processes():
    client, actors, _, _ = build_client()
    actors.actor = Actor(user_id="driver_demo", role=ActorRole.USER)
    booking = client.post(
        "/v1/driveways/driveway_demo_1/holds", json={"expected_version": 1}
    ).json()

    actors.actor = Actor(user_id="payment_service", role=ActorRole.SERVICE)
    client.post(
        f"/v1/bookings/{booking['id']}/payment-processing",
        json={"expected_booking_version": 1},
    )

    actors.actor = Actor(user_id="owner_demo", role=ActorRole.USER)
    response = client.post(
        "/v1/driveways/driveway_demo_1/recover", json={"expected_version": 3}
    )
    assert response.status_code == 409


def test_wrong_driveway_path_cannot_cancel_the_real_booking():
    client, actors, _, _ = build_client()
    actors.actor = Actor(user_id="driver_demo", role=ActorRole.USER)
    booking = client.post(
        "/v1/driveways/driveway_demo_1/holds", json={"expected_version": 1}
    ).json()

    response = client.delete(f"/v1/driveways/not_this_driveway/holds/{booking['id']}")
    still_held = client.get(f"/v1/bookings/{booking['id']}")

    assert response.status_code == 404
    assert still_held.status_code == 200
    assert still_held.json()["state"] == "PENDING_PAYMENT"


def test_payment_service_finalizes_booking_and_repeated_evidence_is_idempotent():
    client, actors, _, publisher = build_client()
    actors.actor = Actor(user_id="driver_demo", role=ActorRole.USER)
    booking = client.post(
        "/v1/driveways/driveway_demo_1/holds", json={"expected_version": 1}
    ).json()
    actors.actor = Actor(user_id="payment_service", role=ActorRole.SERVICE)
    processing = client.post(
        f"/v1/bookings/{booking['id']}/payment-processing",
        json={"expected_booking_version": 1},
    ).json()
    payload = {
        "idempotency_key": booking["idempotency_key"],
        "transaction_hash": "0x" + "1" * 64,
        "expected_booking_version": processing["version"],
    }

    confirmed = client.post(f"/v1/bookings/{booking['id']}/finalize", json=payload)
    repeated = client.post(f"/v1/bookings/{booking['id']}/finalize", json=payload)

    assert confirmed.status_code == 200
    assert confirmed.json()["state"] == "CONFIRMED"
    assert repeated.status_code == 200
    assert repeated.json() == confirmed.json()
    assert publisher.events[-1].type == "booking.confirmed"
