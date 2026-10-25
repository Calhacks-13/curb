"""
Detection pipeline: device detections in -> tracked spots + sign rules out.

Orchestrates object tracker (IoU-based), gap tracker (track-pair confirmation),
sign tracker (IoU + GPS accumulation),
sign localizer (triangulation), and sign_reader (Claude Vision).

Spot lifecycle: OPEN -> REFRESHED; OCCUPIED needs observed vehicle evidence.
Unseen spots age into EXPIRED without implying occupancy.
"""

import asyncio
import logging
import json
import hashlib
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
from app.domain.scan_state import persist_spot, utc_iso
from app.domain.sign_rules import assess_reading, has_curb_evidence, merge_curb_readings, reading_identity, rule_text, evaluate_rule_text

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
        reading: SignPoleReading | None = None,
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
                ) and (reading is None or reading_identity(doc.pole_reading) == reading_identity(reading)):
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
                candidate = SignDocument(**document)
                if reading is None or reading_identity(candidate.pole_reading) == reading_identity(reading):
                    return candidate

        return None

    def register(self, sign_doc: SignDocument) -> None:
        self._positions = [position for position in self._positions if position[2] != sign_doc.id]
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
            if not has_curb_evidence(reading):
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
        self._known_spots: dict[str, SpotDocument] = {}
        self.repository = None
        self.transitions: deque[dict] = deque(maxlen=500)
        self._rule_states: dict[str, str] = {}

    def record(self, event: str, reason: str, spot: SpotDocument | None = None, **details):
        entry = {"occurred_at": datetime.now(UTC).isoformat(), "event": event, "reason": reason, **details}
        if spot is not None:
            entry.update(spot_id=spot.id, segment_id=spot.segment_id, status=spot.status, version=spot.version)
        self.transitions.append(entry)
        logging.getLogger("uvicorn.error.curb.lifecycle").info("cv_transition %s", json.dumps(entry))

    async def _persist(self, spot, now: datetime | None = None):
        await cosmos.upsert_spot(spot)
        if self.repository is not None:
            await persist_spot(self.repository, spot, now)
        self._rule_states[spot.id] = evaluate_rule_text(rule_text(spot.sign_rules), now)[0]
        self._known_spots[spot.segment_id] = spot
        # Persisted identities can be recovered after evicting old inactive records.
        if len(self._known_spots) > 1000:
            retired = next((key for key in self._known_spots if key not in self._spots), None)
            if retired is not None:
                self._known_spots.pop(retired)

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
        previous = self._known_spots.get(segment_id)
        if previous is None:
            stored = await cosmos.get_spot_by_segment(segment_id)
            if stored is not None:
                previous = SpotDocument.model_validate(stored)
        is_seed = is_seed or bool(previous and previous.is_seed)
        spot = SpotDocument(
            id=previous.id if previous else f"spot_{uuid.uuid5(uuid.NAMESPACE_URL, 'curb:space:' + segment_id)}",
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
            version=previous.version + 1 if previous else 1,
            ttl=-1 if is_seed else settings.default_ttl_sec,
            source_session_id=session_id,
            is_seed=is_seed,
            last_transition_reason="gap_reobserved" if previous else "gap_confirmed",
        )
        self._spots[segment_id] = spot
        await self._persist(spot)
        asyncio.create_task(_safe(signalr.broadcast_realtime_event(
            event_type="space.opened",
            entity_id=spot.id,
            payload=_spot_payload(spot),
            entity_version=spot.version,
        )))

        # Broadcast zone so mobile has legal_status context for the new spot
        zone_payload = _zone_payload(segment_id, lat, lng, sign_rules, version=spot.version)
        asyncio.create_task(_safe(signalr.broadcast_realtime_event(
            event_type="sign_rule.updated",
            entity_id=segment_id,
            payload=zone_payload,
            entity_version=spot.version,
        )))

        logger.info("Spot OPENED %s at (%.5f, %.5f) segment=%s", spot.id, lat, lng, segment_id)
        self.record("space.opened", spot.last_transition_reason, spot, session_id=session_id)
        return spot

    async def refresh_spot(
        self,
        spot: SpotDocument,
        sign_rules: SignPoleReading | None = None,
    ) -> None:
        """Re-sighting of an existing OPEN spot — bump version, reset freshness."""
        spot.last_seen_at = datetime.utcnow()
        spot.version += 1
        spot.last_transition_reason = "gap_reobserved"
        if sign_rules is not None:
            spot.sign_rules = sign_rules
        self._spots[spot.segment_id] = spot
        await self._persist(spot)
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
                payload=_zone_payload(spot.segment_id, spot.lat, spot.lng, sign_rules, version=spot.version),
                entity_version=spot.version,
            )))
        logger.debug("Spot REFRESHED %s v=%d", spot.id, spot.version)
        self.record("space.refreshed", spot.last_transition_reason, spot)

    async def occupy_spot(self, segment_id: str, *, reason: str = "vehicle_observed") -> None:
        """Only positive repeated vehicle evidence can mark a spot occupied."""
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
        spot.last_transition_reason = reason
        await self._persist(spot)
        asyncio.create_task(_safe(signalr.broadcast_realtime_event(
            event_type="space.occupied",
            entity_id=spot.id,
            payload=_spot_payload(spot),
            entity_version=spot.version,
        )))
        logger.info("Spot OCCUPIED %s v=%d", spot.id, spot.version)
        self.record("space.occupied", reason, spot)

    async def update_rules(self, spot: SpotDocument, reading: SignPoleReading, *, reason="validated_sign_rule_updated", now=None):
        spot.sign_rules = reading.model_copy(deep=True)
        spot.version += 1
        spot.last_transition_reason = reason
        await self._persist(spot, now)
        asyncio.create_task(_safe(signalr.broadcast_realtime_event(
            "space.refreshed", spot.id, _spot_payload(spot), spot.version,
        )))
        asyncio.create_task(_safe(signalr.broadcast_realtime_event(
            "sign_rule.updated", spot.segment_id,
            _zone_payload(spot.segment_id, spot.lat, spot.lng, reading, version=spot.version, now=now), spot.version,
        )))
        self.record("sign_rule.updated", spot.last_transition_reason, spot)

    async def refresh_rule_times(self, now: datetime | None = None):
        for spot in list(self._spots.values()):
            status, _ = evaluate_rule_text(rule_text(spot.sign_rules), now)
            if spot.sign_rules is not None and status != self._rule_states.get(spot.id, status):
                await self.update_rules(spot, spot.sign_rules, reason="rule_time_window_changed", now=now)

    async def expire_stale(self, now: datetime | None = None):
        now = now or datetime.utcnow()
        if now.tzinfo is not None:
            now = now.astimezone(UTC).replace(tzinfo=None)
        for segment_id, spot in list(self._spots.items()):
            observed = spot.last_seen_at.replace(tzinfo=None)
            if spot.is_seed or (now - observed).total_seconds() <= settings.spot_freshness_sec:
                continue
            self._spots.pop(segment_id)
            spot.status = "expired"
            spot.version += 1
            spot.last_transition_reason = "freshness_expired"
            await self._persist(spot)
            asyncio.create_task(_safe(signalr.broadcast_realtime_event(
                "space.expired", spot.id, _spot_payload(spot), spot.version,
            )))
            self.record("space.expired", "freshness_expired", spot)


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
    state = "UNKNOWN" if spot.status == "expired" else spot.status.upper()
    return {
        "id": spot.id,
        "zone_id": spot.segment_id,
        "location": spot.location or {"type": "Point", "coordinates": [lng, lat]},
        "stall_geometry": stall,
        "internal_state": state,
        "last_observed_at": utc_iso(spot.last_seen_at),
        "base_confidence": spot.confidence,
        "version": spot.version,
        "segment_id": spot.segment_id,
        "status": spot.status,
        "gap_count": spot.gap_count,
        "lat": lat,
        "lng": lng,
        "width_meters": spot.width_meters,
        "opened_at": utc_iso(spot.opened_at),
        "last_seen_at": utc_iso(spot.last_seen_at),
        "occupied_at": utc_iso(spot.occupied_at),
    }


