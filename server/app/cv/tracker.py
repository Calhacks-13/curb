"""
Lightweight multi-object tracker using IoU matching.

Assigns persistent track IDs to YOLO detections across frames.
No external dependencies beyond numpy — uses greedy IoU matching.
"""

import time
import numpy as np

from app.config import settings


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
    """A gap defined by two adjacent track IDs."""
    __slots__ = ("left_track_id", "right_track_id", "bbox", "first_seen", "last_seen")

    def __init__(self, left_id: int, right_id: int, bbox: list[float]):
        self.left_track_id = left_id
        self.right_track_id = right_id
        self.bbox = bbox
        self.first_seen = time.monotonic()
        self.last_seen = time.monotonic()

    @property
    def duration(self) -> float:
        return self.last_seen - self.first_seen

    @property
    def gap_key(self) -> tuple[int, int]:
        return (self.left_track_id, self.right_track_id)


class GapTracker:
    """
    Tracks gaps between adjacent vehicles using track IDs.

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
    ) -> tuple[list[TrackedGap], list[TrackedGap]]:
        """
        Compute gaps from sorted tracks, match to existing tracked gaps.

        Returns (all_gaps, newly_confirmed_gaps).
        """
        now = time.monotonic()

        if len(confirmed_tracks) < 1:
            # No tracks — expire all gaps
            self._expire_old(now)
            return [], []

        # Sort by x-center
        sorted_tracks = sorted(confirmed_tracks, key=lambda t: (t.bbox[0] + t.bbox[2]) / 2)

        # Find gaps between adjacent tracks
        current_gaps: dict[tuple[int, int], list[float]] = {}
        min_gap_px = frame_width * settings.min_gap_fraction

        # Left edge gap (before first vehicle)
        if sorted_tracks[0].bbox[0] >= min_gap_px:
            key = (0, sorted_tracks[0].id)  # 0 = frame edge
            current_gaps[key] = [0, 0, sorted_tracks[0].bbox[0], frame_height]

        # Gaps between vehicles
        for i in range(len(sorted_tracks) - 1):
            right_edge = sorted_tracks[i].bbox[2]
            left_edge = sorted_tracks[i + 1].bbox[0]
            if left_edge - right_edge >= min_gap_px:
                key = (sorted_tracks[i].id, sorted_tracks[i + 1].id)
                current_gaps[key] = [right_edge, 0, left_edge, frame_height]

        # Right edge gap (after last vehicle)
        if frame_width - sorted_tracks[-1].bbox[2] >= min_gap_px:
            key = (sorted_tracks[-1].id, 0)
            current_gaps[key] = [sorted_tracks[-1].bbox[2], 0, frame_width, frame_height]

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

        # Expire gaps not seen this frame
        self._expire_old(now, active_keys)

        # Check for newly confirmed gaps
        all_gaps = list(self._gaps.values())
        newly_confirmed = []
        for gap in all_gaps:
            if gap.gap_key not in self._confirmed:
                if gap.duration >= settings.gap_confirm_sec:
                    self._confirmed.add(gap.gap_key)
                    newly_confirmed.append(gap)

        return all_gaps, newly_confirmed

    def _expire_old(self, now: float, active_keys: set | None = None):
        """Remove gaps not seen recently."""
        dead = []
        for key, gap in self._gaps.items():
            if active_keys is not None and key not in active_keys:
                dead.append(key)
            elif now - gap.last_seen > settings.gap_expire_sec:
                dead.append(key)
        for key in dead:
            self._gaps.pop(key, None)
            self._confirmed.discard(key)

    def get_state_string(self) -> str:
        """Human-readable state for debug panel."""
        if not self._gaps:
            return "no gaps"
        parts = []
        for gap in self._gaps.values():
            dur = gap.duration
            confirmed = gap.gap_key in self._confirmed
            status = "confirmed" if confirmed else f"{dur:.1f}s/{settings.gap_confirm_sec}s"
            parts.append(f"T{gap.left_track_id}-T{gap.right_track_id}: {status}")
        return " | ".join(parts)

    def reset(self):
        self._gaps.clear()
        self._confirmed.clear()
