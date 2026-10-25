import base64
from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.models.cv import BlockObservation, FrameResult
from app.routes import v1


# Real 2×2 JPEG encoded by CoreImage.jpegRepresentation at quality 0.85,
# matching the native crop encoder. Keep the fixed bytes independent of validation.
JPEG_CROP = base64.b64decode(
    "/9j/4AAQSkZJRgABAgEASABIAAD/4QC+RXhpZgAATU0AKgAAAAgABQEaAAUAAAABAAAASgEb"
    "AAUAAAABAAAAUgEoAAMAAAABAAIAAAITAAMAAAABAAEAAIdpAAQAAAABAAAAWgAAAAAAAABIAAAA"
    "AQAAAEgAAAABAAeQAAAHAAAABDAyMjGRAQAHAAAABAECAwCgAAAHAAAABDAxMDCgAQADAAAA"
    "AQABAACgAgAEAAAAAQAAAAKgAwAEAAAAAQAAAAKkBgADAAAAAQAAAAAAAAAAAAD/wAARCAACAAID"
    "ASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIE"
    "AwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcY"
    "GRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWG"
    "h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi"
    "4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QA"
    "tREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLR"
    "ChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3"
    "eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX"
    "2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwABAQEBAQECAQECAwICAgMEAwMDAwQGBAQEBAQG"
    "BwYGBgYGBgcHBwcHBwcHCAgICAgICQkJCQkLCwsLCwsLCwsL/9sAQwECAgIDAwMFAwMFCwgG"
    "CAsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsL/90ABAAB"
    "/9oADAMBAAIRAxEAPwD8X6KKK/lM/wB/D//Z"
)


def padded_jpeg(size):
    """Add legal JPEG comment segments to reach an exact decoded-byte budget."""
    comments = bytearray()
    remaining = size - len(JPEG_CROP)
    while remaining:
        chunk = min(60_000, remaining)
        assert chunk >= 4
        comments.extend(b"\xff\xfe" + (chunk - 2).to_bytes(2, "big") + b"x" * (chunk - 4))
        remaining -= chunk
    return JPEG_CROP[:-2] + comments + JPEG_CROP[-2:]


def jpeg_dimensions(width, height):
    data = bytearray(JPEG_CROP)
    offset = data.index(b"\xff\xc0")
    data[offset + 5:offset + 9] = height.to_bytes(2, "big") + width.to_bytes(2, "big")
    return bytes(data)


class RecordingPipeline:
    def __init__(self, confirmed_block: BlockObservation | None = None):
        self.calls: list[dict] = []
        self.confirmed_block = confirmed_block

    async def process_detections(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "frame_result": FrameResult(
                vehicles=kwargs["vehicles"],
                signs=kwargs["signs"],
                gap_estimate=1 if kwargs["vehicles"] else 0,
                scene_valid=bool(kwargs["vehicles"]),
                pipeline_state="tracking" if kwargs["vehicles"] else "no scene",
            ),
            "confirmed_block": self.confirmed_block,
        }


class RecordingRepository:
    def __init__(self):
        self.upserts: list[tuple[str, object]] = []

    async def upsert(self, collection, value):
        self.upserts.append((collection, value))


def build_client(monkeypatch, pipeline: RecordingPipeline):
    app = FastAPI()
    app.state.parking_repository = RecordingRepository()
    app.include_router(v1.router)
    monkeypatch.setattr(v1, "get_pipeline", lambda: pipeline)
    return TestClient(app), app.state.parking_repository


def submission(**overrides):
    body = {
        "session_id": "cap_123",
        "device_id": "dev_123",
        "captured_at": "2026-10-24T23:30:00Z",
        "lat": 37.8,
        "lng": -122.44,
        "accuracy_m": 4.5,
        "heading": 180.0,
        "vehicles": [
            {"bbox": [10.0, 20.0, 210.0, 300.0], "cls": "car", "confidence": 0.85},
        ],
        "signs": [
            {
                "bbox": [500.0, 50.0, 620.0, 240.0],
                "confidence": 0.7,
                "crop_b64": base64.b64encode(JPEG_CROP).decode("ascii"),
            },
        ],
        "frame_width": 1280,
        "frame_height": 720,
    }
    body.update(overrides)
    return body


