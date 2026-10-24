"""
Centralized configuration via pydantic-settings.

All env vars use CURB_ prefix. Loads from .env file.
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_prefix": "CURB_", "env_file": ".env", "extra": "ignore"}

    # YOLO models
    vehicle_model_path: str = "yolov8m.pt"
    sign_model_path: str = "yolov8m-signs.pt"
    vehicle_confidence: float = 0.5
    sign_confidence: float = 0.4
    min_gap_fraction: float = 0.15

    # Segmentation model (same ultralytics API, pixel-precise masks)
    seg_model_path: str = "yolov8m-seg.pt"

    # Depth estimation (ZoeDepth-NK preferred, DA2 fallback)
    depth_model_id: str = "depth-anything/Depth-Anything-V2-Small"  # DA2 fallback only
    default_camera_hfov_deg: float = 70.0  # horizontal FOV for phone camera

    # Bird's Eye View
    bev_output_size: int = 400  # BEV image is NxN pixels
    bev_meters_per_pixel: float = 0.05  # each BEV pixel = 5cm
    bev_forward_range_m: float = 20.0  # how far ahead to project

    # Occupancy grid
    occupancy_cell_size_m: float = 1.0  # each grid cell = 1m x 1m
    occupancy_free_threshold: int = 3  # frames to confirm free
    occupancy_decay_sec: float = 30.0  # evidence decays after this

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

    # Legacy fallback (kept for non-tracking path)
    confirmation_count: int = 3
    confirmation_window_sec: float = 10.0
    gap_tolerance: int = 1

    # Sign confidence
    sign_read_confidence_threshold: float = 0.5

    # Sign tracking & deduplication
    sign_track_confirm_hits: int = 3
    sign_default_distance_m: float = 8.0
    sign_dedup_radius_m: float = 15.0

    # Block-level snapping (3 decimal places ~ 111m)
    grid_precision: int = 3

    # Spot TTL defaults (seconds)
    default_ttl_sec: int = 1800  # 30 min
    downtown_ttl_sec: int = 900  # 15 min
    suburb_ttl_sec: int = 3600  # 60 min

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


settings = Settings()
