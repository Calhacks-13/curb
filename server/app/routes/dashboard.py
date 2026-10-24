"""
Dashboard API — serves recent confirmed blocks from in-memory deque.
"""

from fastapi import APIRouter

from app.cv.pipeline import get_pipeline

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/recent")
async def recent_blocks():
    pipeline = get_pipeline()
    return {"blocks": list(pipeline.recent_blocks)}
