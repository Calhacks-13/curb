"""Walking away must not look like parking a car in a confirmed opening."""
from collections import deque
from datetime import datetime, timedelta
import asyncio
from types import SimpleNamespace

import pytest

from app.azure import cosmos, signalr
from app.config import settings
from app.cv import tracker
from app.cv.pipeline import Pipeline
from app.models.cv import VehicleDetection
from app.repositories.memory import InMemoryParkingRepository


@pytest.fixture
def clock(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(cosmos, "_use_memory", True)
    monkeypatch.setattr(cosmos, "_mem_spots", {})
    monkeypatch.setattr(cosmos, "_mem_blocks", {})
    monkeypatch.setattr(cosmos, "_mem_signs", {})
    monkeypatch.setattr(signalr, "_event_log", deque(maxlen=500))
    monkeypatch.setattr(signalr, "_event_seq", 0)
    monkeypatch.setattr(signalr, "_client", None)
    for key, value in dict(
        min_gap_fraction=0.15, max_edge_gap_fraction=0.5, track_confirm_hits=2,
        gap_confirm_sec=2, gap_expire_sec=1.5, occupancy_confirm_sec=2,
        occupancy_confirm_hits=3, spot_freshness_sec=300,
    ).items():
        monkeypatch.setattr(settings, key, value)
    return now


def vehicles(blocker=False, shift=0, blocker_y=(60, 340), confidence=0.9):
    boxes = [[0 + shift, 50, 200 + shift, 350], [600 + shift, 50, 1000 + shift, 350]]
    if blocker:
        boxes.append([220 + shift, blocker_y[0], 580 + shift, blocker_y[1]])
    return [VehicleDetection(bbox=box, cls="car", confidence=confidence if index == 2 else 0.9)
            for index, box in enumerate(boxes)]


async def send(pipeline, clock, stamp, detections=None, **metadata):
    clock[0] = stamp
    return await pipeline.process_detections(
        vehicles=vehicles() if detections is None else detections, signs=[],
        **{ "lat": 37.8, "lng": -122.44, "heading": 90, "session_id": "walk",
            "frame_width": 1000, "frame_height": 600, **metadata },
    )


async def open_space(pipeline, clock, start=100, **metadata):
    for stamp in range(start, start + 4):
        result = await send(pipeline, clock, stamp, **metadata)
    return result["confirmed_spot"]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["empty", "one_boundary", "disconnect", "camera_turn", "gps_motion", "rotation"])
async def test_visibility_loss_preserves_last_observation_and_spot(clock, kind):
    pipeline = Pipeline()
    spot = await open_space(pipeline, clock)
    observed = spot.last_seen_at
    if kind == "empty":
        await send(pipeline, clock, 104, [])
        await send(pipeline, clock, 106, [])
    elif kind == "one_boundary":
        await send(pipeline, clock, 104, vehicles()[:1])
        await send(pipeline, clock, 106, vehicles()[:1])
    elif kind == "disconnect":
        clock[0] = 120
        await pipeline.maintain()
    elif kind == "camera_turn":
        await send(pipeline, clock, 104, vehicles(True), heading=130)
    elif kind == "gps_motion":
        await send(pipeline, clock, 104, vehicles(True), lat=37.801)
    else:
        await send(pipeline, clock, 104, vehicles(True), frame_width=600, frame_height=1000)
    current = pipeline._spot_mgr.find_by_segment(spot.segment_id)
    assert current.id == spot.id
    assert current.status == "open"
    assert current.last_seen_at == observed
    assert not any(e["event"] == "space.occupied" for e in pipeline._spot_mgr.transitions)
    assert any(e["event"] == "gap.lost" for e in pipeline._spot_mgr.transitions)


