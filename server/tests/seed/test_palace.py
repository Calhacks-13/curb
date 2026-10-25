from datetime import UTC, datetime, timedelta
from collections import Counter
from unittest.mock import AsyncMock

import pytest

from app.domain.parking import ParkingService
from app.models.domain import GeoPoint
from app.repositories.memory import InMemoryParkingRepository
from app.seed.palace import PalaceScenario, PREFIX, records

NOW = datetime(2026,10,25,12,tzinfo=UTC)


def test_fixture_has_street_aligned_closed_stalls_and_ordinary_rules():
    zones,rules,spaces = records(NOW)
    assert len(spaces)==8
    assert len({space.id for space in spaces})==8
    assert {space.internal_state.value for space in spaces}=={"OPEN"}
    assert 1 <= len(zones) <= 8
    for space in spaces:
        lng,lat=space.location.coordinates
        assert 37.800 < lat < 37.806 and -122.451 < lng < -122.444
        assert space.stall_geometry.coordinates[0][0]==space.stall_geometry.coordinates[0][-1]
        assert "demo" not in space.status_label.lower()
    assert all("demo" not in zone.current_rules.lower() for zone in zones)
    assert all(rule.evidence_text for rule in rules)
    assert len({int((NOW-space.last_observed_at).total_seconds())//90 for space in spaces})==3


@pytest.mark.asyncio
async def test_loading_is_idempotent_and_visible_through_normal_nearby_and_details():
    repository=InMemoryParkingRepository()
    publish=AsyncMock()
    scenario=PalaceScenario(repository,publish,lambda:NOW)
    first=await scenario.start(0)
    again=await scenario.start(0)
    assert first==again
    assert len(await repository.list_spaces())==8
    assert all(space.version==2 for space in await repository.list_spaces())
    service=ParkingService(repository)
    nearby=await service.nearby(GeoPoint(type="Point",coordinates=(-122.4484,37.803)),804.672,NOW)
    assert len(nearby.spaces)==first['open']
    assert Counter(space.freshness.value for space in nearby.spaces).keys()=={'FRESH','AGING','STALE'}
    for space in nearby.spaces:
        detail=await service.detail(space.id,NOW)
        assert detail is not None
        assert detail.current_rules
    assert publish.call_count==2*(len(records(NOW)[0])+8)
    later=await service.nearby(GeoPoint(type="Point",coordinates=(-122.4484,37.803)),804.672,NOW+timedelta(minutes=6))
    assert later.spaces==[]


@pytest.mark.asyncio
async def test_reset_and_refresh_leave_non_scenario_records_untouched():
    repository=InMemoryParkingRepository()
    _,_,spaces=records(NOW)
    real=spaces[1].model_copy(update={"id":"actual-scan", "zone_id":"real-zone"})
    await repository.upsert("spaces",real)
    scenario=PalaceScenario(repository,AsyncMock(),lambda:NOW)
    await scenario.start(60)
    assert scenario._refresh_task is not None
    reset=await scenario.reset()
    assert reset['retired']>0
    assert scenario._refresh_task is None
    assert await repository.get_space(real.id)==real
    assert all(space.internal_state=="UNKNOWN" for space in await repository.list_spaces() if space.id.startswith(PREFIX))
    assert (await scenario.reset())['retired']==0


def test_seed_route_requires_a_user_and_populates_the_existing_parking_api():
    import asyncio
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.models.domain import UserView
    from app.routes.palace import router
    from app.routes.parking import router as parking_router, get_clock
    repository=InMemoryParkingRepository()
    asyncio.run(repository.upsert("users",UserView(id="driver_demo",display_name="Driver",demo_profile="driver")))
    app=FastAPI()
    app.state.parking_repository=repository
    app.state.palace_scenario=PalaceScenario(repository,AsyncMock(),lambda:NOW)
    app.dependency_overrides[get_clock]=lambda:NOW
    app.include_router(router)
    app.include_router(parking_router)
    with TestClient(app) as client:
        assert client.post('/v1/demo/palace',json={"keep_fresh_seconds":0}).status_code==401
        headers={"Authorization":"Bearer demo-token-driver_demo"}
        assert client.post('/v1/demo/palace',headers=headers,json={"keep_fresh_seconds":3601}).status_code==422
        loaded=client.post('/v1/demo/palace',headers=headers,json={"keep_fresh_seconds":0})
        assert loaded.status_code==200
        nearby=client.get('/v1/parking/nearby',headers=headers,params={"lat":37.803,"lng":-122.4484})
        assert nearby.status_code==200
        assert len(nearby.json()['spaces'])==loaded.json()['open']
        space=nearby.json()['spaces'][0]
        assert client.get('/v1/spaces/'+space['id'],headers=headers).status_code==200
        assert client.post('/v1/demo/palace/reset',headers=headers).status_code==200
        assert client.get('/v1/parking/nearby',headers=headers,params={"lat":37.803,"lng":-122.4484}).json()['spaces']==[]


@pytest.mark.asyncio
async def test_driveways_are_nearby_bookable_and_not_overwritten():
    from app.seed.palace import load_driveways
    from app.wiring import build_driveway_service
    repository = InMemoryParkingRepository()
    assert await load_driveways(repository, NOW) == 3
    listings = await repository.list_driveways()
    assert len(listings) == 3
    edited = listings[0].model_copy(update={"price_usdc":"12", "version":2})
    await repository.upsert("driveways", edited)
    await load_driveways(repository, NOW)
    assert (await repository.list_driveways())[0] == edited
    service = build_driveway_service({d.id:d.model_dump(mode="json") for d in await repository.list_driveways()}, NOW)
    nearby = await ParkingService(repository, driveway_service=service).nearby(
        GeoPoint(type="Point",coordinates=(-122.4484,37.803)),804.672,NOW)
    assert len(nearby.driveways) == 3
    assert all(d.available_now for d in nearby.driveways)


@pytest.mark.asyncio
async def test_seed_refresh_does_not_reannounce_existing_openings():
    publish = AsyncMock()
    scenario = PalaceScenario(InMemoryParkingRepository(), publish, lambda:NOW)
    await scenario.start(0)
    assert any(call.args[0] == "space.opened" for call in publish.call_args_list)
    publish.reset_mock()
    await scenario.start(0)
    assert not any(call.args[0] == "space.opened" for call in publish.call_args_list)
    assert any(call.args[0] == "space.refreshed" for call in publish.call_args_list)


@pytest.mark.asyncio
async def test_smaller_scenario_retires_old_markers_without_touching_actual_data():
    from app.seed.palace import load_driveways
    from app.wiring import build_driveway_service
    repository = InMemoryParkingRepository()
    _, _, spaces = records(NOW)
    extra = spaces[0].model_copy(update={"id":PREFIX+"space:old-extra"})
    actual = extra.model_copy(update={"id":"actual-cv-opening"})
    await repository.upsert("spaces", extra)
    await repository.upsert("spaces", actual)
    await load_driveways(repository, NOW)
    sample = (await repository.list_driveways())[0]
    removed = sample.model_copy(update={"id":PREFIX+"driveway:02"})
    await repository.upsert("driveways", removed)
    await load_driveways(repository, NOW)
    await PalaceScenario(repository, AsyncMock(), lambda:NOW).start(0)
    assert (await repository.get_space(extra.id)).internal_state == "UNKNOWN"
    assert await repository.get_space(actual.id) == actual
    listings = await repository.list_driveways()
    assert next(d for d in listings if d.id == removed.id).state == "UNAVAILABLE"
    service = build_driveway_service({d.id:d.model_dump(mode="json") for d in listings}, NOW)
    nearby = await ParkingService(repository, driveway_service=service).nearby(
        GeoPoint(type="Point",coordinates=(-122.4484,37.803)),804.672,NOW)
    assert len(nearby.driveways) == 3
    assert len([s for s in nearby.spaces if s.id.startswith(PREFIX)]) == 8