def test_detection_response_exposes_gap_geometry_and_sign_readings(monkeypatch):
    from app.models.cv import TrackedGapInfo

    class FeedbackPipeline(RecordingPipeline):
        async def process_detections(self, **kwargs):
            result = await super().process_detections(**kwargs)
            frame = result["frame_result"]
            frame.gap_bboxes = [[210, 0, 500, 720]]
            frame.tracked_gaps = [TrackedGapInfo(
                bbox=[210, 0, 500, 720], left_track_id=1, right_track_id=2,
                duration=2.5, confirmed=True,
            )]
            frame.sign_feedback = [{
                "track_id": 3, "bbox": [500, 50, 620, 240], "observations": 3,
                "required_observations": 3, "state": "read",
                "reading": {"signs": [{"raw_text": "2 HOUR PARKING"}], "combined_summary": "Two hour parking"},
            }]
            return result

    client, _ = build_client(monkeypatch, FeedbackPipeline())
    response = client.post("/v1/vision/detections", json=submission())
    assert response.status_code == 200
    body = response.json()
    assert body["frame_width"] == 1280
    assert body["frame_height"] == 720
    assert body["gap_bboxes"] == [[210, 0, 500, 720]]
    assert body["tracked_gaps"][0]["confirmed"] is True
    assert body["tracked_gaps"][0]["duration"] == 2.5
    assert body["sign_feedback"][0]["reading"]["signs"][0]["raw_text"] == "2 HOUR PARKING"
    assert "crop_bytes" not in str(body)


def test_detection_endpoint_decodes_sign_crops_and_calls_pipeline(monkeypatch):
    confirmed = BlockObservation(
        segment_id="scan_segment_1",
        gap_count=1,
        confidence=0.91,
        lat=37.8,
        lng=-122.44,
        location={"type": "Point", "coordinates": [-122.44, 37.8]},
        confirmed_at=datetime(2026, 10, 24, 23, 30, tzinfo=UTC),
    )
    pipeline = RecordingPipeline(confirmed)
    client, repository = build_client(monkeypatch, pipeline)

    response = client.post("/v1/vision/detections", json=submission())

    assert response.status_code == 200
    UUID(response.json()["frame_id"])
    assert response.json() == {
        "frame_id": response.json()["frame_id"],
        "accepted": True,
        "pipeline_state": "tracking",
        "vehicle_count": 1,
        "gap_count": 1,
        "scene_valid": True,
        "captured_at": "2026-10-24T23:30:00+00:00",
        "frame_width": 1280,
        "frame_height": 720,
        "gap_bboxes": [],
        "tracked_gaps": [],
        "sign_feedback": [],
        "space": response.json()["space"],
        "zone": response.json()["zone"],
    }
    assert response.json()["space"]["id"] == "scan_segment_1"
    assert response.json()["space"]["zone_id"] == "scan_segment_1"
    assert response.json()["space"]["location"] == {"type": "Point", "coordinates": [-122.44, 37.8]}
    assert response.json()["space"]["internal_state"] == "OPEN"
    assert response.json()["space"]["last_observed_at"] == "2026-10-24T23:30:00Z"
    assert response.json()["space"]["base_confidence"] == 0.91
    assert response.json()["zone"]["id"] == "scan_segment_1"
    assert response.json()["zone"]["legal_status_now"] == "UNKNOWN"
    assert [name for name, _ in repository.upserts] == ["rules", "zones", "spaces"]
    assert len(pipeline.calls) == 1
    call = pipeline.calls[0]
    assert set(call) == {"session_id", "lat", "lng", "heading", "frame_width", "frame_height", "vehicles", "signs"}
    assert call["session_id"] == "cap_123"
    assert call["lat"] == 37.8
    assert call["lng"] == -122.44
    assert call["heading"] == 180.0
    assert call["frame_width"] == 1280
    assert call["frame_height"] == 720
    assert call["vehicles"][0].model_dump() == {
        "bbox": [10.0, 20.0, 210.0, 300.0],
        "cls": "car",
        "confidence": 0.85,
        "track_id": None,
        "depth_m": None,
    }
    assert call["signs"][0].bbox == [500.0, 50.0, 620.0, 240.0]
    assert call["signs"][0].confidence == 0.7
    assert call["signs"][0].crop_bytes == JPEG_CROP


