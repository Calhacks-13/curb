"""
Sign geolocation: bearing estimation, triangulation, and road segment IDs.

Given GPS observations from multiple frames where a sign was detected,
estimates the sign's physical (lat, lng) position.
"""

import math

from app.config import settings


def estimate_sign_bearing(
    heading_deg: float,
    bbox_center_x: float,
    frame_width: float,
    hfov_deg: float | None = None,
) -> float:
    """
    Estimate compass bearing from phone to sign.

    heading_deg: phone compass heading (0=N, 90=E)
    bbox_center_x: horizontal center of sign bbox in pixels
    frame_width: total frame width in pixels
    hfov_deg: horizontal field of view in degrees

    Returns bearing in degrees [0, 360).
    """
    if hfov_deg is None:
        hfov_deg = settings.default_camera_hfov_deg

    # Offset from center: -0.5 (left edge) to +0.5 (right edge)
    offset = (bbox_center_x / frame_width) - 0.5
    angle_offset = offset * hfov_deg

    bearing = (heading_deg + angle_offset) % 360
    return bearing


def _project_point(lat: float, lng: float, bearing_deg: float, distance_m: float) -> tuple[float, float]:
    """Project a point along a bearing for a given distance."""
    R = 6_371_000
    d = distance_m / R
    brng = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lng1 = math.radians(lng)

    lat2 = math.asin(
        math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(brng)
    )
    lng2 = lng1 + math.atan2(
        math.sin(brng) * math.sin(d) * math.cos(lat1),
        math.cos(d) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), math.degrees(lng2)


def triangulate_sign(
    observations: list[dict],
) -> tuple[float, float, float]:
    """
    Estimate sign position from multiple bearing observations.

    Each observation: {"lat": float, "lng": float, "bearing_deg": float}

    Returns (est_lat, est_lng, uncertainty_m).
    For a single observation, projects along bearing at default distance.
    For 2+, uses weighted midpoint of nearest-approach points between bearing lines.
    """
    if not observations:
        raise ValueError("No observations")

    if len(observations) == 1:
        obs = observations[0]
        est_lat, est_lng = _project_point(
            obs["lat"], obs["lng"], obs["bearing_deg"], settings.sign_default_distance_m
        )
        return est_lat, est_lng, settings.sign_default_distance_m

    # For 2+ observations: find pairwise intersection points and average
    intersection_points: list[tuple[float, float]] = []

    for i in range(len(observations)):
        for j in range(i + 1, len(observations)):
            pt = _bearing_intersection(observations[i], observations[j])
            if pt is not None:
                intersection_points.append(pt)

    if not intersection_points:
        # Bearings are parallel — fall back to midpoint projection
        mid_lat = sum(o["lat"] for o in observations) / len(observations)
        mid_lng = sum(o["lng"] for o in observations) / len(observations)
        mid_bearing = observations[0]["bearing_deg"]
        est_lat, est_lng = _project_point(mid_lat, mid_lng, mid_bearing, settings.sign_default_distance_m)
        return est_lat, est_lng, settings.sign_default_distance_m

    est_lat = sum(p[0] for p in intersection_points) / len(intersection_points)
    est_lng = sum(p[1] for p in intersection_points) / len(intersection_points)

    # Uncertainty: max distance from any observer to estimated point
    uncertainty = max(
        _haversine_m(obs["lat"], obs["lng"], est_lat, est_lng)
        for obs in observations
    )
    # Cap uncertainty — if triangulation gives nonsense, flag it
    uncertainty = min(uncertainty, 50.0)

    return est_lat, est_lng, uncertainty


def _bearing_intersection(
    obs_a: dict, obs_b: dict
) -> tuple[float, float] | None:
    """
    Find intersection of two bearing lines using spherical geometry approximation.
    Returns (lat, lng) or None if lines are nearly parallel.
    """
    lat1, lng1, b1 = math.radians(obs_a["lat"]), math.radians(obs_a["lng"]), math.radians(obs_a["bearing_deg"])
    lat2, lng2, b2 = math.radians(obs_b["lat"]), math.radians(obs_b["lng"]), math.radians(obs_b["bearing_deg"])

    # Use flat-Earth approximation (valid for small distances < 100m)
    cos_lat = math.cos((lat1 + lat2) / 2)

    # Convert to local meters
    x1, y1 = 0.0, 0.0
    dx = (lng2 - lng1) * cos_lat * 6_371_000
    dy = (lat2 - lat1) * 6_371_000
    x2, y2 = dx, dy

    # Direction vectors
    dx1, dy1 = math.sin(b1), math.cos(b1)
    dx2, dy2 = math.sin(b2), math.cos(b2)

    # Solve: P1 + t1*D1 = P2 + t2*D2
    denom = dx1 * dy2 - dy1 * dx2
    if abs(denom) < 1e-10:
        return None  # Nearly parallel

    t1 = ((x2 - x1) * dy2 - (y2 - y1) * dx2) / denom

    # Only accept intersections ahead of the observer (t1 > 0) and within 50m
    if t1 < 0 or t1 > 50:
        return None

    ix = x1 + t1 * dx1
    iy = y1 + t1 * dy1

    # Convert back to lat/lng
    est_lat = obs_a["lat"] + iy / 6_371_000 * (180 / math.pi)
    est_lng = obs_a["lng"] + ix / (6_371_000 * cos_lat) * (180 / math.pi)

    return est_lat, est_lng


def make_road_segment_id(lat: float, lng: float, heading: float) -> str:
    """
    Create a road segment ID from position + travel direction.

    ~11m grid (4 decimal places) + 8 compass directions.
    Opposite sides of the same street get different IDs.
    """
    rounded_lat = round(lat, 4)
    rounded_lng = round(lng, 4)
    direction = _compass_direction(heading)
    return f"{rounded_lat},{rounded_lng},{direction}"


def _compass_direction(heading: float) -> str:
    """Map heading to one of 8 compass directions."""
    directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    idx = round(heading / 45) % 8
    return directions[idx]


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6_371_000
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
