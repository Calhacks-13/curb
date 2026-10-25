import json
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.models.api import (
    AgentParkingSearchRequest,
    CreateHoldRequest,
    NearbyParkingQuery,
    PublicSeedFixture,
    RealtimeNegotiateResponse,
)
from app.models.domain import DrivewayView, ParkingSpaceView, SignRuleView


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def _typescript_seed_fixture() -> dict[str, Any]:
    result = subprocess.run(
        ["npm", "run", "export-fixture", "--workspace", "@curb/contracts", "--silent"],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def _walk(value: Any, path: tuple[str | int, ...] = ()):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from _walk(child, (*path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk(child, (*path, index))
    else:
        yield path, value


def test_seed_fixture_round_trips_between_typescript_and_pydantic():
    raw_fixture = _typescript_seed_fixture()

    parsed = PublicSeedFixture.model_validate(raw_fixture)

    assert parsed.model_dump(mode="json") == raw_fixture
    assert parsed.driver.id == "driver_demo"
    assert parsed.owner.id == "owner_demo"
    assert parsed.av.id == "av_demo"
    assert parsed.driveway.id == "driveway_demo_1"
    assert [(driveway.id, driveway.price_usdc) for driveway in parsed.nearby.driveways] == [
        ("driveway_demo_1", "0.50"),
        ("driveway_av_1", "0.50"),
    ]
    assert parsed.nearby.zones[0].id == "zone_demo_1"
    assert [space.id for space in parsed.nearby.spaces] == [
        "space_demo_1",
        "space_demo_2",
        "space_demo_3",
    ]
    assert [space.detection_confidence for space in parsed.nearby.spaces] == [0.93, 0.88, 0.84]

    coordinate_paths = {
        ("nearby", "zones", 0, "geometry", "coordinates", 0, 0),
        ("nearby", "spaces", 0, "location", "coordinates", 0),
        ("nearby", "driveways", 0, "location", "coordinates", 0),
    }
    flattened = dict(_walk(raw_fixture))
    for path in coordinate_paths:
        longitude = flattened[path]
        latitude = flattened[(*path[:-1], 1)]
        assert -180 <= longitude <= 180
        assert -90 <= latitude <= 90
        assert abs(longitude) > abs(latitude), f"expected [longitude, latitude] at {path}"

    timestamp_values = [
        value
        for path, value in flattened.items()
        if isinstance(path[-1], str)
        and (
            path[-1].endswith("_at")
            or path[-1] in {"availability_start", "availability_end", "generated_at"}
        )
        and value is not None
    ]
    assert timestamp_values
    for value in timestamp_values:
        parsed_timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        assert parsed_timestamp.utcoffset() == timedelta(0)


def test_mobile_nearby_query_requires_the_fixed_half_mile_radius():
    accepted = NearbyParkingQuery(lat=37.775, lng=-122.419, radius_m=804.672)
    assert accepted.radius_m == 804.672

    with pytest.raises(ValidationError):
        NearbyParkingQuery(lat=37.775, lng=-122.419, radius_m=500)


def test_secure_websocket_negotiation_url_matches_typescript_contract():
    response = RealtimeNegotiateResponse(
        url="wss://curb.webpubsub.azure.com/client/hubs/curb?access_token=demo"
    )
    assert str(response.url).startswith("wss://")

    with pytest.raises(ValidationError):
        RealtimeNegotiateResponse(url="https://example.test/negotiate")


def test_held_driveway_exposes_active_booking_payment_state():
    raw_driveway = _typescript_seed_fixture()["driveway"]
    raw_driveway.update(
        {
            "state": "HELD",
            "held_by_user_id": "driver_demo",
            "active_booking": {
                "id": "booking_demo_1",
                "state": "PROCESSING",
                "payment_status": "PROCESSING",
            },
        }
    )

    driveway = DrivewayView.model_validate(raw_driveway)
    assert driveway.active_booking.id == "booking_demo_1"
    assert driveway.active_booking.payment_status.value == "PROCESSING"


def test_python_contracts_reject_values_rejected_by_typescript():
    fixture = _typescript_seed_fixture()

    invalid_booking = {**fixture["booking"], "transaction_hash": ""}
    with pytest.raises(ValidationError):
        PublicSeedFixture.model_validate({**fixture, "booking": invalid_booking})

    sign_rule_without_required_nullable_field = {**fixture["sign_rule"]}
    sign_rule_without_required_nullable_field.pop("max_minutes")
    with pytest.raises(ValidationError):
        SignRuleView.model_validate(sign_rule_without_required_nullable_field)

    with pytest.raises(ValidationError):
        CreateHoldRequest(expected_version=True)
    with pytest.raises(ValidationError):
        NearbyParkingQuery(lat="37.775", lng=-122.419, radius_m=804.672)
    with pytest.raises(ValidationError):
        AgentParkingSearchRequest(lat=37.775, lng=-122.419, radius_m=float("inf"))


def test_legacy_parking_space_defaults_detection_confidence_to_zero():
    raw_space = _typescript_seed_fixture()["nearby"]["spaces"][0]
    raw_space.pop("detection_confidence")

    assert ParkingSpaceView.model_validate(raw_space).detection_confidence == 0
