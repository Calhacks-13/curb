import asyncio
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from typing import Protocol
from uuid import uuid4
from zoneinfo import ZoneInfo

from pydantic import Field, HttpUrl, model_validator

from app.domain.bookings import (
    Booking,
    cancelled_booking,
    confirmed_booking,
    failed_booking,
    processing_booking,
    reconciliation_booking,
)
from app.models.api import DrivewayUpdateRequest
from app.models.domain import (
    ActiveBookingSummary,
    BookingConfirmedEvent,
    BookingConfirmedPayload,
    BookingState,
    BookingView,
    ContractModel,
    DrivewayHeldEvent,
    DrivewayPayload,
    DrivewayReleasedEvent,
    DrivewayState,
    DrivewayUpdatedEvent,
    DrivewayView,
    GeoPoint,
    PaymentFailedEvent,
    PaymentFailedPayload,
    PaymentStatus,
    RealtimeEvent,
    UtcDateTime,
)


class DrivewayError(Exception):
    """Base class for marketplace errors with stable HTTP mappings."""


class NotFoundError(DrivewayError):
    pass


class PermissionDeniedError(DrivewayError):
    pass


class VersionConflictError(DrivewayError):
    pass


class InvalidTransitionError(DrivewayError):
    pass


class ActorRole(str, Enum):
    USER = "USER"
    SERVICE = "SERVICE"


@dataclass(frozen=True)
class Actor:
    user_id: str
    role: ActorRole


class Driveway(ContractModel):
    id: str = Field(min_length=1)
    owner_id: str = Field(min_length=1)
    location: GeoPoint
    photo_url: HttpUrl
    price_usdc: str = Field(pattern=r"^\d+(\.\d{1,6})?$")
    availability_start: UtcDateTime
    availability_end: UtcDateTime
    availability_timezone: str = "America/Los_Angeles"
    state: DrivewayState
    held_by_user_id: str | None
    active_booking_id: str | None
    version: int = Field(gt=0)

    @model_validator(mode="after")
    def state_has_consistent_hold_fields(self):
        if self.state in {DrivewayState.HELD, DrivewayState.BOOKED}:
            if self.held_by_user_id is None or self.active_booking_id is None:
                raise ValueError("held or booked driveway requires an active booking")
        elif self.held_by_user_id is not None or self.active_booking_id is not None:
            raise ValueError("unheld driveway cannot have hold fields")
        return self


class UpdateDriveway(DrivewayUpdateRequest):
    driveway_id: str = Field(min_length=1)
    owner_id: str = Field(min_length=1)


class DrivewayRepository(Protocol):
    async def get_driveway(self, driveway_id: str) -> Driveway | None: ...

    async def get_booking(self, booking_id: str) -> Booking | None: ...

    async def compare_and_swap_driveway(
        self, driveway: Driveway, *, expected_version: int
    ) -> None: ...

    async def create_hold(
        self,
        driveway: Driveway,
        booking: Booking,
        *,
        expected_driveway_version: int,
    ) -> None: ...

    async def compare_and_swap_pair(
        self,
        driveway: Driveway,
        booking: Booking,
        *,
        expected_driveway_version: int,
        expected_booking_version: int,
    ) -> None: ...


class EventPublisher(Protocol):
    async def publish(self, event: RealtimeEvent) -> None: ...


