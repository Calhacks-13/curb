# Unsigned Parking Openings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show qualified observed curb openings without a detected sign, without presenting availability as a legal-parking claim.

**Architecture:** Make canonical sign-detail data optional, admit non-`ILLEGAL` unsigned spaces in the server and mobile freshness filters, then remove legal-curb presentation from mobile UI.

**Tech Stack:** Python/FastAPI/Pydantic, TypeScript/Zod, React Native/Jest.

**Spec:** `docs/superpowers/specs/2026-10-24-unsigned-parking-openings-design.md`

## Global Constraints

- Never infer or display legality from an empty-space observation.
- Preserve confidence, freshness, distance, occupied-space, and driveway behavior.
- Exclude only zones explicitly marked `ILLEGAL`; permit `UNKNOWN` zones without a sign rule.

## Review Focus

- `UNKNOWN`/no-rule spaces appear, whereas `ILLEGAL` spaces do not.
- An unsigned space has a valid no-rule detail response.
- A missing `sign_rule` validates through Python and Zod contracts.
- No visible mobile copy says “Legal to park now.”

---

### Task 1: Permit unsigned openings in the API

**Files:**

- Modify: `packages/contracts/src/domain.ts`, `server/app/models/domain.py`, `server/app/domain/parking.py`
- Test: `packages/contracts/src/contracts.test.ts`, `server/tests/routes/test_parking.py`

**Interfaces:** `SpaceDetail.sign_rule` becomes nullable; `ParkingService.nearby()` accepts qualified spaces in non-`ILLEGAL` zones; `ParkingService.detail()` returns nullable rule data.

- [ ] **Step 1: Write failing contract and route tests** for an `UNKNOWN`, no-rule, qualified open space; its null-rule detail response; and an `ILLEGAL` exclusion control.
- [ ] **Step 2: Run tests and observe expected failure.** Run `npm test --workspace @curb/contracts -- --run contracts.test.ts` and `pytest server/tests/routes/test_parking.py -q`.
- [ ] **Step 3: Implement optional sign detail and non-illegal eligibility** in the listed contract/models/service files.
- [ ] **Step 4: Re-run the targeted tests and verify they pass.**

### Task 2: Render availability without legal-curb status

**Files:**

- Modify: `mobile/src/api/normalize.ts`, `mobile/src/features/find/freshness.ts`, `mobile/src/features/find/options.ts`, `mobile/src/components/MapLegend.tsx`, `mobile/src/components/find/NearbyList.tsx`, `mobile/src/components/find/RouteReplacementPrompt.tsx`, `mobile/src/app/(tabs)/find.tsx`, `mobile/src/map/curbLayers.ts`
- Test: `mobile/src/__tests__/freshness.test.ts`, `mobile/src/__tests__/options.test.ts`, `mobile/src/__tests__/nearby-list.test.tsx`

**Interfaces:** nullable canonical `sign_rule` normalizes to the existing nullable mobile rule; unsigned spots retain normal availability labels.

- [ ] **Step 1: Write failing mobile tests** for an unsigned `UNKNOWN` opening, `ILLEGAL` exclusion, and absence of “Legal to park now.”
- [ ] **Step 2: Run tests and observe expected failure.** Run `npm test --workspace mobile -- freshness.test.ts options.test.ts nearby-list.test.tsx`.
- [ ] **Step 3: Implement availability-first filtering, nullable-rule normalization, and legal-curb UI removal.**
- [ ] **Step 4: Re-run the targeted tests and verify they pass.**

### Task 3: Verify the workspace

- [ ] **Step 1: Run** `npm test` **and** `pytest server/tests -q`.
- [ ] **Step 2: Inspect the final diff against the constraints and report evidence.**
