"""
/v1 API router — bridges the mobile app contract to the existing server.

The mobile Expo app expects these endpoints with specific response shapes.
This router translates between the server's BlockObservation/SignRules models
and the mobile's ParkingSpace/CurbZone/NearbyParkingResponse contract.
"""

import json
import uuid
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Form, Query, UploadFile, File
from pydantic import BaseModel

from app.azure import cosmos, signalr
from app.cv.pipeline import get_pipeline
from app.cv.frame_selector import FrameSelector
from app.routes.ws import viewers as ws_viewers

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["v1"])

_frame_selector = FrameSelector()


# ---------- response models (match mobile types.ts) ----------

class GeoPoint(BaseModel):
    type: str = "Point"
    coordinates: list[float]  # [lng, lat]


class CurbZone(BaseModel):
    id: str
    geometry: dict
    sign_rule_id: str | None = None
    legal_status_now: str = "UNKNOWN"
    next_change_at: str | None = None
    version: int = 1


class ParkingSpace(BaseModel):
    id: str
    zone_id: str
    location: dict
    stall_geometry: dict
    internal_state: str = "UNKNOWN"
    last_observed_at: str | None = None
    base_confidence: float = 0.0
    version: int = 1


class SignRuleView(BaseModel):
    id: str
    summary: str = ""
    max_minutes: int | None = None
    next_change_at: str | None = None
    next_change_summary: str | None = None
    payment_text: str | None = None
    permit_text: str | None = None
    interpretation_confidence: float = 0.0
    last_validated_at: str = ""


class NearbyParkingResponse(BaseModel):
    generated_at: str
    zones: list[CurbZone]
    spaces: list[ParkingSpace]
    driveways: list[dict]


class SpaceDetail(BaseModel):
    space: ParkingSpace
    zone: CurbZone
    rule: SignRuleView | None = None


# ---------- transform helpers ----------

def _block_to_space(block: dict) -> ParkingSpace:
    """Convert a Cosmos BlockObservation doc to mobile ParkingSpace."""
    loc = block.get("location", {})
    coords = loc.get("coordinates", [0, 0])
    lng, lat = coords[0], coords[1]

    # Small stall polygon around the point (~3m box)
    d = 0.00003  # ~3m in degrees
    stall = {
        "type": "Polygon",
        "coordinates": [[
            [lng - d, lat - d],
            [lng + d, lat - d],
            [lng + d, lat + d],
            [lng - d, lat + d],
            [lng - d, lat - d],
        ]],
    }

    gap_count = block.get("gap_count", 0)
    state = "OPEN" if gap_count > 0 else "OCCUPIED"

    confirmed_at = block.get("confirmed_at")
    if isinstance(confirmed_at, str):
        last_observed = confirmed_at
    elif isinstance(confirmed_at, datetime):
        last_observed = confirmed_at.isoformat()
    else:
        last_observed = None

    return ParkingSpace(
        id=block.get("segment_id", block.get("id", "")),
        zone_id=block.get("segment_id", block.get("id", "")),
        location=loc,
        stall_geometry=stall,
        internal_state=state,
        last_observed_at=last_observed,
        base_confidence=block.get("confidence", 0.0),
        version=1,
    )


def _spot_to_space(spot: dict) -> ParkingSpace:
    """Convert a SpotDocument to mobile ParkingSpace with real status."""
    loc = spot.get("location", {})
    coords = loc.get("coordinates", [0, 0])
    lng, lat = coords[0], coords[1]

    d = 0.00003
    stall = {
        "type": "Polygon",
        "coordinates": [[
            [lng - d, lat - d],
            [lng + d, lat - d],
            [lng + d, lat + d],
            [lng - d, lat + d],
            [lng - d, lat - d],
        ]],
    }

    status = spot.get("status", "open")
    state = status.upper()  # open -> OPEN, occupied -> OCCUPIED

    last_seen = spot.get("last_seen_at") or spot.get("opened_at")
    if isinstance(last_seen, datetime):
        last_seen = last_seen.isoformat()

    return ParkingSpace(
        id=spot.get("id", ""),
        zone_id=spot.get("segment_id", ""),
        location=loc,
        stall_geometry=stall,
        internal_state=state,
        last_observed_at=last_seen,
        base_confidence=spot.get("confidence", 0.0),
        version=spot.get("version", 1),
    )


