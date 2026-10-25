import pytest

from app.config import settings
from app.cv.confidence import GapConfidence, choose_gap_evidence, score_gap
from app.cv.tracker import (
    LEFT_FRAME_ID,
    RIGHT_FRAME_ID,
    GapTracker,
    Track,
    TrackedGap,
)


def make_track(track_id: int, confidence: float, bbox: list[float] | None = None) -> Track:
    track = Track(bbox or [0, 0, 100, 100], "car", confidence)
    track.id = track_id
    return track


def test_new_gap_starts_with_one_observation_and_active_updates_increment_once(monkeypatch):
    from app.cv import tracker as tracker_module

    clock = [100.0]
    monkeypatch.setattr(tracker_module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(settings, "min_gap_fraction", 0.15)
    monkeypatch.setattr(settings, "max_edge_gap_fraction", 0.15)

    left = make_track(10, 0.9, [0, 0, 200, 300])
    right = make_track(20, 0.8, [400, 0, 1000, 300])
    gaps = GapTracker()

    active, _, _ = gaps.update([left, right], 1000, 600)
    assert active[0].observation_count == 1

    clock[0] = 101.0
    active, _, _ = gaps.update([left, right], 1000, 600)
    assert active[0].observation_count == 2


def test_interior_gap_uses_weaker_real_boundary_and_weighted_stability():
    gap = TrackedGap(10, 20, [100, 0, 300, 600])
    gap.observation_count = 3

    score = score_gap(gap, [make_track(10, 0.92), make_track(20, 0.7)])

    assert score is not None
    assert score.base_confidence == pytest.approx(0.68)
    assert score.detection_confidence == pytest.approx(0.7)


def test_edge_gap_ignores_virtual_boundary_and_uses_real_anchor():
    gap = TrackedGap(LEFT_FRAME_ID, 20, [0, 0, 300, 600])
    gap.observation_count = 5

    score = score_gap(gap, [make_track(20, 0.85)])

    assert score is not None
    assert score.base_confidence == pytest.approx(0.88)
    assert score.detection_confidence == pytest.approx(0.85)


def test_stability_caps_at_five_observations_and_scores_are_clamped():
    high = TrackedGap(10, RIGHT_FRAME_ID, [100, 0, 300, 600])
    high.observation_count = 99
    low = TrackedGap(20, RIGHT_FRAME_ID, [100, 0, 300, 600])
    low.observation_count = 1

    assert score_gap(high, [make_track(10, 2.0)]) == GapConfidence(
        base_confidence=1.0,
        detection_confidence=1.0,
    )
    low_score = score_gap(low, [make_track(20, -1.0)])
    assert low_score is not None
    assert low_score.base_confidence == pytest.approx(0.04)
    assert low_score.detection_confidence == 0.0


def test_unresolved_real_boundary_fails_closed():
    gap = TrackedGap(10, 20, [100, 0, 300, 600])

    assert score_gap(gap, [make_track(10, 0.9)]) is None


def test_representative_prefers_score_then_duration_then_stable_gap_key():
    lower = TrackedGap(10, 20, [100, 0, 300, 600])
    stronger_short = TrackedGap(30, RIGHT_FRAME_ID, [300, 0, 500, 600])
    stronger_long_high_key = TrackedGap(40, RIGHT_FRAME_ID, [500, 0, 700, 600])
    stronger_long_low_key = TrackedGap(35, RIGHT_FRAME_ID, [700, 0, 900, 600])
    for gap in [lower, stronger_short, stronger_long_high_key, stronger_long_low_key]:
        gap.observation_count = 5
    lower.first_seen, lower.last_seen = 100.0, 105.0
    stronger_short.first_seen, stronger_short.last_seen = 100.0, 102.0
    stronger_long_high_key.first_seen, stronger_long_high_key.last_seen = 100.0, 104.0
    stronger_long_low_key.first_seen, stronger_long_low_key.last_seen = 100.0, 104.0
    tracks = [
        make_track(10, 0.7), make_track(20, 0.7),
        make_track(30, 0.9), make_track(35, 0.9), make_track(40, 0.9),
    ]

    selected = choose_gap_evidence(
        [lower, stronger_short, stronger_long_high_key, stronger_long_low_key],
        tracks,
    )

    assert selected is not None
    assert selected[0] is stronger_long_low_key
    assert selected[1].base_confidence == pytest.approx(0.92)
    assert selected[1].detection_confidence == pytest.approx(0.9)
