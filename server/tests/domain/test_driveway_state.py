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


class FailFirstConfirmationPublisher(CommitCheckingPublisher):
    def __init__(self, repository: InMemoryDrivewayRepository):
        super().__init__(repository)
        self.failed_once = False

    async def publish(self, event):
        if event.type == "booking.confirmed" and not self.failed_once:
            self.failed_once = True
            raise RuntimeError("simulated Web PubSub outage")
        await super().publish(event)


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
        expected_booking_version=processing.version,
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
async def test_simultaneous_repeated_cancel_is_idempotent():
    class BarrierRepository(InMemoryDrivewayRepository):
        def __init__(self, driveways):
            super().__init__(driveways)
            self.arrivals = 0
            self.ready = asyncio.Event()

        async def compare_and_swap_pair(self, *args, **kwargs):
            self.arrivals += 1
            if self.arrivals == 2:
                self.ready.set()
            await self.ready.wait()
            return await super().compare_and_swap_pair(*args, **kwargs)

    repository = BarrierRepository([make_driveway()])
    publisher = CommitCheckingPublisher(repository)
    service = DrivewayService(repository, publisher)
    booking = await service.start_hold("driveway_demo_1", "driver_demo", 1, NOW)

    results = await asyncio.gather(
        service.cancel_hold(booking.id, "driver_demo", NOW),
        service.cancel_hold(booking.id, "driver_demo", NOW),
        return_exceptions=True,
    )

    assert all(isinstance(result, Driveway) for result in results)
    assert all(result.state == DrivewayState.AVAILABLE for result in results)
    assert [event.type for event in publisher.events].count("driveway.released") == 1


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
async def test_availability_inside_both_folds_of_repeated_hour():
    driveway = make_driveway(
        start=datetime(2026, 11, 1, 8, 30, tzinfo=UTC),
        end=datetime(2026, 11, 1, 9, 30, tzinfo=UTC),
    )
    service, _, _ = make_service(driveway)

    first_fold = await service.get_driveway(
        driveway.id, datetime(2026, 11, 1, 8, 45, tzinfo=UTC)
    )
    second_fold = await service.get_driveway(
        driveway.id, datetime(2026, 11, 1, 9, 15, tzinfo=UTC)
    )

    assert first_fold.available_now is True
    assert second_fold.available_now is True


@pytest.mark.asyncio
async def test_hold_outside_availability_window_is_rejected():
    service, _, _ = make_service()

    with pytest.raises(InvalidTransitionError):
        await service.start_hold(
            "driveway_demo_1", "driver_demo", 1, NOW + timedelta(days=1)
        )


@pytest.mark.asyncio
async def test_delayed_failure_cannot_reset_a_newer_processing_attempt():
    service, repository, _ = make_service()
    booking = await service.start_hold("driveway_demo_1", "driver_demo", 1, NOW)
    first_processing = await service.mark_payment_processing(booking.id, 1, NOW)
    first_failure = await service.mark_payment_failed(
        booking.id,
        expected_booking_version=first_processing.version,
        code="FACILITATOR_UNAVAILABLE",
        retryable=True,
        now=NOW,
    )
    duplicate = await service.mark_payment_failed(
        booking.id,
        expected_booking_version=first_processing.version,
        code="FACILITATOR_UNAVAILABLE",
        retryable=True,
        now=NOW,
    )
    assert duplicate == first_failure
    retry_processing = await service.mark_payment_processing(
        booking.id, first_failure.version, NOW
    )

    with pytest.raises(VersionConflictError):
        await service.mark_payment_failed(
            booking.id,
            expected_booking_version=first_processing.version,
            code="FACILITATOR_UNAVAILABLE",
            retryable=True,
            now=NOW,
        )

    current = await repository.get_booking(booking.id)
    driveway = await repository.get_driveway("driveway_demo_1")
    assert current is not None and current.version == retry_processing.version
    assert current.state == BookingState.PROCESSING
    assert driveway is not None
    with pytest.raises(InvalidTransitionError):
        await service.recover_driveway(
            driveway.id, "owner_demo", driveway.version, NOW
        )


@pytest.mark.asyncio
async def test_reconciliation_finalization_preserves_settlement_hash():
    service, repository, _ = make_service()
    booking = await service.start_hold("driveway_demo_1", "driver_demo", 1, NOW)
    recorded_hash = "0x" + "a" * 64
    conflicting_hash = "0x" + "b" * 64
    reconciliation = await service.mark_reconciliation_required(
        booking.id,
        transaction_hash=recorded_hash,
        expected_booking_version=booking.version,
        now=NOW,
    )

    with pytest.raises(InvalidTransitionError):
        await service.finalize_booking(
            booking.id,
            idempotency_key=booking.idempotency_key,
            transaction_hash=conflicting_hash,
            expected_booking_version=reconciliation.version,
            now=NOW,
        )

    unchanged = await repository.get_booking(booking.id)
    assert unchanged is not None and unchanged.transaction_hash == recorded_hash
    confirmed = await service.finalize_booking(
        booking.id,
        idempotency_key=booking.idempotency_key,
        transaction_hash=recorded_hash,
        expected_booking_version=reconciliation.version,
        now=NOW,
    )
    assert confirmed.transaction_hash == recorded_hash


@pytest.mark.asyncio
async def test_matching_finalize_retry_republishes_confirmation_after_outage():
    repository = InMemoryDrivewayRepository([make_driveway()])
    publisher = FailFirstConfirmationPublisher(repository)
    service = DrivewayService(repository, publisher)
    booking = await service.start_hold("driveway_demo_1", "driver_demo", 1, NOW)
    processing = await service.mark_payment_processing(booking.id, 1, NOW)
    transaction_hash = "0x" + "c" * 64

    with pytest.raises(RuntimeError, match="Web PubSub outage"):
        await service.finalize_booking(
            booking.id,
            idempotency_key=booking.idempotency_key,
            transaction_hash=transaction_hash,
            expected_booking_version=processing.version,
            now=NOW,
        )

    confirmed = await service.finalize_booking(
        booking.id,
        idempotency_key=booking.idempotency_key,
        transaction_hash=transaction_hash,
        expected_booking_version=processing.version,
        now=NOW + timedelta(seconds=1),
    )
    assert confirmed.state == BookingState.CONFIRMED
    confirmation_events = [
        event for event in publisher.events if event.type == "booking.confirmed"
    ]
    assert len(confirmation_events) == 1
    assert confirmation_events[0].entity_version == confirmed.version