class InMemoryDrivewayRepository:
    """Local adapter with the same compare-and-swap boundary Cosmos must provide."""

    def __init__(
        self,
        driveways: Iterable[Driveway] = (),
        bookings: Iterable[Booking] = (),
    ):
        self._driveways = {item.id: item.model_copy(deep=True) for item in driveways}
        self._bookings = {item.id: item.model_copy(deep=True) for item in bookings}
        self._lock = asyncio.Lock()

    async def get_driveway(self, driveway_id: str) -> Driveway | None:
        driveway = self._driveways.get(driveway_id)
        return driveway.model_copy(deep=True) if driveway else None

    async def get_booking(self, booking_id: str) -> Booking | None:
        booking = self._bookings.get(booking_id)
        return booking.model_copy(deep=True) if booking else None

    async def compare_and_swap_driveway(
        self, driveway: Driveway, *, expected_version: int
    ) -> None:
        async with self._lock:
            current = self._driveways.get(driveway.id)
            if current is None:
                raise NotFoundError(f"driveway {driveway.id} not found")
            if current.version != expected_version:
                raise VersionConflictError("driveway version is stale")
            self._driveways[driveway.id] = driveway.model_copy(deep=True)

    async def create_hold(
        self,
        driveway: Driveway,
        booking: Booking,
        *,
        expected_driveway_version: int,
    ) -> None:
        async with self._lock:
            current = self._driveways.get(driveway.id)
            if current is None:
                raise NotFoundError(f"driveway {driveway.id} not found")
            if current.version != expected_driveway_version:
                raise VersionConflictError("driveway version is stale")
            if current.state != DrivewayState.AVAILABLE:
                raise InvalidTransitionError("driveway is not available")
            if booking.id in self._bookings:
                raise VersionConflictError("booking already exists")
            self._driveways[driveway.id] = driveway.model_copy(deep=True)
            self._bookings[booking.id] = booking.model_copy(deep=True)

    async def compare_and_swap_pair(
        self,
        driveway: Driveway,
        booking: Booking,
        *,
        expected_driveway_version: int,
        expected_booking_version: int,
    ) -> None:
        async with self._lock:
            current_driveway = self._driveways.get(driveway.id)
            current_booking = self._bookings.get(booking.id)
            if current_driveway is None or current_booking is None:
                raise NotFoundError("driveway or booking not found")
            if current_driveway.version != expected_driveway_version:
                raise VersionConflictError("driveway version is stale")
            if current_booking.version != expected_booking_version:
                raise VersionConflictError("booking version is stale")
            self._driveways[driveway.id] = driveway.model_copy(deep=True)
            self._bookings[booking.id] = booking.model_copy(deep=True)


def is_available_now(driveway: Driveway, now: datetime) -> bool:
    # Resolve the named business timezone so invalid seed data fails loudly,
    # then compare instants in UTC. Local wall-time comparison loses the fold
    # distinction during the repeated hour at the end of daylight saving time.
    ZoneInfo(driveway.availability_timezone)
    utc_now = now.astimezone(UTC)
    utc_start = driveway.availability_start.astimezone(UTC)
    utc_end = driveway.availability_end.astimezone(UTC)
    return (
        driveway.state == DrivewayState.AVAILABLE
        and utc_start <= utc_now < utc_end
    )


def _active_booking_summary(booking: Booking | None) -> ActiveBookingSummary | None:
    if booking is None:
        return None
    return ActiveBookingSummary(
        id=booking.id,
        state=booking.state,
        payment_status=booking.payment_status,
    )


def driveway_view(
    driveway: Driveway, booking: Booking | None, now: datetime
) -> DrivewayView:
    return DrivewayView(
        id=driveway.id,
        owner_id=driveway.owner_id,
        location=driveway.location,
        photo_url=driveway.photo_url,
        price_usdc=driveway.price_usdc,
        availability_start=driveway.availability_start,
        availability_end=driveway.availability_end,
        availability_timezone="America/Los_Angeles",
        state=driveway.state,
        held_by_user_id=driveway.held_by_user_id,
        active_booking=_active_booking_summary(booking),
        available_now=is_available_now(driveway, now),
        distance_m=0,
        version=driveway.version,
    )


