"""
Detection pipeline: device detections in -> tracked spots + sign rules out.

Orchestrates object tracker (IoU-based), gap tracker (track-pair confirmation),
sign tracker (IoU + GPS accumulation),
sign localizer (triangulation), and sign_reader (Claude Vision).

Spot lifecycle: OPEN -> REFRESHED -> OCCUPIED (via gap disappearance)
"""

import asyncio
import logging
import uuid
from collections import deque
from datetime import UTC, datetime

from app.config import settings
from app.models import (
    BlockObservation,
    FrameResult,
    GapMeasurement,
    SignDocument,
    SignPoleReading,
    SpotDocument,
    TrackedGapInfo,
    SignDetection,
    VehicleDetection,
)
from app.cv.tracker import (
    VehicleTracker,
    GapTracker,
    SignTracker,
    SignTrack,
    TrackedGap,
    group_signs_into_poles,
    gap_candidates,
    _iou,
)
from app.cv.sign_reader import read_sign_pole
from app.cv.sign_localizer import (
    estimate_sign_bearing,
    triangulate_sign,
    make_road_segment_id,
    _haversine_m,
)
from app.azure import cosmos, signalr

logger = logging.getLogger(__name__)


class SignDeduplicator:
    """
    Deduplicates signs by geo-position. Checks in-memory cache first,
    then falls back to Cosmos spatial query.
    """

    def __init__(self):
        self._cache: dict[str, SignDocument] = {}
        self._positions: list[tuple[float, float, str]] = []

    async def find_existing(
        self,
        lat: float,
        lng: float,
        radius_m: float | None = None,
        road_segment_id: str | None = None,
    ) -> SignDocument | None:
        if radius_m is None:
            radius_m = settings.sign_dedup_radius_m
        target_direction = None
        if road_segment_id:
            segment_parts = road_segment_id.split(",")
            if len(segment_parts) == 3:
                target_direction = segment_parts[2]

        # Check memory cache first
        for plat, plng, sign_id in self._positions:
            if _haversine_m(lat, lng, plat, plng) <= radius_m:
                doc = self._cache.get(sign_id)
                if doc is not None and (
                    target_direction is None
                    or doc.road_segment_id.rsplit(",", 1)[-1] == target_direction
                ):
                    return doc

        # Fall back to Cosmos
        nearby = await cosmos.query_signs_nearby(lat, lng, radius_m)
        for document in nearby:
            document_segment = document.get("road_segment_id", "")
            if target_direction is not None and (
                document_segment.rsplit(",", 1)[-1] != target_direction
            ):
                continue
            if "pole_reading" in document:
                return SignDocument(**document)

        return None

    def register(self, sign_doc: SignDocument) -> None:
        self._cache[sign_doc.id] = sign_doc
        self._positions.append((sign_doc.lat, sign_doc.lng, sign_doc.id))

    async def find_rules_for_segment(
        self,
        segment_id: str,
        lat: float,
        lng: float,
        radius_m: float | None = None,
    ) -> SignPoleReading | None:
        """Return recorded street-sign rules for the same directional curb."""
        if radius_m is None:
            radius_m = settings.sign_association_radius_m
        segment_parts = segment_id.split(",")
        if len(segment_parts) != 3:
            return None
        direction = segment_parts[2]
        nearby = await cosmos.query_signs_nearby(lat, lng, radius_m)
        documents_by_id = {
            document.get("id"): document
            for document in nearby
            if document.get("id")
        }
        for document in self._cache.values():
            if _haversine_m(lat, lng, document.lat, document.lng) <= radius_m:
                documents_by_id[document.id] = document.model_dump(mode="json")
        candidates: list[tuple[bool, float, SignPoleReading]] = []
        for document in documents_by_id.values():
            document_segment = document.get("road_segment_id", "")
            document_parts = document_segment.split(",")
            if len(document_parts) != 3 or document_parts[2] != direction:
                continue
            reading_data = document.get("pole_reading")
            if not reading_data:
                continue
            reading = SignPoleReading.model_validate(reading_data)
            if reading.sign_category in ("garage", "lot"):
                continue
            document_lat = document.get("lat", 0.0)
            document_lng = document.get("lng", 0.0)
            distance = _haversine_m(lat, lng, document_lat, document_lng)
            candidates.append((document_segment == segment_id, distance, reading))
        if not candidates:
            return None
        candidates.sort(key=lambda candidate: (not candidate[0], candidate[1]))
        return candidates[0][2]


