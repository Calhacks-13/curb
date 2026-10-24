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

## Driveways (Purple Spots)

Added 2 demo driveways near Palace of Fine Arts. These show as purple bays on the map with a "Reserve for $X" flow (hold -> payment -> confirmed -> route).

- `server/app/azure/cosmos.py` — `_SEED_DRIVEWAYS` array, `_mem_driveways` store, `query_driveways_nearby()`
- `server/app/routes/v1.py` — `_driveway_to_view()` helper, wired into `/v1/parking/nearby` response

The mobile already had the full driveway UI: `DrivewayDetailSheet` -> `PaymentSheet` -> `BookingConfirmation` -> "Route here". It just needed server data.

## Color Coding (Map Semantics)

| Color | StallKind | Meaning |
|---|---|---|
| Green | `fresh` | Likely open (seen <=90s ago) |
| Yellow | `aging` | May still be open (<=3min) |
| Gray | `stale` | Stale observation (<=5min) |
| Blue | zone line | Legal zone, availability unknown |
| Purple | `driveway` | Guaranteed private spot after payment |

Defined in `mobile/src/map/curbLayers.ts` and `mobile/src/config/tokens.ts`.

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

---

## Demo Strategy: Palace of Fine Arts Drive + Dynamic Demo

**Goal:** Map the entire parking around POFA with one slow drive, then show dynamic open-to-occupied transitions with a person outside.

**Recommendation (from advisor):** Prioritize the open-to-occupied transition and the sign changing the map. Those two moments prove the system understands both what is physically happening and what it means. The agent demo then shows what that intelligence enables, rather than distracting from the technology you've already built.

### Driving Speed Analysis

The tracking pipeline needs temporal stability to confirm gaps:

| Speed | Effective FPS (through tunnel) | Same car pair visible | Gap confirms? |
|---|---|---|---|
| Parked / walking | ~1.5-2 fps | 5-10+ seconds | Yes, reliably |
| Creeping 5 mph | ~1 fps | 3-5 seconds | Yes, with tuned config |
| 10 mph | ~0.5-1 fps | 2-3 seconds | Marginal |
| 15+ mph | ~0.5 fps | 1-2 seconds | No — IoU breaks, pairs shift too fast |

**Why it breaks at speed:** `GapTracker` identifies gaps by `(left_track_id, right_track_id)`. As you drive, cars enter/leave frame rapidly. IoU matching fails when objects shift too far between frames (at 15 mph, ~11m/s, objects move 11-22 pixels between 0.5 fps frames). New track IDs get assigned every frame → gap pairs never persist → nothing confirms.

**Recommended approach for the drive:** Crawl at 5-10 mph, or better, stop for 2-3 seconds at each block face. The POFA loop has ~8-10 block faces — stopping briefly at each adds ~30s total.

### Config Tuning for Demo

These config changes improve reliability while driving slowly:

| Setting | Current | Recommended | Why |
|---|---|---|---|
| `gap_confirm_sec` | 2.0 | 1.0 | Confirm gaps faster before driving past |
| `gap_expire_sec` | 1.5 | 3.0 | Survive dropped frames / brief occlusions |
| `track_iou_threshold` | 0.2 | 0.1 | Allow larger inter-frame shifts |
| `track_max_age` | 5 | 8 | Keep tracks alive through frame drops |

### Connection Architecture Under Driving Conditions

```
Phone captures 720p JPEG every 500ms
  → FileSystem.uploadAsync (native multipart, reliable)
  → cloudflared HTTPS tunnel (50-150ms RTT)
  → FastAPI: YOLO-seg (~200-400ms GPU, longer CPU)
  → HTTP response (pipeline_state, vehicle_count, optional space)
  → Total round-trip: 300-600ms best case

Backpressure: CaptureController drops frames if previous upload
is still in-flight. No queue buildup. Graceful degradation.

Cellular risk: Tower handoff during drive may cause 1-2s gap.
Tracker state partially resets but recovers on next frame.
```

**Viewer relay is blocking** — `v1.py` sends frames to `/ws/viewer` clients synchronously in the upload handler. If viewer WebSocket is slow, it delays the HTTP response back to the phone, which delays the next capture. Should be moved to `asyncio.create_task` (fire-and-forget) for the drive.

### Spot Propagation to Map Phone

Via Azure Web PubSub (the configured transport):
1. Gap confirmed on server → `SpotManager.open_spot()` → Cosmos upsert + `broadcast_realtime_event()`
2. Server POSTs `space.opened` event to Web PubSub REST API (~100-200ms)
3. Azure fans out over WSS to all connected phones (~50-100ms)
4. Mobile reducer applies event → spot appears on map

**Latency: ~200-300ms after confirmation** (plus the 2s confirmation window itself). Effectively real-time.

The scanning phone also gets immediate feedback: the upload response includes `space` and `zone` fields when a spot confirms (`v1.py:400-403`).

Polling (`GET /v1/realtime/events`) is only a fallback if Web PubSub connection fails 3 times consecutively (`POLL_FALLBACK_AFTER = 3` in `webPubSub.ts`).

### Sign Detection Limitation

Sign detection uses **COCO class 11 (stop sign)** as a proxy. This only detects octagonal red stop signs — it will NOT detect rectangular parking signs, meters, or street cleaning signs. The fine-tuned model (`yolov8m-signs.pt`) does not exist.

**For the demo:** Sign reading won't fire on parking signs. The gap detection + spot lifecycle is the core story. If sign-changes-map is needed, options:
- Add a manual `/v1/debug/inject-sign` endpoint for demo theatrics
- Accept that signs are a future feature
- Point camera at an actual stop sign to prove the pipeline works end-to-end

### Demo Choreography

**Phase 1 — Static mapping (the drive):**
1. Start server + tunnel + viewer
2. Open Expo app → Find Parking → camera streams
3. Drive/walk POFA loop slowly, pausing at each block face
4. Viewer shows green vehicle boxes + gap confirmations
5. Map phone shows spots appearing in real-time (2-4s delay)

**Phase 2 — Dynamic transitions (person outside):**
1. Park scanning phone pointing at a mapped spot (camera stationary)
2. Second phone shows map with green spot
3. Someone parks in the spot → gap disappears → `space.occupied` event
4. Map spot turns gray/disappears within seconds
5. Car leaves → gap reappears → `space.opened` → green dot returns

This is the money shot: the system sees the physical change AND updates the map.

### Things That Could Go Wrong

| Risk | Likelihood | Mitigation |
|---|---|---|
| Tunnel drops mid-drive | Low | cloudflared auto-reconnects; phone just drops frames |
| GPS drift indoors/tunnels | N/A at POFA | Open sky, GPS is fine |
| YOLO misses cars (sun glare, angle) | Medium | Test in advance, seg model handles partial occlusion |
| Gap confirms on non-parking space (driveway, crosswalk) | Medium | Accept for demo — shows system detects ALL gaps |
| Phone overheats from camera + upload | Low | 2-3 min drive is fine |
| Viewer falls behind (slow WS) | Medium | Fix: make relay fire-and-forget |
