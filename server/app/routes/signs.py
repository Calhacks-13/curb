"""
REST endpoints for sign queries and manual sign reading.
"""

from fastapi import APIRouter, UploadFile, File, Query

from app.cv.sign_reader import read_sign
from app.azure import cosmos

router = APIRouter(prefix="/signs", tags=["signs"])


@router.get("/nearby")
async def signs_nearby(
    lat: float = Query(...),
    lng: float = Query(...),
    radius_m: float = Query(200, ge=50, le=2000),
):
    signs = await cosmos.query_signs_nearby(lat, lng, radius_m)
    return {"signs": signs}


@router.post("/read")
async def read_sign_upload(file: UploadFile = File(...)):
    """Manual sign image upload for testing."""
    image_bytes = await file.read()
    rules = await read_sign(image_bytes)
    return rules.model_dump(mode="json")
