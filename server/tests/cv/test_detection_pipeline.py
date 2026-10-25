"""Detection-only pipeline behavior with real trackers and local side effects."""

import asyncio
from collections import deque
import os
from pathlib import Path
import subprocess
import sys
import textwrap
from datetime import UTC, datetime, timedelta

import pytest

from app.azure import cosmos, signalr
from app.config import settings
from app.models import SignDetection, SignDocument, SignPoleReading, SignReading, VehicleDetection


@pytest.mark.parametrize("boundaries,expected", [
    ([], {}),
    ([(10, [150, 10, 500, 300])], {
        (-1, 10): [0, 0, 150, 600], (10, -2): [500, 0, 1000, 600],
    }),
    ([(10, [149, 10, 499, 300])], {}),
    ([(10, [501, 10, 851, 300])], {}),
    ([(10, [0, 10, 100, 300]), (20, [850, 10, 1000, 300])], {
        (10, 20): [100, 0, 850, 600],
    }),
    ([(10, [0, 10, 200, 300]), (20, [350, 10, 1000, 300])], {
        (10, 20): [200, 0, 350, 600],
    }),
])
def test_bounded_gap_candidates(boundaries, expected, monkeypatch):
    from app.cv import tracker

    monkeypatch.setattr(settings, "min_gap_fraction", 0.15)
    monkeypatch.setattr(settings, "max_edge_gap_fraction", 0.5)
    # Assert the exported interface as a failure rather than an import error.
    assert hasattr(tracker, "gap_candidates")
    assert tracker.gap_candidates(boundaries, 1000, 600) == expected


@pytest.fixture
def local_services(monkeypatch):
    monkeypatch.setattr(cosmos, "_use_memory", True)
    for store in ("_mem_spots", "_mem_signs", "_mem_blocks"):
        monkeypatch.setattr(cosmos, store, {})
    monkeypatch.setattr(signalr, "_event_log", deque(maxlen=500))
    monkeypatch.setattr(signalr, "_event_seq", 0)
    monkeypatch.setattr(signalr, "_client", None)
    monkeypatch.setattr(settings, "min_gap_fraction", 0.15)
    # These existing regressions isolate interior gaps and dropout behavior.
    monkeypatch.setattr(settings, "max_edge_gap_fraction", 0.15)
    monkeypatch.setattr(settings, "track_confirm_hits", 2)
    monkeypatch.setattr(settings, "sign_track_confirm_hits", 3)
    monkeypatch.setattr(settings, "track_max_age", 5)
    monkeypatch.setattr(settings, "gap_confirm_sec", 2.0)
    monkeypatch.setattr(settings, "gap_expire_sec", 1.5)


def make_vehicles():
    # Deliberately reversed: the pipeline must sort only for gap calculation.
    return [
        VehicleDetection(bbox=[500, 20, 700, 300], cls="truck", confidence=0.93),
        VehicleDetection(bbox=[50, 30, 300, 350], cls="car", confidence=0.81),
    ]


def make_vehicles_with_confidence(left: float, right: float):
    return [
        VehicleDetection(bbox=[500, 20, 700, 300], cls="truck", confidence=right),
        VehicleDetection(bbox=[50, 30, 300, 350], cls="car", confidence=left),
    ]


async def submit(
    pipeline, vehicles=None, signs=None, width=1000, height=600,
    session_id="drive", heading=90.0,
):
    return await pipeline.process_detections(
        vehicles=vehicles if vehicles is not None else [],
        signs=signs if signs is not None else [],
        frame_width=width, frame_height=height,
        lat=37.8, lng=-122.44, session_id=session_id, heading=heading,
    )


async def flush_background_tasks():
    # occupy_spot schedules its own persistence/broadcast tasks.
    await asyncio.sleep(0)
    await asyncio.sleep(0)


def store_sign(sign_id, segment_id, lat, lng, summary, category="street"):
    reading = SignPoleReading(combined_summary=summary, sign_category=category, confidence_score=0.9, signs=[SignReading(sign_type="parking", raw_text="PARKING " + summary)])
    document = SignDocument(
        id=sign_id,
        road_segment_id=segment_id,
        location={"type": "Point", "coordinates": [lng, lat]},
        lat=lat,
        lng=lng,
        pole_reading=reading,
    )
    cosmos._mem_signs[sign_id] = document.model_dump(mode="json")
    return reading


@pytest.mark.asyncio
async def test_persisted_sign_resolution_prefers_exact_segment(local_services):
    from app.cv.pipeline import Pipeline

    exact = store_sign(
        "exact", "37.8,-122.44,E", 37.8002, -122.44, "Exact segment rules",
    )
    store_sign(
        "closer", "37.8001,-122.44,E", 37.80001, -122.44, "Closer nearby rules",
    )
    deduplicator = Pipeline()._sign_dedup

    assert hasattr(deduplicator, "find_rules_for_segment")
    resolved = await deduplicator.find_rules_for_segment(
        "37.8,-122.44,E", 37.8, -122.44,
    )

    assert resolved == exact


@pytest.mark.asyncio
async def test_persisted_sign_resolution_uses_nearest_same_direction_street_sign(local_services):
    from app.cv.pipeline import Pipeline

    store_sign(
        "far", "37.8001,-122.4403,E", 37.8, -122.4403, "Far rules",
    )
    nearest = store_sign(
        "nearest", "37.8001,-122.4401,E", 37.8, -122.4401, "Nearest rules",
    )
    store_sign(
        "garage", "37.8001,-122.44001,E", 37.8, -122.44001, "Garage rules", "garage",
    )

    resolved = await Pipeline()._sign_dedup.find_rules_for_segment(
        "37.8,-122.44,E", 37.8, -122.44,
    )

    assert resolved == nearest


