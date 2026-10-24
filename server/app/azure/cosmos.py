"""
Async Cosmos DB wrapper.

Two containers:
  - blocks: partition key /segment_id, TTL per document
  - signs: partition key /grid_key, no TTL (permanent)

Graceful fallback: if endpoint is empty, all operations are no-ops.
"""

import math

from app.config import settings
from app.models import BlockObservation, SignDocument, SignRules, SpotDocument

_client = None
_blocks_container = None
_spots_container = None
_signs_container = None

# In-memory fallback stores for local dev (no Cosmos configured)
_mem_blocks: dict[str, dict] = {}
_mem_spots: dict[str, dict] = {}
_mem_signs: dict[str, dict] = {}
_mem_driveways: dict[str, dict] = {}
_mem_garages: dict[str, dict] = {}
_use_memory: bool = False


def _is_configured() -> bool:
    return bool(settings.cosmos_endpoint and settings.cosmos_key)


async def init() -> None:
    global _client, _blocks_container, _spots_container, _signs_container, _use_memory
    if not _is_configured():
        _use_memory = True
        _seed_demo_data()
        return

    from azure.cosmos.aio import CosmosClient
    _client = CosmosClient(settings.cosmos_endpoint, settings.cosmos_key)
    db = _client.get_database_client(settings.cosmos_database)
    _blocks_container = db.get_container_client(settings.cosmos_blocks_container)
    _spots_container = db.get_container_client(settings.cosmos_spots_container)
    _signs_container = db.get_container_client(settings.cosmos_signs_container)
    await _seed_cosmos_data()


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


async def upsert_spot(spot: SpotDocument) -> None:
    """Upsert a SpotDocument (partition key = segment_id)."""
    doc = spot.model_dump(mode="json")
    doc["location"] = {"type": "Point", "coordinates": [spot.lng, spot.lat]}
    if _use_memory:
        _mem_spots[spot.id] = doc
        return
    if _spots_container is None:
        return
    await _spots_container.upsert_item(doc)


def get_spot_by_segment_mem(segment_id: str) -> dict | None:
    """Find an OPEN spot in memory by segment_id (demo fast-path)."""
    for doc in _mem_spots.values():
        if doc.get("segment_id") == segment_id and doc.get("status") == "open":
            return doc
    return None


async def query_spots_nearby(
    lat: float, lng: float, radius_m: float = 500
) -> list[dict]:
    if _use_memory:
        return _mem_nearby(_mem_spots, lat, lng, radius_m)
    if _spots_container is None:
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
    async for item in _spots_container.query_items(query, parameters=params):
        items.append(item)
    return items


async def upsert_sign(
    grid_key: str, sign_rules: SignRules, lat: float = 0.0, lng: float = 0.0
) -> None:
    """Legacy sign upsert (grid_key based)."""
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


async def upsert_sign_document(sign_doc: SignDocument) -> None:
    """Store a geo-mapped sign document (road_segment_id partitioned)."""
    doc = sign_doc.model_dump(mode="json")
    doc["location"] = {
        "type": "Point",
        "coordinates": [sign_doc.lng, sign_doc.lat],
    }
    if _use_memory:
        _mem_signs[sign_doc.id] = doc
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


async def query_driveways_nearby(
    lat: float, lng: float, radius_m: float = 500
) -> list[dict]:
    if _use_memory:
        return _mem_nearby(_mem_driveways, lat, lng, radius_m)
    # No Cosmos container for driveways yet — in-memory only for demo
    return _mem_nearby(_mem_driveways, lat, lng, radius_m)


async def query_garages_nearby(
    lat: float, lng: float, radius_m: float = 1500
) -> list[dict]:
    return _mem_nearby(_mem_garages, lat, lng, radius_m)


async def get_block(segment_id: str) -> dict | None:
    if _use_memory:
        return _mem_blocks.get(segment_id)
    if _blocks_container is None:
        return None
    try:
        return await _blocks_container.read_item(segment_id, partition_key=segment_id)
    except Exception:
        return None


