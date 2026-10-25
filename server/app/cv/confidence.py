"""Evidence scoring for confirmed parking gaps."""

from dataclasses import dataclass

from app.cv.tracker import LEFT_FRAME_ID, RIGHT_FRAME_ID, Track, TrackedGap


@dataclass(frozen=True)
class GapConfidence:
    base_confidence: float
    detection_confidence: float


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def score_gap(gap: TrackedGap, tracks: list[Track]) -> GapConfidence | None:
    """Score a gap from its weakest real boundary and observation stability."""
    real_boundary_ids = {
        track_id
        for track_id in gap.gap_key
        if track_id not in {LEFT_FRAME_ID, RIGHT_FRAME_ID}
    }
    tracks_by_id = {track.id: track for track in tracks}
    if not real_boundary_ids or not real_boundary_ids <= tracks_by_id.keys():
        return None

    detection_confidence = _clamp(min(
        tracks_by_id[track_id].confidence for track_id in real_boundary_ids
    ))
    stability_confidence = min(1.0, gap.observation_count / 5)
    base_confidence = _clamp(
        0.8 * detection_confidence + 0.2 * stability_confidence
    )
    return GapConfidence(
        base_confidence=base_confidence,
        detection_confidence=detection_confidence,
    )


def choose_gap_evidence(
    gaps: list[TrackedGap],
    tracks: list[Track],
) -> tuple[TrackedGap, GapConfidence] | None:
    """Choose the strongest deterministic representative from scorable gaps."""
    scored = [
        (gap, confidence)
        for gap in gaps
        if (confidence := score_gap(gap, tracks)) is not None
    ]
    if not scored:
        return None
    return min(
        scored,
        key=lambda item: (
            -item[1].base_confidence,
            -item[0].duration,
            item[0].gap_key,
        ),
    )