@pytest.mark.asyncio
async def test_persisted_sign_resolution_rejects_opposite_direction_and_legacy_signs(local_services):
    from app.cv.pipeline import Pipeline

    store_sign(
        "opposite", "37.8,-122.44,W", 37.8, -122.44, "Opposite-side rules",
    )
    store_sign(
        "legacy", "", 37.8, -122.44, "Unlocated legacy rules",
    )
    cosmos._mem_signs["legacy"].pop("road_segment_id")

    resolved = await Pipeline()._sign_dedup.find_rules_for_segment(
        "37.8,-122.44,E", 37.8, -122.44,
    )

    assert resolved is None


@pytest.mark.asyncio
async def test_sign_resolution_uses_registered_sign_before_background_persistence(local_services):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    reading = SignPoleReading(combined_summary="Freshly recorded rules", confidence_score=0.9, signs=[SignReading(sign_type="parking", raw_text="PARKING")])
    pipeline._sign_dedup.register(SignDocument(
        id="fresh",
        road_segment_id="37.8,-122.44,E",
        location={"type": "Point", "coordinates": [-122.44, 37.8]},
        lat=37.8,
        lng=-122.44,
        pole_reading=reading,
    ))

    resolved = await pipeline._sign_dedup.find_rules_for_segment(
        "37.8,-122.44,E", 37.8, -122.44,
    )

    assert resolved == reading


@pytest.mark.asyncio
async def test_confirmed_space_inherits_rules_from_previously_recorded_sign(
    local_services, monkeypatch,
):
    from app.cv import tracker
    from app.cv.pipeline import Pipeline

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    recorded_rules = store_sign(
        "recorded", "37.8,-122.44,E", 37.8, -122.44, "Previously recorded rules",
    )
    pipeline = Pipeline()

    for stamp in [100.0, 101.0, 102.5, 104.0]:
        now[0] = stamp
        result = await submit(pipeline, make_vehicles())
    await flush_background_tasks()

    spot = next(iter(pipeline._spot_mgr._spots.values()))
    stored_spot = cosmos._mem_spots[spot.id]
    assert result["confirmed_block"].sign_rules == recorded_rules
    assert spot.sign_rules == recorded_rules
    assert stored_spot["sign_rules"]["combined_summary"] == "Previously recorded rules"


@pytest.mark.asyncio
async def test_confirmed_and_refreshed_space_publish_measured_gap_evidence(
    local_services, monkeypatch,
):
    from app.cv import tracker
    from app.cv.pipeline import Pipeline

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    pipeline = Pipeline()

    for stamp in [100.0, 101.0, 102.5, 104.0]:
        now[0] = stamp
        opened = await submit(pipeline, make_vehicles_with_confidence(0.81, 0.93))
    await flush_background_tasks()

    spot = next(iter(pipeline._spot_mgr._spots.values()))
    assert opened["confirmed_block"].confidence == pytest.approx(0.768)
    assert opened["confirmed_block"].detection_confidence == pytest.approx(0.81)
    assert spot.confidence == pytest.approx(0.768)
    assert spot.detection_confidence == pytest.approx(0.81)
    assert cosmos._mem_spots[spot.id]["confidence"] == pytest.approx(0.768)
    assert cosmos._mem_spots[spot.id]["detection_confidence"] == pytest.approx(0.81)
    opened_event = next(
        event for event in signalr.get_recent_events() if event["type"] == "space.opened"
    )
    assert opened_event["payload"]["base_confidence"] == pytest.approx(0.768)
    assert opened_event["payload"]["detection_confidence"] == pytest.approx(0.81)

    spot.last_seen_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=11)
    now[0] = 105.0
    await submit(pipeline, make_vehicles_with_confidence(0.95, 0.96))
    await flush_background_tasks()

    assert spot.confidence == pytest.approx(0.92)
    assert spot.detection_confidence == pytest.approx(0.95)
    assert cosmos._mem_spots[spot.id]["confidence"] == pytest.approx(0.92)
    assert cosmos._mem_spots[spot.id]["detection_confidence"] == pytest.approx(0.95)
    refreshed_event = next(
        event for event in reversed(signalr.get_recent_events())
        if event["type"] == "space.refreshed"
    )
    assert refreshed_event["payload"]["base_confidence"] == pytest.approx(0.92)
    assert refreshed_event["payload"]["detection_confidence"] == pytest.approx(0.95)


@pytest.mark.asyncio
async def test_multiple_confirmed_gaps_publish_strongest_representative(
    local_services, monkeypatch,
):
    from app.cv import tracker
    from app.cv.pipeline import Pipeline

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(settings, "max_edge_gap_fraction", 0.5)
    pipeline = Pipeline()
    vehicles = [
        VehicleDetection(bbox=[200, 20, 300, 300], cls="car", confidence=0.6),
        VehicleDetection(bbox=[500, 20, 600, 300], cls="car", confidence=0.95),
    ]

    for stamp in [100.0, 101.0, 102.5, 104.0]:
        now[0] = stamp
        result = await submit(pipeline, vehicles)
    await flush_background_tasks()

    spot = next(iter(pipeline._spot_mgr._spots.values()))
    assert result["confirmed_block"].gap_count == 3
    assert result["confirmed_block"].detection_confidence == pytest.approx(0.95)
    assert result["confirmed_block"].confidence == pytest.approx(0.88)
    assert spot.detection_confidence == pytest.approx(0.95)
    assert spot.confidence == pytest.approx(0.88)


