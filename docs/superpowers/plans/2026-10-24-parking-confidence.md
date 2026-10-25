# Parking-Spot Confidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give drivers one consistent, age-decaying parking-open confidence percentage on the map, nearby list, spot details, and active route, backed by measured gap evidence.

**Architecture:** The server owns the confidence at observation time and persists both the aggregate base value and its vehicle-detection component. The mobile app owns a pure five-minute linear age decay and uses the same rounded percentage across every surface. Realtime refreshes replace the evidence and timestamp; no periodic server broadcasts are needed.

**Tech Stack:** Python 3.11, FastAPI, Pydantic 2, pytest, TypeScript, Zod, React Native 0.88, Expo 58, Jest, Testing Library

**Spec:** `docs/superpowers/specs/2026-10-24-parking-confidence-design.md`

## Global Constraints

- The displayed score is confidence that the space is still open now; route ETA never enters the formula.
- Server formula: `base_confidence = clamp(0.8 * detection_confidence + 0.2 * min(1, observation_count / 5), 0, 1)`.
- Client formula: `round(100 * base_confidence * max(0, 1 - age_seconds / 300))`.
- Future timestamps clamp age to zero; invalid or missing timestamps exclude the curb space.
- A curb space disappears after more than 300 seconds without a refresh.
- Legacy records missing `detection_confidence` normalize to `0`; a real refresh replaces it.
- Map and list copy is `{percent}% open`; do not add “Likely open” beneath the detail percentage.
- Spot details show observation age, detection confidence, parking-rule confidence, and the interpreted rule.
- Do not show location accuracy or the removed computer-vision/check-sign disclaimer.
- Route changes always require driver confirmation; a displayed score below 50% triggers the alternative prompt.
- Suggested curb alternatives must display at least 50%; driveway behavior is unchanged.

## Review Focus

- A legacy stored space lacks `detection_confidence`: contract, HTTP, and realtime normalization must expose `0`, covered in Task 1.
- A confirmed gap loses or cannot resolve a real boundary track: it must publish no invented confidence, covered in Task 2.
- A timestamp is future, invalid, missing, exactly 300 seconds old, or just beyond 300 seconds: decay and visibility must remain deterministic, covered in Task 3.
- A routed target computes 49.6% but displays 50%: replacement must follow the displayed `50`, covered in Task 5.
- A realtime refresh raises confidence during an active route: the route card must use the new evidence without changing the route or emitting a false drop announcement, covered in Task 5.

---

### Task 1: Carry Detection Confidence Through Every Contract

**Files:**
- Modify: `packages/contracts/src/domain.ts`
- Modify: `packages/contracts/src/fixtures.ts`
- Modify: `packages/contracts/src/contracts.test.ts`
- Modify: `server/app/models/domain.py`
- Modify: `server/app/models/cv.py`
- Modify: `server/app/routes/v1.py`
- Modify: `server/tests/test_contract_parity.py`
- Modify: `server/tests/routes/test_detections.py`
- Modify: `server/tests/routes/test_parking.py`
- Modify: `mobile/src/api/types.ts`
- Modify: `mobile/src/api/normalize.ts`
- Modify: `mobile/src/realtime/reducer.ts`
- Modify: `mobile/src/demo/fixtures.ts`
- Modify: `mobile/src/demo/demoApi.ts`
- Modify: `mobile/src/__tests__/http-client.test.ts`
- Modify: `mobile/src/realtime/__tests__/reducer.test.ts`

**Interfaces:**
- Consumes: Existing `ParkingSpaceView`, `BlockObservation`, `SpotDocument`, HTTP normalizers, and realtime reducer.
- Produces: `detection_confidence: float` / `number` constrained to `[0, 1]`, with `0` as the legacy-record default.

- [ ] **Step 1: Write failing shared-contract tests**

Add assertions that every seeded parking space has an explicit `detection_confidence`, values outside `[0, 1]` fail, and parsing a legacy space with the field removed yields `detection_confidence: 0`.

- [ ] **Step 2: Run the contract tests and verify they fail**

