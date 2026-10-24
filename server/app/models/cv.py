"""
CV pipeline Pydantic models (detections, tracking, frame results).
"""

from datetime import datetime

from pydantic import BaseModel, Field


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


class SignReading(BaseModel):
    """One physical sign's extracted rules."""
    sign_type: str = "other"  # parking|no_parking|street_cleaning|meter|time_limit|permit|loading_zone|other
    raw_text: str = ""
    hours: str | None = None
    max_duration_min: int | None = None
    price_per_hour: str | None = None
    permit_zone: str | None = None
    restrictions: list[str] = []
    arrow_direction: str | None = None  # left|right|both|None


class SignPoleReading(BaseModel):
    """Combined reading of all signs on one pole."""
    signs: list[SignReading] = []
    combined_summary: str = ""
    combined_hours: str | None = None
    combined_max_duration_min: int | None = None
    combined_price: str | None = None
    combined_restrictions: list[str] = []
    arrow_direction: str | None = None
    confidence_score: float = 0.0
    flagged: bool = False


class SignDocument(BaseModel):
    """Stored in Cosmos signs container."""
    id: str  # uuid
    road_segment_id: str
    location: dict = {}  # GeoJSON Point
    lat: float = 0.0
    lng: float = 0.0
    uncertainty_m: float = 0.0
    pole_reading: SignPoleReading = Field(default_factory=SignPoleReading)
    first_observed: datetime = Field(default_factory=datetime.utcnow)
    last_confirmed: datetime = Field(default_factory=datetime.utcnow)


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
    median_width_meters: float | None = None


class FrameResult(BaseModel):
    vehicles: list[VehicleDetection] = []
    signs: list[SignDetection] = []
    gap_estimate: int = 0
    gap_bboxes: list[list[float]] = []
    gap_measurements: list[GapMeasurement] = []
    sign_rules: SignPoleReading | None = None
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
    hfov: float | None = None  # horizontal FOV from phone camera (degrees)


class BlockObservation(BaseModel):
    segment_id: str
    gap_count: int
    confidence: float
    sign_rules: SignPoleReading | None = None
    confirmed_at: datetime = Field(default_factory=datetime.utcnow)
    ttl: int = 1800
    lat: float = 0.0
    lng: float = 0.0
    location: dict = {}  # GeoJSON point for Cosmos spatial queries


class SpotDocument(BaseModel):
    """Persistent parking spot with lifecycle status, stored in Cosmos."""
    id: str  # spot_<uuid>
    segment_id: str  # road segment (partition key)
    status: str = "open"  # open | occupied | expired
    gap_count: int = 1
    confidence: float = 0.0
    width_meters: float | None = None
    location: dict = {}  # GeoJSON Point
    lat: float = 0.0
    lng: float = 0.0
    sign_rules: SignPoleReading | None = None
    opened_at: datetime = Field(default_factory=datetime.utcnow)
    last_seen_at: datetime = Field(default_factory=datetime.utcnow)
    occupied_at: datetime | None = None
    version: int = 1
    ttl: int = 1800
    source_session_id: str = ""