def _block_to_zone(block: dict, signs: list[dict]) -> CurbZone:
    """Convert a Cosmos BlockObservation doc to mobile CurbZone."""
    loc = block.get("location", {})
    coords = loc.get("coordinates", [0, 0])
    lng, lat = coords[0], coords[1]
    seg_id = block.get("segment_id", block.get("id", ""))

    # LineString along the curb face (~10m segment)
    d = 0.00005  # ~5m
    geometry = {
        "type": "LineString",
        "coordinates": [[lng - d, lat], [lng + d, lat]],
    }

    sign_rule_id = None
    legal_status = "UNKNOWN"

    # Check if there's a matching sign for this block
    # sign_rules is now SignPoleReading (combined_summary) not SignRules (summary)
    block_sign = block.get("sign_rules")
    if isinstance(block_sign, dict):
        summary = block_sign.get("combined_summary") or block_sign.get("summary") or ""
        if summary:
            sign_rule_id = seg_id
            summary_lower = summary.lower()
            if "no parking" in summary_lower or "no stopping" in summary_lower:
                legal_status = "ILLEGAL"
            else:
                legal_status = "LEGAL"

    return CurbZone(
        id=seg_id,
        geometry=geometry,
        sign_rule_id=sign_rule_id,
        legal_status_now=legal_status,
        version=1,
    )


def _sign_to_rule_view(sign_doc: dict) -> SignRuleView:
    """Convert a Cosmos sign doc (SignPoleReading or legacy SignRules) to mobile SignRuleView."""
    # Handle both SignPoleReading (combined_summary) and legacy SignRules (summary)
    summary = sign_doc.get("combined_summary") or sign_doc.get("summary") or ""
    max_min = sign_doc.get("combined_max_duration_min") or sign_doc.get("max_duration_min")
    price = sign_doc.get("combined_price") or sign_doc.get("price")
    return SignRuleView(
        id=sign_doc.get("id", sign_doc.get("grid_key", "")),
        summary=summary,
        max_minutes=max_min,
        payment_text=price,
        interpretation_confidence=sign_doc.get("confidence_score", 0.0),
        last_validated_at=datetime.now(timezone.utc).isoformat(),
    )


# ---------- endpoints ----------

@router.post("/demo/sessions")
async def demo_session(body: dict | None = None):
    """Return a hardcoded demo session so the mobile app can bootstrap."""
    profile = "driver"
    if body and "profile" in body:
        profile = body["profile"]

    user_id = f"{profile}_demo"
    return {
        "user": {
            "id": user_id,
            "display_name": f"Demo {profile.title()}",
            "demo_profile": profile,
        },
        "token": f"demo-token-{user_id}",
    }


@router.get("/parking/nearby")
async def nearby_parking(
    lat: float = Query(...),
    lng: float = Query(...),
    radius_m: float = Query(805, ge=50, le=5000),
):
    """Query spots + blocks + signs, transform to NearbyParkingResponse."""
    spots = await cosmos.query_spots_nearby(lat, lng, radius_m)
    blocks = await cosmos.query_blocks_nearby(lat, lng, radius_m)
    signs = await cosmos.query_signs_nearby(lat, lng, radius_m)

    # Prefer SpotDocuments (have real status); fall back to legacy blocks
    spot_segments = {s.get("segment_id") for s in spots}
    spaces = [_spot_to_space(s) for s in spots if s.get("status") != "expired"]
    # Add legacy blocks that don't have a corresponding SpotDocument
    for b in blocks:
        if b.get("segment_id") not in spot_segments:
            spaces.append(_block_to_space(b))

    zones = [_block_to_zone(b, signs) for b in blocks]

    return NearbyParkingResponse(
        generated_at=datetime.now(timezone.utc).isoformat(),
        zones=zones,
        spaces=spaces,
        driveways=[],
    )