async def delete_seed_spots(spot_id: str | None = None) -> int:
    """Delete seed spots from Cosmos (and in-memory). Returns count deleted."""
    deleted = 0

    if _use_memory:
        to_del = []
        for sid, doc in _mem_spots.items():
            if doc.get("is_seed"):
                if spot_id is None or sid == spot_id:
                    to_del.append(sid)
        for sid in to_del:
            _mem_spots.pop(sid, None)
        # Also clean blocks
        block_del = []
        for bid, doc in _mem_blocks.items():
            if doc.get("ttl") == -1 and doc.get("is_seed"):
                if spot_id is None:
                    block_del.append(bid)
        for bid in block_del:
            _mem_blocks.pop(bid, None)
        return len(to_del)

    if _spots_container is None:
        return 0

    # Query seed spots from Cosmos
    if spot_id:
        query = "SELECT * FROM c WHERE c.is_seed = true AND c.id = @id"
        params = [{"name": "@id", "value": spot_id}]
    else:
        query = "SELECT * FROM c WHERE c.is_seed = true"
        params = []

    async for item in _spots_container.query_items(query, parameters=params):
        try:
            await _spots_container.delete_item(
                item["id"], partition_key=item.get("segment_id", item["id"])
            )
            deleted += 1
        except Exception:
            pass

    return deleted


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


def _seed_demo_data() -> None:
    """Populate in-memory stores with Marina demo spots so the map isn't blank on startup."""
    import logging
    from datetime import datetime, timezone

    logger = logging.getLogger(__name__)
    now = datetime.now(timezone.utc).isoformat()

    SEED_SPOTS = [{**s, "opened_at": now, "last_seen_at": now, "version": 1} for s in _SEED_SPOTS]

    for spot in SEED_SPOTS:
        lng, lat = spot["lng"], spot["lat"]
        d = 0.00003
        doc = {
            **spot,
            "location": {"type": "Point", "coordinates": [lng, lat]},
            "stall_geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [lng - d, lat - d], [lng + d, lat - d],
                    [lng + d, lat + d], [lng - d, lat + d],
                    [lng - d, lat - d],
                ]],
            },
        }
        _mem_spots[spot["id"]] = doc
        # Also seed as a block so zones show up
        block_doc = {
            "id": spot["segment_id"],
            "segment_id": spot["segment_id"],
            "gap_count": 1, "confidence": spot["confidence"],
            "confirmed_at": now, "ttl": 1800,
            "lat": lat, "lng": lng,
            "location": {"type": "Point", "coordinates": [lng, lat]},
            "sign_rules": {"combined_summary": "2-hour parking until 6 PM. Free after 6 PM.", "confidence_score": 0.9},
        }
        _mem_blocks[spot["segment_id"]] = block_doc

    for dw in _SEED_DRIVEWAYS:
        lng, lat = dw["lng"], dw["lat"]
        doc = {**dw, "location": {"type": "Point", "coordinates": [lng, lat]}}
        _mem_driveways[dw["id"]] = doc

    for g in _SEED_GARAGES:
        lng, lat = g["lng"], g["lat"]
        doc = {**g, "location": {"type": "Point", "coordinates": [lng, lat]}}
        _mem_garages[g["id"]] = doc

    logger.info("Seeded %d spots + %d driveways + %d garages into memory", len(SEED_SPOTS), len(_SEED_DRIVEWAYS), len(_SEED_GARAGES))


