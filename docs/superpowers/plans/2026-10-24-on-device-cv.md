# On-Device CV Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run YOLO vehicle and parking-sign inference on iPhone camera buffers, send only structured detections and sign crops to the API, and remove server-side model inference without changing Curb's tracking, confirmation, sign-reading, persistence, or realtime behavior.

**Architecture:** VisionCamera v5 streams native iOS frames into a local Nitro module. The module runs the two exported CoreML models through Vision/Neural Engine and returns pixel-coordinate detections; TypeScript applies one-request backpressure and posts JSON to a new detection endpoint. FastAPI validates and decodes that payload, then passes the existing internal detection models into the unchanged tracker/gap/sign pipeline.

**Tech Stack:** Expo SDK 58, React Native 0.88, VisionCamera 5, React Native Worklets, Nitro Modules, Swift, Vision/CoreML/CoreImage, FastAPI/Pydantic, Jest, pytest, Xcode 26.

**Spec:** `ON_DEVICE_CV.md`

## Global Constraints

- Vehicle and sign inference runs on iPhone; the server must not load YOLO or depth models at startup.
- Keep `VehicleTracker`, `GapTracker`, `SignTracker`, sign triangulation, Claude sign reading, Cosmos persistence, and Web PubSub broadcasting on the server.
- Use `yolov8s-seg.mlpackage` and `yolov8m-worldv2.mlpackage`, exported at 640px with embedded NMS; ignore segmentation masks because the network contract contains boxes only.
- Send vehicle boxes/classes/confidences, sign boxes/confidences/crop JPEGs, frame dimensions, GPS, heading, device id, session id, and capture time as JSON to `POST /v1/vision/detections`.
- Never upload a full camera frame. Keep at most one detection request in flight; drop intermediate results rather than queueing them.
- iOS is the on-device inference target. Android/web may show the preview but must not attempt to instantiate the iOS-only CoreML module.
- Preserve the current camera permission UI, automatic live scanning, Stop/Start control, confirmed-spot self-feedback, and focus/background lifecycle.
- Generated `ios/` output remains reproducible through Expo prebuild and package autolinking; native source and model resources live in the local module, not as hand-maintained app-project edits.
- Expo SDK 58 requires Xcode 26.4+ and iOS 16.4+, superseding the guide's older Xcode 15 floor.

## Review Focus

- Malformed base64, invalid boxes, non-finite coordinates, and out-of-range confidence must produce validation errors without entering the pipeline; Task 1 tests these inputs.
- Empty detections must age/expire existing trackers and never be rejected merely because the lists are empty; Task 2 tests this path.
- Slow or offline uploads must never build a queue and must release the controller for the next result after failure; Task 3 tests both cases.
- Backgrounding, screen blur, permission denial, missing camera hardware, or Stop must disable inference and network submission while preserving the existing UI states; Task 5 tests the React behavior.
- Missing/invalid CoreML model resources must surface as a native inference error rather than crash or silently upload empty detections; Task 4 verifies model-load failure and the Xcode build.

---

### Task 1: Detection API contract

**Files:**
- Create: `server/tests/routes/test_detections.py`
- Create: `server/app/domain/detections.py`
- Modify: `server/app/routes/v1.py`
- Modify: `server/tests/routes/test_parking.py`

**Interfaces:**
- Consumes: JSON matching `DetectionSubmission` from the migration spec.
- Produces: `POST /v1/vision/detections`; `DetectionSubmission.to_pipeline_input() -> tuple[list[VehicleDetection], list[SignDetection]]`; existing `FrameAccepted`-shaped response.

- [ ] **Step 1: Write failing route tests**

Add tests named `test_detection_endpoint_decodes_sign_crops_and_calls_pipeline`, `test_detection_endpoint_accepts_empty_lists`, and parameterized validation tests for malformed base64, inverted/out-of-frame boxes, invalid dimensions, and confidence outside `[0, 1]`. Assert literal pipeline arguments and response fields.

- [ ] **Step 2: Run the tests and verify RED**