Run: `npm test --workspace @curb/contracts`

Expected: FAIL because `ParkingSpaceViewSchema` and fixtures do not define `detection_confidence`.

- [ ] **Step 3: Add the shared and server model fields**

Use `detection_confidence: z.number().min(0).max(1).default(0)` in `ParkingSpaceViewSchema`. Add `detection_confidence: float = Field(default=0, ge=0, le=1)` to `ParkingSpaceView`, `BlockObservation`, and `SpotDocument`, plus the local `/v1` `ParkingSpace` model. Give all deterministic demo spaces explicit nonzero sample values.

- [ ] **Step 4: Write failing transport and compatibility tests**

In server route tests, assert detection self-feedback, canonical persistence, nearby responses, and detail responses include the field. In mobile tests, assert missing HTTP and realtime fields normalize to `0`, while explicit values survive unchanged.

- [ ] **Step 5: Run the focused transport tests and verify they fail**

Run: `PYTHONPATH=server .venv/bin/python -m pytest -c server/pytest.ini server/tests/test_contract_parity.py server/tests/routes/test_detections.py server/tests/routes/test_parking.py -q`

Run: `npm test --workspace mobile -- --runInBand src/__tests__/http-client.test.ts src/realtime/__tests__/reducer.test.ts`

Expected: FAIL because conversions and normalizers do not carry or default the field.

- [ ] **Step 6: Implement transport normalization**

Update `_block_to_space`, `_spot_to_space`, and `_persist_confirmed_scan` to copy `detection_confidence`. Add a focused mobile `normalizeParkingSpace(...)` helper inside `normalize.ts`, use it for nearby/detail responses, and default missing realtime space payloads in the reducer before storing them.

- [ ] **Step 7: Run contract, server, and mobile focused tests**

Run the commands from Steps 2 and 5.

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/domain.ts packages/contracts/src/fixtures.ts packages/contracts/src/contracts.test.ts server/app/models/domain.py server/app/models/cv.py server/app/routes/v1.py server/tests/test_contract_parity.py server/tests/routes/test_detections.py server/tests/routes/test_parking.py mobile/src/api/types.ts mobile/src/api/normalize.ts mobile/src/realtime/reducer.ts mobile/src/demo/fixtures.ts mobile/src/demo/demoApi.ts mobile/src/__tests__/http-client.test.ts mobile/src/realtime/__tests__/reducer.test.ts
git commit -m "feat: carry parking detection confidence"
```

### Task 2: Score Confirmed Gaps and Refresh Stored Evidence

**Files:**
- Create: `server/app/cv/confidence.py`
- Create: `server/tests/cv/test_gap_confidence.py`
- Modify: `server/app/cv/tracker.py`
- Modify: `server/app/cv/pipeline.py`
- Modify: `server/tests/cv/test_detection_pipeline.py`

**Interfaces:**
- Consumes: Task 1 fields on `SpotDocument` and `BlockObservation`; `TrackedGap.gap_key`; current `Track.confidence`.
- Produces: immutable `GapConfidence(base_confidence: float, detection_confidence: float)`, `score_gap(gap: TrackedGap, tracks: list[Track]) -> GapConfidence | None`, and `choose_gap_evidence(gaps: list[TrackedGap], tracks: list[Track]) -> tuple[TrackedGap, GapConfidence] | None`.

- [ ] **Step 1: Write failing unit tests for observation counting and scoring**

Cover: a new gap starts at one observation; each active update increments once; an interior gap uses the weaker boundary confidence; an edge gap uses its one real anchor; stability caps at five observations; values stay within `[0, 1]`; an unresolved real boundary returns `None`.

- [ ] **Step 2: Run the scoring tests and verify they fail**

Run: `PYTHONPATH=server .venv/bin/python -m pytest -c server/pytest.ini server/tests/cv/test_gap_confidence.py -q`

Expected: FAIL because `observation_count` and `app.cv.confidence` do not exist.

- [ ] **Step 3: Implement `TrackedGap.observation_count` and the scoring module**

Initialize the counter to `1`, increment only when that gap key is active in a submitted frame, ignore virtual frame boundaries, and implement the exact weighted formula from Global Constraints. `choose_gap_evidence` sorts by descending base confidence, descending duration, then ascending stable `gap_key`.

- [ ] **Step 4: Run the scoring tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Write failing pipeline lifecycle tests**

Assert that opening and refreshing a spot writes both confidence values to in-memory state, Cosmos payloads, realtime `space.opened` / `space.refreshed` payloads, and `confirmed_block`. Cover multiple confirmed gaps choosing the strongest representative and an unscorable gap producing no published opening.

- [ ] **Step 6: Run pipeline tests and verify they fail**

Run: `PYTHONPATH=server .venv/bin/python -m pytest -c server/pytest.ini server/tests/cv/test_detection_pipeline.py -q`

Expected: FAIL because the pipeline still hard-codes `1.0` and refresh does not replace evidence.

- [ ] **Step 7: Thread `GapConfidence` through the pipeline**

Change `SpotManager.open_spot(...)` and `refresh_spot(...)` to accept the representative gap and `GapConfidence`. Update both values and `last_seen_at` on refresh. Group active confirmed gaps by segment for periodic refresh, select one representative with `choose_gap_evidence`, and use the same evidence for the legacy `BlockObservation` returned as self-feedback.

- [ ] **Step 8: Run all server CV tests**

Run: `PYTHONPATH=server .venv/bin/python -m pytest -c server/pytest.ini server/tests/cv -q`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/app/cv/confidence.py server/app/cv/tracker.py server/app/cv/pipeline.py server/tests/cv/test_gap_confidence.py server/tests/cv/test_detection_pipeline.py
git commit -m "feat: score confirmed parking gaps"
```