@pytest.mark.asyncio
async def test_unscorable_confirmed_gap_publishes_no_opening(local_services, monkeypatch):
    from app.cv import pipeline as module
    from app.cv import tracker

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(module, "choose_gap_evidence", lambda gaps, tracks: None, raising=False)
    pipeline = module.Pipeline()

    for stamp in [100.0, 101.0, 102.5, 104.0]:
        now[0] = stamp
        result = await submit(pipeline, make_vehicles())
    await flush_background_tasks()

    assert result["confirmed_block"] is None
    assert pipeline.spots_in_memory == 0
    assert cosmos._mem_spots == {}
    assert cosmos._mem_blocks == {}
    assert signalr.get_recent_events() == []


@pytest.mark.asyncio
async def test_existing_space_refresh_adds_previously_recorded_sign_rules(
    local_services, monkeypatch,
):
    from app.cv import tracker
    from app.cv.pipeline import Pipeline

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    pipeline = Pipeline()
    for stamp in [100.0, 101.0, 102.5, 104.0]:
        now[0] = stamp
        await submit(pipeline, make_vehicles())
    await flush_background_tasks()
    spot = next(iter(pipeline._spot_mgr._spots.values()))
    assert spot.sign_rules is None

    recorded_rules = store_sign(
        "recorded", "37.8,-122.44,E", 37.8, -122.44, "Rules added on refresh",
    )
    pipeline.cleanup_session("drive")
    for stamp in [110.0, 111.0, 112.5, 114.0]:
        now[0] = stamp
        result = await submit(pipeline, make_vehicles())
    await flush_background_tasks()

    assert result["confirmed_block"].sign_rules == recorded_rules
    assert spot.sign_rules == recorded_rules
    assert cosmos._mem_spots[spot.id]["sign_rules"]["combined_summary"] == "Rules added on refresh"
    assert [event["type"] for event in signalr.get_recent_events()].count("sign_rule.updated") == 2


@pytest.mark.asyncio
async def test_confirmed_space_does_not_inherit_garage_reading_from_session(
    local_services, monkeypatch,
):
    from app.cv import tracker
    from app.cv.pipeline import Pipeline

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    pipeline = Pipeline()
    pipeline._get_session("drive").last_sign_reading = SignPoleReading(
        combined_summary="Garage parking ahead",
        sign_category="garage",
    )

    for stamp in [100.0, 101.0, 102.5, 104.0]:
        now[0] = stamp
        result = await submit(pipeline, make_vehicles())

    assert result["confirmed_block"].sign_rules is None
    assert next(iter(pipeline._spot_mgr._spots.values())).sign_rules is None


@pytest.mark.asyncio
async def test_confirmed_space_does_not_inherit_unlocated_prior_session_reading(
    local_services, monkeypatch,
):
    from app.cv import tracker
    from app.cv.pipeline import Pipeline

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    pipeline = Pipeline()
    pipeline._get_session("drive").last_sign_reading = SignPoleReading(
        combined_summary="Rules from a different block",
        sign_category="street",
    )

    for stamp in [100.0, 101.0, 102.5, 104.0]:
        now[0] = stamp
        result = await submit(pipeline, make_vehicles())

    assert result["confirmed_block"].sign_rules is None
    assert next(iter(pipeline._spot_mgr._spots.values())).sign_rules is None


@pytest.mark.asyncio
@pytest.mark.parametrize("api_key,state", [("", "unavailable"), ("test-key", "gathering")])
async def test_sign_feedback_reports_readiness_and_clears_on_empty_frame(local_services, monkeypatch, api_key, state):
    from app.cv.pipeline import Pipeline

    monkeypatch.setattr(settings, "anthropic_api_key", api_key)
    pipeline = Pipeline()
    result = await submit(pipeline, signs=[SignDetection(
        bbox=[700, 40, 740, 120], confidence=0.8, crop_bytes=b"crop",
    )])
    feedback = result["frame_result"].sign_feedback[0]
    assert feedback["bbox"] == [700, 40, 740, 120]
    assert feedback["observations"] == 1
    assert feedback["required_observations"] == 3
    assert feedback["state"] == state
    assert feedback["reading"] is None
    empty = await submit(pipeline)
    assert empty["frame_result"].sign_feedback == []


@pytest.mark.asyncio
async def test_submitted_values_reach_real_trackers_and_preserve_sign_crop(local_services):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    vehicles = make_vehicles()
    before = [v.model_dump() for v in vehicles]
    sign = SignDetection(bbox=[810, 40, 850, 120], confidence=0.79, crop_bytes=b"sign-jpeg")

    result = await submit(pipeline, vehicles, [sign], width=1200)

    session = pipeline._sessions["drive"]
    assert [(t.bbox, t.cls, t.confidence) for t in session.vehicle_tracker.tracks] == [
        ([500, 20, 700, 300], "truck", 0.93),
        ([50, 30, 300, 350], "car", 0.81),
    ]
    track = session.sign_tracker.tracks[0]
    assert (track.bbox, track.confidence, track.best_crop_bytes) == (
        [810, 40, 850, 120], 0.79, b"sign-jpeg",
    )
    observation = track.gps_observations[0]
    assert (observation.lat, observation.lng, observation.heading,
            observation.bbox_center_x, observation.frame_w) == (37.8, -122.44, 90, 830, 1200)
    assert result["frame_result"].signs[0].crop_bytes == b"sign-jpeg"
    assert [v.model_dump(exclude={"track_id"}) for v in vehicles] == [
        {k: v for k, v in original.items() if k != "track_id"} for original in before
    ]
    assert all(v.track_id is not None for v in result["frame_result"].vehicles)


