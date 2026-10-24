from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.models.api import DemoSessionRequest, DemoSessionResponse
from app.models.domain import UserView
from app.repositories.protocols import ParkingRepository


router = APIRouter(prefix="/v1/demo", tags=["sessions"])
_bearer = HTTPBearer(auto_error=False)


def get_repository(request: Request) -> ParkingRepository:
    repository = getattr(request.app.state, "parking_repository", None)
    if repository is None:
        raise HTTPException(status_code=503, detail="parking repository is not configured")
    return repository


async def require_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    repository: ParkingRepository = Depends(get_repository),
) -> UserView:
    token = credentials.credentials if credentials else ""
    users = {"demo-token-driver_demo": "driver_demo", "demo-token-owner_demo": "owner_demo"}
    user = await repository.get_user(users[token]) if token in users else None
    if user is None:
        raise HTTPException(status_code=401, detail="seeded bearer token required")
    return user


@router.post("/sessions", response_model=DemoSessionResponse)
async def demo_session(body: DemoSessionRequest, repository: ParkingRepository = Depends(get_repository)):
    user = await repository.get_user(f"{body.profile.value}_demo")
    if user is None:
        raise HTTPException(status_code=503, detail="demo profile is not seeded")
    return DemoSessionResponse(user=user, token=f"demo-token-{user.id}")