Run: `python3 -m pytest tests/routes/test_detections.py -q`
Expected: FAIL because `/v1/vision/detections` and `DetectionSubmission` do not exist.

- [ ] **Step 3: Implement the validated JSON boundary**

Define Pydantic types `DetectionBox`, `VehicleDetectionInput`, `SignDetectionInput`, and `DetectionSubmission` in `server/app/domain/detections.py`. Add `async def upload_detections(request: Request, submission: DetectionSubmission)` in `server/app/routes/v1.py`, convert `crop_b64` using strict base64 decoding, invoke the pipeline, and reuse the confirmed-space response shaping from the old frame route.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `python3 -m pytest tests/routes/test_detections.py tests/routes/test_parking.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app/domain/detections.py server/app/routes/v1.py server/tests/routes/test_detections.py server/tests/routes/test_parking.py
git commit -m "feat(server): accept on-device detections"
```

### Task 2: Inference-free server pipeline

**Files:**
- Create: `server/tests/cv/test_detection_pipeline.py`
- Modify: `server/app/cv/pipeline.py`
- Modify: `server/app/routes/ws.py`
- Modify: `server/app/main.py`
- Modify: `server/requirements.txt`
- Delete: `server/app/cv/detector.py`
- Delete: `server/app/cv/depth.py`

**Interfaces:**
- Consumes: `Pipeline.process_detections(vehicles: list[VehicleDetection], signs: list[SignDetection], frame_width: int, frame_height: int, lat: float, lng: float, session_id: str, heading: float = 0.0) -> dict` from Task 1.
- Produces: the existing `{frame_result, confirmed_block}` result and unchanged tracker/persistence/realtime side effects.

- [ ] **Step 1: Write failing pipeline tests**

Test that precomputed detections reach vehicle/sign trackers unchanged, empty lists age trackers, sign crop bytes survive until sign reading, dimensions drive gap thresholds, and importing/starting the app never imports `ultralytics`, `torch`, `cv2`, or `transformers`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `python3 -m pytest tests/cv/test_detection_pipeline.py -q`
Expected: FAIL because `process_detections` does not exist and startup still imports server inference.

- [ ] **Step 3: Move the pipeline boundary**

Replace `process_frame(image_bytes, ...)` with the typed `process_detections(...)` signature. Derive `gap_bboxes`, `gap_estimate`, and `scene_valid` from the submitted vehicle boxes while keeping the tracker, confirmation, sign, storage, and broadcast code intact. Remove detector/depth startup and health/debug references. Retire the binary inference WebSocket path and keep viewer/realtime behavior that does not require source frames.

- [ ] **Step 4: Remove server inference dependencies and sources**

Delete the detector/depth modules and remove Ultralytics, OpenCV, Pillow, Transformers, Accelerate, and timm from `server/requirements.txt`; retain NumPy for the tracker.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `python3 -m pytest tests/cv/test_detection_pipeline.py tests/routes/test_detections.py tests/routes/test_parking.py -q`
Expected: PASS with no server model imports/downloads.

- [ ] **Step 6: Commit**

```bash
git add server/app server/requirements.txt server/tests
git commit -m "refactor(server): remove YOLO inference"
```

### Task 3: Mobile detection transport and backpressure

**Files:**
- Modify: `mobile/src/__tests__/capture-lifecycle.test.ts`
- Create: `mobile/src/__tests__/detection-client.test.ts`
- Create: `mobile/src/features/capture/DetectionUploadController.ts`
- Create: `mobile/src/features/capture/detectionUpload.ts`
- Modify: `mobile/src/api/types.ts`
- Modify: `mobile/src/api/client.ts`
- Modify: `mobile/src/demo/demoApi.ts`
- Delete: `mobile/src/features/capture/CaptureController.ts`
- Delete: `mobile/src/features/capture/frameUpload.ts`

**Interfaces:**
- Consumes: `OnDeviceInference` from Task 4 and existing location/session metadata.
- Produces: `CurbApi.uploadDetections(payload: DetectionSubmission): Promise<FrameAccepted>` and `DetectionUploadController.submit(inference: OnDeviceInference): void` with one request maximum in flight.

