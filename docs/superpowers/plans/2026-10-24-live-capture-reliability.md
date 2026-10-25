# Live Capture Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement each task with a witnessed red/green cycle. The three product-code tasks own disjoint files and may run in parallel.

**Goal:** Make live scanning honest and recoverable when delivery fails, preserve paired space/zone self-feedback, and recognize bounded frame-edge parking gaps without creating blank-frame spots or corrupting spot lifecycle state.

**Architecture:** Keep on-device inference independent from network delivery, but expose delivery state and server-returned detection counts in the camera UI. Namespace realtime versions by entity collection rather than raw ID. Centralize pixel-gap candidate generation around real vehicle anchors plus virtual frame boundaries, while preserving multi-frame confirmation and requiring at least one current real vehicle.

**Tech Stack:** Expo SDK 58, React Native 0.88, TypeScript 6/Jest; Python 3.11+, FastAPI/Pydantic, pytest.

**Spec:** `docs/superpowers/specs/2026-10-23-curb-mvp-design.md` sections 7.2, 7.3, 7.5, 10.2, 10.3, and 10.5, plus the October 24 live-device failure report in the task request.

## Global Constraints

- Keep camera preview and CoreML inference local and responsive; never queue intermediate detection submissions.
- Empty detection submissions remain valid and must reach the server so existing tracks age correctly.
- Upload failures must not masquerade as a working live confirmation path; retries must recover automatically after a later success.
- Preserve same-type duplicate/out-of-order suppression while allowing different entity collections to share an ID and version.
- Never infer a gap from an empty/sign-only frame; frame boundaries are gap anchors, not synthetic vehicles.
- Preserve two vehicle hits and two seconds of gap stability before confirmation.
- Use `America/Los_Angeles` and the existing validated-rule visibility gate unchanged.
- Do not change generated Nitro bridge files or native CoreML model parsing in this fix.

## Review Focus

- A request that never settles must time out, release single-flight backpressure, and make later submissions possible.
- A stopped/restarted or unmounted camera must not receive stale delivery callbacks from an earlier generation.
- Same-ID zone and space updates must both apply, while stale updates within either collection remain suppressed.
- A new unconfirmed vehicle must block a candidate immediately even though it cannot anchor a candidate until confirmed.
- Expiring one of several gap keys for a segment must not mark its spot occupied while another confirmed key still supports it.

---

### Task 1: Observable, Recoverable Detection Delivery

**Files:**
- Modify: `mobile/src/api/types.ts`
- Modify: `mobile/src/api/client.ts`
- Modify: `mobile/src/features/capture/DetectionUploadController.ts`
- Modify: `mobile/src/components/CameraOverlay.tsx`
- Test: `mobile/src/__tests__/detection-client.test.ts`
- Test: `mobile/src/__tests__/capture-lifecycle.test.ts`
- Test: `mobile/src/__tests__/camera-overlay.test.tsx`
- Document: `ON_DEVICE_CV.md`
- Document: `mobile/README.md`

**Interfaces:**
- Extend `FrameAccepted` with optional `pipeline_state`, `vehicle_count`, `gap_count`, and `scene_valid` fields already returned by `POST /v1/vision/detections`.
- Add a controller callback whose immutable event distinguishes `delivered` from `failed`, includes a stats snapshot, and preserves a safe error message plus numeric HTTP status when available.
- Bound only detection uploads to 10 seconds with `AbortController`; convert timeout to `ApiError(0, ..., "request_timeout")` and always clear the timer.

- [ ] **Step 1: Write failing client tests**

Add tests proving an HTML 502 retains status 502, a never-settling detection upload aborts at 10 seconds with code `request_timeout`, and a later upload can execute normally.

- [ ] **Step 2: Run the client tests and verify RED**

Run: `cd mobile && npm test -- --runInBand src/__tests__/detection-client.test.ts`

Expected: FAIL because detection requests have no timeout-specific behavior.

- [ ] **Step 3: Implement the typed response fields and detection-only timeout**

Keep the generic API error contract. Do not apply the 10-second timeout to unrelated nearby, booking, or payment calls.

- [ ] **Step 4: Write failing controller tests**

Test delivered/failed status events, immutable stats snapshots, safe HTTP status propagation, success after failure, and suppression of stale events after stop/restart. Every rejected or timed-out request must release `inFlight`.

- [ ] **Step 5: Run controller tests and verify RED**

Run: `cd mobile && npm test -- --runInBand src/__tests__/capture-lifecycle.test.ts`

Expected: FAIL because the controller exposes no delivery callback.

- [ ] **Step 6: Implement controller delivery events**