class DrivewayService:
    def __init__(self, repository: DrivewayRepository, publisher: EventPublisher):
        self.repository = repository
        self.publisher = publisher

    async def _driveway(self, driveway_id: str) -> Driveway:
        driveway = await self.repository.get_driveway(driveway_id)
        if driveway is None:
            raise NotFoundError(f"driveway {driveway_id} not found")
        return driveway

    async def _booking(self, booking_id: str) -> Booking:
        booking = await self.repository.get_booking(booking_id)
        if booking is None:
            raise NotFoundError(f"booking {booking_id} not found")
        return booking

    async def _view(self, driveway: Driveway, now: datetime) -> DrivewayView:
        booking = None
        if driveway.active_booking_id:
            booking = await self.repository.get_booking(driveway.active_booking_id)
        return driveway_view(driveway, booking, now)

    async def get_driveway(self, driveway_id: str, now: datetime) -> DrivewayView:
        return await self._view(await self._driveway(driveway_id), now)

    async def get_booking(self, booking_id: str, actor: Actor) -> BookingView:
        booking = await self._booking(booking_id)
        driveway = await self._driveway(booking.driveway_id)
        if actor.role != ActorRole.SERVICE and actor.user_id not in {
            booking.driver_id,
            driveway.owner_id,
        }:
            raise PermissionDeniedError("booking is not visible to this user")
        return booking.to_view()

    async def update_driveway(
        self, command: UpdateDriveway, now: datetime
    ) -> DrivewayView:
        current = await self._driveway(command.driveway_id)
        if current.owner_id != command.owner_id:
            raise PermissionDeniedError("only the owner can update this driveway")
        if current.version != command.expected_version:
            raise VersionConflictError("driveway version is stale")
        if current.state in {DrivewayState.HELD, DrivewayState.BOOKED}:
            raise InvalidTransitionError("held or booked driveway cannot be edited")

        updated = current.model_copy(
            update={
                "price_usdc": command.price_usdc,
                "availability_start": command.availability_start,
                "availability_end": command.availability_end,
                "state": (
                    DrivewayState.AVAILABLE
                    if command.available
                    else DrivewayState.UNAVAILABLE
                ),
                "version": current.version + 1,
            }
        )
        await self.repository.compare_and_swap_driveway(
            updated, expected_version=current.version
        )
        view = await self._view(updated, now)
        await self.publisher.publish(
            DrivewayUpdatedEvent(
                type="driveway.updated",
                entity_id=updated.id,
                entity_version=updated.version,
                occurred_at=now,
                payload=DrivewayPayload(driveway=view),
            )
        )
        return view

    async def start_hold(
        self,
        driveway_id: str,
        driver_id: str,
        expected_version: int,
        now: datetime,
    ) -> Booking:
        current = await self._driveway(driveway_id)
        if current.owner_id == driver_id:
            raise PermissionDeniedError("owners cannot reserve their own driveway")
        if current.version != expected_version:
            raise VersionConflictError("driveway version is stale")
        if not is_available_now(current, now):
            raise InvalidTransitionError("driveway is not currently available")

        booking_id = f"booking_{uuid4().hex}"
        booking = Booking(
            id=booking_id,
            idempotency_key=f"{booking_id}_payment",
            driveway_id=current.id,
            driver_id=driver_id,
            state=BookingState.PENDING_PAYMENT,
            payment_status=PaymentStatus.NOT_STARTED,
            amount_usdc=current.price_usdc,
            transaction_hash=None,
            created_at=now,
            confirmed_at=None,
            version=1,
        )
        held = current.model_copy(
            update={
                "state": DrivewayState.HELD,
                "held_by_user_id": driver_id,
                "active_booking_id": booking.id,
                "version": current.version + 1,
            }
        )
        await self.repository.create_hold(
            held, booking, expected_driveway_version=current.version
        )
        await self._publish_held(held, booking, now)
        return booking

    async def cancel_hold(
        self,
        booking_id: str,
        driver_id: str,
        now: datetime,
        *,
        expected_driveway_id: str | None = None,
    ) -> Driveway:
        booking = await self._booking(booking_id)
        if expected_driveway_id and booking.driveway_id != expected_driveway_id:
            raise NotFoundError("booking does not belong to this driveway")
        driveway = await self._driveway(booking.driveway_id)
        if booking.driver_id != driver_id:
            raise PermissionDeniedError("only the holding driver can cancel")
        # DELETE is idempotent: a repeated request may be the client's recovery
        # from a successful cancellation whose response was lost.
        if booking.state == BookingState.CANCELLED:
            return driveway
        if booking.state != BookingState.PENDING_PAYMENT:
            raise InvalidTransitionError("booking cannot be cancelled in its current state")
        released, cancelled = self._release(driveway, booking)
        try:
            await self.repository.compare_and_swap_pair(
                released,
                cancelled,
                expected_driveway_version=driveway.version,
                expected_booking_version=booking.version,
            )
        except VersionConflictError:
            # An overlapping DELETE may have committed the same cancellation.
            # Confirm that outcome instead of reporting a false failure.
            current_booking = await self._booking(booking_id)
            current_driveway = await self._driveway(booking.driveway_id)
            if (
                current_booking.state == BookingState.CANCELLED
                and current_booking.driver_id == driver_id
                and (
                    expected_driveway_id is None
                    or current_booking.driveway_id == expected_driveway_id
                )
            ):
                return current_driveway
            raise
        await self._publish_released(released, now)
        return released

    async def recover_driveway(
        self,
        driveway_id: str,
        owner_id: str,
        expected_version: int,
        now: datetime,
    ) -> Driveway:
        driveway = await self._driveway(driveway_id)
        if driveway.owner_id != owner_id:
            raise PermissionDeniedError("only the owner can recover this driveway")
        if driveway.version != expected_version:
            raise VersionConflictError("driveway version is stale")
        if driveway.state != DrivewayState.HELD or not driveway.active_booking_id:
            raise InvalidTransitionError("driveway has no recoverable hold")
        booking = await self._booking(driveway.active_booking_id)
        if booking.state == BookingState.PROCESSING:
            raise InvalidTransitionError("payment is processing")
        if booking.state not in {
            BookingState.PENDING_PAYMENT,
            BookingState.RECONCILIATION_REQUIRED,
        }:
            raise InvalidTransitionError("booking cannot be recovered")
        released, cancelled = self._release(driveway, booking)
        await self.repository.compare_and_swap_pair(
            released,
            cancelled,
            expected_driveway_version=driveway.version,
            expected_booking_version=booking.version,
        )
        await self._publish_released(released, now)
        return released

    async def mark_payment_processing(
        self, booking_id: str, expected_booking_version: int, now: datetime
    ) -> Booking:
        booking = await self._booking(booking_id)
        driveway = await self._driveway(booking.driveway_id)
        if booking.version != expected_booking_version:
            raise VersionConflictError("booking version is stale")
        if booking.state != BookingState.PENDING_PAYMENT:
            raise InvalidTransitionError("booking is not awaiting payment")
        updated = processing_booking(booking)
        held = driveway.model_copy(update={"version": driveway.version + 1})
        await self.repository.compare_and_swap_pair(
            held,
            updated,
            expected_driveway_version=driveway.version,
            expected_booking_version=booking.version,
        )
        await self._publish_held(held, updated, now)
        return updated

    async def mark_payment_failed(
        self,
        booking_id: str,
        *,
        expected_booking_version: int,
        code: str,
        retryable: bool,
        now: datetime,
    ) -> Booking:
        booking = await self._booking(booking_id)
        if booking.version != expected_booking_version:
            is_exact_duplicate = (
                booking.version == expected_booking_version + 1
                and booking.state == BookingState.PENDING_PAYMENT
                and booking.payment_status == PaymentStatus.FAILED
                and booking.payment_failure_code == code
                and booking.payment_retryable == retryable
            )
            if is_exact_duplicate:
                return booking
            raise VersionConflictError("booking version is stale")
        driveway = await self._driveway(booking.driveway_id)
        if booking.state != BookingState.PROCESSING:
            raise InvalidTransitionError("only processing payments can fail")
        updated = failed_booking(booking, code=code, retryable=retryable)
        held = driveway.model_copy(update={"version": driveway.version + 1})
        await self.repository.compare_and_swap_pair(
            held,
            updated,
            expected_driveway_version=driveway.version,
            expected_booking_version=booking.version,
        )
        await self._publish_held(held, updated, now)
        await self.publisher.publish(
            PaymentFailedEvent(
                type="payment.failed",
                entity_id=updated.id,
                entity_version=updated.version,
                occurred_at=now,
                payload=PaymentFailedPayload(
                    booking_id=updated.id, code=code, retryable=retryable
                ),
            )
        )
        return updated

    async def mark_reconciliation_required(
        self,
        booking_id: str,
        *,
        transaction_hash: str,
        expected_booking_version: int,
        now: datetime,
    ) -> Booking:
        booking = await self._booking(booking_id)
        driveway = await self._driveway(booking.driveway_id)
        if booking.version != expected_booking_version:
            raise VersionConflictError("booking version is stale")
        if booking.state not in {
            BookingState.PENDING_PAYMENT,
            BookingState.PROCESSING,
        }:
            raise InvalidTransitionError("booking cannot require reconciliation")
        updated = reconciliation_booking(booking, transaction_hash=transaction_hash)
        held = driveway.model_copy(update={"version": driveway.version + 1})
        await self.repository.compare_and_swap_pair(
            held,
            updated,
            expected_driveway_version=driveway.version,
            expected_booking_version=booking.version,
        )
        await self._publish_held(held, updated, now)
        return updated

    async def finalize_booking(
        self,
        booking_id: str,
        *,
        idempotency_key: str,
        transaction_hash: str,
        expected_booking_version: int,
        now: datetime,
    ) -> Booking:
        booking = await self._booking(booking_id)
        if booking.state == BookingState.CONFIRMED:
            if (
                booking.idempotency_key == idempotency_key
                and booking.transaction_hash == transaction_hash
            ):
                driveway = await self._driveway(booking.driveway_id)
                await self._publish_confirmed(
                    driveway, booking, booking.confirmed_at or now
                )
                return booking
            raise InvalidTransitionError("booking was finalized with different evidence")
        if booking.version != expected_booking_version:
            raise VersionConflictError("booking version is stale")
        if booking.idempotency_key != idempotency_key:
            raise InvalidTransitionError("idempotency key does not match booking")
        if (
            booking.transaction_hash is not None
            and booking.transaction_hash != transaction_hash
        ):
            raise InvalidTransitionError(
                "transaction hash does not match recorded settlement evidence"
            )
        if booking.state not in {
            BookingState.PROCESSING,
            BookingState.RECONCILIATION_REQUIRED,
        }:
            raise InvalidTransitionError("booking is not ready to finalize")
        driveway = await self._driveway(booking.driveway_id)
        confirmed = confirmed_booking(
            booking, transaction_hash=transaction_hash, confirmed_at=now
        )
        booked = driveway.model_copy(
            update={"state": DrivewayState.BOOKED, "version": driveway.version + 1}
        )
        await self.repository.compare_and_swap_pair(
            booked,
            confirmed,
            expected_driveway_version=driveway.version,
            expected_booking_version=booking.version,
        )
        await self._publish_confirmed(booked, confirmed, now)
        return confirmed

    async def _publish_confirmed(
        self, driveway: Driveway, booking: Booking, occurred_at: datetime
    ) -> None:
        view = await self._view(driveway, occurred_at)
        await self.publisher.publish(
            BookingConfirmedEvent(
                type="booking.confirmed",
                entity_id=booking.id,
                entity_version=booking.version,
                occurred_at=occurred_at,
                payload=BookingConfirmedPayload(
                    booking=booking.to_view(), driveway=view
                ),
            )
        )

    @staticmethod
    def _release(driveway: Driveway, booking: Booking) -> tuple[Driveway, Booking]:
        released = driveway.model_copy(
            update={
                "state": DrivewayState.AVAILABLE,
                "held_by_user_id": None,
                "active_booking_id": None,
                "version": driveway.version + 1,
            }
        )
        return released, cancelled_booking(booking)

    async def _publish_held(
        self, driveway: Driveway, booking: Booking, now: datetime
    ) -> None:
        await self.publisher.publish(
            DrivewayHeldEvent(
                type="driveway.held",
                entity_id=driveway.id,
                entity_version=driveway.version,
                occurred_at=now,
                payload=DrivewayPayload(
                    driveway=driveway_view(driveway, booking, now)
                ),
            )
        )

    async def _publish_released(self, driveway: Driveway, now: datetime) -> None:
        await self.publisher.publish(
            DrivewayReleasedEvent(
                type="driveway.released",
                entity_id=driveway.id,
                entity_version=driveway.version,
                occurred_at=now,
                payload=DrivewayPayload(
                    driveway=driveway_view(driveway, None, now)
                ),
            )
        )