def _zone_payload(segment_id: str, lat: float, lng: float, sign_rules: SignPoleReading | None, *, version: int = 1, now: datetime | None = None) -> dict:
    """Build a CurbZone-compatible dict for Web PubSub broadcast."""
    d = 0.00005  # ~5m LineString
    geometry = {
        "type": "LineString",
        "coordinates": [[lng - d, lat], [lng + d, lat]],
    }
    sign_rule_id = f"scan-rule:{segment_id}"
    legal_status, next_change = evaluate_rule_text(rule_text(sign_rules), now)
    return {
        "id": segment_id,
        "geometry": geometry,
        "sign_rule_id": sign_rule_id,
        "legal_status_now": legal_status,
        "next_change_at": utc_iso(next_change),
        "version": version,
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
        self._reading_cache: dict[tuple[str, str], SignPoleReading] = {}
        self._lock = asyncio.Lock()
        self.mapping_mode: bool = False  # when True, spots are saved as permanent seed

    @property
    def spots_in_memory(self) -> int:
        return self._spot_mgr.spot_count

    def _get_session(self, session_id: str) -> SessionState:
        if session_id not in self._sessions:
            self._sessions[session_id] = SessionState()
        return self._sessions[session_id]

    def cleanup_session(self, session_id: str):
        state = self._sessions.pop(session_id, None)
        if state is not None:
            for gap in state.gap_tracker.invalidate("session_ended"):
                self._record_gap_loss(session_id, state, gap)

    def set_repository(self, repository):
        self._spot_mgr.repository = repository

    def _record_gap_loss(self, session_id, state, gap):
        segment_id = state.confirmed_gap_segments.pop(gap.gap_key, None)
        spot = self._spot_mgr.find_by_segment(segment_id) if segment_id else None
        self._spot_mgr.record(
            "gap.lost", gap.loss_reason or "observation_timeout", spot,
            session_id=session_id, gap_key=list(gap.gap_key),
            blocker_id=gap.blocker_id, evidence_hits=gap.blocked_hits,
            evidence_duration_sec=(gap.blocked_last_seen - gap.blocked_since)
            if gap.blocked_last_seen is not None and gap.blocked_since is not None else 0,
        )
        return segment_id

    async def maintain(self, now: datetime | None = None):
        async with self._lock:
            for session_id, state in self._sessions.items():
                for gap in state.gap_tracker.expire():
                    self._record_gap_loss(session_id, state, gap)
            await self._spot_mgr.expire_stale(now)
            await self._spot_mgr.refresh_rule_times(now)

    async def process_detections(self, *args, **kwargs):
        # Sign reading and persistence await I/O; serialize lifecycle mutations
        # across phones and the maintenance task to preserve event versions.
        async with self._lock:
            return await self._process_detections(*args, **kwargs)

    async def _process_detections(
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
        await self._spot_mgr.expire_stale()
        feedback_spot = None
        viewpoint_losses = []
        previous = session.last_submission
        if previous is not None:
            heading_change = abs((heading - previous["heading"] + 180) % 360 - 180)
            moved = _haversine_m(lat, lng, previous["lat"], previous["lng"])
            changed_size = (frame_width, frame_height) != (previous["frame_width"], previous["frame_height"])
            if changed_size or heading_change > settings.occupancy_max_heading_change or moved > settings.occupancy_max_motion_m:
                viewpoint_losses = session.gap_tracker.invalidate("camera_view_changed")
                session.vehicle_tracker.reset()

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

        expired_confirmed = viewpoint_losses + expired_confirmed
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
        occupied_segments = set()
        for gap in expired_confirmed:
            seg_id = self._record_gap_loss(session_id, session, gap)
            if seg_id and gap.loss_reason == "vehicle_observed":
                occupied_segments.add(seg_id)
        for gap in all_gaps:
            if gap.blocked_hits == 1:
                seg_id = session.confirmed_gap_segments.get(gap.gap_key)
                self._spot_mgr.record("occupancy.pending", "vehicle_in_gap", self._spot_mgr.find_by_segment(seg_id),
                                      session_id=session_id, gap_key=list(gap.gap_key), blocker_id=gap.blocker_id)

        # --- Confirmation: new gaps → open or refresh ---
        if newly_confirmed:
            pipeline_state = "confirmed"
            segment_id = make_road_segment_id(lat, lng, heading)
            current_rules = sign_pole_reading
            sign_rules = (
                current_rules
                if has_curb_evidence(current_rules)
                else None
            )
            if sign_rules is None:
                sign_rules = await self._sign_dedup.find_rules_for_segment(
                    segment_id, lat, lng,
                )

            existing_spot = self._spot_mgr.find_by_segment(segment_id)
            if existing_spot is not None:
                await self._spot_mgr.refresh_spot(existing_spot, sign_rules)
                feedback_spot = existing_spot
            else:
                best_gap = max(newly_confirmed, key=lambda g: g.duration)
                feedback_spot = await self._spot_mgr.open_spot(
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
                if gap.visible and gap.gap_key in confirmed_keys:
                    seg_id = session.confirmed_gap_segments.get(gap.gap_key)
                    if seg_id:
                        existing = self._spot_mgr.find_by_segment(seg_id)
                        if existing and (datetime.utcnow() - existing.last_seen_at).total_seconds() > 10:
                            await self._spot_mgr.refresh_spot(existing)
                            feedback_spot = existing

            pipeline_state = session.gap_tracker.get_state_string()
            if not pipeline_state or pipeline_state == "no gaps":
                n_tracks = len(visible_tracks)
                pipeline_state = f"tracking {n_tracks} vehicle{'s' if n_tracks != 1 else ''}"

        # A stopped camera may never submit again. Enforce every session's gap
        # timeout before its mapping can count as support for a shared spot.
        for other_session_id, state in self._sessions.items():
            for gap in state.gap_tracker.expire():
                self._record_gap_loss(other_session_id, state, gap)

        supported_segments = {
            segment for state in self._sessions.values()
            for key, segment in state.confirmed_gap_segments.items()
            if (gap := state.gap_tracker._gaps.get(key)) is not None and gap.visible
        }
        for segment_id in occupied_segments - supported_segments:
            await self._spot_mgr.occupy_spot(segment_id)
        for segment_id in occupied_segments & supported_segments:
            self._spot_mgr.record("occupancy.suppressed", "open_observation_from_another_gap",
                                  self._spot_mgr.find_by_segment(segment_id))

        previous_empty = (session.last_submission or {}).get("consecutive_empty_submissions", 0)
        session.last_submission = {
            "received_at": received_at,
            "lat": lat, "lng": lng, "heading": heading,
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
            sign_feedback=[{
                "track_id": track.id,
                "bbox": track.bbox,
                "observations": track.hits,
                "required_observations": settings.sign_track_confirm_hits,
                "state": (
                    "unavailable" if not settings.anthropic_api_key and track.read_result is None
                    else "gathering" if track.read_result is None
                    else "uncertain" if track.read_result.flagged
                    else "read"
                ),
                "reading": track.read_result.model_dump(mode="json") if track.read_result else None,
            } for track in session.sign_tracker.tracks if track.time_since_update == 0],
        )

        return {
            "frame_result": frame_result,
            "confirmed_block": confirmed,
            "confirmed_spot": feedback_spot.model_copy(deep=True) if feedback_spot else None,
        }

    async def _process_sign_tracks(
        self, ready_tracks: list[SignTrack], heading: float,
    ) -> SignPoleReading | None:
        # Bound external reading work per submission. Each individual sign crop
        # is read: selecting only the highest-confidence crop discarded the
        # parking sign when a street-name plate shared the same pole.
        selected = sorted(ready_tracks, key=lambda track: track.best_crop_area, reverse=True)[:2]
        result = None
        for pole_tracks in group_signs_into_poles(selected):
            best_track = max(pole_tracks, key=lambda track: len(track.gps_observations))
            observations = [{
                "lat": obs.lat, "lng": obs.lng,
                "bearing_deg": estimate_sign_bearing(obs.heading, obs.bbox_center_x, obs.frame_w),
            } for obs in best_track.gps_observations]
            est_lat, est_lng, uncertainty = triangulate_sign(observations)
            road_seg_id = make_road_segment_id(est_lat, est_lng, heading)

            async def read_track(track):
                track.read_requested = True
                track.read_attempts += 1
                track.read_confidence = track.best_crop_confidence
                track.read_area = track.best_crop_area
                track.read_hits = track.hits
                key = (hashlib.sha256(track.best_crop_bytes).hexdigest(), road_seg_id.rsplit(",", 1)[-1])
                reading = self._reading_cache.get(key)
                if reading is None:
                    reading = assess_reading(await read_sign_pole(track.best_crop_bytes))
                    if not reading.flagged:
                        self._reading_cache[key] = reading.model_copy(deep=True)
                        if len(self._reading_cache) > 256:
                            self._reading_cache.pop(next(iter(self._reading_cache)))
                track.read_result = reading.model_copy(deep=True)
                return reading

            readings = await asyncio.gather(*(read_track(track) for track in pole_tracks))
            parking = merge_curb_readings(readings)
            pole_reading = parking or readings[0]
            if result is None or has_curb_evidence(pole_reading) and not has_curb_evidence(result):
                result = pole_reading
            if parking is None and pole_reading.sign_category not in ("garage", "lot"):
                self._spot_mgr.record("sign.rejected", "not_a_validated_curb_rule", category=pole_reading.sign_category,
                                      summary=pole_reading.combined_summary, score=pole_reading.confidence_score)
                continue

            # Location alone cannot identify a sign: two different plates on
            # the same pole may have entirely different meanings.
            existing = await self._sign_dedup.find_existing(
                est_lat, est_lng, road_segment_id=road_seg_id, reading=pole_reading,
            )
            now = datetime.utcnow()
            sign_doc = existing or SignDocument(
                id=str(uuid.uuid4()), road_segment_id=road_seg_id,
                location={"type": "Point", "coordinates": [est_lng, est_lat]},
                lat=est_lat, lng=est_lng, uncertainty_m=uncertainty, pole_reading=pole_reading,
            )
            sign_doc.pole_reading = pole_reading
            sign_doc.last_confirmed = now
            self._sign_dedup.register(sign_doc)
            await cosmos.upsert_sign_document(sign_doc)
            self._spot_mgr.record("sign.read", "curb_rule_validated" if parking else "parking_poi", sign_id=sign_doc.id,
                                  summary=pole_reading.combined_summary, score=pole_reading.confidence_score)
            if parking is not None:
                # Correct already-open spots without pretending the gap was
                # reobserved. Rule updates must not extend availability freshness.
                for spot in list(self._spot_mgr._spots.values()):
                    resolved = await self._sign_dedup.find_rules_for_segment(spot.segment_id, spot.lat, spot.lng)
                    if resolved is not None and resolved != spot.sign_rules:
                        await self._spot_mgr.update_rules(spot, resolved)
                asyncio.create_task(_safe(signalr.broadcast_realtime_event(
                    "sign_rule.updated", road_seg_id, _zone_payload(road_seg_id, est_lat, est_lng, parking),
                )))
            else:
                asyncio.create_task(_safe(signalr.broadcast_realtime_event(
                    "garage.detected", sign_doc.id, {
                        "id": sign_doc.id, "location": sign_doc.location, "lat": sign_doc.lat, "lng": sign_doc.lng,
                        "name": pole_reading.garage_name, "summary": pole_reading.combined_summary,
                        "price": pole_reading.combined_price, "arrow_direction": pole_reading.arrow_direction,
                        "sign_category": pole_reading.sign_category, "version": 1,
                    },
                )))
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
