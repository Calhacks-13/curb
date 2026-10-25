import asyncio
import logging
from datetime import UTC, datetime, timedelta

import pytest
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
from app.routes.agent import (
    AV_ID,
    AV_ROUTE,
    TARGET_DRIVEWAY_ID,
    AgentDemoRunner,
    get_agent_demo_runner,
    router,
)
from app.routes.driveways import get_actor


NOW = datetime(2026, 10, 25, 1, 0, tzinfo=UTC)
TX_HASH = "0x" + "a" * 64


class RecordingPublisher:
    def __init__(self, timeline=None):
        self.events = []
        self.timeline = timeline

    async def publish(self, event):
        self.events.append(event)
        if self.timeline is not None:
            self.timeline.append(event.type)


def driveway() -> Driveway:
    return Driveway(
        id=TARGET_DRIVEWAY_ID,
        owner_id="owner_demo",
        location={"type": "Point", "coordinates": list(AV_ROUTE[-1][0])},
        photo_url="https://assets.example.test/driveway_av_1.jpg",
        price_usdc="5.00",
        availability_start=NOW - timedelta(hours=1),
        availability_end=NOW + timedelta(hours=5),
        availability_timezone="America/Los_Angeles",
        state=DrivewayState.AVAILABLE,
        held_by_user_id=None,
        active_booking_id=None,
        version=1,
    )


class SettlingPaymentExecutor:
    def __init__(self, service: DrivewayService):
        self.service = service
        self.calls = []

    async def execute(self, booking_id: str, caller_token: str) -> dict:
        self.calls.append((booking_id, caller_token))
        booking = await self.service.repository.get_booking(booking_id)
        processing = await self.service.mark_payment_processing(booking_id, booking.version, NOW)
        confirmed = await self.service.finalize_booking(
            booking_id,
            idempotency_key=booking.idempotency_key,
            transaction_hash=TX_HASH,
            expected_booking_version=processing.version,
            now=NOW,
        )
        return {
            "booking": confirmed.to_view().model_dump(mode="json"),
            "explorer_url": f"https://sepolia.basescan.org/tx/{TX_HASH}",
        }


@pytest.mark.asyncio
async def test_runner_drives_holds_waits_and_settles_one_target(caplog):
    timeline = []
    driveway_publisher = RecordingPublisher(timeline)
    untouched = driveway().model_copy(update={"id": "driveway_other", "version": 7})
    service = DrivewayService(
        InMemoryDrivewayRepository([driveway(), untouched]), driveway_publisher
    )
    payment = SettlingPaymentExecutor(service)
    positions = []
    sleeps = []

    async def publish_position(position, heading, version):
        positions.append((position, heading, version))
        timeline.append("agent.position")

    async def sleep(seconds):
        sleeps.append(seconds)

    runner = AgentDemoRunner(
        service,
        payment,
        publish_position=publish_position,
        sleep=sleep,
        clock=lambda: NOW,
    )

    with caplog.at_level(logging.INFO):
        await runner.run_once()

    assert positions == [(*waypoint, version) for version, waypoint in enumerate(AV_ROUTE, 1)]
    assert sleeps == [0.5] * (len(AV_ROUTE) - 1) + [2.0]
    assert [event.type for event in driveway_publisher.events] == [
        "driveway.held",
        "driveway.held",
        "booking.confirmed",
    ]
    assert timeline == ["agent.position"] * 6 + [
        "driveway.held",
        "driveway.held",
        "booking.confirmed",
    ]
    booking_id = driveway_publisher.events[-1].entity_id
    assert payment.calls == [(booking_id, f"demo-token-{AV_ID}")]
    final = await service.get_driveway(TARGET_DRIVEWAY_ID, NOW)
    assert final.state == DrivewayState.BOOKED
    other = await service.get_driveway("driveway_other", NOW)
    assert other.state == DrivewayState.AVAILABLE
    assert other.version == 7
    booking = await service.repository.get_booking(booking_id)
    assert booking.transaction_hash == TX_HASH
    assert f"Booked {TARGET_DRIVEWAY_ID} — $5.00 USDC — tx: {TX_HASH}" in caplog.text


@pytest.mark.asyncio
async def test_payment_failure_is_logged_and_does_not_invent_a_booking(caplog):
    publisher = RecordingPublisher()
    service = DrivewayService(InMemoryDrivewayRepository([driveway()]), publisher)

    class FailedPayment:
        async def execute(self, booking_id: str, caller_token: str) -> dict:
            raise RuntimeError("payments unavailable")

    async def immediate_sleep(_seconds):
        return None

    runner = AgentDemoRunner(
        service,
        FailedPayment(),
        publish_position=lambda *_args: immediate_sleep(0),
        sleep=immediate_sleep,
        clock=lambda: NOW,
    )

    with caplog.at_level(logging.ERROR):
        assert runner.start() is True
        await runner.task

    held = await service.get_driveway(TARGET_DRIVEWAY_ID, NOW)
    booking = await service.repository.get_booking(held.active_booking.id)
    assert held.state == DrivewayState.HELD
    assert booking.transaction_hash is None
    assert "payments unavailable" in caplog.text


@pytest.mark.asyncio
async def test_start_is_single_flight_until_the_active_run_finishes():
    service = DrivewayService(InMemoryDrivewayRepository([driveway()]), RecordingPublisher())
    entered = asyncio.Event()
    release = asyncio.Event()

    async def blocking_sleep(_seconds):
        entered.set()
        await release.wait()

    runner = AgentDemoRunner(
        service,
        SettlingPaymentExecutor(service),
        publish_position=lambda *_args: blocking_sleep(0),
        sleep=blocking_sleep,
        clock=lambda: NOW,
    )

    assert runner.start() is True
    await entered.wait()
    assert runner.start() is False
    release.set()
    await runner.task
    assert runner.running is False


class RouteRunner:
    def __init__(self):
        self.calls = 0

    def start(self):
        self.calls += 1
        return self.calls == 1


def test_run_demo_requires_authentication_returns_202_and_rejects_concurrent_run():
    app = FastAPI()
    fake = RouteRunner()
    app.include_router(router)
    app.dependency_overrides[get_agent_demo_runner] = lambda: fake
    client = TestClient(app)

    assert client.post("/v1/agent/run-demo").status_code == 401
    app.dependency_overrides[get_actor] = lambda: Actor(
        user_id="driver_demo", role=ActorRole.USER
    )

    started = client.post("/v1/agent/run-demo")
    duplicate = client.post("/v1/agent/run-demo")

    assert started.status_code == 202
    assert started.json() == {"status": "started", "agent_id": AV_ID}
    assert duplicate.status_code == 409
    assert fake.calls == 2
