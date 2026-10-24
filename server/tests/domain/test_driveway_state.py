import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from app.domain.bookings import Booking
from app.domain.driveways import (
    Actor,
    ActorRole,
    Driveway,
    DrivewayService,
    InMemoryDrivewayRepository,
    InvalidTransitionError,
    UpdateDriveway,
    VersionConflictError,
)
from app.models.domain import BookingState, DrivewayState, PaymentStatus


NOW = datetime(2026, 10, 24, 1, 0, tzinfo=UTC)


class CommitCheckingPublisher:
    def __init__(self, repository: InMemoryDrivewayRepository):
        self.repository = repository
        self.events = []

    async def publish(self, event):
        driveway = await self.repository.get_driveway("driveway_demo_1")
        assert driveway is not None
        assert driveway.version >= event.entity_version
        self.events.append(event)


def make_driveway(
    *,
    state: DrivewayState = DrivewayState.AVAILABLE,
    start: datetime = NOW - timedelta(hours=1),
    end: datetime = NOW + timedelta(hours=5),
) -> Driveway:
    return Driveway(
        id="driveway_demo_1",
        owner_id="owner_demo",
        location={"type": "Point", "coordinates": [-122.4192, 37.7751]},
        photo_url="https://assets.example.test/driveway_demo_1.jpg",
        price_usdc="8.00",
        availability_start=start,
        availability_end=end,
        availability_timezone="America/Los_Angeles",
        state=state,
        held_by_user_id=None,
        active_booking_id=None,
        version=1,
    )


def make_service(driveway: Driveway | None = None):
    repository = InMemoryDrivewayRepository([driveway or make_driveway()])
    publisher = CommitCheckingPublisher(repository)
    return DrivewayService(repository, publisher), repository, publisher


@pytest.mark.asyncio
async def test_stale_update_is_rejected_without_publishing():
    service, _, publisher = make_service()
    command = UpdateDriveway(
        driveway_id="driveway_demo_1",
        owner_id="owner_demo",
        expected_version=99,
        available=False,
        price_usdc="9.00",
        availability_start=NOW,
        availability_end=NOW + timedelta(hours=2),
    )

    with pytest.raises(VersionConflictError):
        await service.update_driveway(command, NOW)

    assert publisher.events == []


@pytest.mark.asyncio
async def test_exactly_one_simultaneous_hold_succeeds():
    service, repository, publisher = make_service()

    results = await asyncio.gather(
        service.start_hold("driveway_demo_1", "driver_one", 1, NOW),
        service.start_hold("driveway_demo_1", "driver_two", 1, NOW),
        return_exceptions=True,
    )

    bookings = [result for result in results if isinstance(result, Booking)]
    conflicts = [result for result in results if isinstance(result, VersionConflictError)]
    assert len(bookings) == 1
    assert len(conflicts) == 1

    driveway = await repository.get_driveway("driveway_demo_1")
    assert driveway is not None
    assert driveway.state == DrivewayState.HELD
    assert driveway.held_by_user_id == bookings[0].driver_id
    assert driveway.active_booking_id == bookings[0].id
    assert [event.type for event in publisher.events] == ["driveway.held"]


@pytest.mark.asyncio
async def test_hold_has_no_timeout_and_second_driver_cannot_replace_it():
    service, repository, _ = make_service()
    booking = await service.start_hold("driveway_demo_1", "driver_demo", 1, NOW)

    with pytest.raises(InvalidTransitionError):
        await service.start_hold("driveway_demo_1", "driver_two", 2, NOW + timedelta(days=365))

    driveway = await repository.get_driveway("driveway_demo_1")
    stored_booking = await repository.get_booking(booking.id)
    assert driveway is not None and driveway.state == DrivewayState.HELD
    assert stored_booking is not None and stored_booking.state == BookingState.PENDING_PAYMENT


