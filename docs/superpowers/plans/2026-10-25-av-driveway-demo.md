# AV Driveway Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the ten-second AV demo in which a blue AV marker drives to `driveway_av_1`, holds it as `av_demo`, pays $5.00 through the existing x402 Base Sepolia payment service, and turns the driveway into a gray `Booked $5.00` marker on every connected phone.

**Architecture:** Add the AV user and target driveway to the shared strict seed contract, then add a FastAPI agent runner that publishes route positions, invokes the existing `DrivewayService` for the hold, and calls the existing payments service to execute the real x402 booking payment. Extend the mobile realtime boundary with `agent.position`, render that event as a separate smoothly moving blue AV marker, and derive the booked price label from the realtime driveway snapshot. Server restart remains the reset mechanism; no reset endpoint is added.

**Tech Stack:** FastAPI/Pydantic/pytest, TypeScript/Zod, Expo React Native/Jest/jsdom, Azure Web PubSub fallback log, existing Node x402/CDP payments service.

**Spec:** `AV-DRIVEWAY-DEMO.md`

## Global Constraints

- The target is exactly `driveway_av_1`, owned by `owner_demo`, priced at `5.00` USDC.
- The AV identity is exactly `av_demo`; the server uses `demo-token-av_demo` when asking the payments service to execute the booking.
- The route contains six fixed waypoints ending at the target driveway and publishes one `agent.position` event every 0.5 seconds.
- The held state remains visible for two seconds before payment starts.
- The real payment path is `POST /v1/payments/{booking_id}/execute` on the existing payments service; it remains responsible for x402 settlement and `booking.confirmed` publication.
- The trigger returns without waiting for the animation/payment and rejects a second concurrent run.
- The final map copy is exactly `Booked $5.00` for a driveway booked by another identity.
- Restarting the server resets the in-memory demo; no reset endpoint is in scope.
- Do not add dependencies.

## Review Focus

- A second trigger while a demo is running must return `409` and must not create a second hold or payment.
- Payment-service errors must be logged and leave the driveway in its truthful held/payment state rather than fabricating a transaction hash.
- An out-of-order or malformed `agent.position` event must not corrupt parking reducer state or crash the mobile feed.
- The AV marker must remain distinct from the phone driver's existing car marker and must not move it.
- Booked styling and accessible text must stay gray/read-only in day and night modes and must include the canonical formatted price.

---

### Task 1: Seed the AV identity and target driveway

**Files:**
- Modify: `packages/contracts/src/domain.ts`
- Modify: `packages/contracts/src/fixtures.ts`
- Modify: `packages/contracts/src/contracts.test.ts`
- Modify: `server/app/models/api.py`
- Modify: `server/app/seed/loader.py`
- Modify: `server/app/seed/public.json`
- Modify: `server/tests/test_contract_parity.py`
- Modify: `server/tests/test_parking_repositories.py`

**Interfaces:**
- Consumes: the existing strict `PublicSeedFixture` and `NearbyParkingResponse.driveways` list.
- Produces: `PublicSeedFixture.av`, an `av_demo` repository user, and a seeded `driveway_av_1` visible through nearby reads and the driveway service.

- [ ] **Step 1: Write failing contract and repository tests**

Assert that both TypeScript and Python fixtures contain `av.id === "av_demo"`, that the nearby list contains `driveway_av_1` with `price_usdc === "5.00"`, and that `load_seed` persists the AV user.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test --workspace @curb/contracts && ../../.venv/bin/pytest server/tests/test_contract_parity.py server/tests/test_parking_repositories.py -q`

Expected: FAIL because `av` and `driveway_av_1` are absent.

- [ ] **Step 3: Extend the strict fixture and seed loader**

Add `av: UserView`/`av: UserViewSchema`; seed `av_demo` with the driver demo profile; append `driveway_av_1` near the existing demo coordinates with an all-day window, owner `owner_demo`, and price `5.00`; load all three users.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test --workspace @curb/contracts && ../../.venv/bin/pytest server/tests/test_contract_parity.py server/tests/test_parking_repositories.py -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/domain.ts packages/contracts/src/fixtures.ts packages/contracts/src/contracts.test.ts server/app/models/api.py server/app/seed/loader.py server/app/seed/public.json server/tests/test_contract_parity.py server/tests/test_parking_repositories.py
git commit -m "feat: seed AV driveway demo"
```

### Task 2: Add the asynchronous server demo runner

