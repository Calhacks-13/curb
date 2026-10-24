from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException

from app.domain.driveways import Actor, ActorRole, DrivewayError, DrivewayService
from app.models.api import (
    FinalizeBookingRequest,
    PaymentFailedRequest,
    PaymentProcessingRequest,
)
from app.models.domain import BookingView
from app.routes.driveways import as_http_error, get_actor, get_clock, get_driveway_service


router = APIRouter(prefix="/v1/bookings", tags=["bookings"])


def require_payment_service(actor: Actor) -> None:
    if actor.role != ActorRole.SERVICE:
        raise HTTPException(status_code=403, detail="payment service authentication required")


@router.get("/{booking_id}", response_model=BookingView)
async def get_booking(
    booking_id: str,
    service: DrivewayService = Depends(get_driveway_service),
    actor: Actor = Depends(get_actor),
):
    try:
        return await service.get_booking(booking_id, actor)
    except DrivewayError as error:
        raise as_http_error(error) from error


@router.post("/{booking_id}/payment-processing", response_model=BookingView)
async def mark_payment_processing(
    booking_id: str,
    request: PaymentProcessingRequest,
    service: DrivewayService = Depends(get_driveway_service),
    actor: Actor = Depends(get_actor),
    now: datetime = Depends(get_clock),
):
    require_payment_service(actor)
    try:
        booking = await service.mark_payment_processing(
            booking_id, request.expected_booking_version, now
        )
        return booking.to_view()
    except DrivewayError as error:
        raise as_http_error(error) from error


@router.post("/{booking_id}/payment-failed", response_model=BookingView)
async def mark_payment_failed(
    booking_id: str,
    request: PaymentFailedRequest,
    service: DrivewayService = Depends(get_driveway_service),
    actor: Actor = Depends(get_actor),
    now: datetime = Depends(get_clock),
):
    require_payment_service(actor)
    try:
        booking = await service.mark_payment_failed(
            booking_id,
            expected_booking_version=request.expected_booking_version,
            code=request.code,
            retryable=request.retryable,
            now=now,
        )
        return booking.to_view()
    except DrivewayError as error:
        raise as_http_error(error) from error


@router.post("/{booking_id}/finalize", response_model=BookingView)
async def finalize_booking(
    booking_id: str,
    request: FinalizeBookingRequest,
    service: DrivewayService = Depends(get_driveway_service),
    actor: Actor = Depends(get_actor),
    now: datetime = Depends(get_clock),
):
    require_payment_service(actor)
    try:
        booking = await service.finalize_booking(
            booking_id,
            idempotency_key=request.idempotency_key,
            transaction_hash=request.transaction_hash,
            expected_booking_version=request.expected_booking_version,
            now=now,
        )
        return booking.to_view()
    except DrivewayError as error:
        raise as_http_error(error) from error