class SpotManager:
    """
    In-memory index of active SpotDocuments keyed by segment_id.
    Handles create/refresh/occupy transitions and broadcasts events.
    """

    def __init__(self):
        # segment_id -> SpotDocument (only OPEN spots)
        self._spots: dict[str, SpotDocument] = {}

    @property
    def spot_count(self) -> int:
        return len(self._spots)

    def find_by_segment(self, segment_id: str) -> SpotDocument | None:
        return self._spots.get(segment_id)

    async def open_spot(
        self,
        segment_id: str,
        lat: float,
        lng: float,
        gap: TrackedGap,
        session_id: str,
        sign_rules: SignPoleReading | None = None,
        is_seed: bool = False,
    ) -> SpotDocument:
        """Create a new OPEN spot and broadcast space.opened + sign_rule.updated."""
        now = datetime.utcnow()
        spot = SpotDocument(
            id=f"spot_{uuid.uuid4()}",
            segment_id=segment_id,
            status="open",
            gap_count=1,
            confidence=1.0,
            width_meters=round(gap.median_width_meters, 2) if gap.median_width_meters else None,
            location={"type": "Point", "coordinates": [lng, lat]},
            lat=lat,
            lng=lng,
            sign_rules=sign_rules,
            opened_at=now,
            last_seen_at=now,
            version=1,
            ttl=-1 if is_seed else settings.default_ttl_sec,
            source_session_id=session_id,
            is_seed=is_seed,
        )
        self._spots[segment_id] = spot
        asyncio.create_task(_safe(cosmos.upsert_spot(spot)))
        asyncio.create_task(_safe(signalr.broadcast_realtime_event(
            event_type="space.opened",
            entity_id=spot.id,
            payload=_spot_payload(spot),
            entity_version=spot.version,
        )))

        # Broadcast zone so mobile has legal_status context for the new spot
        zone_payload = _zone_payload(segment_id, lat, lng, sign_rules)
        asyncio.create_task(_safe(signalr.broadcast_realtime_event(
            event_type="sign_rule.updated",
            entity_id=segment_id,
            payload=zone_payload,
        )))

        logger.info("Spot OPENED %s at (%.5f, %.5f) segment=%s", spot.id, lat, lng, segment_id)
        return spot

    async def refresh_spot(
        self,
        spot: SpotDocument,
        sign_rules: SignPoleReading | None = None,
    ) -> None:
        """Re-sighting of an existing OPEN spot — bump version, reset freshness."""
        spot.last_seen_at = datetime.utcnow()
        spot.version += 1
        if sign_rules is not None:
            spot.sign_rules = sign_rules
        self._spots[spot.segment_id] = spot
        asyncio.create_task(_safe(cosmos.upsert_spot(spot)))
        asyncio.create_task(_safe(signalr.broadcast_realtime_event(
            event_type="space.refreshed",
            entity_id=spot.id,
            payload=_spot_payload(spot),
            entity_version=spot.version,
        )))
        if sign_rules is not None:
            asyncio.create_task(_safe(signalr.broadcast_realtime_event(
                event_type="sign_rule.updated",
                entity_id=spot.segment_id,
                payload=_zone_payload(spot.segment_id, spot.lat, spot.lng, sign_rules),
            )))
        logger.debug("Spot REFRESHED %s v=%d", spot.id, spot.version)

    async def occupy_spot(self, segment_id: str) -> None:
        """Gap disappeared — mark spot as occupied and broadcast."""
        spot = self._spots.get(segment_id)
        if spot is None:
            return
        # Seed spots (mapping mode) are permanent — never occupy them
        if spot.is_seed:
            return
        self._spots.pop(segment_id)
        spot.status = "occupied"
        spot.occupied_at = datetime.utcnow()
        spot.version += 1
        spot.ttl = 300  # short TTL for occupied spots
        asyncio.create_task(_safe(cosmos.upsert_spot(spot)))
        asyncio.create_task(_safe(signalr.broadcast_realtime_event(
            event_type="space.occupied",
            entity_id=spot.id,
            payload=_spot_payload(spot),
            entity_version=spot.version,
        )))
        logger.info("Spot OCCUPIED %s v=%d", spot.id, spot.version)


