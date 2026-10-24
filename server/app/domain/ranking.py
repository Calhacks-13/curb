from math import asin, atan2, cos, radians, sin, sqrt
from typing import TypeVar

from app.models.domain import AgentParkingOption, DrivewayView, GeoLineString, GeoPoint, ParkingSpaceView


ParkingOption = AgentParkingOption | DrivewayView | ParkingSpaceView
Option = TypeVar("Option", bound=ParkingOption)


def distance_m(origin: GeoPoint, destination: GeoPoint) -> float:
    lng1, lat1 = map(radians, origin.coordinates)
    lng2, lat2 = map(radians, destination.coordinates)
    a = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lng2 - lng1) / 2) ** 2
    return 6_371_000 * 2 * asin(min(1, sqrt(a)))


def distance_to_line_m(origin: GeoPoint, line: GeoLineString) -> float:
    """Shortest spherical distance to any segment, including its endpoints."""
    def bearing(start: GeoPoint, end: GeoPoint) -> float:
        lng1, lat1 = map(radians, start.coordinates)
        lng2, lat2 = map(radians, end.coordinates)
        return atan2(sin(lng2 - lng1) * cos(lat2),
                     cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(lng2 - lng1))

    nearest = float("inf")
    for first, second in zip(line.coordinates, line.coordinates[1:]):
        start, end = GeoPoint(type="Point", coordinates=first), GeoPoint(type="Point", coordinates=second)
        delta = distance_m(start, origin) / 6_371_000
        direction = bearing(start, origin) - bearing(start, end)
        along = atan2(sin(delta) * cos(direction), cos(delta))
        segment_length = distance_m(start, end)
        candidate = min(distance_m(origin, start), distance_m(origin, end))
        if segment_length > 0 and 0 <= along <= segment_length / 6_371_000:
            candidate = abs(asin(max(-1, min(1, sin(delta) * sin(direction))))) * 6_371_000
        nearest = min(nearest, candidate)
    return nearest


def rank_options(origin: GeoPoint, options: list[Option]) -> list[Option]:
    """Rank usable supply without mutating persisted view fields."""
    def key(option: ParkingOption):
        driveway = isinstance(option, DrivewayView) or (
            isinstance(option, AgentParkingOption) and option.type == "DRIVEWAY"
        )
        freshness = getattr(option, "freshness", None)
        confidence = getattr(option, "base_confidence", getattr(option, "confidence", None))
        return (0 if driveway else 1, {"FRESH": 0, "AGING": 1, "STALE": 2}.get(freshness, 3),
                -(confidence or 0), option.distance_m, option.id)

    return sorted([
        option.model_copy(update={"distance_m": distance_m(origin, option.location)})
        for option in options
    ], key=key)