### Task 3: Derive One Age-Adjusted Score for Map and Nearby Results

**Files:**
- Create: `mobile/src/features/find/confidence.ts`
- Create: `mobile/src/__tests__/confidence.test.ts`
- Modify: `mobile/src/features/find/freshness.ts`
- Modify: `mobile/src/features/find/options.ts`
- Modify: `mobile/src/map/messages.ts`
- Modify: `mobile/src/__tests__/freshness.test.ts`
- Modify: `mobile/src/__tests__/options.test.ts`
- Modify: `mobile/src/__tests__/find-map.test.tsx`

**Interfaces:**
- Consumes: Task 1 `ParkingSpace.detection_confidence`, existing `base_confidence`, `last_observed_at`, and the once-per-second `now` value.
- Produces: `currentOpenConfidence(space, now) -> number | null`, `displayOpenPercent(space, now) -> number | null`, and `FindOption.confidencePercent?: number`.

- [ ] **Step 1: Write failing confidence-helper tests**

Assert an age-zero score equals base confidence, linear decay at intermediate ages, future time clamps to zero age, exactly 300 seconds returns `0`, more than 300 seconds returns `null`, and missing/invalid timestamps return `null`.

- [ ] **Step 2: Run the helper tests and verify they fail**

Run: `npm test --workspace mobile -- --runInBand src/__tests__/confidence.test.ts`

Expected: FAIL because `confidence.ts` does not exist.

- [ ] **Step 3: Implement the pure confidence helper**

Use the exact client formula from Global Constraints. Keep formatting outside the helper; return a numeric fraction and whole percent so all consumers share rounding.

- [ ] **Step 4: Write failing option and map tests**

Assert curb options use `{percent}% open`, retain age and walk time outside the removed detail subtitle, expose `confidencePercent`, sort equal-freshness curb spaces by descending current confidence before distance, and emit the same percent in `MapPill.label`. Verify driveways keep their current labels and ordering behavior.

- [ ] **Step 5: Run the option/map tests and verify they fail**

Run: `npm test --workspace mobile -- --runInBand src/__tests__/freshness.test.ts src/__tests__/options.test.ts src/__tests__/find-map.test.tsx`

Expected: FAIL because options and map pills still use freshness labels.

- [ ] **Step 6: Integrate confidence into visibility, options, and map messages**

