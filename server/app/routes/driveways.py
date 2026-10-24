from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.domain.driveways import (
    Actor,
    DrivewayError,
    DrivewayService,
    InvalidTransitionError,
    NotFoundError,
    PermissionDeniedError,
    UpdateDriveway,
    VersionConflictError,
)
from app.models.api import CreateHoldRequest, DrivewayUpdateRequest, RecoverDrivewayRequest
from app.models.domain import BookingView, DrivewayView


router = APIRouter(prefix="/v1/driveways", tags=["driveways"])


def get_driveway_service(request: Request) -> DrivewayService:
    service = getattr(request.app.state, "driveway_service", None)
    if service is None:
        raise HTTPException(status_code=503, detail="driveway service is not configured")
    return service


def get_actor(request: Request) -> Actor:
    actor = getattr(request.state, "actor", None)
    if actor is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return actor


def get_clock() -> datetime:
    return datetime.now(UTC)


def as_http_error(error: DrivewayError) -> HTTPException:
    if isinstance(error, NotFoundError):
        return HTTPException(status_code=404, detail=str(error))
    if isinstance(error, PermissionDeniedError):
        return HTTPException(status_code=403, detail=str(error))
    if isinstance(error, (VersionConflictError, InvalidTransitionError)):
        return HTTPException(status_code=409, detail=str(error))
    return HTTPException(status_code=500, detail="driveway operation failed")


@router.patch("/{driveway_id}", response_model=DrivewayView)
async def update_driveway(
    driveway_id: str,
    request: DrivewayUpdateRequest,
    service: DrivewayService = Depends(get_driveway_service),
    actor: Actor = Depends(get_actor),
    now: datetime = Depends(get_clock),
):
    try:
        return await service.update_driveway(
            UpdateDriveway(
                driveway_id=driveway_id,
                owner_id=actor.user_id,
                **request.model_dump(),
            ),
            now,
        )
    except DrivewayError as error:
        raise as_http_error(error) from error


@router.post(
    "/{driveway_id}/holds",
    response_model=BookingView,
    status_code=status.HTTP_201_CREATED,
)
async def start_hold(
    driveway_id: str,
    request: CreateHoldRequest,
    service: DrivewayService = Depends(get_driveway_service),
    actor: Actor = Depends(get_actor),
    now: datetime = Depends(get_clock),
):
    try:
        booking = await service.start_hold(
            driveway_id, actor.user_id, request.expected_version, now
        )
        return booking.to_view()
    except DrivewayError as error:
        raise as_http_error(error) from error


@router.delete("/{driveway_id}/holds/{booking_id}", response_model=DrivewayView)
async def cancel_hold(
    driveway_id: str,
    booking_id: str,
    service: DrivewayService = Depends(get_driveway_service),
    actor: Actor = Depends(get_actor),
    now: datetime = Depends(get_clock),
):
    try:
        released = await service.cancel_hold(
            booking_id,
            actor.user_id,
            now,
            expected_driveway_id=driveway_id,
        )
        return await service.get_driveway(driveway_id, now)
    except DrivewayError as error:
        raise as_http_error(error) from error


@router.post("/{driveway_id}/recover", response_model=DrivewayView)
async def recover_driveway(
    driveway_id: str,
    request: RecoverDrivewayRequest,
    service: DrivewayService = Depends(get_driveway_service),
    actor: Actor = Depends(get_actor),
    now: datetime = Depends(get_clock),
):
    try:
        await service.recover_driveway(
            driveway_id, actor.user_id, request.expected_version, now
        )
        return await service.get_driveway(driveway_id, now)
    except DrivewayError as error:
        raise as_http_error(error) from error
