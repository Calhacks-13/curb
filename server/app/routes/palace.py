from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.routes.sessions import require_user

router = APIRouter(prefix="/v1/demo/palace", tags=["demo"], dependencies=[Depends(require_user)])


class PalaceSeedOptions(BaseModel):
    keep_fresh_seconds: int = Field(default=1800, ge=0, le=3600, strict=True)


@router.post("")
async def load_palace(request: Request, options: PalaceSeedOptions):
    return await request.app.state.palace_scenario.start(options.keep_fresh_seconds)


@router.post("/reset")
async def reset_palace(request: Request):
    return await request.app.state.palace_scenario.reset()
