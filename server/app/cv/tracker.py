"""
Lightweight multi-object tracker using IoU matching.

Assigns persistent track IDs to YOLO detections across frames.
No external dependencies beyond numpy — uses greedy IoU matching.
"""

import time
import numpy as np

from app.config import settings


LEFT_FRAME_ID = -1
RIGHT_FRAME_ID = -2


def gap_candidates(
    boundaries: list[tuple[int, list[float]]], frame_width: int, frame_height: int,
) -> dict[tuple[int, int], list[float]]:
    """Pixel openings between ordered real vehicles and bounded frame edges.

    Frame boundaries never create a candidate without a real vehicle. Merge
    overlapping horizontal extents so a contained box cannot expose false space.
    """
    if not boundaries:
        return {}
    minimum = frame_width * settings.min_gap_fraction
    edge_maximum = frame_width * settings.max_edge_gap_fraction
    candidates = {}
    first_id, first_bbox = boundaries[0]
    if minimum <= first_bbox[0] <= edge_maximum:
        candidates[(LEFT_FRAME_ID, first_id)] = [0, 0, first_bbox[0], frame_height]
    right_id, right_edge = first_id, first_bbox[2]
    for track_id, bbox in boundaries[1:]:
        if bbox[0] - right_edge >= minimum:
            candidates[(right_id, track_id)] = [right_edge, 0, bbox[0], frame_height]
        if bbox[2] > right_edge:
            right_id, right_edge = track_id, bbox[2]
    if minimum <= frame_width - right_edge <= edge_maximum:
        candidates[(right_id, RIGHT_FRAME_ID)] = [right_edge, 0, frame_width, frame_height]
    return candidates


class Track:
    """Single tracked object."""
    __slots__ = (
        "id", "bbox", "cls", "confidence",
        "hits", "age", "time_since_update", "first_seen",
    )

    _next_id = 1

    def __init__(self, bbox: list[float], cls: str, confidence: float):
        self.id = Track._next_id
        Track._next_id += 1
        self.bbox = bbox
        self.cls = cls
        self.confidence = confidence
        self.hits = 1
        self.age = 1
        self.time_since_update = 0
        self.first_seen = time.monotonic()

    def update(self, bbox: list[float], cls: str, confidence: float):
        self.bbox = bbox
        self.cls = cls
        self.confidence = confidence
        self.hits += 1
        self.time_since_update = 0

    def mark_missed(self):
        self.time_since_update += 1
        self.age += 1

    @property
    def is_confirmed(self) -> bool:
        return self.hits >= settings.track_confirm_hits

    @property
    def is_dead(self) -> bool:
        return self.time_since_update > settings.track_max_age


