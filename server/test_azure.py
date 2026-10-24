"""
Quick smoke test for Azure services: Cosmos DB + Web PubSub.
Run from server/: python test_azure.py
"""

import asyncio
import sys
import os

# Ensure app is importable
sys.path.insert(0, os.path.dirname(__file__))

from app.config import settings
from app.azure import cosmos, signalr


async def test_cosmos():
    print("=" * 50)
    print("COSMOS DB")
    print("=" * 50)

    configured = bool(settings.cosmos_endpoint and settings.cosmos_key)
    print(f"  Configured: {configured}")
    if not configured:
        print("  SKIP — set CURB_COSMOS_ENDPOINT + CURB_COSMOS_KEY in .env")
        return False

    print(f"  Endpoint:   {settings.cosmos_endpoint[:40]}...")
    print(f"  Database:   {settings.cosmos_database}")
    print(f"  Containers: blocks={settings.cosmos_blocks_container}, "
          f"spots={settings.cosmos_spots_container}, signs={settings.cosmos_signs_container}")

    await cosmos.init()

    # --- Test spots container ---
    print("\n  [spots] Writing test document...")
    from app.models import SpotDocument
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    test_spot = SpotDocument(
        id="test_spot_smoke",
        segment_id="test_segment_smoke",
        status="open",
        gap_count=1,
        confidence=0.95,
        width_meters=5.5,
        location={"type": "Point", "coordinates": [-122.4194, 37.7749]},
        lat=37.7749,
        lng=-122.4194,
        opened_at=now,
        last_seen_at=now,
        version=1,
        ttl=60,  # auto-deletes in 60s
    )
    try:
        await cosmos.upsert_spot(test_spot)
        print("  [spots] Write OK")
    except Exception as e:
        print(f"  [spots] Write FAILED: {e}")
        return False

    print("  [spots] Querying nearby (37.7749, -122.4194, 500m)...")
    try:
        results = await cosmos.query_spots_nearby(37.7749, -122.4194, 500)
        found = any(r.get("id") == "test_spot_smoke" for r in results)
        print(f"  [spots] Query OK — {len(results)} results, test doc found: {found}")
    except Exception as e:
        print(f"  [spots] Query FAILED: {e}")
        return False

    # --- Test blocks container ---
    print("\n  [blocks] Writing test document...")
    from app.models import BlockObservation
    test_block = BlockObservation(
        segment_id="test_block_smoke",
        gap_count=1,
        confidence=0.9,
        confirmed_at=now,
        ttl=60,
        lat=37.7749,
        lng=-122.4194,
        location={"type": "Point", "coordinates": [-122.4194, 37.7749]},
    )
    try:
        await cosmos.upsert_block(test_block)
        print("  [blocks] Write OK")
    except Exception as e:
        print(f"  [blocks] Write FAILED: {e}")
        return False

    print("  [blocks] Reading back by segment_id...")
    try:
        doc = await cosmos.get_block("test_block_smoke")
        print(f"  [blocks] Read OK — found: {doc is not None}")
    except Exception as e:
        print(f"  [blocks] Read FAILED: {e}")
        return False

    # --- Test signs container ---
    print("\n  [signs] Querying nearby signs...")
    try:
        signs = await cosmos.query_signs_nearby(37.7749, -122.4194, 500)
        print(f"  [signs] Query OK — {len(signs)} results")
    except Exception as e:
        print(f"  [signs] Query FAILED: {e}")
        return False

    await cosmos.close()
    print("\n  COSMOS: ALL TESTS PASSED")
    return True


async def test_webpubsub():
    print("\n" + "=" * 50)
    print("WEB PUBSUB")
    print("=" * 50)

    configured = bool(settings.webpubsub_connection_string)
    print(f"  Configured: {configured}")
    if not configured:
        print("  SKIP — set CURB_WEBPUBSUB_CONNECTION_STRING in .env")
        print("  (Polling fallback via /v1/realtime/events will still work)")
        return None  # Not a failure, just not configured

    await signalr.init()

    # Test client URL generation
    print("  Generating client URL...")
    try:
        url = await signalr.get_client_url("test_user")
        if url:
            print(f"  Client URL OK: {url[:60]}...")
        else:
            print("  Client URL returned None — check connection string")
            return False
    except Exception as e:
        print(f"  Client URL FAILED: {e}")
        return False

    # Test event broadcast
    print("  Broadcasting test event...")
    try:
        await signalr.broadcast_realtime_event(
            event_type="space.opened",
            entity_id="test_spot_smoke",
            payload={"id": "test_spot_smoke", "status": "open", "lat": 37.7749, "lng": -122.4194},
            entity_version=1,
        )
        print("  Broadcast OK")
    except Exception as e:
        print(f"  Broadcast FAILED: {e}")
        return False

    # Test polling endpoint
    events = signalr.get_recent_events(0)
    print(f"  In-memory event log: {len(events)} events")
    test_found = any(e.get("entity_id") == "test_spot_smoke" for e in events)
    print(f"  Test event in log: {test_found}")

    await signalr.close()
    print("\n  WEB PUBSUB: ALL TESTS PASSED")
    return True


async def test_polling_fallback():
    print("\n" + "=" * 50)
    print("POLLING FALLBACK (always works, no Azure needed)")
    print("=" * 50)

    # Reset signalr module state for clean test
    signalr._event_log.clear()
    signalr._event_seq = 0

    # Broadcast without Web PubSub — should store in memory
    await signalr.broadcast_realtime_event(
        event_type="space.opened",
        entity_id="poll_test_1",
        payload={"id": "poll_test_1", "zone_id": "seg_1", "internal_state": "OPEN",
                 "stall_geometry": {"type": "Polygon", "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]]}},
        entity_version=1,
    )
    await signalr.broadcast_realtime_event(
        event_type="space.refreshed",
        entity_id="poll_test_1",
        payload={"id": "poll_test_1", "internal_state": "OPEN"},
        entity_version=2,
    )

    events = signalr.get_recent_events(0)
    print(f"  Events stored: {len(events)} (expected 2)")
    assert len(events) == 2, f"Expected 2 events, got {len(events)}"

    events_since_1 = signalr.get_recent_events(1)
    print(f"  Events since seq=1: {len(events_since_1)} (expected 1)")
    assert len(events_since_1) == 1, f"Expected 1 event, got {len(events_since_1)}"

    print(f"  Event types: {[e['type'] for e in events]}")
    print(f"  Versions: {[e['entity_version'] for e in events]}")

    print("\n  POLLING FALLBACK: PASSED")
    return True


async def main():
    print("\nCurb Azure Smoke Tests")
    print(f"Working dir: {os.getcwd()}")
    print()

    cosmos_ok = await test_cosmos()
    pubsub_ok = await test_webpubsub()
    poll_ok = await test_polling_fallback()

    print("\n" + "=" * 50)
    print("SUMMARY")
    print("=" * 50)
    print(f"  Cosmos DB:        {'PASS' if cosmos_ok else 'SKIP' if cosmos_ok is False and not (settings.cosmos_endpoint and settings.cosmos_key) else 'FAIL'}")
    print(f"  Web PubSub:       {'PASS' if pubsub_ok else 'SKIP (polling works)' if pubsub_ok is None else 'FAIL'}")
    print(f"  Polling fallback: {'PASS' if poll_ok else 'FAIL'}")
    print()


if __name__ == "__main__":
    asyncio.run(main())