def test_detection_endpoint_accepts_empty_lists(monkeypatch):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission(vehicles=[], signs=[])

    response = client.post("/v1/vision/detections", json=body)

    assert response.status_code == 200
    assert response.json()["accepted"] is True
    assert response.json()["vehicle_count"] == 0
    assert response.json()["gap_count"] == 0
    assert response.json()["scene_valid"] is False
    assert response.json()["pipeline_state"] == "no scene"
    assert "space" not in response.json()
    assert "zone" not in response.json()
    assert pipeline.calls[0]["vehicles"] == []
    assert pipeline.calls[0]["signs"] == []


def test_debug_state_reports_latest_submission_without_retaining_detections(monkeypatch):
    from app.cv import pipeline as pipeline_module
    from app.config import settings

    monkeypatch.setattr(settings, "min_gap_fraction", 0.15)
    monkeypatch.setattr(settings, "max_edge_gap_fraction", 0.5)
    monkeypatch.setattr(settings, "track_confirm_hits", 2)
    pipeline = pipeline_module.Pipeline()
    monkeypatch.setattr(pipeline_module, "_pipeline", pipeline)
    client, _ = build_client(monkeypatch, pipeline)

    with client:
        for empty_count in [1, 2]:
            accepted = client.post("/v1/vision/detections", json=submission(vehicles=[], signs=[]))
            assert accepted.status_code == 200
            assert {key: accepted.json()[key] for key in (
                "accepted", "pipeline_state", "vehicle_count", "gap_count", "scene_valid",
            )} == {
                "accepted": True, "pipeline_state": "no_scene", "vehicle_count": 0,
                "gap_count": 0, "scene_valid": False,
            }
            state = client.get("/v1/debug/state").json()["sessions"]["cap_123"]
            assert "last_submission" in state
            latest = state["last_submission"]
            assert datetime.fromisoformat(latest["received_at"]).utcoffset().total_seconds() == 0
            assert {key: value for key, value in latest.items() if key not in {"received_at", "lat", "lng", "heading"}} == {
                "frame_width": 1280, "frame_height": 720, "vehicle_count": 0, "sign_count": 0,
                "visible_confirmed_tracks": 0, "candidate_count": 0,
                "consecutive_empty_submissions": empty_count, "pipeline_state": "no_scene",
            }

        vehicle = [{"bbox": [400, 20, 880, 300], "cls": "car", "confidence": 0.9}]
        for hits in [1, 2]:
            accepted = client.post("/v1/vision/detections", json=submission(vehicles=vehicle, signs=[]))
            assert accepted.status_code == 200
            assert accepted.json()["vehicle_count"] == 1
            assert accepted.json()["gap_count"] == 2
            latest = client.get("/v1/debug/state").json()["sessions"]["cap_123"]["last_submission"]
            assert latest["vehicle_count"] == 1
            assert latest["sign_count"] == 0
            assert latest["candidate_count"] == 2
            assert latest["visible_confirmed_tracks"] == hits - 1
            assert latest["consecutive_empty_submissions"] == 0
            assert latest["pipeline_state"] == accepted.json()["pipeline_state"]

        accepted = client.post("/v1/vision/detections", json=submission(vehicles=[], signs=[]))
        state = client.get("/v1/debug/state").json()["sessions"]["cap_123"]
        # Retained tracks differ from current submitted/visible counts.
        assert state["vehicle_tracks"] == 1
        assert state["last_submission"]["vehicle_count"] == 0
        assert state["last_submission"]["visible_confirmed_tracks"] == 0
        assert state["last_submission"]["consecutive_empty_submissions"] == 1
        # A sign-only input is an observed scene, but never parking evidence.
        accepted = client.post("/v1/vision/detections", json=submission(vehicles=[]))
        latest = client.get("/v1/debug/state").json()["sessions"]["cap_123"]["last_submission"]
        assert latest["vehicle_count"] == 0
        assert latest["sign_count"] == 1
        assert latest["candidate_count"] == 0
        assert latest["consecutive_empty_submissions"] == 0
        assert "space" not in accepted.json()