# Shared seed data used by both in-memory and Cosmos paths
_SEED_SPOTS = [
    # Palace of Fine Arts area — Baker St, Bay St, Lyon St
    # seed_age_sec controls freshness color: ≤90s green, ≤180s yellow, ≤300s gray
    {"id": "seed_spot_1", "segment_id": "seg_baker_bay_1", "status": "open", "gap_count": 1,
     "confidence": 0.88, "lat": 37.80190, "lng": -122.44720, "width_meters": 5.8, "seed_age_sec": 30},
    {"id": "seed_spot_2", "segment_id": "seg_bay_lyon_1", "status": "open", "gap_count": 1,
     "confidence": 0.84, "lat": 37.80240, "lng": -122.44630, "width_meters": 6.1, "seed_age_sec": 120},
    {"id": "seed_spot_3", "segment_id": "seg_palace_dr_1", "status": "open", "gap_count": 1,
     "confidence": 0.91, "lat": 37.80150, "lng": -122.44850, "width_meters": 5.5, "seed_age_sec": 10},
    {"id": "seed_spot_4", "segment_id": "seg_lyon_jefferson_1", "status": "open", "gap_count": 1,
     "confidence": 0.80, "lat": 37.80310, "lng": -122.44550, "width_meters": 5.2, "seed_age_sec": 220},
]


_SEED_GARAGES = [
    {"id": "seed_garage_1", "lat": 37.80050, "lng": -122.44900,
     "name": "Palace of Fine Arts Garage", "summary": "Public parking, $3/hr, 120 spaces",
     "price": "$3/hr", "arrow_direction": "right", "sign_category": "garage", "version": 1},
    {"id": "seed_garage_2", "lat": 37.80350, "lng": -122.44400,
     "name": "Marina Blvd Parking Lot", "summary": "Open lot, $2/hr, first hour free",
     "price": "$2/hr", "arrow_direction": None, "sign_category": "lot", "version": 1},
]

_SEED_DRIVEWAYS = [
    # Private driveways near Palace of Fine Arts — purple on map
    {"id": "driveway_demo_1", "owner_id": "owner_demo",
     "lat": 37.80170, "lng": -122.44680,
     "photo_url": None, "price_usdc": "8",
     "availability_start": "00:00", "availability_end": "23:59",
     "availability_timezone": "America/Los_Angeles",
     "state": "AVAILABLE", "held_by_user_id": None, "version": 1},
    {"id": "driveway_demo_2", "owner_id": "owner_demo",
     "lat": 37.80280, "lng": -122.44770,
     "photo_url": None, "price_usdc": "6",
     "availability_start": "00:00", "availability_end": "23:59",
     "availability_timezone": "America/Los_Angeles",
     "state": "AVAILABLE", "held_by_user_id": None, "version": 1},
]


async def _seed_cosmos_data() -> None:
    """Upsert seed spots + blocks into Cosmos so the app has data on startup."""
    import logging
    from datetime import datetime, timezone

    logger = logging.getLogger(__name__)
    now = datetime.now(timezone.utc).isoformat()

    for spot in _SEED_SPOTS:
        lng, lat = spot["lng"], spot["lat"]
        d = 0.00003
        spot_doc = {
            **spot,
            "opened_at": now, "last_seen_at": now, "version": 1, "ttl": -1,
            "location": {"type": "Point", "coordinates": [lng, lat]},
        }
        block_doc = {
            "id": spot["segment_id"],
            "segment_id": spot["segment_id"],
            "gap_count": 1, "confidence": spot["confidence"],
            "confirmed_at": now, "ttl": -1,
            "lat": lat, "lng": lng,
            "location": {"type": "Point", "coordinates": [lng, lat]},
            "sign_rules": {"combined_summary": "2-hour parking until 6 PM. Free after 6 PM.", "confidence_score": 0.9},
        }
        try:
            if _spots_container:
                await _spots_container.upsert_item(spot_doc)
            if _blocks_container:
                await _blocks_container.upsert_item(block_doc)
        except Exception:
            logger.debug("Seed upsert failed for %s", spot["id"], exc_info=True)

    # Driveways go into in-memory store (no Cosmos container for driveways yet)
    for dw in _SEED_DRIVEWAYS:
        lng, lat = dw["lng"], dw["lat"]
        _mem_driveways[dw["id"]] = {**dw, "location": {"type": "Point", "coordinates": [lng, lat]}}

    logger.info("Seeded %d demo spots + blocks + %d driveways", len(_SEED_SPOTS), len(_SEED_DRIVEWAYS))
