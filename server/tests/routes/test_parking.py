import asyncio
import json
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.models.api import NearbyParkingResponse, PublicSeedFixture, SpaceDetail


NOW = datetime(2026, 10, 24, 1, tzinfo=UTC)
ORIGIN = {"lat": 37.775, "lng": -122.419, "radius_m": 804.672}
AUTH = {"Authorization": "Bearer demo-token-driver_demo"}
OWNER_AUTH = {"Authorization": "Bearer demo-token-owner_demo"}


@pytest.fixture
def seed():
    result = subprocess.run(
        ["npm", "run", "export-fixture", "--workspace", "@curb/contracts", "--silent"],
        cwd=Path(__file__).resolve().parents[3], capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def build_client(seed, now=NOW):
    from app.repositories.memory import InMemoryParkingRepository
    from app.routes.parking import get_clock, router as parking_router
    from app.routes.sessions import router as sessions_router
    from app.seed.loader import load_seed

    repository = InMemoryParkingRepository()
    asyncio.run(load_seed(repository, PublicSeedFixture.model_validate(seed)))
    app = FastAPI()
    app.state.parking_repository = repository
    app.include_router(sessions_router)
    app.include_router(parking_router)
    app.dependency_overrides[get_clock] = lambda: now
    return TestClient(app), repository


def nearby(client, headers=AUTH, **overrides):
    return client.get("/v1/parking/nearby", params={**ORIGIN, **overrides}, headers=headers)


@pytest.mark.parametrize("age,expected", [
    (0, "FRESH"), (90, "FRESH"), (90.001, "AGING"), (180, "AGING"),
    (180.001, "STALE"), (300, "STALE"), (300.001, None),
])
def test_nearby_freshness_and_expiry_leave_legal_zone(seed, age, expected):
    seed["nearby"]["spaces"] = [seed["nearby"]["spaces"][0]]
    seed["nearby"]["spaces"][0]["last_observed_at"] = (NOW - timedelta(seconds=age)).isoformat()
    client, _ = build_client(seed)

    response = nearby(client)

    assert response.status_code == 200
    parsed = NearbyParkingResponse.model_validate(response.json())
    assert parsed.zones[0].legal_status_now == "LEGAL"
    assert [s.freshness for s in parsed.spaces] == ([expected] if expected else [])


@pytest.mark.parametrize("change", ["occupied", "unknown", "illegal", "low_confidence", "far"])
def test_nearby_suppresses_unusable_openings(seed, change):
    space = seed["nearby"]["spaces"][0]
    seed["nearby"]["spaces"] = [space]
    if change == "occupied":
        space["internal_state"] = "OCCUPIED"
    elif change == "unknown":
        space["internal_state"] = "UNKNOWN"
    elif change == "illegal":
        seed["nearby"]["zones"][0]["legal_status_now"] = "ILLEGAL"
    elif change == "low_confidence":
        space["base_confidence"] = 0.2
    else:
        space["location"]["coordinates"] = [-122.5, 37.775]
    client, _ = build_client(seed)

    body = nearby(client).json()

    assert body["spaces"] == []
    assert body["zones"][0]["legal_status_now"] == ("ILLEGAL" if change == "illegal" else "LEGAL")


@pytest.mark.parametrize("change", ["unknown_no_rule", "missing_rule", "wrong_zone_rule"])
def test_nearby_shows_unsigned_openings_with_no_rule_detail(seed, change):
    """An observed opening without a validated sign is listed, and its detail has no rule."""
    zone = seed["nearby"]["zones"][0]
    seed["nearby"]["spaces"] = [seed["nearby"]["spaces"][0]]
    if change == "unknown_no_rule":
        zone["legal_status_now"] = "UNKNOWN"
        zone["sign_rule_id"] = None
    elif change == "missing_rule":
        zone["sign_rule_id"] = None
    else:
        seed["sign_rule"]["zone_id"] = "another_zone"
    client, _ = build_client(seed)

    parsed = NearbyParkingResponse.model_validate(nearby(client).json())
    response = client.get("/v1/spaces/space_demo_1", headers=AUTH)

    assert [(s.id, s.status_label) for s in parsed.spaces] == [("space_demo_1", "Likely open")]
    assert response.status_code == 200
    detail = SpaceDetail.model_validate(response.json())
    assert detail.sign_rule is None
    assert detail.max_minutes is None
    assert detail.status_label == "Likely open"


def test_nearby_still_hides_unsigned_openings_in_illegal_zones(seed):
    """Explicitly illegal curbs stay hidden even when no sign rule is attached."""
    zone = seed["nearby"]["zones"][0]
    zone["legal_status_now"] = "ILLEGAL"
    zone["sign_rule_id"] = None
    client, _ = build_client(seed)

    assert nearby(client).json()["spaces"] == []


def test_nearby_omits_outside_zones_and_driveways(seed):
    seed["nearby"]["driveways"] = seed["nearby"]["driveways"][:1]
    seed["nearby"]["zones"][0]["geometry"]["coordinates"] = [[-122.5, 37.775], [-122.51, 37.775]]
    seed["nearby"]["driveways"][0]["location"]["coordinates"] = [-122.5, 37.775]
    client, _ = build_client(seed)
    body = nearby(client).json()
    assert body["zones"] == []
    assert body["spaces"] == []
    assert body["driveways"] == []


@pytest.mark.parametrize("radius", [804, 805, 804.672001, 500, 0, -1])
def test_mobile_radius_is_exact(seed, radius):
    client, _ = build_client(seed)
    assert nearby(client, radius_m=radius).status_code == 422


def test_nearby_recomputes_distance_and_preserves_longitude_latitude(seed):
    client, _ = build_client(seed)
    body = nearby(client).json()
    assert body["spaces"][0]["location"]["coordinates"] == [-122.41955, 37.77502]
    assert 48 < body["spaces"][0]["distance_m"] < 49
    assert 20 < body["driveways"][0]["distance_m"] < 22


@pytest.mark.parametrize("state", ["UNAVAILABLE", "AVAILABLE"])
def test_driveways_only_appear_while_currently_available(seed, state):
    seed["nearby"]["driveways"] = seed["nearby"]["driveways"][:1]
    seed["nearby"]["driveways"][0]["state"] = state
    client, _ = build_client(seed, NOW + timedelta(hours=8))
    assert nearby(client).json()["driveways"] == []


@pytest.mark.parametrize("offset,visible", [
    (-3600.001, False), (-3600, True), (25199.999, True), (25200, False),
])
def test_driveway_availability_window_has_inclusive_start_exclusive_end(seed, offset, visible):
    seed["nearby"]["driveways"] = seed["nearby"]["driveways"][:1]
    client, _ = build_client(seed, NOW + timedelta(seconds=offset))
    assert bool(nearby(client).json()["driveways"]) == visible


@pytest.mark.parametrize("state", ["UNAVAILABLE", "HELD", "BOOKED"])
def test_non_available_driveway_state_is_omitted_inside_window(seed, state):
    driveway = seed["nearby"]["driveways"][0]
    seed["nearby"]["driveways"] = [driveway]
    driveway["state"] = state
    if state in {"HELD", "BOOKED"}:
        driveway["held_by_user_id"] = "another_driver"
        driveway["active_booking"] = {
            "id": "booking_demo_1", "state": "PENDING_PAYMENT" if state == "HELD" else "CONFIRMED",
            "payment_status": "NOT_STARTED" if state == "HELD" else "SETTLED",
        }
    client, _ = build_client(seed)
    assert nearby(client).json()["driveways"] == []


def test_detail_returns_canonical_rule_and_404_for_unknown_space(seed):
    client, _ = build_client(seed)
    response = client.get("/v1/spaces/space_demo_1", headers=AUTH)
    assert response.status_code == 200
    detail = SpaceDetail.model_validate(response.json())
    assert detail.id == "space_demo_1"
    assert detail.detection_confidence == 0.93
    assert detail.sign_rule.id == "sign_rule_demo_1"
    assert detail.max_minutes == 120
    assert client.get("/v1/spaces/missing", headers=AUTH).status_code == 404


def test_local_demo_seed_refreshes_observations_without_changing_fixture_data(seed):
    from app.repositories.memory import InMemoryParkingRepository
    from app.seed.loader import load_seed

    fixture = PublicSeedFixture.model_validate(seed)
    reference = datetime(2026, 10, 24, 2, tzinfo=UTC)
    repository = InMemoryParkingRepository()

    asyncio.run(load_seed(repository, fixture, refresh_observations=True, now=reference))

    refreshed = asyncio.run(repository.get_space("space_demo_1"))
    assert refreshed.last_observed_at == reference - timedelta(seconds=20)
    assert fixture.nearby.spaces[0].last_observed_at == datetime(2026, 10, 24, 0, 59, 40, tzinfo=UTC)


def test_confirmed_scan_is_saved_to_the_canonical_map_repository(seed):
    from app.models.cv import BlockObservation
    from app.routes.v1 import _persist_confirmed_scan

    client, repository = build_client(seed)
    observed_at = NOW - timedelta(seconds=20)
    scan = BlockObservation(
        segment_id="scan_segment_1", gap_count=1, confidence=0.91, detection_confidence=0.87,
        lat=37.80279, lng=-122.44935,
        location={"type": "Point", "coordinates": [-122.44935, 37.80279]},
        confirmed_at=observed_at,
    )

    asyncio.run(_persist_confirmed_scan(repository, scan))

    response = nearby(client, lat=scan.lat, lng=scan.lng)
    assert response.status_code == 200
    body = response.json()
    assert [space["id"] for space in body["spaces"]] == [scan.segment_id]
    assert body["spaces"][0]["location"]["coordinates"] == [scan.lng, scan.lat]
    assert body["spaces"][0]["detection_confidence"] == 0.87
    assert body["zones"][0]["current_rules"].startswith("Scanner-confirmed")


def test_sessions_are_idempotent_validate_profiles_and_do_not_refresh_seed(seed):
    from app.seed.loader import load_seed

    client, repository = build_client(seed)
    first = client.post("/v1/demo/sessions", json={"profile": "driver"})
    second = client.post("/v1/demo/sessions", json={"profile": "driver"})
    assert first.status_code == 200
    assert first.json() == second.json()
    assert first.json()["user"]["id"] == "driver_demo"
    assert client.post("/v1/demo/sessions", json={"profile": "owner"}).json()["user"]["id"] == "owner_demo"
    assert client.post("/v1/demo/sessions", json={"profile": "admin"}).status_code == 422
    altered = PublicSeedFixture.model_validate(seed)
    altered.nearby.spaces[0].last_observed_at = NOW
    asyncio.run(load_seed(repository, altered))
    stored = asyncio.run(repository.get_space("space_demo_1"))
    assert stored.last_observed_at == datetime(2026, 10, 24, 0, 59, 40, tzinfo=UTC)
    assert len(asyncio.run(repository.list_spaces())) == 3


def test_nearby_and_detail_require_seeded_bearer_token(seed):
    client, _ = build_client(seed)
    assert client.get("/v1/parking/nearby", params=ORIGIN).status_code == 401
    assert client.get("/v1/spaces/space_demo_1").status_code == 401
    assert client.get("/v1/parking/nearby", params=ORIGIN, headers={"Authorization": "Bearer invalid"}).status_code == 401


def test_main_registers_canonical_routes_once_without_loading_vision(seed):
    from app.main import app
    from app.routes.parking import get_clock

    client, repository = build_client(seed)
    app.state.parking_repository = repository
    app.dependency_overrides[get_clock] = lambda: NOW
    try:
        paths = [route.path for route in app.routes]
        assert paths.count("/v1/demo/sessions") == 1
        assert paths.count("/v1/parking/nearby") == 1
        assert paths.count("/v1/spaces/{space_id}") == 1
        assert paths.count("/v1/vision/detections") == 1
        assert "/v1/vision/frames" not in paths
        assert "/v1/realtime/negotiate" in paths
        response = nearby(TestClient(app))
        assert response.status_code == 200
        NearbyParkingResponse.model_validate(response.json())
    finally:
        app.dependency_overrides.pop(get_clock, None)


def test_nearby_uses_committed_marketplace_state(seed):
    from app.domain.driveways import Driveway, DrivewayService, InMemoryDrivewayRepository

    class Publisher:
        async def publish(self, event):
            pass

    view = seed["driveway"]
    driveway = Driveway.model_validate({
        **{key: value for key, value in view.items() if key not in {"active_booking", "available_now", "distance_m"}},
        "active_booking_id": None,
    })
    marketplace = InMemoryDrivewayRepository([driveway])
    service = DrivewayService(marketplace, Publisher())
    client, _ = build_client(seed)
    client.app.state.driveway_service = service
    assert [view["id"] for view in nearby(client).json()["driveways"]] == ["driveway_demo_1"]

    asyncio.run(service.start_hold("driveway_demo_1", "driver_demo", 1, NOW))

    held = nearby(client).json()["driveways"]
    assert [view["id"] for view in held] == ["driveway_demo_1"]
    assert held[0]["state"] == "HELD"
    assert held[0]["available_now"] is False


def test_owner_nearby_keeps_unavailable_listing_outside_radius_and_window(seed):
    driveway = seed["nearby"]["driveways"][0]
    seed["nearby"]["driveways"] = [driveway]
    driveway["state"] = "UNAVAILABLE"
    driveway["location"]["coordinates"] = [-122.5, 37.775]
    client, _ = build_client(seed, NOW + timedelta(days=1))

    response = nearby(client, headers=OWNER_AUTH).json()

    assert [view["id"] for view in response["driveways"]] == ["driveway_demo_1"]
    assert response["driveways"][0]["available_now"] is False


def test_zone_crossing_search_circle_is_retained_when_endpoints_are_outside(seed):
    seed["nearby"]["zones"][0]["geometry"]["coordinates"] = [[-122.44, 37.775], [-122.40, 37.775]]
    client, _ = build_client(seed)
    body = nearby(client).json()
    assert [zone["id"] for zone in body["zones"]] == ["zone_demo_1"]
    assert len(body["spaces"]) == 3