Emit status only for the active generation. Continue inference/submission after failure; the next successful response clears the current delivery failure through a `delivered` event.

- [ ] **Step 7: Write failing camera UI tests**

Cover: waiting for the first inference; successful empty inference plus server receipt (`0 vehicles`); HTTP 502 displayed as `Upload unavailable`/retrying rather than `Live`; native detection boxes remain visible during delivery failure; later success returns to connected state; compact and expanded accessibility text; stale/unmounted settlements do not update UI.

- [ ] **Step 8: Run camera tests and verify RED**

Run: `cd mobile && npm test -- --runInBand src/__tests__/camera-overlay.test.tsx`

Expected: FAIL because upload state and server counts are not rendered.

- [ ] **Step 9: Implement the camera delivery state**

Keep native inference failures as terminal scanner errors. Delivery failure is non-terminal: change the live badge/caption to an explicit unavailable/retrying state and keep inference active. A delivered response shows server receipt and vehicle/gap counts, allowing successful zero detections to be distinguished from transport failure.

- [ ] **Step 10: Document the operational boundary**

Document that `EXPO_PUBLIC_API_URL` is inlined/cached and requires a full app reload after change; include local `/health`, public `/health`, and tunnel-process checks. Do not claim the repository can restore missing tunnel credentials.

- [ ] **Step 11: Verify Task 1**

Run: `cd mobile && npm test -- --runInBand src/__tests__/detection-client.test.ts src/__tests__/capture-lifecycle.test.ts src/__tests__/camera-overlay.test.tsx && npm run typecheck && npm run lint`

Expected: all selected tests, typecheck, and lint pass.

---

### Task 2: Entity-Scoped Realtime Versions and Same-ID Self-Feedback

**Files:**
- Modify: `mobile/src/realtime/reducer.ts`
- Modify: `mobile/src/app/(tabs)/find.tsx` only if needed to exercise the paired response path
- Test: `mobile/src/realtime/__tests__/reducer.test.ts`
- Test: `mobile/src/__tests__/find-map.test.tsx`

**Interfaces:**
- Internal version keys are `space:<id>`, `zone:<id>`, `driveway:<id>`, `booking:<id>`, and `garage:<id>`.
- Space event types share the `space` sequence; `sign_rule.updated` uses `zone`; booking payload driveway updates use `driveway`.
- No server contract or public `ParkingState` collections change.

- [ ] **Step 1: Write failing reducer tests**

Add same-ID/version space+zone events in both orders; independent version advancement; duplicate/stale suppression across `space.opened`/`space.refreshed`/`space.occupied`; nearby seeding with shared IDs; and booking+driveway shared-ID nested update coverage.

- [ ] **Step 2: Run reducer tests and verify RED**

Run: `cd mobile && npm test -- --runInBand src/realtime/__tests__/reducer.test.ts`

Expected: FAIL because `versions` is keyed only by raw entity ID.

- [ ] **Step 3: Implement entity-scoped version keys**

Use one helper for event-to-collection identity and one helper for nearby collection seeding. Do not use the complete event type as the key.

- [ ] **Step 4: Write a failing Find integration test**

Invoke the captured `CameraOverlay.onSpotConfirmed` callback with a fresh space and legal zone sharing the same ID/version, then assert both legal zone geometry and the visible stall/pill are sent to the map.

- [ ] **Step 5: Run the Find test and verify RED**

Run: `cd mobile && npm test -- --runInBand src/__tests__/find-map.test.tsx`

Expected: FAIL because one half of the paired update is currently discarded.

- [ ] **Step 6: Make the paired self-feedback path pass**

Keep both events versioned. Only change dispatch ordering if the integration test demonstrates it is required for the visible map result; do not expand this task into remote/canonical spot identity migration.

- [ ] **Step 7: Verify Task 2**

Run: `cd mobile && npm test -- --runInBand src/realtime/__tests__/reducer.test.ts src/__tests__/find-map.test.tsx && npm run typecheck && npm run lint`

Expected: all selected tests, typecheck, and lint pass.

---

### Task 3: Bounded Frame-Edge Gap Candidates and Honest Server Diagnostics

**Files:**
- Modify: `server/app/config.py`
- Modify: `server/app/cv/tracker.py`
- Modify: `server/app/cv/pipeline.py`
- Modify: `server/app/routes/v1.py`
- Test: `server/tests/test_config.py`
- Test: `server/tests/cv/test_detection_pipeline.py`
- Test: `server/tests/routes/test_detections.py`