@pytest.mark.parametrize(
    "change",
    [
        {"signs": [{"bbox": [1, 1, 2, 2], "confidence": 0.7, "crop_b64": "%%%"}]},
        {"vehicles": [{"bbox": [20, 0, 10, 10], "cls": "car", "confidence": 0.8}]},
        {"vehicles": [{"bbox": [0, 0, 1281, 10], "cls": "car", "confidence": 0.8}]},
        {"frame_width": 0},
        {"vehicles": [{"bbox": [0, 0, 10, 10], "cls": "car", "confidence": 1.01}]},
    ],
    ids=["malformed-base64", "inverted-box", "out-of-frame-box", "invalid-dimensions", "invalid-confidence"],
)
def test_detection_endpoint_rejects_malformed_payload(monkeypatch, change):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)

    response = client.post("/v1/vision/detections", json=submission(**change))

    assert response.status_code == 422
    assert pipeline.calls == []


@pytest.mark.parametrize("kind", ["vehicles", "signs"])
@pytest.mark.parametrize("bbox", [
    [-1, 0, 10, 10], [0, -1, 10, 10], [0, 20, 10, 10],
    [0, 0, 0, 10], [0, 0, 10, 0], [0, 0, 10, 721],
    [0, 0, 1281, 10], [0, 0, 10], [0, 0, 10, 10, 20],
    [0, 0, None, 10],
    [False, 0, 10, 10], ["0", 0, 10, 10],
])
def test_detection_endpoint_rejects_invalid_boxes(monkeypatch, kind, bbox):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission()
    body[kind][0]["bbox"] = bbox
    response = client.post("/v1/vision/detections", json=body)
    assert response.status_code == 422
    assert pipeline.calls == []


@pytest.mark.parametrize("kind", ["vehicles", "signs"])
@pytest.mark.parametrize("confidence", [-0.01, 1.01, None, True, "0.8"])
def test_detection_endpoint_rejects_invalid_confidence(monkeypatch, kind, confidence):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission()
    body[kind][0]["confidence"] = confidence
    response = client.post("/v1/vision/detections", json=body)
    assert response.status_code == 422
    assert pipeline.calls == []


@pytest.mark.parametrize("change", [
    {"frame_width": -1}, {"frame_height": 0}, {"frame_width": 1280.5},
    {"frame_height": True}, {"frame_width": "1280"},
    {"lat": 91}, {"lng": -181}, {"lat": None},
    {"lng": None}, {"heading": None},
    {"accuracy_m": -1},
    {"session_id": ""}, {"device_id": ""}, {"captured_at": "invalid"},
])
def test_detection_endpoint_rejects_invalid_metadata(monkeypatch, change):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    response = client.post("/v1/vision/detections", json=submission(**change))
    assert response.status_code == 422
    assert pipeline.calls == []


