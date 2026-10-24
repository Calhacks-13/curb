from datetime import datetime
from typing import Literal

from pydantic import Field

from app.models.domain import (
    BookingState,
    BookingView,
    ContractModel,
    PaymentStatus,
    UtcDateTime,
)


class Booking(ContractModel):
    """Persistent booking intent. Holds deliberately have no expiry field."""

    id: str = Field(min_length=1)
    idempotency_key: str = Field(min_length=1)
    driveway_id: str = Field(min_length=1)
    driver_id: str = Field(min_length=1)
    state: BookingState
    payment_status: PaymentStatus
    amount_usdc: str = Field(pattern=r"^\d+(\.\d{1,6})?$")
    network: Literal["base-sepolia"] = "base-sepolia"
    transaction_hash: str | None = Field(min_length=1)
    payment_failure_code: str | None = Field(default=None, min_length=1)
    payment_retryable: bool | None = None
    created_at: UtcDateTime
    confirmed_at: UtcDateTime | None
    version: int = Field(gt=0)

    def to_view(self) -> BookingView:
        return BookingView.model_validate(
            self.model_dump(
                exclude={"payment_failure_code", "payment_retryable"},
            )
        )


def cancelled_booking(booking: Booking) -> Booking:
    return booking.model_copy(
        update={
            "state": BookingState.CANCELLED,
            "version": booking.version + 1,
        }
    )


def processing_booking(booking: Booking) -> Booking:
    return booking.model_copy(
        update={
            "state": BookingState.PROCESSING,
            "payment_status": PaymentStatus.PROCESSING,
            "payment_failure_code": None,
            "payment_retryable": None,
            "version": booking.version + 1,
        }
    )


def failed_booking(booking: Booking, *, code: str, retryable: bool) -> Booking:
    return booking.model_copy(
        update={
            "state": BookingState.PENDING_PAYMENT,
            "payment_status": PaymentStatus.FAILED,
            "payment_failure_code": code,
            "payment_retryable": retryable,
            "version": booking.version + 1,
        }
    )


def reconciliation_booking(
    booking: Booking, *, transaction_hash: str
) -> Booking:
    return booking.model_copy(
        update={
            "state": BookingState.RECONCILIATION_REQUIRED,
            "payment_status": PaymentStatus.SETTLED,
            "transaction_hash": transaction_hash,
            "payment_failure_code": None,
            "payment_retryable": None,
            "version": booking.version + 1,
        }
    )


def confirmed_booking(
    booking: Booking, *, transaction_hash: str, confirmed_at: datetime
) -> Booking:
    return booking.model_copy(
        update={
            "state": BookingState.CONFIRMED,
            "payment_status": PaymentStatus.SETTLED,
            "transaction_hash": transaction_hash,
            "payment_failure_code": None,
            "payment_retryable": None,
            "confirmed_at": confirmed_at,
            "version": booking.version + 1,
        }
    )
