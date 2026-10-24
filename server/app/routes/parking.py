from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.domain.parking import ParkingService
from app.models.domain import GeoPoint, NearbyParkingResponse, SpaceDetail, UserView
from app.repositories.protocols import ParkingRepository
from app.routes.sessions import get_repository, require_user


router = APIRouter(prefix="/v1", tags=["parking"], dependencies=[Depends(require_user)])


def get_clock() -> datetime:
    return datetime.now(UTC)


@router.get("/parking/nearby", response_model=NearbyParkingResponse)
async def nearby_parking(
    request: Request,
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    radius_m: float = Query(804.672, ge=804.672, le=804.672),
    user: UserView = Depends(require_user),
    repository: ParkingRepository = Depends(get_repository),
    now: datetime = Depends(get_clock),
):
    return await ParkingService(
        repository,
        driveway_service=getattr(request.app.state, "driveway_service", None),
        demo_follow_origin=getattr(request.app.state, "local_demo", False),
    ).nearby(
        GeoPoint(type="Point", coordinates=(lng, lat)), radius_m, now, viewer_id=user.id
    )


@router.get("/spaces/{space_id}", response_model=SpaceDetail)
async def get_space(
    space_id: str,
    repository: ParkingRepository = Depends(get_repository),
    now: datetime = Depends(get_clock),
):
    detail = await ParkingService(repository).detail(space_id, now)
    if detail is None:
        raise HTTPException(status_code=404, detail="space or validated rule not found")
    return detail
