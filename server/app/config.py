"""
Centralized configuration via pydantic-settings.

All env vars use CURB_ prefix. Loads from .env file.
"""

from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_prefix": "CURB_", "env_file": ".env", "extra": "ignore"}

    # Pixel gap threshold for detections submitted by the device
    min_gap_fraction: float = 0.15

    # Bearing estimation for sign triangulation
    default_camera_hfov_deg: float = 70.0  # horizontal FOV for phone camera

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


settings = Settings()