def test_detection_endpoint_accepts_unavailable_gps_accuracy(monkeypatch):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)

    response = client.post("/v1/vision/detections", json=submission(accuracy_m=None))

    assert response.status_code == 200
    assert response.json()["accepted"] is True
    assert len(pipeline.calls) == 1
    assert pipeline.calls[0]["lat"] == 37.8
    assert pipeline.calls[0]["lng"] == -122.44


@pytest.mark.parametrize("crop", ["anBlZw", "anBlZw==\n", "é", ""])
def test_detection_endpoint_rejects_invalid_crop(monkeypatch, crop):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission()
    body["signs"][0]["crop_b64"] = crop
    assert client.post("/v1/vision/detections", json=body).status_code == 422
    assert pipeline.calls == []


def test_detection_endpoint_accepts_boundary_boxes_and_confidence(monkeypatch):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission()
    body["vehicles"][0].update(bbox=[0, 0, 1280, 720], confidence=0)
    body["signs"][0].update(bbox=[0, 0, 1280, 720], confidence=1)
    assert client.post("/v1/vision/detections", json=body).status_code == 200
    assert pipeline.calls[0]["vehicles"][0].confidence == 0
    assert pipeline.calls[0]["signs"][0].confidence == 1


def test_submission_converts_to_internal_detection_models():
    from app.domain.detections import DetectionSubmission
    from app.models.cv import SignDetection, VehicleDetection

    vehicles, signs = DetectionSubmission.model_validate(submission()).to_pipeline_input()
    assert isinstance(vehicles[0], VehicleDetection)
    assert vehicles[0].bbox == [10, 20, 210, 300]
    assert vehicles[0].cls == "car"
    assert isinstance(signs[0], SignDetection)
    assert signs[0].crop_bytes == JPEG_CROP


@pytest.mark.parametrize(("kind", "count"), [("vehicles", 65), ("signs", 17)])
def test_detection_endpoint_rejects_excess_detections(monkeypatch, kind, count):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission()
    body[kind] *= count
    assert client.post("/v1/vision/detections", json=body).status_code == 422
    assert pipeline.calls == []


def test_detection_endpoint_accepts_detection_count_limits(monkeypatch):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission()
    body["vehicles"] *= 64
    body["signs"] *= 16
    assert client.post("/v1/vision/detections", json=body).status_code == 200
    assert len(pipeline.calls[0]["vehicles"]) == 64
    assert len(pipeline.calls[0]["signs"]) == 16


@pytest.mark.parametrize("size", [262_145, 262_148], ids=["decoded-budget", "encoded-budget"])
def test_detection_endpoint_rejects_oversized_crop(monkeypatch, size):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission()
    body["signs"][0]["crop_b64"] = base64.b64encode(padded_jpeg(size)).decode("ascii")
    assert client.post("/v1/vision/detections", json=body).status_code == 422
    assert pipeline.calls == []


def test_detection_endpoint_rejects_aggregate_crop_budget_before_decoding(monkeypatch):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission()
    body["signs"][0]["crop_b64"] = base64.b64encode(padded_jpeg(262_144)).decode("ascii")
    body["signs"] *= 5

    def unexpected_decode(*args, **kwargs):
        pytest.fail("aggregate encoded budget must be checked before decoding crops")

    monkeypatch.setattr("app.domain.detections.base64.b64decode", unexpected_decode)
    assert client.post("/v1/vision/detections", json=body).status_code == 422
    assert pipeline.calls == []


def test_detection_endpoint_rejects_aggregate_decoded_crop_budget(monkeypatch):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission()
    # Encoding/padding can hide a one-byte decoded overflow at the encoded limit.
    body["signs"] = [dict(body["signs"][0], crop_b64=base64.b64encode(padded_jpeg(size)).decode("ascii"))
                     for size in [262_144, 262_144, 262_144, 261_121, 1024]]
    assert client.post("/v1/vision/detections", json=body).status_code == 422
    assert pipeline.calls == []