def _spot_payload(spot: SpotDocument) -> dict:
    """Build a full ParkingSpace-compatible dict for Web PubSub broadcast.

    The mobile reducer requires `stall_geometry` for new spaces (never seen
    via /nearby poll), otherwise the event is silently dropped.
    """
    lng, lat = spot.lng, spot.lat
    d = 0.00003  # ~3m box around the point
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
    state = spot.status.upper()  # "open" -> "OPEN", "occupied" -> "OCCUPIED"
    return {
        "id": spot.id,
        "zone_id": spot.segment_id,
        "location": spot.location or {"type": "Point", "coordinates": [lng, lat]},
        "stall_geometry": stall,
        "internal_state": state,
        "last_observed_at": spot.last_seen_at.isoformat() if spot.last_seen_at else None,
        "base_confidence": spot.confidence,
        "version": spot.version,
        "segment_id": spot.segment_id,
        "status": spot.status,
        "gap_count": spot.gap_count,
        "lat": lat,
        "lng": lng,
        "width_meters": spot.width_meters,
        "opened_at": spot.opened_at.isoformat() if spot.opened_at else None,
        "last_seen_at": spot.last_seen_at.isoformat() if spot.last_seen_at else None,
        "occupied_at": spot.occupied_at.isoformat() if spot.occupied_at else None,
    }


def _zone_payload(segment_id: str, lat: float, lng: float, sign_rules: SignPoleReading | None) -> dict:
    """Build a CurbZone-compatible dict for Web PubSub broadcast."""
    d = 0.00005  # ~5m LineString
    geometry = {
        "type": "LineString",
        "coordinates": [[lng - d, lat], [lng + d, lat]],
    }
    sign_rule_id = segment_id
    legal_status = "LEGAL"
    if sign_rules and sign_rules.combined_summary:
        s = sign_rules.combined_summary.lower()
        if "no parking" in s or "no stopping" in s:
            legal_status = "ILLEGAL"
    return {
        "id": segment_id,
        "geometry": geometry,
        "sign_rule_id": sign_rule_id,
        "legal_status_now": legal_status,
        "version": 1,
    }


class SessionState:
    """Per-session tracking state."""
    __slots__ = ("vehicle_tracker", "gap_tracker", "sign_tracker",
                 "confirmed_gap_segments", "last_sign_reading", "last_submission")

    def __init__(self):
        self.vehicle_tracker = VehicleTracker()
        self.gap_tracker = GapTracker()
        self.sign_tracker = SignTracker()
        # Map gap_key -> segment_id for tracking which gaps map to which spots
        self.confirmed_gap_segments: dict[tuple[int, int], str] = {}
        self.last_sign_reading: SignPoleReading | None = None
        self.last_submission: dict | None = None