@pytest.mark.asyncio
async def test_repeated_vehicle_in_stable_gap_occupies_and_reuses_identity_on_reopening(clock):
    pipeline = Pipeline()
    repository = InMemoryParkingRepository()
    pipeline.set_repository(repository)
    spot = await open_space(pipeline, clock)
    for stamp in [104, 105]:
        await send(pipeline, clock, stamp, vehicles(True))
        assert pipeline._spot_mgr.find_by_segment(spot.segment_id).status == "open"
    await send(pipeline, clock, 106, vehicles(True))
    assert pipeline._spot_mgr.find_by_segment(spot.segment_id) is None
    occupied = await repository.get_space(spot.id)
    assert occupied.internal_state.value == "OCCUPIED"
    assert occupied.version == spot.version + 1
    assert occupied.last_observed_at.replace(tzinfo=None) == spot.last_seen_at
    transition = next(e for e in pipeline._spot_mgr.transitions if e["event"] == "space.occupied")
    assert transition["reason"] == "vehicle_observed"
    loss = next(e for e in pipeline._spot_mgr.transitions if e["reason"] == "vehicle_observed" and e["event"] == "gap.lost")
    assert loss["evidence_hits"] == 3
    for stamp in [107, 108, 109]:
        reopened = await send(pipeline, clock, stamp)
    assert reopened["confirmed_spot"].id == spot.id
    assert reopened["confirmed_spot"].version == occupied.version + 1
    assert len(await repository.list_spaces()) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["transient", "moving_anchors", "other_lane", "low_confidence", "different_blockers", "missing_observation"])
async def test_ambiguous_obstruction_never_proves_occupancy(clock, kind):
    pipeline = Pipeline()
    spot = await open_space(pipeline, clock)
    for stamp in [104, 105, 106, 107]:
        if kind == "transient":
            detections = vehicles(stamp == 104)
        elif kind == "moving_anchors":
            detections = vehicles(True, shift=50)
        elif kind == "other_lane":
            detections = vehicles(True, blocker_y=(420, 580))
        elif kind == "low_confidence":
            detections = vehicles(True, confidence=0.3)
        elif kind == "different_blockers":
            detections = vehicles(True)
            pipeline._sessions["walk"].vehicle_tracker.tracks = [
                track for track in pipeline._sessions["walk"].vehicle_tracker.tracks
                if track.id in next(iter(pipeline._sessions["walk"].gap_tracker._gaps.values())).gap_key
            ]
        else:
            detections = [] if stamp == 105 else vehicles(True)
        await send(pipeline, clock, stamp, detections)
    assert pipeline._spot_mgr.find_by_segment(spot.segment_id).status == "open"
    assert not any(e["event"] == "space.occupied" for e in pipeline._spot_mgr.transitions)


@pytest.mark.asyncio
async def test_pending_obstruction_never_refreshes_freshness(clock):
    pipeline = Pipeline()
    snapshot = await open_space(pipeline, clock)
    spot = pipeline._spot_mgr.find_by_segment(snapshot.segment_id)
    spot.last_seen_at -= timedelta(seconds=12)
    observed = spot.last_seen_at
    await send(pipeline, clock, 104, vehicles(True))
    assert spot.last_seen_at == observed
    assert spot.version == 1


@pytest.mark.asyncio
async def test_stop_scanning_expires_to_unknown_after_five_minutes_and_recovers_identity(clock):
    pipeline = Pipeline()
    repository = InMemoryParkingRepository()
    pipeline.set_repository(repository)
    spot = await open_space(pipeline, clock)
    await pipeline.maintain(now=spot.last_seen_at + timedelta(seconds=300))
    assert pipeline._spot_mgr.find_by_segment(spot.segment_id) is not None
    await pipeline.maintain(now=spot.last_seen_at + timedelta(seconds=301))
    assert pipeline._spot_mgr.find_by_segment(spot.segment_id) is None
    stored = await repository.get_space(spot.id)
    assert stored.internal_state.value == "UNKNOWN"
    assert stored.last_observed_at.replace(tzinfo=None) == spot.last_seen_at
    assert stored.version == 2
    transitions = pipeline._spot_mgr.transitions
    assert any(e["event"] == "space.expired" and e["reason"] == "freshness_expired" for e in transitions)
    # A new process recovers the stored identity/version, rather than another marker.
    restarted = Pipeline()
    restarted.set_repository(repository)
    reopened = await open_space(restarted, clock, start=200)
    assert reopened.id == spot.id
    assert reopened.version == 3
    assert len(await repository.list_spaces()) == 1