@pytest.mark.asyncio
@pytest.mark.parametrize("width,height,expected", [
    (1000, 600, [[300, 0, 500, 600]]),
    (2000, 900, []),
    (1000, 900, [[300, 0, 500, 900]]),
])
async def test_submitted_dimensions_control_pixel_gaps(local_services, width, height, expected):
    from app.cv.pipeline import Pipeline

    result = await submit(Pipeline(), make_vehicles(), width=width, height=height)

    assert set(result) == {"frame_result", "confirmed_block", "confirmed_spot"}
    frame = result["frame_result"]
    assert frame.gap_bboxes == expected
    assert frame.gap_estimate == len(expected)
    assert [m.model_dump() for m in frame.gap_measurements] == ([{
        "bbox": [300, 0, 500, height], "width_meters": None,
        "width_pixels": 200, "is_valid_spot": True,
    }] if expected else [])
    assert frame.scene_valid is True
    assert frame.raw_detections == []
    assert frame.used_segmentation is False
    assert frame.used_depth is False


@pytest.mark.asyncio
async def test_gap_threshold_includes_exact_boundary_and_rejects_oversized_edges(local_services):
    from app.cv.pipeline import Pipeline

    vehicles = [
        VehicleDetection(bbox=[50, 20, 200, 300], cls="car", confidence=0.9),
        VehicleDetection(bbox=[350, 20, 400, 300], cls="car", confidence=0.8),
        VehicleDetection(bbox=[500, 20, 550, 300], cls="car", confidence=0.8),
    ]
    result = await submit(Pipeline(), vehicles)
    assert result["frame_result"].gap_bboxes == [[200, 0, 350, 600]]


@pytest.fixture
def edge_services(local_services, monkeypatch):
    monkeypatch.setattr(settings, "max_edge_gap_fraction", 0.5)
    from app.cv import tracker

    clock = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: clock[0])
    return clock


def boxed_vehicles(*extents):
    return [VehicleDetection(bbox=[left, 20, right, 300], cls="car", confidence=0.9)
            for left, right in extents]


@pytest.mark.asyncio
@pytest.mark.parametrize("extent,expected", [
    ((200, 900), [[0, 0, 200, 600]]),
    ((100, 800), [[800, 0, 1000, 600]]),
    ((300, 700), [[0, 0, 300, 600], [700, 0, 1000, 600]]),
])
async def test_single_vehicle_edges_retain_hit_and_stability_gates(edge_services, extent, expected):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    for stamp in [100.0, 101.0, 102.0, 102.9, 103.0]:
        edge_services[0] = stamp
        result = await submit(pipeline, boxed_vehicles(extent))
        frame = result["frame_result"]
        assert frame.gap_bboxes == expected
        if stamp == 100:
            assert frame.tracked_gaps == []
        else:
            assert [g.bbox for g in frame.tracked_gaps] == expected
        assert (result["confirmed_block"] is not None) == (stamp == 103)
    assert result["confirmed_block"].gap_count == len(expected)
    assert len(pipeline._sessions["drive"].vehicle_tracker.tracks) == 1
    await flush_background_tasks()


@pytest.mark.asyncio
async def test_empty_and_sign_only_inputs_never_create_or_advance_edges(edge_services):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    sign = SignDetection(bbox=[800, 40, 840, 120], confidence=0.7, crop_bytes=b"crop")
    for stamp, signs in [(100.0, []), (101.0, [sign])]:
        edge_services[0] = stamp
        result = await submit(pipeline, signs=signs)
        assert result["frame_result"].gap_bboxes == []
        assert result["frame_result"].tracked_gaps == []
        assert result["confirmed_block"] is None
    for stamp in [102.0, 103.0]:
        edge_services[0] = stamp
        await submit(pipeline, boxed_vehicles((300, 700)))
    gaps = list(pipeline._sessions["drive"].gap_tracker._gaps.values())
    assert len(gaps) == 2
    for stamp, signs in [(103.5, []), (104.0, [sign]), (104.6, [])]:
        edge_services[0] = stamp
        result = await submit(pipeline, signs=signs)
        assert result["confirmed_block"] is None
        assert all(g.last_seen == 103 and g.duration == 0 for g in gaps)
    assert pipeline._sessions["drive"].gap_tracker._gaps == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("anchors,blocker,blocked_bbox", [
    ([(300, 700)], (0, 100), [0, 0, 300, 600]),
    ([(300, 700)], (900, 1000), [700, 0, 1000, 600]),
    ([(0, 200), (800, 1000)], (400, 600), [200, 0, 800, 600]),
])
async def test_unconfirmed_current_vehicle_blocks_without_anchoring(
    edge_services, anchors, blocker, blocked_bbox,
):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    for stamp in [100.0, 101.0]:
        edge_services[0] = stamp
        await submit(pipeline, boxed_vehicles(*anchors))
    session = pipeline._sessions["drive"]
    assert blocked_bbox in [g.bbox for g in session.gap_tracker._gaps.values()]
    edge_services[0] = 102.0
    result = await submit(pipeline, boxed_vehicles(*anchors, blocker))
    new_track = next(t for t in session.vehicle_tracker.tracks if t.hits == 1)
    assert blocked_bbox not in result["frame_result"].gap_bboxes
    assert blocked_bbox not in [g.bbox for g in session.gap_tracker._gaps.values()]
    assert all(new_track.id not in g.gap_key for g in session.gap_tracker._gaps.values())
    edge_services[0] = 103.0
    result = await submit(pipeline, boxed_vehicles(*anchors, blocker))
    assert any(new_track.id in g.gap_key for g in session.gap_tracker._gaps.values())
    assert all(not g.confirmed for g in result["frame_result"].tracked_gaps
               if new_track.id in (g.left_track_id, g.right_track_id))
    await flush_background_tasks()