def test_detection_endpoint_accepts_crop_budgets_and_decodes_each_crop_once(monkeypatch):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission()
    crop = padded_jpeg(262_144)
    body["signs"][0]["crop_b64"] = base64.b64encode(crop).decode("ascii")
    body["signs"] *= 4
    decode = base64.b64decode
    decoded = []

    def recording_decode(*args, **kwargs):
        value = decode(*args, **kwargs)
        decoded.append(value)
        return value

    monkeypatch.setattr("app.domain.detections.base64.b64decode", recording_decode)
    assert client.post("/v1/vision/detections", json=body).status_code == 200
    assert len(decoded) == 4
    assert all(sign.crop_bytes == crop for sign in pipeline.calls[0]["signs"])


@pytest.mark.parametrize("crop", [
    b"arbitrary non-image bytes", b"\x89PNG\r\n\x1a\n", JPEG_CROP[:-2], JPEG_CROP[:100],
    b"\xff\xd8\xff\xd9", JPEG_CROP + b"trailing", b"\xff\xd8\xff\xe0\x00\x01\xff\xd9",
    JPEG_CROP.replace(b"\xff\xda\x00\x0c", b"\xff\xda\x00\xff"),
    jpeg_dimensions(0, 2), jpeg_dimensions(2, 0), jpeg_dimensions(2049, 2),
    jpeg_dimensions(2, 2049), jpeg_dimensions(2048, 2048),
], ids=["non-image", "png", "missing-eoi", "truncated-segment", "empty-jpeg", "trailing-data",
        "invalid-segment-length", "truncated-scan-header", "zero-width", "zero-height",
        "oversized-width", "oversized-height", "pixel-budget"])
def test_detection_endpoint_rejects_invalid_jpeg(monkeypatch, crop):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    body = submission()
    body["signs"][0]["crop_b64"] = base64.b64encode(crop).decode("ascii")
    assert client.post("/v1/vision/detections", json=body).status_code == 422
    assert pipeline.calls == []


@pytest.mark.parametrize("change", [
    {"frame_width": 4097}, {"frame_height": 4097}, {"frame_width": 4096, "frame_height": 4096},
    {"session_id": "x" * 129}, {"device_id": "x" * 129}, {"surprise": "x" * 1000},
    {"captured_at": "2026-10-24T23:30:00Z" + " " * 65},
    {"vehicles": [{"bbox": [0, 0, 1, 1], "confidence": 0.5, "cls": "x" * 33}]},
    {"vehicles": [{"bbox": [0, 0, 1, 1], "confidence": 0.5, "cls": "car", "extra": "x"}]},
    {"signs": [{"bbox": [0, 0, 1, 1], "confidence": 0.5,
                "crop_b64": base64.b64encode(JPEG_CROP).decode("ascii"), "extra": "x"}]},
])
def test_detection_endpoint_rejects_unbounded_metadata(monkeypatch, change):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    assert client.post("/v1/vision/detections", json=submission(**change)).status_code == 422
    assert pipeline.calls == []


@pytest.mark.parametrize(("width", "height"), [(1920, 1080), (720, 1280), (4000, 4000)])
def test_detection_endpoint_accepts_hardware_frame_sizes(monkeypatch, width, height):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    assert client.post("/v1/vision/detections", json=submission(frame_width=width, frame_height=height)).status_code == 200
    assert len(pipeline.calls) == 1


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
@pytest.mark.parametrize("field", ["lat", "lng", "heading", "accuracy_m", "bbox", "confidence"])
def test_submission_rejects_nonfinite_numbers(value, field):
    from pydantic import ValidationError
    from app.domain.detections import DetectionSubmission

    body = submission()
    if field == "bbox":
        body["vehicles"][0]["bbox"][0] = value
    elif field == "confidence":
        body["signs"][0]["confidence"] = value
    else:
        body[field] = value
    with pytest.raises(ValidationError):
        DetectionSubmission.model_validate(body)