@pytest.mark.asyncio
async def test_new_track_ids_after_dropout_refresh_the_same_map_record(clock):
    pipeline = Pipeline()
    repository = InMemoryParkingRepository()
    pipeline.set_repository(repository)
    first = await open_space(pipeline, clock)
    pipeline.cleanup_session("walk")
    second = await open_space(pipeline, clock, start=200)
    assert second.id == first.id
    assert second.version > first.version
    assert len(await repository.list_spaces()) == 1


@pytest.mark.asyncio
async def test_edge_gaps_never_claim_occupancy_from_a_changed_frame_edge(clock):
    pipeline = Pipeline()
    one_car = [VehicleDetection(bbox=[200, 50, 900, 350], cls="car", confidence=0.9)]
    spot = await open_space(pipeline, clock, detections=one_car)
    for stamp in [104, 105, 106, 107]:
        await send(pipeline, clock, stamp, [
            one_car[0], VehicleDetection(bbox=[0, 50, 200, 350], cls="car", confidence=0.95),
        ])
    assert pipeline._spot_mgr.find_by_segment(spot.segment_id).status == "open"
    assert not any(e["event"] == "space.occupied" for e in pipeline._spot_mgr.transitions)


@pytest.mark.asyncio
async def test_vehicle_moving_through_gap_must_settle_before_counting_as_occupied(clock):
    pipeline = Pipeline()
    spot = await open_space(pipeline, clock)
    for index, stamp in enumerate([104, 105, 106, 107]):
        observed = vehicles(True)
        observed[-1].bbox = [140 + 50 * index, 60, 500 + 50 * index, 340]
        await send(pipeline, clock, stamp, observed)
    assert pipeline._spot_mgr.find_by_segment(spot.segment_id).status == "open"


@pytest.mark.asyncio
async def test_another_phone_still_seeing_gap_blocks_an_occupied_transition(clock):
    pipeline = Pipeline()
    spot = await open_space(pipeline, clock)
    await open_space(pipeline, clock, session_id="other")
    for stamp in [104, 105, 106]:
        await send(pipeline, clock, stamp, session_id="other")
        await send(pipeline, clock, stamp, vehicles(True))
    assert pipeline._spot_mgr.find_by_segment(spot.segment_id).status == "open"
    assert any(e["event"] == "occupancy.suppressed" for e in pipeline._spot_mgr.transitions)


@pytest.mark.asyncio
async def test_response_repository_and_realtime_share_identity_version_and_utc_time(clock, monkeypatch):
    from app.domain.detections import DetectionSubmission
    from app.routes import v1

    pipeline = Pipeline()
    repository = InMemoryParkingRepository()
    monkeypatch.setattr(v1, "get_pipeline", lambda: pipeline)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(parking_repository=repository)))
    for stamp in [100, 101, 102, 103]:
        clock[0] = stamp
        payload = DetectionSubmission.model_validate({
            "device_id": "phone", "session_id": "walk", "captured_at": "2026-10-25T06:00:00Z",
            "lat": 37.8, "lng": -122.44, "accuracy_m": 3, "heading": 90,
            "frame_width": 1000, "frame_height": 600, "signs": [],
            "vehicles": [{"bbox": v.bbox, "cls": v.cls, "confidence": v.confidence} for v in vehicles()],
        })
        response = await v1.upload_detections(request, payload)
    await asyncio.sleep(0)
    response_space = response["space"]
    record = await repository.get_space(response_space["id"])
    event = next(event for event in signalr.get_recent_events() if event["type"] == "space.opened")
    assert event["entity_id"] == response_space["id"] == record.id
    assert response_space["version"] == event["entity_version"] == record.version
    assert response_space["last_observed_at"].endswith("Z")
    assert event["payload"]["last_observed_at"] == response_space["last_observed_at"]
    zone = await repository.get_zone(record.zone_id)
    assert response["zone"]["sign_rule_id"] == zone.sign_rule_id
    assert len(await repository.list_spaces()) == 1