- [ ] **Step 1: Write failing transport/controller tests**

Assert JSON `POST /v1/vision/detections`, authorization, exact snake-case payload fields, one in-flight upload, drop-not-queue behavior, recovery after rejection, and no submit after stop.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- --runInBand src/__tests__/capture-lifecycle.test.ts src/__tests__/detection-client.test.ts`
Expected: FAIL because detection transport and controller do not exist.

- [ ] **Step 3: Implement the JSON transport**

Add `DetectionSubmission`, `VehicleDetectionPayload`, `SignDetectionPayload`, and `OnDeviceInference` types. Replace multipart `uploadFrame` with JSON `uploadDetections`; remove transient JPEG filesystem code.

- [ ] **Step 4: Implement result backpressure**

Create `DetectionUploadController` with `start()`, `stop()`, `submit()`, and `{sent, dropped, failed}` stats. It snapshots the latest `FrameContext`, adds `captured_at`, and forwards successful confirmed-space responses.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm test -- --runInBand src/__tests__/capture-lifecycle.test.ts src/__tests__/detection-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mobile/src
git commit -m "feat(mobile): send on-device detections"
```

### Task 4: CoreML VisionCamera Nitro module and model export

**Files:**
- Create: `mobile/modules/curb-vision/package.json`
- Create: `mobile/modules/curb-vision/nitro.json`
- Create: `mobile/modules/curb-vision/CurbVision.podspec`
- Create: `mobile/modules/curb-vision/src/specs/CurbVision.nitro.ts`
- Create: `mobile/modules/curb-vision/src/index.ts`
- Create: `mobile/modules/curb-vision/ios/HybridCurbVision.swift`
- Generate: `mobile/modules/curb-vision/nitrogen/generated/**`
- Create: `mobile/modules/curb-vision/models/README.md`
- Create: `mobile/scripts/export-coreml-models.py`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: VisionCamera `Frame`, bundled `yolov8s-seg.mlmodelc`, and `yolov8m-worldv2.mlmodelc`.
- Produces: `CurbVision.detect(frame: Frame) -> OnDeviceInference`, where boxes are top-left-origin pixel `[x1, y1, x2, y2]`, vehicles include COCO class names, and signs include cropped JPEG base64.

- [ ] **Step 1: Define the Nitro contract and generate bindings**

Declare `CurbBox`, `CurbVehicleDetection`, `CurbSignDetection`, `CurbInferenceResult`, and iOS Swift `CurbVision` HybridObject. Run `npx nitrogen` in the module and commit generated bindings.

- [ ] **Step 2: Implement CoreML inference**

Load both compiled resources with `MLModelConfiguration.computeUnits = .cpuAndNeuralEngine`, execute Vision requests against the frame pixel buffer, parse embedded-NMS `confidence`/`coordinates` outputs with real `MLMultiArray` strides, retain only vehicle classes `{car,motorcycle,bus,truck}`, and crop sign boxes with CoreImage JPEG encoding. Throw clear errors for missing models, unsupported result shapes, invalid frames, and inference failures.

- [ ] **Step 3: Add reproducible model export**

Write `export-coreml-models.py` using Ultralytics `YOLO`/`YOLOWorld`, the seven specified sign classes, `imgsz=640`, and `nms=True`. Output the exact resource names under the module's `models/` directory; keep generated binary packages out of ordinary Git unless Git LFS is configured.

- [ ] **Step 4: Generate model resources locally**

Run: `uv run --python 3.11 mobile/scripts/export-coreml-models.py`
Expected: both `.mlpackage` directories exist and CoreML tools can load their specifications.

- [ ] **Step 5: Verify native compilation**

Run: `cd mobile/modules/curb-vision && npx nitrogen`
Expected: generated bindings are current with no schema/type errors.

- [ ] **Step 6: Commit**

```bash
git add .gitignore mobile/modules/curb-vision mobile/scripts/export-coreml-models.py
git commit -m "feat(ios): add CoreML frame inference"
```

