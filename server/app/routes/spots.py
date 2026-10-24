"""
REST endpoints for spot queries and single-shot observation.
"""

from fastapi import APIRouter, UploadFile, File, Query

from app.cv.pipeline import get_pipeline
from app.azure import cosmos

router = APIRouter(prefix="/spots", tags=["spots"])


@router.get("/nearby")
async def spots_nearby(
    lat: float = Query(...),
    lng: float = Query(...),
    radius_m: float = Query(500, ge=50, le=5000),
):
    blocks = await cosmos.query_blocks_nearby(lat, lng, radius_m)
    return {"blocks": blocks}


@router.post("/observe")
async def observe(
    lat: float = Query(...),
    lng: float = Query(...),
    file: UploadFile = File(...),
):
    """Single-shot frame upload for testing/fallback."""
    image_bytes = await file.read()
    pipeline = get_pipeline()
    result = await pipeline.process_frame(
        image_bytes=image_bytes,
        lat=lat,
        lng=lng,
        session_id="rest-oneshot",
    )
    return result["frame_result"].model_dump(mode="json")


@router.get("/{segment_id}")
async def get_block(segment_id: str):
    block = await cosmos.get_block(segment_id)
    if block is None:
        return {"error": "not found"}
    return block