**Files:**
- Create: `server/app/routes/agent.py`
- Create: `server/tests/routes/test_agent.py`
- Modify: `server/app/config.py`
- Modify: `server/app/main.py`

**Interfaces:**
- Consumes: `DrivewayService.start_hold(...)`, `signalr.broadcast_realtime_event(...)`, the payments service `POST /v1/payments/{booking_id}/execute`, and seeded `driveway_av_1` version/state.
- Produces: authenticated `POST /v1/agent/run-demo` returning `202`, plus `agent.position`, `driveway.held`, and the payments service's existing `booking.confirmed` sequence.

- [ ] **Step 1: Write failing runner tests**

Cover six ordered `agent.position` events ending at the driveway, 0.5-second movement pacing, a hold by `av_demo`, a two-second hold pause, payment execution with `demo-token-av_demo`, terminal success logging with amount/hash, truthful behavior on payment failure, and rejection of concurrent runs.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `../../.venv/bin/pytest server/tests/routes/test_agent.py -q`

Expected: FAIL because `app.routes.agent` does not exist.

- [ ] **Step 3: Implement the runner and route**

Create an injectable runner with fixed six-waypoint route constants, injected clock/sleep/event publisher/payment executor for deterministic tests, and an `asyncio.Lock`/active flag for single-flight execution. Add `CURB_PAYMENT_SERVICE_URL` with default `http://127.0.0.1:8787`, call the payment endpoint with the AV demo bearer token, log but do not synthesize settlement on failure, wire the router and runner into the FastAPI lifespan, and return `202` before the background task finishes.

- [ ] **Step 4: Run focused and server tests and verify GREEN**

Run: `../../.venv/bin/pytest server/tests/routes/test_agent.py -q && ../../.venv/bin/pytest server/tests -q`

Expected: PASS with no new warnings attributable to the runner.

- [ ] **Step 5: Commit**

```bash
git add server/app/routes/agent.py server/tests/routes/test_agent.py server/app/config.py server/app/main.py
git commit -m "feat: orchestrate AV driveway demo"
```

### Task 3: Carry AV positions through mobile realtime

**Files:**
- Modify: `mobile/src/api/types.ts`
- Modify: `mobile/src/realtime/webPubSub.ts`
- Modify: `mobile/src/realtime/reducer.ts`
- Modify: `mobile/src/features/find/useParkingState.ts`
- Modify: `mobile/src/app/(tabs)/find.tsx`
- Modify: `mobile/src/map/messages.ts`
- Modify: `mobile/src/map/webview/runtime.ts`
- Modify: `mobile/src/map/webview/mapHtml.ts`
- Modify: `mobile/src/realtime/__tests__/webPubSub.test.ts`
- Modify: `mobile/src/realtime/__tests__/reducer.test.ts`
- Modify: `mobile/src/__tests__/find-map.test.tsx`
- Modify: `mobile/src/__tests__/map-runtime.test.ts`

**Interfaces:**
- Consumes: realtime `agent.position` payload `{ position: [lng, lat], heading: number }` for entity `av_demo`.
- Produces: `setAgentPosition` map messages and a distinct blue, heading-aware, smoothly interpolated AV marker; parking state remains unchanged by agent-only events.

- [ ] **Step 1: Write failing realtime and renderer tests**

Assert parser acceptance/validation of `agent.position`, reducer no-op behavior, Find forwarding of valid positions, no forwarding of malformed positions, independent car and AV messages, and a blue AV DOM marker that updates position/heading without creating duplicates.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test --workspace mobile -- --runInBand mobile/src/realtime/__tests__/webPubSub.test.ts mobile/src/realtime/__tests__/reducer.test.ts mobile/src/__tests__/find-map.test.tsx mobile/src/__tests__/map-runtime.test.ts`

Expected: FAIL because `agent.position` and `setAgentPosition` are not supported.

- [ ] **Step 3: Implement the mobile event and marker path**

Add the event type and a narrow payload validator, bypass parking reduction for the agent event, preserve it for the screen callback, store the latest AV position in Find, and send a new typed map command. In the runtime create one noninteractive blue marker with a heading indicator and interpolate updates over their observed interval; add day/night-safe CSS in `mapHtml.ts`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test --workspace mobile -- --runInBand mobile/src/realtime/__tests__/webPubSub.test.ts mobile/src/realtime/__tests__/reducer.test.ts mobile/src/__tests__/find-map.test.tsx mobile/src/__tests__/map-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/api/types.ts mobile/src/realtime/webPubSub.ts mobile/src/realtime/reducer.ts mobile/src/features/find/useParkingState.ts 'mobile/src/app/(tabs)/find.tsx' mobile/src/map/messages.ts mobile/src/map/webview/runtime.ts mobile/src/map/webview/mapHtml.ts mobile/src/realtime/__tests__/webPubSub.test.ts mobile/src/realtime/__tests__/reducer.test.ts mobile/src/__tests__/find-map.test.tsx mobile/src/__tests__/map-runtime.test.ts
git commit -m "feat: render realtime AV route"
```

