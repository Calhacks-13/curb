"""
Shared Pydantic models used across the codebase.
"""

from pydantic import BaseModel, Field
from datetime import datetime


class VehicleDetection(BaseModel):
    bbox: list[float]
    cls: str
    confidence: float
    track_id: int | None = None


class SignDetection(BaseModel):
    bbox: list[float]
    confidence: float
    crop_bytes: bytes = Field(exclude=True)


class SignRules(BaseModel):
    summary: str = ""
    price: str | None = None
    max_duration_min: int | None = None
    hours: str | None = None
    restrictions: list[str] = []
    raw_text: str = ""
    confidence_score: float = 0.0
    flagged: bool = False


class RawDetection(BaseModel):
    bbox: list[float]
    cls: str
    confidence: float
    accepted: bool
    reason: str = ""


class GapMeasurement(BaseModel):
    bbox: list[float]
    width_meters: float | None = None
    width_pixels: int = 0
    is_valid_spot: bool = False


class TrackedGapInfo(BaseModel):
    left_track_id: int
    right_track_id: int
    bbox: list[float]
    duration: float = 0.0
    confirmed: bool = False


class FrameResult(BaseModel):
    vehicles: list[VehicleDetection] = []
    signs: list[SignDetection] = []
    gap_estimate: int = 0
    gap_bboxes: list[list[float]] = []
    gap_measurements: list[GapMeasurement] = []
    sign_rules: SignRules | None = None
    lat: float = 0.0
    lng: float = 0.0
    processed: bool = True
    raw_detections: list[RawDetection] = []
    scene_valid: bool = False
    pipeline_state: str = ""
    used_segmentation: bool = False
    used_depth: bool = False
    tracked_gaps: list[TrackedGapInfo] = []


class WSMetadata(BaseModel):
    lat: float
    lng: float
    heading: float = 0.0
    speed: float = 0.0
    timestamp: str = ""
    camera_pitch: float = 0.0
    camera_pitch: float = 0.0  # device pitch angle in degrees (from gyroscope)


class BlockObservation(BaseModel):
    segment_id: str
    gap_count: int
    confidence: float
    sign_rules: SignRules | None = None
    confirmed_at: datetime = Field(default_factory=datetime.utcnow)
    ttl: int = 1800
    lat: float = 0.0
    lng: float = 0.0
    location: dict = {}  # GeoJSON point for Cosmos spatial queries
