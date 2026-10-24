"""
Centralized configuration via pydantic-settings.

All env vars use CURB_ prefix. Loads from .env file.
"""

from pydantic import field_validator
from pydantic_settings import BaseSettings


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
    vehicle_confidence: float = 0.5
    sign_confidence: float = 0.4
    min_gap_fraction: float = 0.15

    # Segmentation model (same ultralytics API, pixel-precise masks)
    seg_model_path: str = "yolov8m-seg.pt"

    # Depth estimation (ZoeDepth-NK preferred, DA2 fallback)
    depth_model_id: str = "depth-anything/Depth-Anything-V2-Small-hf"
    default_camera_hfov_deg: float = 70.0  # horizontal FOV for phone camera

    # Bird's Eye View
    bev_output_size: int = 400  # BEV image is NxN pixels

    # Gap sizing (meters)
    min_gap_meters: float = 4.5  # minimum gap to count as a parking spot

    # Frame selection (simple rate limiter, no MAD)
    target_fps: float = 2.5

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


settings = Settings()
