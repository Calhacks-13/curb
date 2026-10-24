"""
Monocular depth estimation using ZoeDepth (metric) or Depth Anything V2 (relative).

ZoeDepth-NK outputs metric depth in meters directly, eliminating the
hand-tuned heuristic needed for relative depth models.
Falls back to DA2 with calibration if ZoeDepth unavailable.
"""

import math
import numpy as np
from PIL import Image

from app.config import settings

_depth_pipeline = None
_depth_available: bool | None = None
_metric_depth: bool = False  # True when model outputs meters directly


def load_depth_model():
    """Load depth model. Prefers ZoeDepth-NK (metric), falls back to DA2 (relative)."""
    global _depth_pipeline, _depth_available, _metric_depth
    if _depth_available is not None:
        return _depth_available

    # Try ZoeDepth-NK first (metric depth)
    for device in ("cuda", "cpu"):
        try:
            import torch
            _depth_pipeline = torch.hub.load(
                "isl-org/ZoeDepth", "ZoeD_NK", pretrained=True
            )
            _depth_pipeline = _depth_pipeline.to(device).eval()
            _metric_depth = True
            _depth_available = True
            return True
        except Exception:
            continue

    # Fall back to DA2 via transformers pipeline
    for device in ("cuda", "cpu"):
        try:
            from transformers import pipeline
            _depth_pipeline = pipeline(
                "depth-estimation",
                model=settings.depth_model_id,
                device=device,
            )
            _metric_depth = False
            _depth_available = True
            return True
        except Exception:
            continue

    _depth_available = False
    return False


def is_available() -> bool:
    return _depth_available is True


def is_metric() -> bool:
    return _metric_depth


def estimate_depth(image: Image.Image) -> np.ndarray | None:
    """
    Run depth estimation on a PIL image.

    If ZoeDepth (metric): returns depth map in meters (H, W).
    If DA2 (relative): returns normalized 0-1 depth map (higher = farther).
    """
    if not is_available() or _depth_pipeline is None:
        return None

    if _metric_depth:
        import torch
        with torch.no_grad():
            depth_map = _depth_pipeline.infer_pil(image)
        return depth_map.astype(np.float32)
    else:
        result = _depth_pipeline(image)
        depth_map = np.array(result["depth"])
        d_min, d_max = depth_map.min(), depth_map.max()
        if d_max - d_min > 0:
            depth_map = (depth_map - d_min) / (d_max - d_min)
        else:
            depth_map = np.zeros_like(depth_map, dtype=np.float32)
        return depth_map.astype(np.float32)


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
    sampled_depth = float(np.median(depth_map[y_lo:y_hi, x_lo:x_hi]))

    if _metric_depth:
        # ZoeDepth: sampled_depth is already in meters
        if sampled_depth < 0.1:
            return None
        estimated_distance_m = sampled_depth
    else:
        # DA2: relative depth 0-1, needs manual calibration
        if sampled_depth < 0.01:
            return None
        estimated_distance_m = 3.0 / (sampled_depth + 0.05)

    # Angular width of gap in radians
    hfov_rad = math.radians(hfov)
    gap_angle = (gap_pixel_width / image_width) * hfov_rad

    # Real-world width at that distance
    real_width_m = 2.0 * estimated_distance_m * math.tan(gap_angle / 2.0)
    return round(real_width_m, 2)