Make `visibleSpaces` exclude `null` confidence while keeping the inclusive 300-second freshness behavior. Add the calculated percentage to curb `FindOption`s, use it for curb titles and pills, and add it as the within-freshness ranking key. Keep `StallKind` for color and geometry only.

- [ ] **Step 7: Run the focused mobile tests**

Run the commands from Steps 2 and 5.

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add mobile/src/features/find/confidence.ts mobile/src/features/find/freshness.ts mobile/src/features/find/options.ts mobile/src/map/messages.ts mobile/src/__tests__/confidence.test.ts mobile/src/__tests__/freshness.test.ts mobile/src/__tests__/options.test.ts mobile/src/__tests__/find-map.test.tsx
git commit -m "feat: decay parking confidence on device"
```

### Task 4: Present Driver Trust in Spot Details

**Files:**
- Modify: `mobile/src/components/find/SpaceDetailSheet.tsx`
- Modify: `mobile/src/app/(tabs)/find.tsx`
- Modify: `mobile/src/__tests__/space-detail-rule.test.tsx`
- Modify: `mobile/src/__tests__/find-map.test.tsx`

**Interfaces:**
- Consumes: Task 3 `FindOption.confidencePercent`; Task 1 `ParkingSpace.detection_confidence`; existing `SignRuleView.interpretation_confidence`.
- Produces: `SpaceDetailSheet` props include `confidencePercent: number`; the sheet renders the selected Option B trust layout.

- [ ] **Step 1: Write failing component tests for the approved detail layout**

Assert the sheet renders “Chance the spot is open: 82 percent” accessibly, a visible `82%`, last-observed age, detection confidence, parking-rule confidence, the existing rule, and Route here. Assert it omits location accuracy, “Likely open · 2 min walk,” and the removed disclaimer. Cover legacy `detection_confidence: 0` and a missing/blank rule confidence rendered as an em dash.

- [ ] **Step 2: Run detail tests and verify they fail**

Run: `npm test --workspace mobile -- --runInBand src/__tests__/space-detail-rule.test.tsx src/__tests__/find-map.test.tsx`

Expected: FAIL because the current sheet shows static base confidence and the old three-stat layout.

- [ ] **Step 3: Implement the selected detail presentation**

Add the main percentage and meter, then rows for Last observed, Detection confidence, and Parking rule confidence. Pass the current percentage from the selected `FindOption` so the sheet and map cannot disagree. Preserve rule loading, retry, and rule-detail behavior.

- [ ] **Step 4: Run detail and map tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/components/find/SpaceDetailSheet.tsx mobile/src/app/'(tabs)'/find.tsx mobile/src/__tests__/space-detail-rule.test.tsx mobile/src/__tests__/find-map.test.tsx
git commit -m "feat: explain parking confidence in spot details"
```

### Task 5: Keep Confidence Live During Routing and Offer Safe Alternatives

**Files:**
- Modify: `mobile/src/features/find/route.ts`
- Modify: `mobile/src/components/find/RouteCard.tsx`
- Modify: `mobile/src/components/find/RouteReplacementPrompt.tsx`
- Modify: `mobile/src/app/(tabs)/find.tsx`
- Modify: `mobile/src/__tests__/route-confirmation.test.ts`
- Modify: `mobile/src/__tests__/find-map.test.tsx`

**Interfaces:**
- Consumes: Task 3 `FindOption.confidencePercent`; existing route line, ETA, and replacement confirmation flow.
- Produces: route sheet state with `initialConfidencePercent: number | null`; `replacementFor(...)` uses displayed percentages and returns reason `"confidence"` when the target falls below 50%.

- [ ] **Step 1: Write failing replacement-policy tests**

Cover: displayed `50` stays quiet; displayed `49` triggers; alternatives below `50` are rejected; eligible alternatives retain freshness then distance ranking; taken targets still trigger; driveways still bypass confidence replacement.

- [ ] **Step 2: Run route-policy tests and verify they fail**

Run: `npm test --workspace mobile -- --runInBand src/__tests__/route-confirmation.test.ts`

