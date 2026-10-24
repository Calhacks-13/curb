"""
REST endpoints for sign queries and manual sign reading.
"""

from datetime import datetime
from fastapi import APIRouter, UploadFile, File, Query

from app.cv.sign_localizer import make_road_segment_id, _haversine_m
from app.azure import cosmos

router = APIRouter(prefix="/signs", tags=["signs"])


@router.get("/nearby")
async def signs_nearby(
    lat: float = Query(...),
    lng: float = Query(...),
    radius_m: float = Query(200, ge=50, le=2000),
    heading: float | None = Query(None, ge=0, lt=360),
):
    signs = await cosmos.query_signs_nearby(lat, lng, radius_m)

    # Optionally filter by same side of street (similar road_segment_id direction)
    if heading is not None:
        from app.cv.sign_localizer import _compass_direction
        driver_dir = _compass_direction(heading)
        filtered = []
        for s in signs:
            seg_id = s.get("road_segment_id", "")
            if seg_id:
                parts = seg_id.split(",")
                if len(parts) == 3 and parts[2] == driver_dir:
                    filtered.append(s)
                    continue
            # Keep signs without road_segment_id (legacy)
            filtered.append(s)
        signs = filtered

    return {"signs": signs}


@router.get("/rules-here")
async def rules_here(
    lat: float = Query(...),
    lng: float = Query(...),
    heading: float = Query(..., ge=0, lt=360),
    radius_m: float = Query(50, ge=10, le=500),
):
    """
    Find nearest sign(s) on same side of street, return combined rules
    and compute can_park_now from stored hours/restrictions at query time.
    """
    signs = await cosmos.query_signs_nearby(lat, lng, radius_m)

    if not signs:
        return {"rules": None, "can_park_now": None, "signs_found": 0}

    # Filter to same road direction
    from app.cv.sign_localizer import _compass_direction
    driver_dir = _compass_direction(heading)

    same_side = []
    for s in signs:
        seg_id = s.get("road_segment_id", "")
        if seg_id:
            parts = seg_id.split(",")
            if len(parts) == 3 and parts[2] != driver_dir:
                continue
        same_side.append(s)

    if not same_side:
        same_side = signs  # Fall back to all if no directional match

    # Sort by distance, take closest
    same_side.sort(
        key=lambda s: _haversine_m(
            lat, lng,
            s.get("lat", 0), s.get("lng", 0),
        )
    )

    closest = same_side[0]
    pole_reading = closest.get("pole_reading")

    # Compute can_park_now from stored rules
    can_park_now = _evaluate_parking_now(pole_reading) if pole_reading else None

    return {
        "rules": pole_reading,
        "can_park_now": can_park_now,
        "signs_found": len(same_side),
        "distance_m": round(_haversine_m(lat, lng, closest.get("lat", 0), closest.get("lng", 0)), 1),
    }


def _evaluate_parking_now(pole_reading: dict) -> bool | None:
    """
    Evaluate whether parking is allowed right now based on stored rules.
    Returns True/False/None (None = can't determine).
    """
    if not pole_reading:
        return None

    signs = pole_reading.get("signs", [])
    if not signs:
        return None

    now = datetime.now()
    hour = now.hour
    weekday = now.weekday()  # 0=Mon, 6=Sun

    for sign in signs:
        sign_type = sign.get("sign_type", "other")

        # Definitive no-parking signs
        if sign_type == "no_parking":
            hours_str = sign.get("hours")
            if hours_str is None:
                return False  # No parking anytime
            # If hours are specified, we'd need to parse them
            # For now, flag it as restricted
            return False

        if sign_type == "street_cleaning":
            # Street cleaning means no parking during those hours
            return None  # Would need hour parsing

    # If we only see parking/meter signs, parking is generally allowed
    has_parking = any(s.get("sign_type") in ("parking", "meter", "time_limit") for s in signs)
    if has_parking:
        return True

    return None


@router.post("/read")
async def read_sign_upload(file: UploadFile = File(...)):
    from app.cv.sign_reader import read_sign
    """Manual sign image upload for testing."""
    image_bytes = await file.read()
    rules = await read_sign(image_bytes)
    return rules.model_dump(mode="json")


@router.post("/read-pole")
async def read_pole_upload(file: UploadFile = File(...)):
    """Manual pole image upload for testing — returns structured per-sign rules."""
    image_bytes = await file.read()
    from app.cv.sign_reader import read_sign_pole

    reading = await read_sign_pole(image_bytes)
    return reading.model_dump(mode="json")