@pytest.mark.asyncio
async def test_visible_anchor_shrinks_edge_immediately(edge_services):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    for stamp in [100.0, 101.0, 102.0, 103.0]:
        edge_services[0] = stamp
        await submit(pipeline, boxed_vehicles((300, 700)))
    session = pipeline._sessions["drive"]
    vehicle_id = session.vehicle_tracker.tracks[0].id
    assert (-1, vehicle_id) in session.gap_tracker._confirmed
    edge_services[0] = 103.1
    await submit(pipeline, boxed_vehicles((100, 700)))
    assert (-1, vehicle_id) not in session.gap_tracker._gaps
    assert (vehicle_id, -2) in session.gap_tracker._confirmed
    await flush_background_tasks()


@pytest.mark.asyncio
async def test_edge_anchor_dropout_recovers_then_expires(edge_services):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    for stamp in [100.0, 101.0, 102.0, 103.0]:
        edge_services[0] = stamp
        await submit(pipeline, boxed_vehicles((300, 700)))
    session = pipeline._sessions["drive"]
    original_gaps = dict(session.gap_tracker._gaps)
    assert len(original_gaps) == 2
    edge_services[0] = 103.2
    await submit(pipeline)
    assert all(g.last_seen == 103 for g in original_gaps.values())
    edge_services[0] = 104.0
    recovered = await submit(pipeline, boxed_vehicles((300, 700)))
    assert recovered["confirmed_block"] is None
    assert all(session.gap_tracker._gaps[key] is gap for key, gap in original_gaps.items())
    for stamp in [104.1, 105.6]:
        edge_services[0] = stamp
        await submit(pipeline)
    assert session.gap_tracker._gaps == {}
    await flush_background_tasks()


@pytest.mark.asyncio
async def test_segment_stays_open_after_all_gap_tracks_expire(edge_services):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    for stamp in [100.0, 101.0, 102.0, 103.0]:
        edge_services[0] = stamp
        await submit(pipeline, boxed_vehicles((300, 700)))
    await flush_background_tasks()
    spot = next(iter(pipeline._spot_mgr._spots.values()))
    session = pipeline._sessions["drive"]
    assert len(session.confirmed_gap_segments) == 2
    edge_services[0] = 103.1
    await submit(pipeline, boxed_vehicles((100, 700)))
    await flush_background_tasks()
    assert len(session.confirmed_gap_segments) == 1
    assert pipeline._spot_mgr.find_by_segment(spot.segment_id) is spot
    assert cosmos._mem_spots[spot.id]["status"] == "open"
    assert "space.occupied" not in [e["type"] for e in signalr.get_recent_events()]
    edge_services[0] = 103.2
    await submit(pipeline, boxed_vehicles((100, 900)))
    await flush_background_tasks()
    assert session.confirmed_gap_segments == {}
    assert pipeline.spots_in_memory == 1
    assert cosmos._mem_spots[spot.id]["status"] == "open"
    assert [e["type"] for e in signalr.get_recent_events()].count("space.occupied") == 0


