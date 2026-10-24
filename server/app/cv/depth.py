"""
Monocular depth estimation using Depth Anything V2.

Converts pixel gaps to approximate real-world meters
by combining depth map with known camera FOV.
"""

import asyncio
import math
import numpy as np
from PIL import Image

from app.config import settings

_depth_pipeline = None
_depth_available: bool | None = None


def load_depth_model():
    """Load Depth Anything V2 model. Returns True if successful."""
    global _depth_pipeline, _depth_available
    if _depth_available is not None:
        return _depth_available
    try:
        from transformers import pipeline
        _depth_pipeline = pipeline(
            "depth-estimation",
            model=settings.depth_model_id,
            device="cuda",
        )
        _depth_available = True
    except Exception:
        try:
            from transformers import pipeline
            _depth_pipeline = pipeline(
                "depth-estimation",
                model=settings.depth_model_id,
                device="cpu",
            )
            _depth_available = True
        except Exception:
            _depth_available = False
    return _depth_available


def is_available() -> bool:
    return _depth_available is True


def estimate_depth(image: Image.Image) -> np.ndarray | None:
    """
    Run depth estimation on a PIL image.
    Returns a depth map as numpy array (H, W) with values 0-1
    where higher = farther.
    """
    if not is_available() or _depth_pipeline is None:
        return None

    result = _depth_pipeline(image)
    depth_map = np.array(result["depth"])

    # Normalize to 0-1 range
    d_min, d_max = depth_map.min(), depth_map.max()
    if d_max - d_min > 0:
        depth_map = (depth_map - d_min) / (d_max - d_min)
    else:
        depth_map = np.zeros_like(depth_map, dtype=np.float32)

    return depth_map.astype(np.float32)


async def estimate_depth_async(image: Image.Image) -> np.ndarray | None:
    return await asyncio.to_thread(estimate_depth, image)


def measure_gap_width_meters(
    depth_map: np.ndarray,
    gap_bbox: list[float],
    image_width: int,
    camera_hfov_deg: float | None = None,
) -> float | None:
    """
    Estimate real-world width of a gap in meters.

    Uses the depth at the gap center and camera FOV to convert
    pixel width to meters via:
        real_width = 2 * depth * tan(pixel_angle / 2)
    where pixel_angle = (gap_pixels / image_pixels) * hfov
    """
    if depth_map is None:
        return None

    hfov = camera_hfov_deg or settings.default_camera_hfov_deg
    x1, y1, x2, y2 = gap_bbox
    gap_pixel_width = x2 - x1

    # Sample depth at gap center
    cy = int((y1 + y2) / 2)
    cx = int((x1 + x2) / 2)
    cy = max(0, min(cy, depth_map.shape[0] - 1))
    cx = max(0, min(cx, depth_map.shape[1] - 1))

    # Sample a small region around center for robustness
    r = 5
    y_lo = max(0, cy - r)
    y_hi = min(depth_map.shape[0], cy + r)
    x_lo = max(0, cx - r)
    x_hi = min(depth_map.shape[1], cx + r)
    relative_depth = float(np.median(depth_map[y_lo:y_hi, x_lo:x_hi]))

    # Convert relative depth (0-1) to approximate metric distance.
    # Depth Anything V2 gives relative depth; we use a rough calibration:
    # typical street scene — relative 0.3 ~ 5m, 0.1 ~ 15m, 0.5 ~ 2m
    # Inverse relationship: real_distance ~ k / (relative_depth + eps)
    # Calibrated k for phone dashcam at ~1.2m height
    if relative_depth < 0.01:
        return None

    estimated_distance_m = 3.0 / (relative_depth + 0.05)

    # Angular width of gap in radians
    hfov_rad = math.radians(hfov)
    gap_angle = (gap_pixel_width / image_width) * hfov_rad

    # Real-world width at that distance
    real_width_m = 2.0 * estimated_distance_m * math.tan(gap_angle / 2.0)
    return round(real_width_m, 2)