**Interfaces:**
- Export one candidate helper from `tracker.py` that accepts ordered real boundaries `(id, bbox)` and returns keyed gap boxes; reserve `-1` for the left frame boundary and `-2` for the right.
- Add `Settings.max_edge_gap_fraction = 0.5`; require `min_gap_fraction <= max_edge_gap_fraction <= 1.0`.
- Add a bounded `SessionState.last_submission` diagnostic shown under `/v1/debug/state.sessions[session_id]` with timestamp, dimensions, submitted vehicle/sign counts, visible confirmed-track count, candidate count, consecutive empty submissions, and pipeline state.

- [ ] **Step 1: Write failing candidate/config tests**

Cover exact 15% inclusion, left and right edge candidates at or below 50%, rejection above 50%, interior gaps unaffected by the edge maximum, and no candidates for empty input. Cover invalid threshold ordering/ranges.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `./.venv/bin/python -m pytest -q server/tests/test_config.py server/tests/cv/test_detection_pipeline.py`

Expected: FAIL because edge candidates and the edge maximum do not exist.

- [ ] **Step 3: Implement the shared candidate helper and configuration**

Generate left, interior, and right candidates only when at least one current real vehicle exists. The raw frame result and `GapTracker` must consume the same helper so reported candidates match tracked candidates.

- [ ] **Step 4: Write failing tracking regressions**

Cover: one confirmed vehicle producing a stable left/right opening; empty and sign-only frames never creating or advancing a gap; unconfirmed vehicles blocking geometry but not anchoring confirmation; immediate invalidation when a visible anchor shrinks an edge below threshold; anchor dropout/recovery using the existing timeout; and two-hit/two-second confirmation retained.

- [ ] **Step 5: Run tracking tests and verify RED**

Run: `./.venv/bin/python -m pytest -q server/tests/cv/test_detection_pipeline.py`

Expected: FAIL under the current adjacent-pair-only implementation.

- [ ] **Step 6: Implement tracked edge identities and blocker semantics**

Pass all current real tracks as blockers; only confirmed real tracks may anchor candidates. Treat frame sentinels as visible for geometry invalidation without creating Track instances or a sentinel-to-sentinel blank-frame gap.

- [ ] **Step 7: Write the multi-support lifecycle regression**

Confirm two gap keys onto one segment, expire one while the other remains, and assert the spot stays open; expire the final supporting key and assert exactly one occupied transition.

- [ ] **Step 8: Fix segment support accounting**

Remove expired key mappings, register same-frame new confirmations, then occupy only segments with no remaining confirmed supporting key. This ordering must prevent a transient occupy/refresh pair in one submission.

- [ ] **Step 9: Write failing debug-state tests**

Submit a zero-vehicle frame and a vehicle frame, then assert latest-submission counts, consecutive-empty behavior, candidate count, and pipeline state. Preserve the existing accepted response fields used by the mobile telemetry.

- [ ] **Step 10: Implement bounded per-session diagnostics**

Store only the latest summary and integer counters; do not retain images, crops, or unbounded histories.

- [ ] **Step 11: Verify Task 3**

Run: `./.venv/bin/python -m pytest -q server/tests/test_config.py server/tests/cv/test_detection_pipeline.py server/tests/routes/test_detections.py`

Expected: all selected tests pass.

---

### Task 4: Integrated Verification and Runtime Recovery

**Files:**
- No required product-code ownership; reconcile the three task diffs and operational state.

- [ ] **Step 1: Review all diffs for overlap and requirement coverage**

Confirm no task changed generated Nitro code, no raw camera image is uploaded/stored, and the reducer still rejects same-entity stale events.

- [ ] **Step 2: Run the complete automated suites**

Run: `cd mobile && npm test -- --runInBand && npm run typecheck && npm run lint`

Run: `./.venv/bin/python -m pytest -q server/tests`

Expected: 0 failures. Existing Python UTC deprecation warnings may remain but must be reported.

- [ ] **Step 3: Restore the local API process**

Start the FastAPI app on port 8000 and verify `GET http://127.0.0.1:8000/health` returns 200 before starting a tunnel.

- [ ] **Step 4: Restore or explicitly report the external tunnel boundary**

Attempt the existing reserved ngrok URL only when account credentials/configuration are available. Verify public `/health` returns 200. If credentials are absent, leave the code complete and report the exact runtime blocker; do not silently replace the committed/bundled endpoint with an unverified transient URL.

- [ ] **Step 5: Device acceptance check when a connected iPhone is available**

Verify three distinguishable states: native inference error, successful `0 vehicles` delivered to server, and upload unavailable/retrying. Then verify a same-ID confirmed space+zone appears on the map and a bounded single-vehicle edge opening confirms after the configured hit/stability gates.
