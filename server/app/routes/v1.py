"""
/v1 API router — bridges the mobile app contract to the existing server.

The mobile Expo app expects these endpoints with specific response shapes.
This router translates between the server's BlockObservation/SignRules models
and the mobile's ParkingSpace/CurbZone/NearbyParkingResponse contract.
"""

import uuid
import logging
from datetime import UTC, datetime, timezone

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel

from app.azure import cosmos, signalr
from app.domain.detections import DetectionSubmission
from app.models.cv import BlockObservation
from app.models.domain import (
    CurbZoneView as CanonicalCurbZone,
    DayOfWeek,
    GeoLineString,
    GeoPoint as CanonicalGeoPoint,
    GeoPolygon,
    InternalSpaceState,
    LegalStatus,
    ParkingSpaceView as CanonicalParkingSpace,
    PaymentRules,
    PermitRules,
    RuleKind,
    SignRuleView as CanonicalSignRule,
    WeeklyRuleWindow,
)
from app.repositories.protocols import ParkingRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["v1"])


def get_pipeline():
    from app.cv.pipeline import get_pipeline as load_pipeline

    return load_pipeline()


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

    sign_rule_id = seg_id
    legal_status = "LEGAL"

    # If sign rules exist, use them to determine legal status
    block_sign = block.get("sign_rules")
    if isinstance(block_sign, dict):
        summary = block_sign.get("combined_summary") or block_sign.get("summary") or ""
        if summary:
            summary_lower = summary.lower()
            if "no parking" in summary_lower or "no stopping" in summary_lower:
                legal_status = "ILLEGAL"

    return CurbZone(
        id=seg_id,
        geometry=geometry,
        sign_rule_id=sign_rule_id,
        legal_status_now=legal_status,
        version=1,
    )


async def _persist_confirmed_scan(repository: ParkingRepository, block: BlockObservation) -> None:
    """Store a scanner-confirmed opening in the canonical map repository.

    A scanner observation is tied to its captured GPS coordinates; it never
    moves demo data or invents a location elsewhere on the map.
    """
    if not (-90 <= block.lat <= 90 and -180 <= block.lng <= 180) or (block.lat == block.lng == 0):
        logger.warning("Not persisting scan %s without a valid GPS coordinate", block.segment_id)
        return

    observed_at = block.confirmed_at
    if observed_at.tzinfo is None:
        observed_at = observed_at.replace(tzinfo=UTC)
    else:
        observed_at = observed_at.astimezone(UTC)

    sign = block.sign_rules
    evidence = sign.combined_summary.strip() if sign and sign.combined_summary.strip() else (
        "Scanner-confirmed open curb space; verify posted signs before parking."
    )
    prohibited = bool(sign and any(
        phrase in evidence.lower() for phrase in ("no parking", "no stopping")
    ))
    legal_status = LegalStatus.ILLEGAL if prohibited else LegalStatus.LEGAL
    rule_kind = RuleKind.NO_PARKING if prohibited else RuleKind.ALLOWED
    rule_id = f"scan-rule:{block.segment_id}"
    d = 0.00003
    line_d = 0.00005
    coordinates = (block.lng, block.lat)

    rule = CanonicalSignRule(
        id=rule_id,
        zone_id=block.segment_id,
        weekly_schedule=[WeeklyRuleWindow(
            days=list(DayOfWeek), start_local="00:00", end_local="23:59", kind=rule_kind,
        )],
        max_minutes=sign.combined_max_duration_min if sign else None,
        payment_rules=PaymentRules(
            required=bool(sign and sign.combined_price),
            price_text=sign.combined_price if sign else None,
        ),
        permit_rules=PermitRules(required=False, permitted_labels=[]),
        exceptions=[],
        evidence_text=evidence,
        interpretation_confidence=max(0.0, min(1.0, block.confidence)),
        last_validated_at=observed_at,
        version=1,
    )
    zone = CanonicalCurbZone(
        id=block.segment_id,
        geometry=GeoLineString(type="LineString", coordinates=[
            (block.lng - line_d, block.lat), (block.lng + line_d, block.lat),
        ]),
        sign_rule_id=rule_id,
        legal_status_now=legal_status,
        current_rules=evidence,
        next_change_at=None,
        version=1,
    )
    space = CanonicalParkingSpace(
        id=block.segment_id,
        zone_id=block.segment_id,
        location=CanonicalGeoPoint(type="Point", coordinates=coordinates),
        stall_geometry=GeoPolygon(type="Polygon", coordinates=[[
            (block.lng - d, block.lat - d), (block.lng + d, block.lat - d),
            (block.lng + d, block.lat + d), (block.lng - d, block.lat + d),
            (block.lng - d, block.lat - d),
        ]]),
        internal_state=InternalSpaceState.OPEN if block.gap_count > 0 else InternalSpaceState.OCCUPIED,
        last_observed_at=observed_at,
        base_confidence=max(0.0, min(1.0, block.confidence)),
        freshness=None,
        status_label="Likely open",
        distance_m=0,
        version=1,
    )
    await repository.upsert("rules", rule)
    await repository.upsert("zones", zone)
    await repository.upsert("spaces", space)


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