### Task 5: VisionCamera UI integration and native build configuration

**Files:**
- Create: `mobile/src/__tests__/camera-overlay.test.tsx`
- Modify: `mobile/src/components/CameraOverlay.tsx`
- Modify: `mobile/src/app/(tabs)/find.tsx`
- Modify: `mobile/package.json`
- Modify: `mobile/package-lock.json`
- Modify: `package-lock.json`
- Modify: `mobile/app.json`

**Interfaces:**
- Consumes: `CurbVision.detect(frame)` from Task 4 and `DetectionUploadController` from Task 3.
- Produces: the current `CameraOverlay` UI backed by VisionCamera v5 `Camera`, `useFrameOutput`, and `scheduleOnRN`, with inference enabled only for active live scanning on iOS.

- [ ] **Step 1: Write failing camera lifecycle tests**

Mock only the native camera boundary and assert permission states, active/focused mounting, Start/Stop, no module call on Android/web, one inference callback forwarded to the controller, and controller shutdown on blur/background/unmount.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- --runInBand src/__tests__/camera-overlay.test.tsx`
Expected: FAIL because `CameraOverlay` still uses Expo Camera and JPEG capture.

- [ ] **Step 3: Install supported native dependencies**

Run from `mobile/`: `npx expo install react-native-vision-camera@5.2.3 react-native-vision-camera-worklets@5.2.3 react-native-nitro-modules@0.37.1 react-native-nitro-image@0.15.2 ./modules/curb-vision`
Remove `expo-camera` with the package manager and remove its config plugin.

- [ ] **Step 4: Replace the camera implementation**

Use `useCameraPermission`, `useCameraDevice('back')`, `useFrameOutput({ targetResolution: {width: 1280, height: 720}, pixelFormat: 'native', enablePhysicalBufferRotation: true, dropFramesWhileBusy: true })`, and `scheduleOnRN` to deliver inference results. Always dispose frames in `finally`; disable the frame output unless scanning is active and the iOS module is available.

- [ ] **Step 5: Run tests, typecheck, and lint**

Run: `npm test -- --runInBand src/__tests__/camera-overlay.test.tsx src/__tests__/capture-lifecycle.test.ts src/__tests__/detection-client.test.ts && npm run typecheck && npm run lint`
Expected: PASS with no warnings from project code.

- [ ] **Step 6: Commit**

```bash
git add mobile
git commit -m "feat(mobile): run camera inference on device"
```

### Task 6: Prebuild, Xcode verification, and migration documentation

**Files:**
- Modify: `mobile/README.md`
- Modify: `ON_DEVICE_CV.md`
- Generate (ignored): `mobile/ios/**`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: reproducible Expo prebuild, an Xcode workspace that links VisionCamera/Nitro/CoreML models, and operator instructions for device builds/model updates.

- [ ] **Step 1: Update native-build documentation**

Document Xcode 26.4+, iOS 16.4+, model export, `npx expo prebuild --clean --platform ios`, CocoaPods, `npx expo run:ios --device`, Xcode signing, the loss of Expo Go compatibility, payload/privacy changes, and how to profile Neural Engine placement.

- [ ] **Step 2: Generate the iOS project**

Run: `cd mobile && npx expo prebuild --clean --platform ios`
Expected: prebuild completes and autolinks VisionCamera, Worklets, Nitro, and CurbVision without hand edits.

- [ ] **Step 3: Build the iOS app**

Run: `xcodebuild -workspace mobile/ios/Curb.xcworkspace -scheme Curb -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO build`
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Run complete verification**

Run: `npm test` (outside the socket-restricted sandbox for payment route tests), `npm run typecheck`, `npm run lint --workspace mobile`, `python3 -m pytest` from `server/`, `npx expo-doctor` from `mobile/`, and the Xcode build from Step 3.
Expected: all project suites pass; doctor reports no actionable dependency mismatch; Xcode build succeeds.

- [ ] **Step 5: Commit**

```bash
git add ON_DEVICE_CV.md mobile/README.md
git commit -m "docs: finish on-device CV migration"
```