def _iou(bbox_a: list[float], bbox_b: list[float]) -> float:
    """Compute IoU between two [x1, y1, x2, y2] bboxes."""
    x1 = max(bbox_a[0], bbox_b[0])
    y1 = max(bbox_a[1], bbox_b[1])
    x2 = min(bbox_a[2], bbox_b[2])
    y2 = min(bbox_a[3], bbox_b[3])

    inter = max(0, x2 - x1) * max(0, y2 - y1)
    if inter == 0:
        return 0.0

    area_a = (bbox_a[2] - bbox_a[0]) * (bbox_a[3] - bbox_a[1])
    area_b = (bbox_b[2] - bbox_b[0]) * (bbox_b[3] - bbox_b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


class VehicleTracker:
    """
    Multi-object tracker for vehicles.

    Per-session: each phone stream gets its own tracker instance.
    Uses greedy IoU matching — sufficient at 2-3 fps with relatively
    static street scenes.
    """

    def __init__(self):
        self.tracks: list[Track] = []

    def update(self, detections: list[dict]) -> list[Track]:
        """
        Match new detections to existing tracks, return all active tracks.

        detections: list of {"bbox": [x1,y1,x2,y2], "cls": str, "confidence": float}
        """
        if not self.tracks:
            # First frame — create tracks for all detections
            for det in detections:
                self.tracks.append(Track(det["bbox"], det["cls"], det["confidence"]))
            return [t for t in self.tracks if t.is_confirmed]

        if not detections:
            # No detections — mark all tracks as missed
            for track in self.tracks:
                track.mark_missed()
            self.tracks = [t for t in self.tracks if not t.is_dead]
            return [t for t in self.tracks if t.is_confirmed]

        # Compute IoU matrix: tracks x detections
        n_tracks = len(self.tracks)
        n_dets = len(detections)
        iou_matrix = np.zeros((n_tracks, n_dets), dtype=np.float32)

        for i, track in enumerate(self.tracks):
            for j, det in enumerate(detections):
                iou_matrix[i, j] = _iou(track.bbox, det["bbox"])

        # Greedy matching by descending IoU
        matched_tracks = set()
        matched_dets = set()

        # Flatten and sort by IoU descending
        indices = np.dstack(np.unravel_index(
            np.argsort(iou_matrix.ravel())[::-1], iou_matrix.shape
        ))[0]

        for i, j in indices:
            if i in matched_tracks or j in matched_dets:
                continue
            if iou_matrix[i, j] < settings.track_iou_threshold:
                break  # remaining are below threshold
            # Match
            det = detections[j]
            self.tracks[i].update(det["bbox"], det["cls"], det["confidence"])
            self.tracks[i].age += 1
            matched_tracks.add(i)
            matched_dets.add(j)

        # Mark unmatched tracks as missed
        for i in range(n_tracks):
            if i not in matched_tracks:
                self.tracks[i].mark_missed()

        # Create new tracks for unmatched detections
        for j in range(n_dets):
            if j not in matched_dets:
                det = detections[j]
                self.tracks.append(Track(det["bbox"], det["cls"], det["confidence"]))

        # Remove dead tracks
        self.tracks = [t for t in self.tracks if not t.is_dead]

        return [t for t in self.tracks if t.is_confirmed]

    def reset(self):
        self.tracks.clear()
        Track._next_id = 1


class TrackedGap:
    """A gap between real vehicle IDs or one virtual frame boundary."""
    __slots__ = (
        "left_track_id", "right_track_id", "bbox", "first_seen", "last_seen",
        "_width_samples",
    )

    _MAX_WIDTH_SAMPLES = 10

    def __init__(self, left_id: int, right_id: int, bbox: list[float]):
        self.left_track_id = left_id
        self.right_track_id = right_id
        self.bbox = bbox
        self.first_seen = time.monotonic()
        self.last_seen = time.monotonic()
        self._width_samples: list[float] = []

    def add_width_sample(self, width_m: float):
        """Record a gap width measurement for multi-frame averaging."""
        self._width_samples.append(width_m)
        if len(self._width_samples) > self._MAX_WIDTH_SAMPLES:
            self._width_samples.pop(0)

    @property
    def median_width_meters(self) -> float | None:
        if not self._width_samples:
            return None
        sorted_s = sorted(self._width_samples)
        n = len(sorted_s)
        if n % 2 == 1:
            return sorted_s[n // 2]
        return (sorted_s[n // 2 - 1] + sorted_s[n // 2]) / 2.0

    @property
    def duration(self) -> float:
        return self.last_seen - self.first_seen

    @property
    def gap_key(self) -> tuple[int, int]:
        return (self.left_track_id, self.right_track_id)


class GapTracker:
    """
    Tracks gaps between vehicles and bounded frame edges using stable IDs.

    A gap is "confirmed" when the same pair of track IDs has had a gap
    between them for >= confirmation_sec seconds continuously.
    """

    def __init__(self):
        # gap_key (left_id, right_id) -> TrackedGap
        self._gaps: dict[tuple[int, int], TrackedGap] = {}
        self._confirmed: set[tuple[int, int]] = set()

    def update(
        self,
        confirmed_tracks: list[Track],
        frame_width: int,
        frame_height: int,
        gap_measurements: list | None = None,
        current_tracks: list[Track] | None = None,
    ) -> tuple[list[TrackedGap], list[TrackedGap], list[TrackedGap]]:
        """
        Compute gaps from sorted tracks, match to existing tracked gaps.
        Optionally ingest per-frame gap width measurements for multi-frame averaging.

        Returns (all_gaps, newly_confirmed_gaps, expired_confirmed_gaps).
        """
        now = time.monotonic()
        # Retire evidence that timed out during a submission hiatus before
        # matching can refresh last_seen for the same vehicle identities.
        expired_confirmed = self._expire_old(now)

        if len(confirmed_tracks) < 1:
            return [], [], expired_confirmed

        # Fresh unconfirmed vehicles block openings immediately, but cannot
        # anchor their own gap until the normal vehicle hit threshold is met.
        blockers = current_tracks if current_tracks is not None else confirmed_tracks
        sorted_tracks = sorted(blockers, key=lambda track: track.bbox[0])
        eligible_ids = {track.id for track in confirmed_tracks} | {LEFT_FRAME_ID, RIGHT_FRAME_ID}
        current_gaps = {
            key: bbox for key, bbox in gap_candidates(
                [(track.id, track.bbox) for track in sorted_tracks], frame_width, frame_height,
            ).items() if set(key) <= eligible_ids
        }

        # Match current gaps to tracked gaps
        active_keys = set()
        for key, bbox in current_gaps.items():
            active_keys.add(key)
            if key in self._gaps:
                # Update existing gap
                self._gaps[key].bbox = bbox
                self._gaps[key].last_seen = now
            else:
                # New gap
                self._gaps[key] = TrackedGap(key[0], key[1], bbox)

        # Ingest width measurements into the matching tracked gaps
        if gap_measurements:
            self._ingest_measurements(current_gaps, gap_measurements)

        # Expire gaps not seen this frame
        visible_track_ids = {track.id for track in blockers} | {LEFT_FRAME_ID, RIGHT_FRAME_ID}
        expired_confirmed.extend(self._expire_old(now, active_keys, visible_track_ids))

        # Check for newly confirmed gaps
        all_gaps = list(self._gaps.values())
        newly_confirmed = []
        for gap in all_gaps:
            if gap.gap_key in active_keys and gap.gap_key not in self._confirmed:
                if gap.duration >= settings.gap_confirm_sec:
                    self._confirmed.add(gap.gap_key)
                    newly_confirmed.append(gap)

        return all_gaps, newly_confirmed, expired_confirmed

    def _ingest_measurements(self, current_gaps, gap_measurements):
        """Match detector gap_measurements to tracked gaps by bbox overlap and record width samples."""
        gap_keys_by_bbox = list(current_gaps.items())
        for gm in gap_measurements:
            if gm.width_meters is None:
                continue
            # Find the tracked gap whose bbox best overlaps this measurement's bbox
            best_key = None
            best_overlap = 0.0
            gm_x1, gm_x2 = gm.bbox[0], gm.bbox[2]
            for key, bbox in gap_keys_by_bbox:
                x1, x2 = bbox[0], bbox[2]
                overlap = max(0, min(gm_x2, x2) - max(gm_x1, x1))
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_key = key
            if best_key and best_key in self._gaps:
                self._gaps[best_key].add_width_sample(gm.width_meters)

    def _expire_old(
        self,
        now: float,
        active_keys: set | None = None,
        visible_track_ids: set[int] | None = None,
    ) -> list[TrackedGap]:
        """Remove gaps not seen recently. Returns expired gaps that were confirmed."""
        dead = []
        for key, gap in self._gaps.items():
            # Missing boundaries may be a temporary detection dropout. Only
            # invalidate geometry immediately when both boundaries are visible;
            # otherwise retain the gap until its last real sighting times out.
            if (active_keys is not None and key not in active_keys
                    and visible_track_ids is not None
                    and set(key) <= visible_track_ids):
                dead.append(key)
            elif now - gap.last_seen > settings.gap_expire_sec:
                dead.append(key)
        expired_confirmed = []
        for key in dead:
            if key in self._confirmed:
                gap = self._gaps.get(key)
                if gap is not None:
                    expired_confirmed.append(gap)
            self._gaps.pop(key, None)
            self._confirmed.discard(key)
        return expired_confirmed

    def expire(self) -> list[TrackedGap]:
        """Expire timed-out gaps without requiring another detection from this session."""
        return self._expire_old(time.monotonic())

    def get_state_string(self) -> str:
        """Human-readable state for debug panel."""
        if not self._gaps:
            return "no gaps"
        parts = []
        for gap in self._gaps.values():
            dur = gap.duration
            confirmed = gap.gap_key in self._confirmed
            status = "confirmed" if confirmed else f"{dur:.1f}s/{settings.gap_confirm_sec}s"
            left = "left edge" if gap.left_track_id == LEFT_FRAME_ID else f"T{gap.left_track_id}"
            right = "right edge" if gap.right_track_id == RIGHT_FRAME_ID else f"T{gap.right_track_id}"
            parts.append(f"{left}-{right}: {status}")
        return " | ".join(parts)

    def reset(self):
        self._gaps.clear()
        self._confirmed.clear()


# ---------------------------------------------------------------------------
# Sign Tracking
# ---------------------------------------------------------------------------

class GPSObservation:
    """Single GPS observation of a sign from a frame."""
    __slots__ = ("lat", "lng", "heading", "bbox_center_x", "frame_w")

    def __init__(self, lat: float, lng: float, heading: float, bbox_center_x: float, frame_w: float):
        self.lat = lat
        self.lng = lng
        self.heading = heading
        self.bbox_center_x = bbox_center_x
        self.frame_w = frame_w


class SignTrack:
    """Single tracked sign detection."""
    __slots__ = (
        "id", "bbox", "confidence",
        "hits", "time_since_update",
        "best_crop_bytes", "best_crop_confidence",
        "gps_observations", "read_result", "read_requested",
    )

    _next_id = 1

    def __init__(self, bbox: list[float], confidence: float, crop_bytes: bytes):
        self.id = SignTrack._next_id
        SignTrack._next_id += 1
        self.bbox = bbox
        self.confidence = confidence
        self.hits = 1
        self.time_since_update = 0
        self.best_crop_bytes = crop_bytes
        self.best_crop_confidence = confidence
        self.gps_observations: list[GPSObservation] = []
        self.read_result = None  # Will hold SignPoleReading once read
        self.read_requested = False

    def update(self, bbox: list[float], confidence: float, crop_bytes: bytes):
        self.bbox = bbox
        self.confidence = confidence
        self.hits += 1
        self.time_since_update = 0
        if confidence > self.best_crop_confidence:
            self.best_crop_bytes = crop_bytes
            self.best_crop_confidence = confidence

    def add_gps(self, lat: float, lng: float, heading: float, bbox_center_x: float, frame_w: float):
        self.gps_observations.append(GPSObservation(lat, lng, heading, bbox_center_x, frame_w))

    def mark_missed(self):
        self.time_since_update += 1

    @property
    def is_confirmed(self) -> bool:
        return self.hits >= settings.sign_track_confirm_hits

    @property
    def is_dead(self) -> bool:
        return self.time_since_update > settings.track_max_age

    @property
    def needs_reading(self) -> bool:
        return self.is_confirmed and not self.read_requested


class SignTracker:
    """
    Multi-object tracker for signs. Same greedy IoU matching as VehicleTracker.
    """

    def __init__(self):
        self.tracks: list[SignTrack] = []

    def update(self, detections: list[dict]) -> list[SignTrack]:
        """
        Match new sign detections to existing tracks, return all active tracks.

        detections: list of {"bbox": [x1,y1,x2,y2], "confidence": float, "crop_bytes": bytes}
        """
        if not self.tracks:
            for det in detections:
                self.tracks.append(SignTrack(det["bbox"], det["confidence"], det["crop_bytes"]))
            return list(self.tracks)

        if not detections:
            for track in self.tracks:
                track.mark_missed()
            self.tracks = [t for t in self.tracks if not t.is_dead]
            return list(self.tracks)

        n_tracks = len(self.tracks)
        n_dets = len(detections)
        iou_matrix = np.zeros((n_tracks, n_dets), dtype=np.float32)

        for i, track in enumerate(self.tracks):
            for j, det in enumerate(detections):
                iou_matrix[i, j] = _iou(track.bbox, det["bbox"])

        matched_tracks = set()
        matched_dets = set()

        indices = np.dstack(np.unravel_index(
            np.argsort(iou_matrix.ravel())[::-1], iou_matrix.shape
        ))[0]

        for i, j in indices:
            if i in matched_tracks or j in matched_dets:
                continue
            if iou_matrix[i, j] < settings.track_iou_threshold:
                break
            det = detections[j]
            self.tracks[i].update(det["bbox"], det["confidence"], det["crop_bytes"])
            matched_tracks.add(i)
            matched_dets.add(j)

        for i in range(n_tracks):
            if i not in matched_tracks:
                self.tracks[i].mark_missed()

        for j in range(n_dets):
            if j not in matched_dets:
                det = detections[j]
                self.tracks.append(SignTrack(det["bbox"], det["confidence"], det["crop_bytes"]))

        self.tracks = [t for t in self.tracks if not t.is_dead]
        return list(self.tracks)

    def reset(self):
        self.tracks.clear()
        SignTrack._next_id = 1


def group_signs_into_poles(sign_tracks: list[SignTrack]) -> list[list[SignTrack]]:
    """
    Group vertically-aligned, horizontally-close sign tracks into pole clusters.

    Signs on the same pole are typically stacked vertically with similar x-centers.
    """
    if not sign_tracks:
        return []

    # Sort by x-center
    sorted_tracks = sorted(sign_tracks, key=lambda t: (t.bbox[0] + t.bbox[2]) / 2)

    poles: list[list[SignTrack]] = []
    current_pole = [sorted_tracks[0]]

    for track in sorted_tracks[1:]:
        prev = current_pole[-1]
        prev_cx = (prev.bbox[0] + prev.bbox[2]) / 2
        curr_cx = (track.bbox[0] + track.bbox[2]) / 2
        prev_width = prev.bbox[2] - prev.bbox[0]
        curr_width = track.bbox[2] - track.bbox[0]

        # Same pole if x-centers are within the average width of the two signs
        threshold = (prev_width + curr_width) / 2
        if abs(curr_cx - prev_cx) <= threshold:
            current_pole.append(track)
        else:
            poles.append(current_pole)
            current_pole = [track]

    poles.append(current_pole)
    return poles