def _garage_to_view(g: dict) -> dict:
    """Convert an in-memory garage doc to the mobile Garage shape."""
    loc = g.get("location", {})
    if not loc:
        lng, lat = g.get("lng", 0), g.get("lat", 0)
        loc = {"type": "Point", "coordinates": [lng, lat]}
    return {
        "id": g.get("id", ""),
        "location": loc,
        "lat": g.get("lat", 0),
        "lng": g.get("lng", 0),
        "name": g.get("name"),
        "summary": g.get("summary", ""),
        "price": g.get("price"),
        "arrow_direction": g.get("arrow_direction"),
        "sign_category": g.get("sign_category", "garage"),
        "version": g.get("version", 1),
    }


def _driveway_to_view(dw: dict) -> dict:
    """Convert an in-memory driveway doc to the mobile Driveway shape."""
    loc = dw.get("location", {})
    if not loc:
        lng, lat = dw.get("lng", 0), dw.get("lat", 0)
        loc = {"type": "Point", "coordinates": [lng, lat]}
    return {
        "id": dw.get("id", ""),
        "owner_id": dw.get("owner_id", ""),
        "location": loc,
        "photo_url": dw.get("photo_url"),
        "price_usdc": str(dw.get("price_usdc", "0")),
        "availability_start": dw.get("availability_start", "00:00"),
        "availability_end": dw.get("availability_end", "23:59"),
        "availability_timezone": "America/Los_Angeles",
        "state": dw.get("state", "AVAILABLE"),
        "held_by_user_id": dw.get("held_by_user_id"),
        "version": dw.get("version", 1),
    }


# ---------- endpoints ----------

@router.post("/vision/detections")
async def upload_detections(request: Request, submission: DetectionSubmission):
    """Accept validated on-device detections and return confirmed-space feedback."""
    vehicles, signs = submission.to_pipeline_input()
    result = await get_pipeline().process_detections(
        vehicles=vehicles,
        signs=signs,
        frame_width=submission.frame_width,
        frame_height=submission.frame_height,
        lat=submission.lat,
        lng=submission.lng,
        session_id=submission.session_id,
        heading=submission.heading,
    )

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
        await _persist_confirmed_scan(request.app.state.parking_repository, confirmed)
        block_dict = confirmed.model_dump(mode="json")
        response["space"] = _block_to_space(block_dict).model_dump(mode="json")
        response["zone"] = _block_to_zone(block_dict, []).model_dump(mode="json")
    return response


@router.get("/debug/state")
async def debug_state():
    """Observability endpoint: dump in-memory pipeline state."""
    from app.cv.pipeline import get_pipeline

    pipeline = get_pipeline()
    mgr = pipeline._spot_mgr
    dedup = pipeline._sign_dedup

    sessions_info = {}
    for sid, sess in pipeline._sessions.items():
        sessions_info[sid] = {
            "vehicle_tracks": len(sess.vehicle_tracker.tracks),
            "confirmed_gaps": len(sess.gap_tracker._confirmed),
            "sign_tracks": len(sess.sign_tracker.tracks),
            "gap_segments": dict(
                (f"{k[0]},{k[1]}", v) for k, v in sess.confirmed_gap_segments.items()
            ),
            "last_sign_reading": sess.last_sign_reading.combined_summary if sess.last_sign_reading else None,
        }

    spots_info = {}
    for seg_id, spot in mgr._spots.items():
        spots_info[seg_id] = {
            "id": spot.id,
            "status": spot.status,
            "lat": spot.lat,
            "lng": spot.lng,
            "version": spot.version,
            "width_meters": spot.width_meters,
            "opened_at": spot.opened_at.isoformat() if spot.opened_at else None,
            "last_seen_at": spot.last_seen_at.isoformat() if spot.last_seen_at else None,
            "sign_summary": spot.sign_rules.combined_summary if spot.sign_rules else None,
        }

    signs_info = [
        {"id": doc.id, "lat": doc.lat, "lng": doc.lng,
         "summary": doc.pole_reading.combined_summary if doc.pole_reading else None}
        for doc in dedup._cache.values()
    ]

    return {
        "sessions": sessions_info,
        "spots": spots_info,
        "signs_deduped": signs_info,
        "recent_blocks": len(pipeline.recent_blocks),
        "event_buffer": len(signalr.get_recent_events(0)),
    }


# ---------- mapping mode ----------

@router.get("/mapping/status")
async def mapping_status():
    """Check if mapping mode is active."""
    pipeline = get_pipeline()
    return {"mapping_mode": pipeline.mapping_mode}


@router.post("/mapping/toggle")
async def mapping_toggle():
    """Toggle mapping mode on/off. Returns new state."""
    pipeline = get_pipeline()
    pipeline.mapping_mode = not pipeline.mapping_mode
    state = "ON" if pipeline.mapping_mode else "OFF"
    logger.info("Mapping mode toggled %s", state)
    return {"mapping_mode": pipeline.mapping_mode}


@router.delete("/mapping/spots")
async def delete_seed_spots(spot_id: str | None = Query(None)):
    """Delete seed spots. If spot_id given, delete that one; otherwise delete all seed spots."""
    deleted = await cosmos.delete_seed_spots(spot_id)
    # Also clear from in-memory SpotManager
    pipeline = get_pipeline()
    mgr = pipeline._spot_mgr
    to_remove = []
    for seg_id, spot in mgr._spots.items():
        if spot.is_seed:
            if spot_id is None or spot.id == spot_id:
                to_remove.append(seg_id)
    for seg_id in to_remove:
        mgr._spots.pop(seg_id, None)
    logger.info("Deleted %d seed spots (cosmos: %d)", len(to_remove), deleted)
    return {"deleted_memory": len(to_remove), "deleted_cosmos": deleted}


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
