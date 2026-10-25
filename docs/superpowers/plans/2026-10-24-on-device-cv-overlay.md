# On-device CV Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the iPhone's latest on-device vehicle and sign detections over its live camera preview, with a tap-to-expand full-screen view.

**Architecture:** Keep raw frames on-device. `CameraOverlay` retains the latest `OnDeviceInference`, renders a reusable overlay aligned to VisionCamera's `cover` crop, and moves the single active camera view between compact and full-screen presentations.

**Tech Stack:** React Native 0.88, Expo 58, VisionCamera 5, TypeScript, Jest, Testing Library

**Spec:** `ON_DEVICE_CV.md`

## Global Constraints

- Raw frames remain on-device; no new network payloads or server routes.
- Inference and uploads continue only while the existing scanning eligibility is true.
- Vehicle and sign boxes use each result's `frameWidth` and `frameHeight`.
- Only one active native camera preview is mounted at a time.
- The compact view remains draggable; tapping the preview opens full screen and an explicit close control exits it.

## Review Focus

- Cover-cropped previews: boxes stay aligned in compact and portrait full-screen layouts.
- Empty detections: the overlay clearly reports zero without stale boxes.
- Stop/error/background: inference lifecycle and uploads retain existing behavior.
- Accessibility: expansion, close, and each visible detection have useful labels.
- High-frequency results: only the latest result is retained; no unbounded queue is created.

---

### Task 1: Detection layer and full-screen camera

**Files:**
- Create: `mobile/src/components/DetectionOverlay.tsx`
- Modify: `mobile/src/components/CameraOverlay.tsx`
- Modify: `mobile/src/__tests__/camera-overlay.test.tsx`
- Create: `mobile/src/__tests__/detection-overlay.test.tsx`

**Interfaces:**
- Consumes: `OnDeviceInference` from `mobile/src/api/types.ts`.
- Produces: `DetectionOverlay({ result })` aligned to the camera's fixed `cover` mode and compact/full-screen camera presentations.

- [ ] **Step 1: Write failing component tests**

Assert literal scaled box positions for a cover-cropped preview, vehicle/sign labels and counts, clearing on an empty result, opening full screen by tapping the preview, and closing it without mounting two cameras.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npm test -- --runInBand src/__tests__/detection-overlay.test.tsx src/__tests__/camera-overlay.test.tsx`

Expected: failures because `DetectionOverlay` and the expansion interaction do not exist.

- [ ] **Step 3: Implement the minimal overlay and expansion behavior**

Add a measured overlay that maps `[x1,y1,x2,y2]` through the same `cover` scale/crop as the preview. Retain the latest valid inference on the RN thread. Render one camera surface in either the compact card or a full-screen `Modal`, with detection count/status and close affordance.

- [ ] **Step 4: Verify focused and full mobile checks**

Run: `npm test -- --runInBand src/__tests__/detection-overlay.test.tsx src/__tests__/camera-overlay.test.tsx`

Run: `npm test -- --runInBand && npm run typecheck && npm run lint`

Expected: all commands exit 0.

- [ ] **Step 5: Build and test on the physical iPhone**

Rebuild the embedded-bundle device app, install/launch it, start scanning, and confirm visible live boxes plus compact/full-screen transitions without Core ML or camera errors.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-10-24-on-device-cv-overlay.md mobile/src/components/DetectionOverlay.tsx mobile/src/components/CameraOverlay.tsx mobile/src/__tests__/detection-overlay.test.tsx mobile/src/__tests__/camera-overlay.test.tsx
git commit -m "feat(ios): visualize on-device detections"
```