@pytest.mark.asyncio
async def test_failed_payment_stays_held_and_driver_can_cancel():
    service, repository, publisher = make_service()
    booking = await service.start_hold("driveway_demo_1", "driver_demo", 1, NOW)
    processing = await service.mark_payment_processing(booking.id, 1, NOW)
    failed = await service.mark_payment_failed(
        booking.id,
        code="FACILITATOR_UNAVAILABLE",
        retryable=True,
        now=NOW,
    )

    held = await repository.get_driveway("driveway_demo_1")
    assert processing.state == BookingState.PROCESSING
    assert failed.state == BookingState.PENDING_PAYMENT
    assert failed.payment_status == PaymentStatus.FAILED
    assert held is not None and held.state == DrivewayState.HELD

    released = await service.cancel_hold(booking.id, "driver_demo", NOW)
    assert released.state == DrivewayState.AVAILABLE
    assert released.active_booking_id is None
    assert [event.type for event in publisher.events] == [
        "driveway.held",
        "driveway.held",
        "driveway.held",
        "payment.failed",
        "driveway.released",
    ]


@pytest.mark.asyncio
async def test_confirmed_booking_never_reports_driveway_available():
    service, _, _ = make_service()
    booking = await service.start_hold("driveway_demo_1", "driver_demo", 1, NOW)
    processing = await service.mark_payment_processing(booking.id, 1, NOW)

    confirmed = await service.finalize_booking(
        booking.id,
        idempotency_key=booking.idempotency_key,
        transaction_hash="0x" + "1" * 64,
        expected_booking_version=processing.version,
        now=NOW,
    )
    driveway = await service.get_driveway("driveway_demo_1", NOW)

    assert confirmed.state == BookingState.CONFIRMED
    assert driveway.state == DrivewayState.BOOKED
    assert driveway.available_now is False


@pytest.mark.asyncio
async def test_owner_recovery_is_locked_during_processing():
    service, _, _ = make_service()
    booking = await service.start_hold("driveway_demo_1", "driver_demo", 1, NOW)
    await service.mark_payment_processing(booking.id, 1, NOW)

    with pytest.raises(InvalidTransitionError):
        await service.recover_driveway("driveway_demo_1", "owner_demo", 3, NOW)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "booking_state",
    [BookingState.PENDING_PAYMENT, BookingState.RECONCILIATION_REQUIRED],
)
async def test_owner_can_recover_abandoned_nonprocessing_hold(booking_state):
    service, repository, _ = make_service()
    booking = await service.start_hold("driveway_demo_1", "driver_demo", 1, NOW)
    if booking_state == BookingState.RECONCILIATION_REQUIRED:
        await service.mark_reconciliation_required(
            booking.id,
            transaction_hash="0x" + "2" * 64,
            expected_booking_version=1,
            now=NOW,
        )

    current = await repository.get_driveway("driveway_demo_1")
    assert current is not None
    released = await service.recover_driveway(
        "driveway_demo_1", "owner_demo", current.version, NOW
    )
    assert released.state == DrivewayState.AVAILABLE
    assert released.active_booking_id is None


@pytest.mark.asyncio
async def test_availability_window_uses_pacific_dst_boundaries():
    # Fall-back day: 00:30 PDT to 02:30 PST spans four UTC hours.
    driveway = make_driveway(
        start=datetime(2026, 11, 1, 7, 30, tzinfo=UTC),
        end=datetime(2026, 11, 1, 10, 30, tzinfo=UTC),
    )
    service, _, _ = make_service(driveway)

    before = await service.get_driveway(
        driveway.id, datetime(2026, 11, 1, 7, 29, 59, tzinfo=UTC)
    )
    repeated_hour = await service.get_driveway(
        driveway.id, datetime(2026, 11, 1, 9, 30, tzinfo=UTC)
    )
    after = await service.get_driveway(
        driveway.id, datetime(2026, 11, 1, 10, 30, tzinfo=UTC)
    )

    assert before.available_now is False
    assert repeated_hour.available_now is True
    assert after.available_now is False


@pytest.mark.asyncio
async def test_hold_outside_availability_window_is_rejected():
    service, _, _ = make_service()

    with pytest.raises(InvalidTransitionError):
        await service.start_hold(
            "driveway_demo_1", "driver_demo", 1, NOW + timedelta(days=1)
        )
