"""
Full CV pipeline: frame in -> tracked spots + sign rules out.

Orchestrates detector (YOLO-seg + depth), object tracker (IoU-based),
gap tracker (track-pair confirmation), and sign_reader (Claude Vision).
"""

import asyncio
import logging
import time
from collections import deque
from datetime import datetime

from app.config import settings
from app.models import (
    BlockObservation,
    FrameResult,
    GapMeasurement,
    SignRules,
    TrackedGapInfo,
    VehicleDetection,
    SignDetection,
    RawDetection,
)
from app.cv.detector import detect_from_frame_async
from app.cv.tracker import VehicleTracker, GapTracker, _iou
from app.cv.sign_reader import read_sign
from app.azure import cosmos, signalr

logger = logging.getLogger(__name__)


class SessionState:
    """Per-session tracking state."""
    __slots__ = ("vehicle_tracker", "gap_tracker")

    def __init__(self):
        self.vehicle_tracker = VehicleTracker()
        self.gap_tracker = GapTracker()


class Pipeline:
    def __init__(self):
        self._sign_cache: dict[str, SignRules] = {}
        self._sessions: dict[str, SessionState] = {}
        self.recent_blocks: deque[dict] = deque(maxlen=50)

    def _get_session(self, session_id: str) -> SessionState:
        if session_id not in self._sessions:
            self._sessions[session_id] = SessionState()
        return self._sessions[session_id]

    def cleanup_session(self, session_id: str):
        self._sessions.pop(session_id, None)

    async def process_frame(
        self,
        image_bytes: bytes,
        lat: float,
        lng: float,
        session_id: str,
        camera_pitch: float = 0.0,
    ) -> dict:
        """
        Main entry point. Returns dict with frame_result and
        optional confirmed_block.
        """
        session = self._get_session(session_id)
        detections = await detect_from_frame_async(image_bytes, camera_pitch)

        # --- Sign reading (unchanged) ---
        sign_rules: SignRules | None = None
        grid_key = _snap_to_grid(lat, lng)

        if detections["signs"]:
            if grid_key in self._sign_cache:
                sign_rules = self._sign_cache[grid_key]
            else:
                best_sign: SignDetection = max(
                    detections["signs"], key=lambda s: s.confidence
                )
                sign_rules = await read_sign(best_sign.crop_bytes)
                self._sign_cache[grid_key] = sign_rules
                asyncio.create_task(_safe(cosmos.upsert_sign(grid_key, sign_rules, lat=lat, lng=lng)))

        scene_valid = detections["scene_valid"]
        confirmed = None
        pipeline_state = "no_scene"
        tracked_gap_infos: list[TrackedGapInfo] = []

        if scene_valid:
            # --- Object tracking ---
            # Feed accepted vehicle detections to tracker
            det_dicts = [
                {"bbox": v.bbox, "cls": v.cls, "confidence": v.confidence}
                for v in detections["vehicles"]
            ]
            confirmed_tracks = session.vehicle_tracker.update(det_dicts)

            # Assign track IDs back to vehicle detections for protocol
            # Match by IoU (tracks may reorder)
            for vehicle in detections["vehicles"]:
                best_track_id = None
                best_iou = 0.0
                for track in session.vehicle_tracker.tracks:
                    iou = _iou(vehicle.bbox, track.bbox)
                    if iou > best_iou:
                        best_iou = iou
                        best_track_id = track.id
                if best_iou > 0.3:
                    vehicle.track_id = best_track_id

            # --- Gap tracking ---
            frame_w = detections.get("frame_width", 1280)
            frame_h = detections.get("frame_height", 720)

            all_gaps, newly_confirmed = session.gap_tracker.update(
                confirmed_tracks, frame_w, frame_h
            )

            # Build tracked gap info for protocol
            confirmed_keys = session.gap_tracker._confirmed
            for gap in all_gaps:
                tracked_gap_infos.append(TrackedGapInfo(
                    left_track_id=gap.left_track_id,
                    right_track_id=gap.right_track_id,
                    bbox=gap.bbox,
                    duration=round(gap.duration, 1),
                    confirmed=gap.gap_key in confirmed_keys,
                ))

            # --- Confirmation ---
            if newly_confirmed:
                pipeline_state = "confirmed"
                segment_id = _make_segment_id(lat, lng)
                confirmed = BlockObservation(
                    segment_id=segment_id,
                    gap_count=len(newly_confirmed),
                    confidence=1.0,
                    sign_rules=sign_rules,
                    confirmed_at=datetime.utcnow(),
                    ttl=settings.default_ttl_sec,
                    lat=lat,
                    lng=lng,
                    location={"type": "Point", "coordinates": [lng, lat]},
                )
                self.recent_blocks.appendleft(confirmed.model_dump(mode="json"))
                asyncio.create_task(_safe(cosmos.upsert_block(confirmed)))
                asyncio.create_task(_safe(signalr.broadcast_block(confirmed)))
            else:
                pipeline_state = session.gap_tracker.get_state_string()
                if not pipeline_state or pipeline_state == "no gaps":
                    n_tracks = len(confirmed_tracks)
                    pipeline_state = f"tracking {n_tracks} vehicle{'s' if n_tracks != 1 else ''}"
        else:
            # No scene — still run tracker with empty detections to age out tracks
            session.vehicle_tracker.update([])

        frame_result = FrameResult(
            vehicles=detections["vehicles"],
            signs=detections["signs"],
            gap_estimate=detections["gap_estimate"],
            gap_bboxes=detections["gap_bboxes"],
            gap_measurements=detections.get("gap_measurements", []),
            sign_rules=sign_rules,
            lat=lat,
            lng=lng,
            raw_detections=detections["raw_detections"],
            scene_valid=scene_valid,
            pipeline_state=pipeline_state,
            used_segmentation=detections.get("used_segmentation", False),
            used_depth=detections.get("used_depth", False),
            tracked_gaps=tracked_gap_infos,
        )

        return {
            "frame_result": frame_result,
            "confirmed_block": confirmed,
        }


async def _safe(coro):
    """Run a coroutine as fire-and-forget, logging errors instead of crashing."""
    try:
        await coro
    except Exception:
        logger.exception("Background task failed")


def _snap_to_grid(lat: float, lng: float) -> str:
    p = settings.grid_precision
    return f"{round(lat, p)},{round(lng, p)}"


def _make_segment_id(lat: float, lng: float) -> str:
    return _snap_to_grid(lat, lng)


# Module-level singleton
_pipeline: Pipeline | None = None


def get_pipeline() -> Pipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = Pipeline()
    return _pipeline
