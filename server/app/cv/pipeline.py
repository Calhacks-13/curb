"""
Full CV pipeline: frame in → spots + sign rules out.

Orchestrates detector.py (YOLO, every frame) and
sign_reader.py (Claude Vision, only when sign detected).
"""

from app.cv.detector import detect_from_frame
from app.cv.sign_reader import read_sign

# Cache sign readings by approximate GPS (rounded to ~10m grid)
_sign_cache: dict[tuple[float, float], dict] = {}


def process_frame(image_bytes: bytes, lat: float, lng: float) -> dict:
    """
    Main entry point. Called by the /spots/observe endpoint.

    Returns:
        {
            "vehicles": [...],
            "gap_estimate": int,
            "sign_rules": {...} | None,
            "lat": float,
            "lng": float,
        }
    """
    detections = detect_from_frame(image_bytes)

    sign_rules = None
    if detections["signs"]:
        grid_key = _snap_to_grid(lat, lng)

        if grid_key in _sign_cache:
            sign_rules = _sign_cache[grid_key]
        else:
            # Read the highest-confidence sign crop
            best_sign = max(detections["signs"], key=lambda s: s["conf"])
            sign_rules = read_sign(best_sign["crop_bytes"])
            _sign_cache[grid_key] = sign_rules

    return {
        "vehicles": detections["vehicles"],
        "gap_estimate": detections["gap_estimate"],
        "sign_rules": sign_rules,
        "lat": lat,
        "lng": lng,
    }


def _snap_to_grid(lat: float, lng: float, precision: int = 4) -> tuple[float, float]:
    """Snap GPS to ~10m grid to avoid re-reading same sign."""
    return (round(lat, precision), round(lng, precision))