### Task 4: Render booked driveways as gray price chips

**Files:**
- Modify: `mobile/src/features/find/options.ts`
- Modify: `mobile/src/map/webview/runtime.ts`
- Modify: `mobile/src/map/webview/mapHtml.ts`
- Modify: `mobile/src/__tests__/options.test.ts`
- Modify: `mobile/src/__tests__/map-runtime.test.ts`

**Interfaces:**
- Consumes: a driveway in `BOOKED` state with `price_usdc: "5.00"` booked by another identity.
- Produces: a muted/read-only `MapPill` labeled exactly `Booked $5.00`, with gray callout/chip/tail styling and booked-specific accessibility copy.

- [ ] **Step 1: Write failing option and DOM tests**

Change the booked-option assertion to `Booked $5.00`; assert the rendered label, gray class/style, gray tail, and an accessibility label that says it is booked rather than guaranteed after payment.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test --workspace mobile -- --runInBand mobile/src/__tests__/options.test.ts mobile/src/__tests__/map-runtime.test.ts`

Expected: FAIL because booked pills currently say only `Booked` and retain generic driveway accessibility text.

- [ ] **Step 3: Implement the booked presentation**

Format the booked label from `price_usdc`, retain `muted: true`, make runtime accessibility conditional on booked/muted state, and complete gray day/night styles for the callout, driveway chip, and tail.

- [ ] **Step 4: Run focused tests, mobile lint, and typecheck**

Run: `npm test --workspace mobile -- --runInBand mobile/src/__tests__/options.test.ts mobile/src/__tests__/map-runtime.test.ts && npm run lint --workspace mobile && npm run typecheck --workspace mobile`

Expected: PASS with zero lint/type errors.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/features/find/options.ts mobile/src/map/webview/runtime.ts mobile/src/map/webview/mapHtml.ts mobile/src/__tests__/options.test.ts mobile/src/__tests__/map-runtime.test.ts
git commit -m "feat: show booked driveway price on map"
```

### Task 5: Verify the integrated demo contract

**Files:**
- Modify if required by verification only: `AV-DRIVEWAY-DEMO.md`

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: a verified server/mobile/contracts/payments build and accurate run instructions.

- [ ] **Step 1: Add an integration-level server test**

Exercise the route with an in-memory driveway service, immediate fake sleeper, captured realtime publisher, and fake payment executor that performs the real service state transitions; assert the final driveway is `BOOKED`, the booking transaction hash is preserved, only `driveway_av_1` was touched, and event order is positions then hold then confirmation.

- [ ] **Step 2: Run the integration test and verify RED before any required glue change**

Run: `../../.venv/bin/pytest server/tests/routes/test_agent.py -q`

Expected: FAIL only if cross-task glue is incomplete; if it already passes, record that the integration behavior was covered in Task 2 and make no production change.

- [ ] **Step 3: Make the smallest glue or instruction correction needed**

Keep the documented five-terminal workflow, correct the funding command to the repository's actual `npm run fund` if still stale, and document that the server calls payments on port `8787` by default.

- [ ] **Step 4: Run full verification**

Run: `../../.venv/bin/pytest server/tests -q`

Run: `npm test --workspace mobile -- --runInBand`

Run: `npm test --workspace @curb/contracts`

Run: `npm test --workspace @curb/payments` (with local socket permission)

Run: `npm run typecheck && npm run lint --workspace mobile`

Expected: server 279+ tests pass; all mobile, contracts, and payments tests pass; typecheck and lint exit 0.

- [ ] **Step 5: Commit**

```bash
git add AV-DRIVEWAY-DEMO.md server/tests/routes/test_agent.py
git commit -m "docs: finalize AV driveway demo workflow"
```
