import pytest

from app.azure import cosmos
from app.routes import v1

SPOT = {
    "id": "seed_spot_1",
    "segment_id": "seg_baker_bay_1",
    "status": "open",
    "confidence": 0.88,
    "gap_count": 1,
    "lat": 37.8017,
    "lng": -122.4466,
    "last_seen_at": "2026-10-24T18:00:00+00:00",
    "location": {"type": "Point", "coordinates": [-122.4466, 37.8017]},
}
BLOCK = {
    "id": "seg_baker_bay_1",
    "segment_id": "seg_baker_bay_1",
    "gap_count": 1,
    "confidence": 0.88,
    "confirmed_at": "2026-10-24T18:00:00+00:00",
    "lat": 37.8017,
    "lng": -122.4466,
    "location": {"type": "Point", "coordinates": [-122.4466, 37.8017]},
    "sign_rules": {"combined_summary": "2-hour parking until 6 PM. Free after 6 PM.", "confidence_score": 0.9},
}


@pytest.fixture
def memory_store(monkeypatch):
    monkeypatch.setattr(cosmos, "_use_memory", True)
    monkeypatch.setattr(cosmos, "_mem_spots", {SPOT["id"]: SPOT})
    monkeypatch.setattr(cosmos, "_mem_blocks", {BLOCK["segment_id"]: BLOCK})
    monkeypatch.setattr(cosmos, "_mem_signs", {}, raising=False)


@pytest.mark.asyncio
async def test_get_spot_reads_by_id(memory_store):
    assert (await cosmos.get_spot("seed_spot_1"))["segment_id"] == "seg_baker_bay_1"
    assert await cosmos.get_spot("missing") is None


@pytest.mark.asyncio
async def test_space_detail_finds_an_sf_spot_and_its_rule(memory_store):
    detail = await v1.get_space("seed_spot_1")
    assert not hasattr(detail, "status_code"), "expected a SpaceDetail, got a 404 response"
    assert detail.rule is not None
    assert detail.rule.summary == "2-hour parking until 6 PM. Free after 6 PM."


@pytest.mark.asyncio
async def test_space_detail_still_404s_for_unknown_ids(memory_store):
    response = await v1.get_space("spot_unknown")
    assert response.status_code == 404
