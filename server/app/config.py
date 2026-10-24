"""
Centralized configuration via pydantic-settings.

All env vars use CURB_ prefix. Loads from .env file.
Hardware auto-detection sets optimal defaults for CPU vs CUDA vs MPS.
"""

import logging

from pydantic import field_validator
from pydantic_settings import BaseSettings

_logger = logging.getLogger(__name__)


def _detect_device() -> str:
    """Detect best available compute device."""
    try:
        import torch
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            _logger.info("GPU detected: %s (CUDA)", name)
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            _logger.info("GPU detected: Apple Silicon (MPS)")
            return "mps"
    except Exception:
        pass
    _logger.info("No GPU detected — running on CPU")
    return "cpu"


# Detect once at import time
_DEVICE = _detect_device()
HAS_CUDA = _DEVICE == "cuda"
HAS_MPS = _DEVICE == "mps"
HAS_GPU = HAS_CUDA or HAS_MPS


class Settings(BaseSettings):
    model_config = {"env_prefix": "CURB_", "env_file": ".env", "extra": "ignore"}

    # YOLO models
    vehicle_model_path: str = "yolov8m.pt"
    sign_model_path: str = "yolov8m-signs.pt"
    sign_world_model_path: str = "yolov8m-worldv2.pt"
    sign_world_classes: list[str] = [
        "parking sign", "no parking sign", "traffic sign", "parking meter",
        "parking garage sign", "parking lot sign", "parking arrow sign",
    ]
    vehicle_confidence: float = 0.35
    sign_confidence: float = 0.35
    min_gap_fraction: float = 0.15

    # Inference speed — auto-tuned by device in apply_device_defaults()
    yolo_imgsz: int = 0  # 0 = auto (640 GPU, 480 CPU)
    yolo_half: bool = False  # auto-set True on CUDA
    depth_every_n: int = 0  # 0 = auto (1 GPU, 3 CPU)
    sign_every_n: int = 0  # 0 = auto (1 GPU, 3 CPU)

    # Segmentation model — auto-selected by device
    seg_model_path: str = ""  # empty = auto (m-seg GPU, s-seg CPU)

    # Depth estimation (ZoeDepth-NK preferred, DA2 fallback)
    depth_model_id: str = "depth-anything/Depth-Anything-V2-Small-hf"
    depth_enabled: bool | None = None  # None = auto (True GPU, False CPU)
    default_camera_hfov_deg: float = 70.0  # horizontal FOV for phone camera

    # Bird's Eye View
    bev_output_size: int = 400  # BEV image is NxN pixels

    # Gap sizing (meters)
    min_gap_meters: float = 4.5  # minimum gap to count as a parking spot

    # Frame selection (simple rate limiter, no MAD)
    target_fps: float = 5.0

    # Object tracking (IoU-based)
    track_iou_threshold: float = 0.2
    track_max_age: int = 5  # frames without match before track dies
    track_confirm_hits: int = 2  # hits to confirm a track (show to user)

    # Gap confirmation (track-based)
    gap_confirm_sec: float = 2.0  # seconds gap must persist to confirm
    gap_expire_sec: float = 1.5  # seconds without seeing gap before it expires

    # Sign confidence
    sign_read_confidence_threshold: float = 0.5

    # Sign tracking & deduplication
    sign_track_confirm_hits: int = 3
    sign_default_distance_m: float = 8.0
    sign_dedup_radius_m: float = 15.0

    # Spot TTL defaults (seconds)
    default_ttl_sec: int = 1800  # 30 min

    # Azure Cosmos DB
    cosmos_endpoint: str = ""
    cosmos_key: str = ""
    cosmos_database: str = "curb"
    cosmos_blocks_container: str = "blocks"
    cosmos_spots_container: str = "spots"
    cosmos_signs_container: str = "signs"

    # Azure SignalR (legacy web client)
    signalr_connection_string: str = ""
    signalr_hub: str = "spots"

    # Azure Web PubSub (mobile app realtime)
    webpubsub_connection_string: str = ""
    webpubsub_hub: str = "curb"

    # Shared secret the payment service sends as its bearer token
    payment_service_token: str = ""

    # Anthropic
    anthropic_api_key: str = ""

    # Browser-only development origins. Native iOS requests do not use CORS.
    cors_allowed_origins: str = "http://localhost:8081,http://localhost:19006"

    @field_validator("cors_allowed_origins")
    @classmethod
    def validate_cors_allowed_origins(cls, value: str) -> str:
        origins = [origin.strip() for origin in value.split(",") if origin.strip()]
        if "*" in origins:
            raise ValueError("wildcard CORS origins are not allowed")
        if not origins:
            raise ValueError("at least one CORS origin is required")
        return ",".join(origins)

    @property
    def cors_origins(self) -> list[str]:
        return self.cors_allowed_origins.split(",")

    # Detected device (read-only, set at startup)
    device: str = _DEVICE

    def apply_device_defaults(self) -> None:
        """Fill in zero/None/empty values with device-appropriate defaults."""
        gpu = HAS_GPU

        if not self.seg_model_path:
            self.seg_model_path = "yolov8m-seg.pt" if gpu else "yolov8s-seg.pt"
        if self.yolo_imgsz == 0:
            self.yolo_imgsz = 640 if gpu else 480
        if not self.yolo_half:
            self.yolo_half = HAS_CUDA  # FP16 only on CUDA
        if self.depth_every_n == 0:
            self.depth_every_n = 1 if gpu else 3
        if self.sign_every_n == 0:
            self.sign_every_n = 1 if gpu else 3
        if self.depth_enabled is None:
            self.depth_enabled = gpu

        _logger.info(
            "Device: %s | seg=%s | imgsz=%d | half=%s | depth=%s (every %d) | signs every %d",
            self.device, self.seg_model_path, self.yolo_imgsz,
            self.yolo_half, self.depth_enabled, self.depth_every_n, self.sign_every_n,
        )


settings = Settings()
settings.apply_device_defaults()