class Pipeline:
    def __init__(self):
        self._sign_dedup = SignDeduplicator()
        self._spot_mgr = SpotManager()
        self._sessions: dict[str, SessionState] = {}
        self.recent_blocks: deque[dict] = deque(maxlen=50)
        self.mapping_mode: bool = False  # when True, spots are saved as permanent seed

    @property
    def spots_in_memory(self) -> int:
        return self._spot_mgr.spot_count

    def _get_session(self, session_id: str) -> SessionState:
        if session_id not in self._sessions:
            self._sessions[session_id] = SessionState()
        return self._sessions[session_id]

    def cleanup_session(self, session_id: str):
        self._sessions.pop(session_id, None)

    async def process_detections(
        self,
        vehicles: list[VehicleDetection],
        signs: list[SignDetection],
        frame_width: int,
        frame_height: int,
        lat: float,
        lng: float,
        session_id: str,
        heading: float = 0.0,
    ) -> dict:
        """
        Main entry point. Returns dict with frame_result and
        optional confirmed_block.
        """
        session = self._get_session(session_id)
        received_at = datetime.now(UTC).isoformat()
        sorted_vehicles = sorted(vehicles, key=lambda vehicle: vehicle.bbox[0])
        gap_bboxes = list(gap_candidates(
            [(index, vehicle.bbox) for index, vehicle in enumerate(sorted_vehicles, start=1)],
            frame_width, frame_height,
        ).values())
        gap_measurements = [
            GapMeasurement(
                bbox=bbox,
                width_pixels=int(bbox[2] - bbox[0]),
                is_valid_spot=True,
            )
            for bbox in gap_bboxes
        ]

        # --- Sign tracking & reading ---
        sign_pole_reading: SignPoleReading | None = None

        if signs:
            sign_det_dicts = [
                {
                    "bbox": s.bbox,
                    "confidence": s.confidence,
                    "crop_bytes": s.crop_bytes,
                }
                for s in signs
            ]
            all_sign_tracks = session.sign_tracker.update(sign_det_dicts)

            # Add GPS observation to each matched track
            for track in all_sign_tracks:
                if track.time_since_update == 0:
                    bbox_cx = (track.bbox[0] + track.bbox[2]) / 2
                    track.add_gps(lat, lng, heading, bbox_cx, frame_width)

            # Process confirmed tracks that haven't been read yet
            ready_tracks = [t for t in all_sign_tracks if t.needs_reading]
            if ready_tracks:
                sign_pole_reading = await self._process_sign_tracks(
                    ready_tracks, heading
                )
                if sign_pole_reading is not None:
                    session.last_sign_reading = sign_pole_reading
        else:
            session.sign_tracker.update([])

        scene_valid = bool(vehicles or signs)
        confirmed = None
        pipeline_state = "no_scene"
        tracked_gap_infos: list[TrackedGapInfo] = []

        # --- Object tracking (empty frames must age tracks too) ---
        det_dicts = [
            {"bbox": v.bbox, "cls": v.cls, "confidence": v.confidence}
            for v in vehicles
        ]
        confirmed_tracks = session.vehicle_tracker.update(det_dicts)

        # Assign track IDs back to vehicle detections for protocol.
        for vehicle in vehicles:
            best_track_id = None
            best_iou = 0.0
            for track in session.vehicle_tracker.tracks:
                iou = _iou(vehicle.bbox, track.bbox)
                if iou > best_iou:
                    best_iou = iou
                    best_track_id = track.id
            if best_iou > 0.3:
                vehicle.track_id = best_track_id

        # Missed vehicle tracks remain available for matching, but must not
        # count as fresh sightings that keep gaps alive on empty frames.
        visible_tracks = [t for t in confirmed_tracks if t.time_since_update == 0]
        current_tracks = [t for t in session.vehicle_tracker.tracks if t.time_since_update == 0]
        all_gaps, newly_confirmed, expired_confirmed = session.gap_tracker.update(
            visible_tracks, frame_width, frame_height,
            gap_measurements=gap_measurements,
            current_tracks=current_tracks,
        )

        confirmed_keys = session.gap_tracker._confirmed
        for gap in all_gaps:
            median_w = gap.median_width_meters
            tracked_gap_infos.append(TrackedGapInfo(
                left_track_id=gap.left_track_id,
                right_track_id=gap.right_track_id,
                bbox=gap.bbox,
                duration=round(gap.duration, 1),
                confirmed=gap.gap_key in confirmed_keys,
                median_width_meters=round(median_w, 2) if median_w is not None else None,
            ))

        # Remove expired support now, but decide occupancy only after registering
        # this submission's new confirmations for the same segment.
        expired_segments = set()
        for gap in expired_confirmed:
            seg_id = session.confirmed_gap_segments.pop(gap.gap_key, None)
            if seg_id:
                expired_segments.add(seg_id)

        # --- Confirmation: new gaps → open or refresh ---
        if newly_confirmed:
            pipeline_state = "confirmed"
            segment_id = make_road_segment_id(lat, lng, heading)
            current_rules = sign_pole_reading
            sign_rules = (
                current_rules
                if current_rules and current_rules.sign_category not in ("garage", "lot")
                else None
            )
            if sign_rules is None:
                sign_rules = await self._sign_dedup.find_rules_for_segment(
                    segment_id, lat, lng,
                )

            existing_spot = self._spot_mgr.find_by_segment(segment_id)
            if existing_spot is not None:
                asyncio.create_task(_safe(self._spot_mgr.refresh_spot(existing_spot, sign_rules)))
            else:
                best_gap = max(newly_confirmed, key=lambda g: g.duration)
                await self._spot_mgr.open_spot(
                    segment_id=segment_id,
                    lat=lat,
                    lng=lng,
                    gap=best_gap,
                    session_id=session_id,
                    sign_rules=sign_rules,
                    is_seed=self.mapping_mode,
                )
            for gap in newly_confirmed:
                session.confirmed_gap_segments[gap.gap_key] = segment_id

            # Also maintain legacy BlockObservation for backward compatibility.
            confirmed = BlockObservation(
                segment_id=segment_id,
                gap_count=len(newly_confirmed),
                confidence=1.0,
                sign_rules=sign_rules,
                confirmed_at=datetime.utcnow(),
                ttl=-1 if self.mapping_mode else settings.default_ttl_sec,
                lat=lat,
                lng=lng,
                location={"type": "Point", "coordinates": [lng, lat]},
            )
            self.recent_blocks.appendleft(confirmed.model_dump(mode="json"))
            asyncio.create_task(_safe(cosmos.upsert_block(confirmed)))
            asyncio.create_task(_safe(signalr.broadcast_block(confirmed)))
        elif scene_valid:
            # Re-sighting of existing confirmed gaps (still visible).
            for gap in all_gaps:
                if gap.gap_key in confirmed_keys:
                    seg_id = session.confirmed_gap_segments.get(gap.gap_key)
                    if seg_id:
                        existing = self._spot_mgr.find_by_segment(seg_id)
                        if existing and (datetime.utcnow() - existing.last_seen_at).total_seconds() > 10:
                            asyncio.create_task(_safe(self._spot_mgr.refresh_spot(existing)))

            pipeline_state = session.gap_tracker.get_state_string()
            if not pipeline_state or pipeline_state == "no gaps":
                n_tracks = len(visible_tracks)
                pipeline_state = f"tracking {n_tracks} vehicle{'s' if n_tracks != 1 else ''}"

        # A stopped camera may never submit again. Enforce every session's gap
        # timeout before its mapping can count as support for a shared spot.
        for state in self._sessions.values():
            for gap in state.gap_tracker.expire():
                segment_id = state.confirmed_gap_segments.pop(gap.gap_key, None)
                if segment_id:
                    expired_segments.add(segment_id)

        supported_segments = {
            segment for state in self._sessions.values()
            for segment in state.confirmed_gap_segments.values()
        }
        for segment_id in expired_segments - supported_segments:
            await self._spot_mgr.occupy_spot(segment_id)

        previous_empty = (session.last_submission or {}).get("consecutive_empty_submissions", 0)
        session.last_submission = {
            "received_at": received_at,
            "frame_width": frame_width,
            "frame_height": frame_height,
            "vehicle_count": len(vehicles),
            "sign_count": len(signs),
            "visible_confirmed_tracks": len(visible_tracks),
            "candidate_count": len(gap_bboxes),
            "consecutive_empty_submissions": previous_empty + 1 if not scene_valid else 0,
            "pipeline_state": pipeline_state,
        }

        frame_result = FrameResult(
            vehicles=vehicles,
            signs=signs,
            gap_estimate=len(gap_bboxes),
            gap_bboxes=gap_bboxes,
            gap_measurements=gap_measurements,
            sign_rules=sign_pole_reading,
            lat=lat,
            lng=lng,
            raw_detections=[],
            scene_valid=scene_valid,
            pipeline_state=pipeline_state,
            used_segmentation=False,
            used_depth=False,
            tracked_gaps=tracked_gap_infos,
        )

        return {
            "frame_result": frame_result,
            "confirmed_block": confirmed,
        }

    async def _process_sign_tracks(
        self,
        ready_tracks: list[SignTrack],
        heading: float,
    ) -> SignPoleReading | None:
        """
        Triangulate, deduplicate, group into poles, call Claude Vision if needed.
        Returns the SignPoleReading for the most relevant pole, or None.
        """
        result: SignPoleReading | None = None

        poles = group_signs_into_poles(ready_tracks)

        for pole_tracks in poles:
            for t in pole_tracks:
                t.read_requested = True

            # Triangulate using the track with the most GPS observations
            best_track = max(pole_tracks, key=lambda t: len(t.gps_observations))
            observations = [
                {
                    "lat": obs.lat,
                    "lng": obs.lng,
                    "bearing_deg": estimate_sign_bearing(
                        obs.heading, obs.bbox_center_x, obs.frame_w
                    ),
                }
                for obs in best_track.gps_observations
            ]

            est_lat, est_lng, uncertainty = triangulate_sign(observations)
            road_seg_id = make_road_segment_id(est_lat, est_lng, heading)

            # Dedup check
            existing = await self._sign_dedup.find_existing(
                est_lat, est_lng, road_segment_id=road_seg_id,
            )
            if existing is not None:
                pole_reading = existing.pole_reading
                if pole_reading is None:
                    # Cosmos doc existed but had no reading — treat as new
                    pass
                else:
                    for t in pole_tracks:
                        t.read_result = pole_reading
                    existing.last_confirmed = datetime.utcnow()
                    asyncio.create_task(_safe(cosmos.upsert_sign_document(existing)))
                    logger.info("Sign dedup hit at (%.5f, %.5f), reusing %s", est_lat, est_lng, existing.id)
                    if result is None:
                        result = pole_reading
                    continue

            # No existing sign — call Claude Vision once for the whole pole
            best_crop_track = max(pole_tracks, key=lambda t: t.best_crop_confidence)
            pole_reading = await read_sign_pole(best_crop_track.best_crop_bytes)

            for t in pole_tracks:
                t.read_result = pole_reading

            sign_doc = SignDocument(
                id=str(uuid.uuid4()),
                road_segment_id=road_seg_id,
                location={"type": "Point", "coordinates": [est_lng, est_lat]},
                lat=est_lat,
                lng=est_lng,
                uncertainty_m=uncertainty,
                pole_reading=pole_reading,
            )
            self._sign_dedup.register(sign_doc)
            asyncio.create_task(_safe(cosmos.upsert_sign_document(sign_doc)))

            # Broadcast: street signs update zones, garage signs are POIs
            if pole_reading.sign_category in ("garage", "lot"):
                asyncio.create_task(_safe(signalr.broadcast_realtime_event(
                    event_type="garage.detected",
                    entity_id=sign_doc.id,
                    payload={
                        "id": sign_doc.id,
                        "location": sign_doc.location,
                        "lat": est_lat,
                        "lng": est_lng,
                        "name": pole_reading.garage_name,
                        "summary": pole_reading.combined_summary,
                        "price": pole_reading.combined_price,
                        "arrow_direction": pole_reading.arrow_direction,
                        "sign_category": pole_reading.sign_category,
                        "version": 1,
                    },
                )))
                logger.info(
                    "GARAGE sign at (%.5f, %.5f) — %s, arrow=%s, segment=%s",
                    est_lat, est_lng, pole_reading.garage_name or pole_reading.combined_summary,
                    pole_reading.arrow_direction, road_seg_id,
                )
            else:
                asyncio.create_task(_safe(signalr.broadcast_realtime_event(
                    event_type="sign_rule.updated",
                    entity_id=road_seg_id,
                    payload=_zone_payload(road_seg_id, est_lat, est_lng, pole_reading),
                )))
                logger.info(
                    "STREET sign at (%.5f, %.5f) uncertainty=%.1fm, %d signs on pole, segment=%s",
                    est_lat, est_lng, uncertainty, len(pole_reading.signs), road_seg_id,
                )

            if result is None:
                result = pole_reading

        return result


async def _safe(coro):
    """Run a coroutine as fire-and-forget, logging errors instead of crashing."""
    try:
        await coro
    except Exception:
        logger.exception("Background task failed")


# Module-level singleton
_pipeline: Pipeline | None = None


def get_pipeline() -> Pipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = Pipeline()
    return _pipeline
