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
from app.models import SignDetection, SignPoleReading, VehicleDetection


@pytest.fixture
def local_services(monkeypatch):
    monkeypatch.setattr(cosmos, "_use_memory", True)
    for store in ("_mem_spots", "_mem_signs", "_mem_blocks"):
        monkeypatch.setattr(cosmos, store, {})
    monkeypatch.setattr(signalr, "_event_log", deque(maxlen=500))
    monkeypatch.setattr(signalr, "_event_seq", 0)
    monkeypatch.setattr(signalr, "_client", None)
    monkeypatch.setattr(settings, "min_gap_fraction", 0.15)
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


async def submit(pipeline, vehicles=None, signs=None, width=1000, height=600):
    return await pipeline.process_detections(
        vehicles=vehicles if vehicles is not None else [],
        signs=signs if signs is not None else [],
        frame_width=width, frame_height=height,
        lat=37.8, lng=-122.44, session_id="drive", heading=90.0,
    )


async def flush_background_tasks():
    # occupy_spot schedules its own persistence/broadcast tasks.
    await asyncio.sleep(0)
    await asyncio.sleep(0)


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

    assert set(result) == {"frame_result", "confirmed_block"}
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
async def test_gap_threshold_includes_exact_boundary_and_ignores_frame_edges(local_services):
    from app.cv.pipeline import Pipeline

    vehicles = [
        VehicleDetection(bbox=[50, 20, 200, 300], cls="car", confidence=0.9),
        VehicleDetection(bbox=[350, 20, 400, 300], cls="car", confidence=0.8),
        VehicleDetection(bbox=[500, 20, 550, 300], cls="car", confidence=0.8),
    ]
    result = await submit(Pipeline(), vehicles)
    assert result["frame_result"].gap_bboxes == [[200, 0, 350, 600]]


@pytest.mark.asyncio
async def test_best_crop_reaches_sign_reading_and_sign_is_persisted(local_services, monkeypatch):
    from app.cv import pipeline as module

    read_crops = []
    reading = SignPoleReading(combined_summary="Two hour parking", confidence_score=0.9)

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
    track = pipeline._sessions["drive"].sign_tracker.tracks[0]
    assert len(track.gps_observations) == 3
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
async def test_empty_submissions_expire_all_trackers_and_occupy_confirmed_spot(local_services, monkeypatch):
    from app.cv import pipeline as module
    from app.cv import tracker

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    pipeline = module.Pipeline()
    sign = SignDetection(bbox=[800, 40, 840, 120], confidence=0.7, crop_bytes=b"crop")
    await submit(pipeline, make_vehicles(), [sign])
    now[0] = 101.0
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
            assert sign_track.time_since_update == 3
        elif i == 1:
            # Expiry follows the gap timeout, even while missed vehicles live.
            await flush_background_tasks()
            assert len(session.vehicle_tracker.tracks) == 2
            assert session.gap_tracker._confirmed == set()
            assert pipeline.spots_in_memory == 0
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
    assert pipeline.spots_in_memory == 0
    assert [s["status"] for s in cosmos._mem_spots.values()] == ["occupied"]
    assert [e["type"] for e in signalr.get_recent_events()].count("space.occupied") == 1


@pytest.mark.asyncio
async def test_existing_spot_is_refreshed_on_resighting_and_new_gap_confirmation(local_services, monkeypatch):
    from app.cv import pipeline as module
    from app.cv import tracker

    now = [100.0]
    monkeypatch.setattr(tracker.time, "monotonic", lambda: now[0])
    pipeline = module.Pipeline()
    for stamp in [100.0, 101.0, 104.0]:
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
    for stamp in [110.0, 111.0, 114.0]:
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