@router.get("/spaces/{space_id}")
async def get_space(space_id: str):
    """Get space detail with sign rule."""
    # Try looking up as a block segment_id first, then try as spot zone_id
    block = await cosmos.get_block(space_id)

    if block is None:
        # space_id might be a spot id (e.g. "seed_spot_1") — find the spot
        # and use its segment_id to look up the block
        spots = await cosmos.query_spots_nearby(0, 0, 50000)  # broad search
        spot = next((s for s in spots if s.get("id") == space_id), None)
        if spot:
            seg_id = spot.get("segment_id", "")
            block = await cosmos.get_block(seg_id)
            if block is None:
                # No block exists — build a synthetic one from the spot
                block = {
                    "segment_id": seg_id, "id": seg_id,
                    "gap_count": spot.get("gap_count", 1),
                    "confidence": spot.get("confidence", 0.0),
                    "confirmed_at": spot.get("last_seen_at"),
                    "lat": spot.get("lat", 0), "lng": spot.get("lng", 0),
                    "location": spot.get("location", {}),
                    "sign_rules": spot.get("sign_rules"),
                }

    if block is None:
        from fastapi.responses import JSONResponse
        return JSONResponse({"error": "not found"}, status_code=404)

    signs = await cosmos.query_signs_nearby(
        block.get("lat", 0), block.get("lng", 0), 200
    )

    space = _block_to_space(block)
    zone = _block_to_zone(block, signs)

    rule = None
    block_sign = block.get("sign_rules")
    if isinstance(block_sign, dict) and (block_sign.get("combined_summary") or block_sign.get("summary")):
        rule = _sign_to_rule_view(block_sign)

    return SpaceDetail(space=space, zone=zone, rule=rule)


@router.post("/vision/frames")
async def upload_frame(
    frame: UploadFile = File(...),
    metadata: str = Form(...),
):
    """Accept FormData (jpeg + metadata JSON), run through CV pipeline."""
    meta = json.loads(metadata)
    image_bytes = await frame.read()

    lat = meta.get("lat", 0.0)
    lng = meta.get("lng", 0.0)
    heading = meta.get("heading", 0.0) or 0.0
    session_id = meta.get("session_id", str(uuid.uuid4()))

    # Simple rate limiting
    if not _frame_selector.should_process(session_id, image_bytes):
        return {"frame_id": str(uuid.uuid4()), "accepted": False}

    pipeline = get_pipeline()
    result = await pipeline.process_frame(
        image_bytes=image_bytes,
        lat=lat,
        lng=lng,
        session_id=session_id,
        heading=heading,
    )

    # Relay to WS viewers (so laptop viewer shows mobile frames + detections)
    if ws_viewers:
        response = result["frame_result"].model_dump(mode="json")
        response_json = json.dumps(response)
        dead = []
        for v in ws_viewers:
            try:
                await v.send_bytes(image_bytes)
                await v.send_text(response_json)
            except Exception:
                dead.append(v)
        for v in dead:
            ws_viewers.discard(v)

    # Realtime events (space.opened/refreshed/occupied) are now
    # broadcast directly by the pipeline's SpotManager.

    # Self-feedback: include confirmed spot in the response so the scanning
    # phone sees its OWN spots immediately, without waiting for Web PubSub.
    fr = result["frame_result"]
    response = {
        "frame_id": str(uuid.uuid4()),
        "accepted": True,
        "pipeline_state": fr.pipeline_state or "no scene",
        "vehicle_count": len(fr.vehicles),
        "gap_count": fr.gap_estimate,
        "scene_valid": fr.scene_valid,
    }
    confirmed = result.get("confirmed_block")
    if confirmed is not None:
        block_dict = confirmed.model_dump(mode="json")
        response["space"] = _block_to_space(block_dict).model_dump(mode="json")
        response["zone"] = _block_to_zone(block_dict, []).model_dump(mode="json")
    return response


@router.post("/realtime/negotiate")
async def realtime_negotiate():
    """Return a Web PubSub client connection URL."""
    url = await signalr.get_client_url()
    if url is None:
        return {"url": None, "error": "Web PubSub not configured"}
    return {"url": url}


@router.get("/realtime/events")
async def poll_realtime_events(since: int = Query(0, ge=0)):
    """Local-demo fallback: poll for realtime events when Web PubSub is unavailable.

    Mobile calls this when /realtime/negotiate returns url=null.
    Returns events with seq > `since`; client tracks the last seq it saw.
    """
    events = signalr.get_recent_events(since)
    return {"events": events}
