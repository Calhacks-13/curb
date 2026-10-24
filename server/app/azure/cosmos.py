"""
Async Cosmos DB wrapper.

Two containers:
  - blocks: partition key /segment_id, TTL per document
  - signs: partition key /grid_key, no TTL (permanent)

Graceful fallback: if endpoint is empty, all operations are no-ops.
"""

import math

from app.config import settings
from app.models import BlockObservation, SignRules

_client = None
_blocks_container = None
_signs_container = None

# In-memory fallback stores for local dev (no Cosmos configured)
_mem_blocks: dict[str, dict] = {}
_mem_signs: dict[str, dict] = {}
_use_memory: bool = False


def _is_configured() -> bool:
    return bool(settings.cosmos_endpoint and settings.cosmos_key)


async def init() -> None:
    global _client, _blocks_container, _signs_container, _use_memory
    if not _is_configured():
        _use_memory = True
        return

    from azure.cosmos.aio import CosmosClient
    _client = CosmosClient(settings.cosmos_endpoint, settings.cosmos_key)
    db = _client.get_database_client(settings.cosmos_database)
    _blocks_container = db.get_container_client(settings.cosmos_blocks_container)
    _signs_container = db.get_container_client(settings.cosmos_signs_container)


async def close() -> None:
    global _client
    if _client is not None:
        await _client.close()
        _client = None


async def upsert_block(observation: BlockObservation) -> None:
    doc = observation.model_dump(mode="json")
    doc["id"] = observation.segment_id
    doc["ttl"] = observation.ttl
    doc["location"] = {
        "type": "Point",
        "coordinates": [observation.lng, observation.lat],
    }
    if _use_memory:
        _mem_blocks[observation.segment_id] = doc
        return
    if _blocks_container is None:
        return
    await _blocks_container.upsert_item(doc)


async def upsert_sign(
    grid_key: str, sign_rules: SignRules, lat: float = 0.0, lng: float = 0.0
) -> None:
    doc = sign_rules.model_dump(mode="json")
    doc["id"] = grid_key
    doc["grid_key"] = grid_key
    doc["location"] = {
        "type": "Point",
        "coordinates": [lng, lat],
    }
    if _use_memory:
        _mem_signs[grid_key] = doc
        return
    if _signs_container is None:
        return
    await _signs_container.upsert_item(doc)


async def query_blocks_nearby(
    lat: float, lng: float, radius_m: float = 500
) -> list[dict]:
    if _use_memory:
        return _mem_nearby(_mem_blocks, lat, lng, radius_m)
    if _blocks_container is None:
        return []
    query = (
        "SELECT * FROM c WHERE "
        "ST_DISTANCE(c.location, {'type': 'Point', 'coordinates': [@lng, @lat]}) < @radius"
    )
    params = [
        {"name": "@lat", "value": lat},
        {"name": "@lng", "value": lng},
        {"name": "@radius", "value": radius_m},
    ]
    items = []
    async for item in _blocks_container.query_items(query, parameters=params):
        items.append(item)
    return items


async def query_signs_nearby(
    lat: float, lng: float, radius_m: float = 200
) -> list[dict]:
    if _use_memory:
        return _mem_nearby(_mem_signs, lat, lng, radius_m)
    if _signs_container is None:
        return []
    query = (
        "SELECT * FROM c WHERE "
        "ST_DISTANCE(c.location, {'type': 'Point', 'coordinates': [@lng, @lat]}) < @radius"
    )
    params = [
        {"name": "@lat", "value": lat},
        {"name": "@lng", "value": lng},
        {"name": "@radius", "value": radius_m},
    ]
    items = []
    async for item in _signs_container.query_items(query, parameters=params):
        items.append(item)
    return items


async def get_block(segment_id: str) -> dict | None:
    if _use_memory:
        return _mem_blocks.get(segment_id)
    if _blocks_container is None:
        return None
    try:
        return await _blocks_container.read_item(segment_id, partition_key=segment_id)
    except Exception:
        return None


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Approximate distance in meters between two GPS points."""
    R = 6_371_000
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _mem_nearby(store: dict[str, dict], lat: float, lng: float, radius_m: float) -> list[dict]:
    """Filter in-memory store by distance."""
    results = []
    for doc in store.values():
        loc = doc.get("location", {})
        coords = loc.get("coordinates", [0, 0])
        if _haversine_m(lat, lng, coords[1], coords[0]) <= radius_m:
            results.append(doc)
    return results
