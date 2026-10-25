# Persisted Sign-to-Space Association Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach previously recorded parking-sign rules to later detected open spaces on the same directional curb segment.

**Architecture:** Add persisted-rule resolution to the CV pipeline's sign deduplicator. Space confirmation will prefer a current-submission reading, then safely resolve an exact or nearby same-direction geolocated street sign from memory or persistence and apply it during both open and refresh transitions.

**Tech Stack:** Python 3, FastAPI domain models, Azure Cosmos abstraction, pytest/pytest-asyncio

**Spec:** `docs/superpowers/specs/2026-10-24-sign-space-association-design.md`

## Global Constraints

- Use a 50-metre maximum association radius.
- Never fall back across opposite travel directions.
- Exclude garage and lot sign categories.
- Preserve existing API and persistence schemas.

## Review Focus

- Multiple nearby signs: exact segment must win even if another same-direction sign is closer.
- Opposite-side-only signs: leave rules unset.
- Legacy documents without a `road_segment_id`: do not attach automatically.
- Existing open spots: refresh persists newly resolved rules.
- Repeat scans: update the existing sign's confirmation timestamp without creating a duplicate.

---

### Task 1: Resolve Persisted Sign Rules

**Files:**
- Modify: `server/app/config.py`
- Modify: `server/app/cv/pipeline.py`
- Test: `server/tests/cv/test_detection_pipeline.py`

**Interfaces:**
- Consumes: `cosmos.query_signs_nearby(lat, lng, radius_m)` and `make_road_segment_id(lat, lng, heading)`.
- Produces: `SignDeduplicator.find_rules_for_segment(segment_id: str, lat: float, lng: float, radius_m: float | None = None) -> SignPoleReading | None`.

- [ ] **Step 1: Write failing tests for exact-match preference, nearest same-direction fallback, and opposite-direction rejection.**
- [ ] **Step 2: Run the focused tests and confirm they fail because persisted sign rules are not resolved.**
- [ ] **Step 3: Add the association-radius setting and implement persisted rule resolution.**
- [ ] **Step 4: Run the focused tests and confirm they pass.**

### Task 2: Apply Resolved Rules to Opened and Refreshed Spaces

**Files:**
- Modify: `server/app/cv/pipeline.py`
- Test: `server/tests/cv/test_detection_pipeline.py`

**Interfaces:**
- Consumes: `SignDeduplicator.find_rules_for_segment(...)` from Task 1.
- Produces: `SpotManager.refresh_spot(spot: SpotDocument, sign_rules: SignPoleReading | None = None) -> None` with persistence of newly resolved rules.

- [ ] **Step 1: Write failing pipeline tests showing a prior-session persisted sign is applied to a new space and to an existing refreshed space.**
- [ ] **Step 2: Run the focused tests and confirm the missing association causes the failures.**
- [ ] **Step 3: Resolve rules during gap confirmation and pass them through open/refresh and `BlockObservation`.**
- [ ] **Step 4: Run the focused tests and confirm they pass.**

### Task 3: Persist Repeat Confirmation

**Files:**
- Modify: `server/app/cv/pipeline.py`
- Test: `server/tests/cv/test_detection_pipeline.py`

**Interfaces:**
- Consumes: existing geo-deduplication in `_process_sign_tracks`.
- Produces: repeat observations that persist `last_confirmed` on the existing `SignDocument`.

- [ ] **Step 1: Write a failing test proving a repeated scan keeps one document and advances `last_confirmed`.**
- [ ] **Step 2: Run the focused test and confirm the stored timestamp remains unchanged.**
- [ ] **Step 3: Upsert the reused sign document after updating its confirmation timestamp.**
- [ ] **Step 4: Run the focused test and confirm it passes.**

### Task 4: Full Verification

**Files:**
- Verify: `server/tests/cv/test_detection_pipeline.py`
- Verify: server test suite

- [ ] **Step 1: Run the complete CV pipeline test module.**
- [ ] **Step 2: Run the complete server test suite and report any unrelated failures explicitly.**
- [ ] **Step 3: Inspect the final diff against the design success criteria.**

