# Recent Changes (Oct 24 session)

Summary for agents picking up this codebase.

## Critical Fix: Mobile Frame Streaming

React Native's `fetch` + `FormData` silently fails for binary file uploads. Switched to `expo-file-system/legacy`'s `FileSystem.uploadAsync` which does native multipart.

**File:** `mobile/src/api/client.ts` — `uploadFrame()` method

## Camera Overlay: Stop Scanning Button

Added `onStopScan` prop to `CameraOverlay.tsx`, wired in `find.tsx` via `setScanActive(false)`.

**Files:** `mobile/src/components/CameraOverlay.tsx`, `mobile/src/app/(tabs)/find.tsx`

## Seed Data at Palace of Fine Arts

Seeded 4 demo spots around Palace of Fine Arts (Baker/Bay/Lyon/Palace Dr). Seeds into both in-memory store AND Cosmos DB on startup.

**File:** `server/app/azure/cosmos.py` — `_SEED_SPOTS`, `_seed_demo_data()`, `_seed_cosmos_data()`

## Null/Undefined Crash Fixes

### Mobile
- `options.ts` — guarded `space.location?.coordinates` and `space.stall_geometry?.coordinates?.[0]` with optional chaining + fallback
- `SpaceDetailSheet.tsx` — null guard on `load.detail.space.base_confidence`
- `useSpaceDetail.ts` — validates response shape (`detail?.space` check) before treating as success
- `route.ts` — guarded `best?.geometry?.coordinates` in Mapbox directions response

### Server
- `v1.py` — `isinstance(block_sign, dict)` check before calling `.get()` on sign_rules (could be non-dict)
- `v1.py` — `get_space` endpoint: proper 404, handles spot IDs that don't match block segment_ids, builds synthetic block from spot data when needed
- `pipeline.py` — `existing.pole_reading` None check in sign dedup path (Cosmos doc may have no reading)

## Realtime Spot Payload Fix

`_spot_payload()` in `pipeline.py` now includes all fields the mobile reducer needs: `id`, `zone_id`, `stall_geometry`, `location`, `internal_state`, `last_observed_at`, `base_confidence`, `version`. Without these, mobile silently drops new spaces from Web PubSub events.

## Map Camera

Default camera center moved to Palace of Fine Arts: `[-122.4475, 37.8022]`.

**File:** `mobile/src/map/mapConfig.ts`

## Architecture Quick Reference

```
Phone (Expo) --POST /v1/vision/frames--> Server (FastAPI + YOLO)
                                          |
                                          +--> Cosmos DB (spots, blocks, signs)
                                          +--> Web PubSub broadcast (space.opened/refreshed/occupied)
                                          |
Other phones <--WSS Web PubSub-----------+
             <--GET /v1/realtime/events---+  (polling fallback)
             <--GET /v1/parking/nearby----+  (initial load)
```

Key: `FileSystem.uploadAsync` for frame upload (NOT fetch+FormData). Import from `expo-file-system/legacy`.