@pytest.mark.asyncio
async def test_same_frame_new_confirmation_prevents_transient_occupation(edge_services):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    for stamp in [100.0, 101.0, 102.0, 103.0]:
        edge_services[0] = stamp
        await submit(pipeline, boxed_vehicles((300, 1000)))
    await flush_background_tasks()
    spot = next(iter(pipeline._spot_mgr._spots.values()))
    edge_services[0] = 104.0
    await submit(pipeline, boxed_vehicles((300, 850)))
    edge_services[0] = 105.0
    await submit(pipeline, boxed_vehicles((300, 850)))
    edge_services[0] = 106.0
    result = await submit(pipeline, boxed_vehicles((100, 850)))
    await flush_background_tasks()
    assert result["confirmed_block"].gap_count == 1
    assert pipeline._spot_mgr.find_by_segment(spot.segment_id) is spot
    assert cosmos._mem_spots[spot.id]["status"] == "open"
    assert spot.version == 2
    assert [e["type"] for e in signalr.get_recent_events()] == [
        "space.opened", "sign_rule.updated", "space.refreshed",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("loss_time,still_supported", [
    (104.5, True), (104.6, False),
], ids=["fresh-other-session", "expired-dormant-session"])
async def test_cross_session_support_requires_unexpired_gap(
    edge_services, loss_time, still_supported,
):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    for stamp in [100.0, 101.0, 102.0, 103.0]:
        edge_services[0] = stamp
        for session_id in ["A", "B"]:
            await submit(pipeline, boxed_vehicles((300, 700)), session_id=session_id)
    await flush_background_tasks()
    spot = next(iter(pipeline._spot_mgr._spots.values()))
    dormant = pipeline._sessions["A"]
    active = pipeline._sessions["B"]
    assert len(dormant.confirmed_gap_segments) == len(active.confirmed_gap_segments) == 2

    # B loses its two gaps with the same real vehicle still visible. A sends
    # nothing else: another session's update must enforce A's expiry timeout.
    edge_services[0] = loss_time
    await submit(pipeline, boxed_vehicles((100, 900)), session_id="B")
    await flush_background_tasks()
    assert active.confirmed_gap_segments == {}
    if still_supported:
        assert len(dormant.confirmed_gap_segments) == 2
        assert pipeline._spot_mgr.find_by_segment(spot.segment_id) is spot
        assert cosmos._mem_spots[spot.id]["status"] == "open"
        assert "space.occupied" not in [e["type"] for e in signalr.get_recent_events()]
    else:
        assert dormant.gap_tracker._gaps == {}
        assert dormant.gap_tracker._confirmed == set()
        assert dormant.confirmed_gap_segments == {}
        assert pipeline._spot_mgr.find_by_segment(spot.segment_id) is spot
        assert cosmos._mem_spots[spot.id]["status"] == "open"
        # Neither tracking loss nor repeated empty submissions prove occupancy.
        edge_services[0] = 105.0
        await submit(pipeline, session_id="B")
        await flush_background_tasks()
        assert [e["type"] for e in signalr.get_recent_events()].count("space.occupied") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("extents", [
    [(200, 900)], [(0, 200), (500, 1000)],
], ids=["edge", "interior"])
async def test_submission_hiatus_restarts_pending_gap_stability(edge_services, extents):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    for stamp in [99.0, 100.0]:
        edge_services[0] = stamp
        await submit(pipeline, boxed_vehicles(*extents))
    session = pipeline._sessions["drive"]
    original = next(iter(session.gap_tracker._gaps.values()))
    assert original.duration == 0
    assert session.gap_tracker._confirmed == set()
    edge_services[0] = 111.0
    result = await submit(pipeline, boxed_vehicles(*extents))
    replacement = next(iter(session.gap_tracker._gaps.values()))
    assert result["confirmed_block"] is None
    assert replacement.gap_key == original.gap_key
    assert replacement is not original
    assert replacement.duration == 0
    assert session.gap_tracker._confirmed == set()
    assert pipeline.spots_in_memory == 0


@pytest.mark.asyncio
async def test_pending_gap_recovers_at_exact_expiry_boundary(edge_services):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    for stamp in [99.0, 100.0]:
        edge_services[0] = stamp
        await submit(pipeline, boxed_vehicles((200, 900)))
    session = pipeline._sessions["drive"]
    original = next(iter(session.gap_tracker._gaps.values()))
    edge_services[0] = 101.5
    result = await submit(pipeline, boxed_vehicles((200, 900)))
    assert result["confirmed_block"] is None
    assert session.gap_tracker._gaps[original.gap_key] is original
    assert original.duration == 1.5
    edge_services[0] = 102.0
    result = await submit(pipeline, boxed_vehicles((200, 900)))
    assert result["confirmed_block"].gap_count == 1
    assert session.gap_tracker._gaps[original.gap_key] is original
    await flush_background_tasks()


@pytest.mark.asyncio
@pytest.mark.parametrize("extents", [
    [(200, 900)], [(0, 200), (500, 1000)],
], ids=["edge", "interior"])
async def test_submission_hiatus_expires_confirmed_support_before_recreating_gap(edge_services, extents):
    from app.cv.pipeline import Pipeline

    pipeline = Pipeline()
    for stamp in [98.0, 99.0, 100.0, 101.0]:
        edge_services[0] = stamp
        await submit(pipeline, boxed_vehicles(*extents))
    await flush_background_tasks()
    session = pipeline._sessions["drive"]
    original = next(iter(session.gap_tracker._gaps.values()))
    spot = next(iter(pipeline._spot_mgr._spots.values()))
    assert session.confirmed_gap_segments == {original.gap_key: spot.segment_id}
    edge_services[0] = 111.0
    result = await submit(pipeline, boxed_vehicles(*extents))
    await flush_background_tasks()
    replacement = next(iter(session.gap_tracker._gaps.values()))
    assert result["confirmed_block"] is None
    assert replacement.gap_key == original.gap_key
    assert replacement is not original
    assert replacement.duration == 0
    assert session.gap_tracker._confirmed == set()
    assert session.confirmed_gap_segments == {}
    assert pipeline.spots_in_memory == 1
    assert cosmos._mem_spots[spot.id]["status"] == "open"
    assert [e["type"] for e in signalr.get_recent_events()].count("space.occupied") == 0


@pytest.mark.asyncio
async def test_best_crop_reaches_sign_reading_and_sign_is_persisted(local_services, monkeypatch):
    from app.cv import pipeline as module

    read_crops = []
    reading = SignPoleReading(combined_summary="Two hour parking", confidence_score=0.9, signs=[SignReading(sign_type="time_limit", raw_text="2 HOUR PARKING")])

    async def read_sign(crop):
        read_crops.append(crop)
        return reading

    # Claude is the external boundary; tracking, triangulation and persistence are real.
    monkeypatch.setattr(module, "read_sign_pole", read_sign)
    pipeline = module.Pipeline()
    for confidence, crop in [(0.6, b"first"), (0.95, b"best"), (0.7, b"last")]:
        result = await submit(pipeline, signs=[SignDetection(
            bbox=[700, 40, 740, 120], confidence=confidence, crop_bytes=crop,
        )])
    await flush_background_tasks()

    assert read_crops == [b"best"]
    assert result["frame_result"].scene_valid is True
    assert result["frame_result"].sign_rules == reading
    feedback = result["frame_result"].sign_feedback[0]
    assert feedback["state"] == "read"
    assert feedback["reading"]["combined_summary"] == "Two hour parking"
    # Repeated sightings retain the cached reading, even without a new read call.
    repeated = await submit(pipeline, signs=[SignDetection(
        bbox=[700, 40, 740, 120], confidence=0.7, crop_bytes=b"again",
    )])
    assert repeated["frame_result"].sign_feedback[0]["reading"] == feedback["reading"]
    assert read_crops == [b"best"]
    track = pipeline._sessions["drive"].sign_tracker.tracks[0]
    assert len(track.gps_observations) == 4
    assert track.read_result == reading
    assert pipeline._sessions["drive"].last_sign_reading == reading
    assert len(cosmos._mem_signs) == 1
    stored = next(iter(cosmos._mem_signs.values()))
    assert stored["pole_reading"]["combined_summary"] == "Two hour parking"
    # x=720 in a 1000px frame gives bearing=105.4deg, so project south/east.
    assert stored["lat"] < 37.8
    assert stored["lng"] > -122.44
    assert [e["type"] for e in signalr.get_recent_events()] == ["sign_rule.updated"]


@pytest.mark.asyncio
async def test_repeat_sign_scan_persists_confirmation_without_duplicate(local_services, monkeypatch):
    from app.cv import pipeline as module

    read_crops = []
    reading = SignPoleReading(combined_summary="Two hour parking", confidence_score=0.9, signs=[SignReading(sign_type="time_limit", raw_text="2 HOUR PARKING")])

    async def read_sign(crop):
        read_crops.append(crop)
        return reading

    monkeypatch.setattr(module, "read_sign_pole", read_sign)
    pipeline = module.Pipeline()
    sign = SignDetection(bbox=[700, 40, 740, 120], confidence=0.9, crop_bytes=b"sign")

    for _ in range(3):
        await submit(pipeline, signs=[sign], session_id="first-pass")
    await flush_background_tasks()
    sign_id, stored_before = next(iter(cosmos._mem_signs.items()))
    confirmed_before = stored_before["last_confirmed"]

    for _ in range(3):
        await submit(pipeline, signs=[sign], session_id="repeat-pass")
    await flush_background_tasks()

    assert read_crops == [b"sign"]
    assert list(cosmos._mem_signs) == [sign_id]
    assert cosmos._mem_signs[sign_id]["last_confirmed"] > confirmed_before


@pytest.mark.asyncio
async def test_opposite_direction_sign_scan_is_not_deduplicated(local_services, monkeypatch):
    from app.cv import pipeline as module

    read_crops = []

    async def read_sign(crop):
        read_crops.append(crop)
        return SignPoleReading(combined_summary=f"Rules {len(read_crops)}", confidence_score=0.9, signs=[SignReading(sign_type="parking", raw_text="PARKING")])

    monkeypatch.setattr(module, "read_sign_pole", read_sign)
    monkeypatch.setattr(settings, "sign_dedup_radius_m", 25.0)
    pipeline = module.Pipeline()
    sign = SignDetection(bbox=[480, 40, 520, 120], confidence=0.9, crop_bytes=b"sign")

    for _ in range(3):
        await submit(pipeline, signs=[sign], session_id="east-pass", heading=90.0)
    for _ in range(3):
        await submit(pipeline, signs=[sign], session_id="west-pass", heading=270.0)
    await flush_background_tasks()

    assert read_crops == [b"sign", b"sign"]
    assert len(cosmos._mem_signs) == 2
    assert {document["road_segment_id"].rsplit(",", 1)[-1]
            for document in cosmos._mem_signs.values()} == {"E", "W"}


@pytest.mark.asyncio
async def test_empty_submissions_expire_tracks_without_occupying_spot(local_services, monkeypatch):
    from app.cv import pipeline as module
    from app.cv import tracker

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    pipeline = module.Pipeline()
    sign = SignDetection(bbox=[800, 40, 840, 120], confidence=0.7, crop_bytes=b"crop")
    await submit(pipeline, make_vehicles(), [sign])
    now[0] = 101.0
    await submit(pipeline, make_vehicles())
    now[0] = 102.5
    await submit(pipeline, make_vehicles())
    now[0] = 104.0
    confirmed = await submit(pipeline, make_vehicles())
    await flush_background_tasks()

    assert confirmed["confirmed_block"].gap_count == 1
    assert pipeline.spots_in_memory == 1
    assert len(cosmos._mem_blocks) == 1
    assert [s["status"] for s in cosmos._mem_spots.values()] == ["open"]
    assert [e["type"] for e in signalr.get_recent_events()] == ["space.opened", "sign_rule.updated"]

    session = pipeline._sessions["drive"]
    vehicle_tracks = list(session.vehicle_tracker.tracks)
    sign_track = session.sign_tracker.tracks[0]
    for i in range(6):
        now[0] = 105.0 + i
        result = await submit(pipeline)
        if i == 0:
            assert all(t.time_since_update == 1 for t in vehicle_tracks)
            assert sign_track.time_since_update == 4
        elif i == 1:
            # Expiry follows the gap timeout, even while missed vehicles live.
            await flush_background_tasks()
            assert len(session.vehicle_tracker.tracks) == 2
            assert session.gap_tracker._confirmed == set()
            assert pipeline.spots_in_memory == 1
    await flush_background_tasks()

    frame = result["frame_result"]
    assert frame.scene_valid is False
    assert frame.gap_estimate == 0
    assert frame.gap_bboxes == []
    assert frame.gap_measurements == []
    assert frame.pipeline_state == "no_scene"
    assert session.vehicle_tracker.tracks == []
    assert session.sign_tracker.tracks == []
    assert session.gap_tracker._gaps == {}
    assert session.gap_tracker._confirmed == set()
    assert session.confirmed_gap_segments == {}
    assert pipeline.spots_in_memory == 1
    assert [s["status"] for s in cosmos._mem_spots.values()] == ["open"]
    assert [e["type"] for e in signalr.get_recent_events()].count("space.occupied") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("visible_indices", [[], [0], [1]], ids=["empty", "right-only", "left-only"])
async def test_boundary_dropout_preserves_gap_until_timeout_and_recovers(
    local_services, monkeypatch, visible_indices,
):
    from app.cv import pipeline as module
    from app.cv import tracker

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    pipeline = module.Pipeline()
    for stamp in [100.0, 101.0, 102.5, 104.0]:
        now[0] = stamp
        await submit(pipeline, make_vehicles())
    await flush_background_tasks()

    session = pipeline._sessions["drive"]
    gap = next(iter(session.gap_tracker._gaps.values()))
    spot = next(iter(pipeline._spot_mgr._spots.values()))
    assert gap.last_seen == 104.0

    async def dropout_at(stamp):
        now[0] = stamp
        vehicles = make_vehicles()
        await submit(pipeline, [vehicles[index] for index in visible_indices])
        await flush_background_tasks()

    await dropout_at(104.1)
    assert pipeline.spots_in_memory == 1
    assert cosmos._mem_spots[spot.id]["status"] == "open"
    assert session.gap_tracker._gaps[gap.gap_key] is gap
    assert gap.last_seen == 104.0

    now[0] = 105.0
    recovered = await submit(pipeline, make_vehicles())
    await flush_background_tasks()
    assert recovered["confirmed_block"] is None
    assert session.gap_tracker._gaps[gap.gap_key] is gap
    assert gap.gap_key in session.gap_tracker._confirmed
    assert gap.last_seen == 105.0
    assert pipeline._spot_mgr.find_by_segment(spot.segment_id) is spot
    assert cosmos._mem_spots[spot.id]["status"] == "open"
    assert "space.occupied" not in [e["type"] for e in signalr.get_recent_events()]

    for stamp in [105.1, 106.2]:
        await dropout_at(stamp)
        assert gap.last_seen == 105.0
        assert pipeline.spots_in_memory == 1
        assert gap.gap_key in session.gap_tracker._confirmed

    await dropout_at(106.6)
    assert session.gap_tracker._gaps == {}
    assert session.confirmed_gap_segments == {}
    assert pipeline.spots_in_memory == 1
    assert cosmos._mem_spots[spot.id]["status"] == "open"
    assert [e["type"] for e in signalr.get_recent_events()].count("space.occupied") == 0


@pytest.mark.asyncio
async def test_existing_spot_is_refreshed_on_resighting_and_new_gap_confirmation(local_services, monkeypatch):
    from app.cv import pipeline as module
    from app.cv import tracker

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    pipeline = module.Pipeline()
    for stamp in [100.0, 101.0, 102.5, 104.0]:
        now[0] = stamp
        await submit(pipeline, make_vehicles())
    await flush_background_tasks()
    spot = next(iter(pipeline._spot_mgr._spots.values()))
    spot.last_seen_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=11)
    now[0] = 105.0
    await submit(pipeline, make_vehicles())
    await flush_background_tasks()
    assert spot.version == 2

    # A separate session on the same segment must refresh the existing spot.
    pipeline.cleanup_session("drive")
    for stamp in [110.0, 111.0, 112.5, 114.0]:
        now[0] = stamp
        await submit(pipeline, make_vehicles())
    await flush_background_tasks()
    assert pipeline.spots_in_memory == 1
    assert spot.version == 3
    assert cosmos._mem_spots[spot.id]["version"] == 3
    assert [e["type"] for e in signalr.get_recent_events()].count("space.refreshed") == 2


