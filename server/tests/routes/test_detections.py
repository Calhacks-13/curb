import base64
from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.models.cv import BlockObservation, FrameResult
from app.routes import v1


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
                "crop_b64": base64.b64encode(b"jpeg-crop").decode("ascii"),
            },
        ],
        "frame_width": 1280,
        "frame_height": 720,
    }
    body.update(overrides)
    return body


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
    assert response.json()["zone"]["legal_status_now"] == "LEGAL"
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
    assert call["signs"][0].crop_bytes == b"jpeg-crop"


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
    {"accuracy_m": -1}, {"accuracy_m": None},
    {"session_id": ""}, {"device_id": ""}, {"captured_at": "invalid"},
])
def test_detection_endpoint_rejects_invalid_metadata(monkeypatch, change):
    pipeline = RecordingPipeline()
    client, _ = build_client(monkeypatch, pipeline)
    response = client.post("/v1/vision/detections", json=submission(**change))
    assert response.status_code == 422
    assert pipeline.calls == []


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
    assert signs[0].crop_bytes == b"jpeg-crop"


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