@pytest.mark.asyncio
async def test_maintenance_runs_and_is_cancelled_on_app_shutdown(clock, monkeypatch):
    from unittest.mock import AsyncMock
    from fastapi import FastAPI
    from app import main
    from app.cv import pipeline as module
    from app.cv import sign_reader

    pipeline = Pipeline()
    pipeline.maintain = AsyncMock()
    monkeypatch.setattr(module, "get_pipeline", lambda: pipeline)
    monkeypatch.setattr(cosmos, "init", AsyncMock())
    monkeypatch.setattr(cosmos, "close", AsyncMock())
    monkeypatch.setattr(signalr, "init", AsyncMock())
    monkeypatch.setattr(signalr, "close", AsyncMock())
    monkeypatch.setattr(sign_reader, "close_client", AsyncMock())
    app = FastAPI()
    app.state.parking_repository = InMemoryParkingRepository()
    async with main.lifespan(app):
        await asyncio.sleep(0)
        pipeline.maintain.assert_awaited_once()
    assert cosmos.close.await_count == 1
    assert signalr.close.await_count == 1


@pytest.mark.asyncio
async def test_mapping_seed_exemption_survives_reobservation_after_restart(clock):
    pipeline = Pipeline()
    pipeline.mapping_mode = True
    seed = await open_space(pipeline, clock)
    restarted = Pipeline()
    observed = await open_space(restarted, clock, start=200)
    assert observed.id == seed.id
    assert observed.is_seed is True
    await restarted.maintain(now=observed.last_seen_at + timedelta(seconds=301))
    assert restarted._spot_mgr.find_by_segment(seed.segment_id) is not None


@pytest.mark.asyncio
async def test_slow_sign_read_does_not_block_gap_feedback_or_expire_its_tracking(clock, monkeypatch):
    from app.cv import pipeline as module
    from app.models.cv import SignDetection, SignPoleReading, SignReading
    release = asyncio.Event()
    started = asyncio.Event()
    async def read(_crop):
        started.set()
        await release.wait()
        return SignPoleReading(signs=[SignReading(sign_type="time_limit", raw_text="2 HOUR PARKING")],
                               combined_summary="Two hour parking", confidence_score=0.9)
    monkeypatch.setattr(module, "read_sign_pole", read)
    pipeline = Pipeline()
    sign = SignDetection(bbox=[450, 20, 500, 100], confidence=0.9, crop_bytes=b"crop")
    try:
        for stamp in [100, 101, 102, 103, 104]:
            clock[0] = stamp
            response = asyncio.create_task(pipeline.process_detections(vehicles=vehicles(), signs=[sign],
                frame_width=1000, frame_height=600, lat=37.8, lng=-122.44, heading=90, session_id="walk"))
            for _ in range(30):
                await asyncio.sleep(0)
            assert response.done(), "OCR held up the live camera response"
            result = response.result()
        assert started.is_set() and not release.is_set()
        assert any(gap.confirmed for gap in result["frame_result"].tracked_gaps)
        assert pipeline._sign_jobs
        assert not any(event["event"] == "gap.lost" for event in pipeline._spot_mgr.transitions)
        release.set()
        await pipeline.wait_for_sign_reads()
        assert pipeline._sessions["walk"].sign_tracker.tracks[0].read_result.combined_summary == "Two hour parking"
    finally:
        release.set()
        await pipeline.close()


@pytest.mark.asyncio
async def test_new_opening_publishes_its_zone_before_the_space(clock):
    pipeline = Pipeline()
    spot = await open_space(pipeline, clock)
    await asyncio.sleep(0)
    events = signalr.get_recent_events()
    opening = next(index for index, event in enumerate(events) if event["type"] == "space.opened" and event["entity_id"] == spot.id)
    assert any(event["type"] == "sign_rule.updated" and event["entity_id"] == spot.segment_id for event in events[:opening])