def test_app_import_startup_and_observability_require_no_inference_runtime(tmp_path):
    script = textwrap.dedent("""
        import importlib.abc
        import sys

        class ForbiddenImport(BaseException):
            pass

        class NoInferenceImports(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                if fullname.split('.')[0] in {'ultralytics', 'torch', 'cv2', 'transformers'}:
                    raise ForbiddenImport('Forbidden inference import: ' + fullname)

        sys.meta_path.insert(0, NoInferenceImports())
        from fastapi.testclient import TestClient
        from app.main import app

        paths = {route.path for route in app.routes}
        assert not paths.intersection({'/ws/stream', '/ws/viewer', '/v1/vision/frames'})
        assert {'/v1/vision/detections', '/v1/realtime/events', '/v1/realtime/negotiate'} <= paths
        with TestClient(app) as client:
            health = client.get('/health')
            assert health.status_code == 200, health.text
            assert health.json()['status'] == 'ok'
            assert {'cosmos_configured', 'signalr_configured', 'webpubsub_configured', 'spots_in_memory'} <= health.json().keys()
            assert not {'device', 'seg_model', 'yolo_imgsz', 'yolo_half', 'vehicle_model_loaded', 'seg_model_available', 'sign_model_available', 'depth_enabled', 'depth_model_available', 'depth_metric'}.intersection(health.json())
            state = client.get('/v1/debug/state')
            assert state.status_code == 200, state.text
            assert {'sessions', 'spots', 'signs_deduped', 'recent_blocks', 'event_buffer'} <= state.json().keys()
            assert 'models' not in state.json()
            assert client.post('/v1/realtime/negotiate').status_code == 200
            assert client.get('/v1/realtime/events').status_code == 200
    """)
    env = {key: value for key, value in os.environ.items() if not key.startswith("CURB_")}
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
    completed = subprocess.run(
        [sys.executable, "-c", script], cwd=tmp_path, env=env,
        capture_output=True, text=True, timeout=30,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