Expected: FAIL because replacement currently keys only on freshness and has no confidence reason.

- [ ] **Step 3: Implement the replacement policy**

Extend `FindOption` use in `replacementFor` without recomputing or re-rounding confidence. Trigger only when `confidencePercent < 50`, and filter curb alternatives with `(confidencePercent ?? 0) >= 50` before existing freshness/distance sorting. Update prompt copy for the confidence reason and keep explicit “Keep route” / “Route to new spot” actions.

- [ ] **Step 4: Write failing route-card integration tests**

With fake timers, assert the route captures its starting percentage, updates once per second, shows the current percentage, reports a drop only after one rounded point, offers a replacement below 50, and keeps the current route until confirmation. Inject a newer `space.refreshed` event with a higher base confidence and current timestamp; assert the score rises and no false drop announcement appears.

- [ ] **Step 5: Run route integration tests and verify they fail**

Run: `npm test --workspace mobile -- --runInBand src/__tests__/find-map.test.tsx`

Expected: FAIL because route state and `RouteCard` do not carry confidence.

- [ ] **Step 6: Implement live route confidence**

Capture `initialConfidencePercent` when Route here succeeds. Render ETA, current `{percent}% open`, and the rounded drop from the captured value. Reuse the existing one-second freshness clock; do not create a second timer. Keep the target route stable until the driver accepts a replacement.

- [ ] **Step 7: Run all focused route tests**

Run the commands from Steps 2 and 5.

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add mobile/src/features/find/route.ts mobile/src/components/find/RouteCard.tsx mobile/src/components/find/RouteReplacementPrompt.tsx mobile/src/app/'(tabs)'/find.tsx mobile/src/__tests__/route-confirmation.test.ts mobile/src/__tests__/find-map.test.tsx
git commit -m "feat: update parking confidence while routing"
```

### Task 6: Verify Cross-Surface Consistency and Accessibility

**Files:**
- Modify: `mobile/src/__tests__/find-map.test.tsx`
- Modify: `mobile/src/__tests__/nearby-list.test.tsx`
- Modify: `mobile/src/__tests__/freshness-clock.test.ts`
- Modify: `docs/superpowers/specs/2026-10-24-parking-confidence-design.md`

**Interfaces:**
- Consumes: All preceding server, contract, and mobile interfaces.
- Produces: one integration proof that map, list, detail, and route display the same rounded score at the same instant.

- [ ] **Step 1: Add a cross-surface integration test**

Use one curb space with a fixed base confidence and timestamp. Assert the nearby row, map pill, detail sheet, and route card show the same percentage; advance one second and assert all live surfaces use the newly decayed value without another HTTP request. Verify the main percentage has a complete accessibility label and the route live region does not announce every tick.

- [ ] **Step 2: Run the mobile confidence suite**

Run: `npm test --workspace mobile -- --runInBand src/__tests__/confidence.test.ts src/__tests__/freshness.test.ts src/__tests__/freshness-clock.test.ts src/__tests__/options.test.ts src/__tests__/nearby-list.test.tsx src/__tests__/space-detail-rule.test.tsx src/__tests__/route-confirmation.test.ts src/__tests__/find-map.test.tsx`

Expected: PASS.

- [ ] **Step 3: Run repository verification**

Run: `PYTHONPATH=server .venv/bin/python -m pytest -c server/pytest.ini server/tests -q`

Run: `npm test --workspaces --if-present`

Run: `npm run typecheck --workspaces --if-present`

Run: `npm run lint --workspace mobile`

Expected: all commands exit `0`.

- [ ] **Step 4: Mark the approved spec implemented and commit final integration coverage**

Change the spec status from `Approved` to `Implemented` only after Step 3 passes.

```bash
git add mobile/src/__tests__/find-map.test.tsx mobile/src/__tests__/nearby-list.test.tsx mobile/src/__tests__/freshness-clock.test.ts docs/superpowers/specs/2026-10-24-parking-confidence-design.md
git commit -m "test: verify parking confidence experience"
```
