# On-device computer vision

Curb runs vehicle and parking-sign detection on iPhone camera buffers with
VisionCamera v5 and a local Swift/Nitro module. Full frames stay on the device.
The API receives JSON detections and small sign-crop JPEGs. The server still
owns tracking, gap confirmation, sign triangulation, Claude sign reading,
Cosmos persistence, and Web PubSub broadcasts.

## Prerequisites

- macOS, **Xcode 26.4+**, its command-line tools, and an installed iOS Simulator
  runtime. The app uses **Expo SDK 58**, **React Native 0.88**, and **iOS 16.4+**.
- Node **24.3+ on the 24.x LTS line**, npm, and
  [uv](https://docs.astral.sh/uv/getting-started/installation/).
  Install workspace dependencies with `npm ci` at the repository root.
- CocoaPods on PATH: `brew install cocoapods`, then `pod --version`.
- An iPhone and Apple development signing team for real camera/inference tests.
  The simulator compile below needs no signing credentials.

Expo Go cannot load CurbVision, VisionCamera, or the other custom native modules.
Build the native debug app locally. Expo Continuous Native Generation makes
`mobile/ios/` disposable, ignored output. Change `app.json`, package configuration,
or `mobile/modules/curb-vision/` and regenerate; never maintain changes by hand in
the generated app project.

## Export models

From the repository root on macOS:

```sh
UV_CACHE_DIR=/tmp/curb-uv-cache uv run --python 3.11 mobile/scripts/export-coreml-models.py
```

The script pins Ultralytics 8.3.237, CoreML Tools 9.0, Torch 2.7.0, torchvision
0.22.0, NumPy 2.2.6, and the CLIP source revision. It downloads the original
`yolov8s-seg.pt` / `yolov8m-worldv2.pt` checkpoints and CLIP text encoder, exports
at 640×640 with embedded Apple NMS, validates each package, and publishes:

```text
mobile/modules/curb-vision/models/yolov8s-seg.mlpackage
mobile/modules/curb-vision/models/yolov8m-worldv2.mlpackage
```

The pinned exporter does not embed NMS for segmentation heads. The script removes
only mask branches and checks that all 84 trained box/class channels remain
bit-identical before exporting the vehicle detection branch. It preserves the
`yolov8s-seg` name. Swift returns only COCO `car`, `motorcycle`, `bus`, and `truck`.
YOLO-World embeds these exact prompts in order:

```text
parking sign
no parking sign
traffic sign
parking meter
parking garage sign
parking lot sign
parking arrow sign
```

The sign exporter pads seven score channels to 80 with zeros. Both models expose
`confidence` / `coordinates`, embed confidence 0.25 and IoU 0.45 thresholds, and
contain class-order metadata checked by Swift. See [resource details](mobile/modules/curb-vision/models/README.md).

Allow several minutes and substantial cache/download space on a fresh machine:
Python/Torch dependencies and CLIP are much larger than the final packages.
Observed packages total about **75 MiB** (21 MiB vehicles, 54 MiB signs). Export
took seconds per model after downloads on the development Mac; timings vary.
Packages, compiled models, checkpoints, caches, Pods, and native build output
stay out of Git. Fresh checkouts and remote builders must export/provision the
real packages before prebuild; this repository does not distribute the binaries.

## Generate and build iOS

Configure `mobile/.env` from `.env.example`, including Mapbox and a
device-reachable `EXPO_PUBLIC_API_URL` for live scanning:

```sh
cd mobile
CI=1 npx expo prebuild --clean --platform ios
npx expo run:ios --device
```

Prebuild installs Pods automatically. Verify it autolinks CurbVision,
VisionCamera, VisionCameraWorklets, NitroModules, NitroImage, and RNWorklets.
To reinstall Pods without regeneration, run `cd ios && pod install` from
`mobile/`, then return to `mobile/`. After native dependency/configuration/model
changes, clean prebuild and rebuild. A JavaScript reload cannot add native code
or replace bundled models.

Open `mobile/ios/Curb.xcworkspace` in Xcode, select the **Curb** scheme/iPhone,
and select your Apple team under **Signing & Capabilities**. Enable automatic
signing, use a unique bundle identifier for your team if needed, enable Developer
Mode on the phone, and trust the certificate when prompted. Put persistent bundle
identifier/config changes in `mobile/app.json` before another clean prebuild.
`npx expo run:ios --device` builds/installs the debug app and starts Metro;
subsequent JS-only work can use `npx expo start` with the installed native app.

From the repository root, inspect schemes/destinations and compile without a phone:

```sh
xcodebuild -list -workspace mobile/ios/Curb.xcworkspace
xcodebuild -showdestinations -workspace mobile/ios/Curb.xcworkspace -scheme Curb
xcodebuild \
  -workspace mobile/ios/Curb.xcworkspace \
  -scheme Curb \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGNING_ALLOWED=NO build
```

Choose an installed simulator if that name is unavailable. A first native build
can take several minutes and several gigabytes of derived data. CocoaPods places
models in `CurbVisionModels.bundle`; Xcode compiles the exact resources
**`yolov8s-seg.mlmodelc`** / **`yolov8m-worldv2.mlmodelc`** within that bundle in
the app product. Swift searches that bundle through its owning bundle and the
main app bundle. Compile/resource checks do not validate camera hardware or ANE.

## Runtime and privacy contract

`CameraOverlay.tsx` uses VisionCamera v5 `Camera` / `useFrameOutput` with a
1280×720 target, native pixel format, `enablePhysicalBufferRotation: true`, and
`dropFramesWhileBusy: true`. Its worklet calls a cached CurbVision HybridObject
synchronously and sends plain detection values to React Native with `scheduleOnRN`.
Every frame is disposed in `finally`, including errors. No source JPEG is made.

Swift reads CVPixelBuffer directly, requires physically upright/unmirrored frames,
and caches both models and Vision requests. CoreML uses `.cpuAndNeuralEngine`;
Vision scales the full buffer to 640×640. Results are finite, clamped top-left
pixel `[x1,y1,x2,y2]` boxes. Only sign crops are JPEG/base64 encoded. Missing
models/inference failures appear in the camera card and stop scanning; Stop/Start
retries after the cause is fixed.

Inference requires iOS, live API, a real location fix, permission, camera hardware,
an active focused screen, and scanning enabled. Stop, blur, backgrounding, or
permission loss removes the output. Demo mode and Android are preview only; web
shows an unavailable camera card. Android/web never instantiate CurbVision.

`DetectionUploadController` allows one request in flight and drops intermediate
results. Errors release the guard; stopping invalidates callbacks and prevents
later submissions/confirmations. There is no offline queue.

Detection uploads have a 10-second deadline and abort their HTTP request on
timeout (`ApiError` code `request_timeout`, status `0`). A fresh inference result
can try again after rejection or timeout. Other API requests retain their existing
timeouts. Delivery callbacks carry frozen events and stats snapshots only for the
current scanning generation; stopping/restarting or unmounting suppresses old
delivery callbacks.

The camera distinguishes **Waiting for first inference**, **Waiting for server
receipt**, **Server received** (including server vehicle/gap counts when supplied),
and **Upload unavailable** with safe HTTP/timeout information. A successful empty
result still uploads and can show `0 vehicles · 0 gaps`; it is different from a
delivery failure. The next successful response clears the current delivery error.
Upload failure keeps local inference and detection boxes active while fresh
results retry. Native inference errors still stop the scanner.

Expand the camera preview to inspect gap analysis and sign readings. The detection
response includes source dimensions/time, candidate `gap_bboxes`, `tracked_gaps`
(track IDs, observation duration, confirmation and optional meter estimate), and
per-track `sign_feedback` (gathering/unavailable/uncertain/read plus extracted text
and interpreted rules). White dashed openings are candidates; solid white openings
have temporal confirmation. Pixel widths do not establish vehicle fit or legality.
Gap geometry is from the last server sample, expires after three seconds from
capture, and is hidden after an upload failure or camera-dimension change.
Successful empty responses clear gap overlays. Sign feedback exposes missing reader
configuration, uncertainty, and reader errors rather than treating detection as a
successful read. The last reading remains available in the expanded panel after
the sign leaves view, labeled as a previous reading, until scanning stops/restarts.

JSON goes to `POST /v1/vision/detections`:

```json
{
  "device_id": "device-id",
  "session_id": "session-id",
  "captured_at": "2026-10-24T18:00:00.000Z",
  "lat": 37.8,
  "lng": -122.4,
  "accuracy_m": null,
  "heading": 180,
  "frame_width": 1280,
  "frame_height": 720,
  "vehicles": [{ "bbox": [10, 20, 200, 300], "cls": "car", "confidence": 0.85 }],
  "signs": []
}
```

`accuracy_m` is required and may be `null` when GPS accuracy is unavailable.
Each sign entry contains `bbox`, `confidence`, and `crop_b64`: strict base64 of
the sign-crop JPEG bytes, without a data-URL prefix. Full frames never leave the
device. The example uses an empty sign list and can be submitted as written.

The API enforces conservative per-submission limits before pipeline processing:

| Input | Limit |
| --- | --- |
| Vehicles / signs | 64 / 16 detections |
| Each JPEG crop | 256 KiB decoded; 349,528 base64 characters |
| All JPEG crops combined | 1 MiB decoded; 1,398,168 base64 characters including padding allowance |
| Crop dimensions | Positive, at most 2048 per axis and 4,000,000 pixels |
| Frame dimensions | Positive integers, at most 4096 per axis and 16,000,000 pixels |
| Session / device identifiers | 128 characters each |
| Vehicle class / capture timestamp | 32 / 64 characters |

Unknown submission/detection fields are rejected. Counts and aggregate encoded
crop length are checked before decoding; exact decoded sizes are checked before
pipeline entry. These budgets keep tracker matching and sign payloads bounded
while allowing ample post-NMS detections at the 1280×720 camera target. The frame
ceiling also accommodates larger hardware buffers and portrait orientation:
VisionCamera's target resolution is a preference. Crop ceilings allow large sign
regions from those buffers while bounding downstream image-reader pixel work.

FastAPI validates bounds/confidence, strict base64, and JPEG structure (complete
segments, frame/scan headers, quantization/Huffman tables, entropy-scan framing,
end marker, and positive bounded dimensions). This dependency-free structural
check does not decode entropy codes or establish visual correctness. Each crop
is base64-decoded once and the validated bytes are reused. Invalid or over-budget
submissions return 422 without calling `Pipeline.process_detections`.
Empty lists age trackers. The server keeps
VehicleTracker, GapTracker, SignTracker, sign triangulation, best-crop Claude
reading, confirmed-space lifecycle, Cosmos, and Web PubSub. It loads no YOLO/depth
models and accepts no binary camera inference stream.

## Gap visibility and spot lifecycle

Tracking loss does not prove occupancy. When the camera turns, moves, rotates,
loses a boundary vehicle, stops submitting, or times out, the last open observation
keeps its original timestamp. The map ages it through its existing freshness colors
and hides it after five minutes. A one-second server maintenance task also marks
stale spots `expired`/`UNKNOWN` and emits `space.expired` without requiring another
camera upload. Mapping-mode seed spots remain exempt from expiry.

An occupied transition requires both real boundary vehicles to remain stable and
the same sufficiently confident vehicle to cover the opening in the same image
row for at least two seconds and three observations. Both the anchors and blocker
must remain stable against their reference boxes. Missing observations reset the
obstruction evidence. Frame-edge gaps cannot prove occupancy. Fresh contradictory
open-gap evidence from another session suppresses an occupied transition.
These conservative image checks still require physical-device validation; they
do not measure vehicle fit or establish curb legality.

`CURB_OCCUPANCY_CONFIRM_SEC` / `CURB_OCCUPANCY_CONFIRM_HITS` default to 2 / 3.
Anchor and blocker IoU thresholds default to 0.8; gap coverage and minimum blocker
confidence default to 0.6. Heading changes over 10 degrees, GPS steps over 5 metres,
or changed buffer dimensions invalidate the old viewpoint. These limits favor
retaining an aging observation over guessing occupancy from ambiguous footage.

Reobservations reuse the spot ID/version stored for the same directional road
segment, including after tracking/session loss, occupancy, expiry, or server
restart. Upload self-feedback, canonical nearby reads, and realtime events use
that same identity. This preserves the existing segment-based map granularity;
it does not distinguish multiple individually located stalls in one segment.
All outgoing observation timestamps explicitly carry UTC.

Structured `cv_transition` server logs and the bounded `transitions` history at
`GET /v1/debug/state` record open/refresh/occupied/expired decisions and gap-loss
reasons. `gap_diagnostics` exposes current visibility and pending obstruction
evidence. The history holds 500 entries and resets on server restart. It contains
no camera images or sign crops.

## Sign evidence and rule selection

The expanded scanner uses monochrome controls and white detection brackets.
A translucent silver car illustrates eligible confirmed openings; the camera
retains its original image. The white diagnostics sheet opens on demand with
Overview, Gaps and Signs tabs for tracking, measurements, extracted text,
reading scores and server receipts. Expansion, diagnostics and pause/resume
retain the same native camera. Previous readings are explicitly labeled.

Every selected sign crop is read individually (at most two per submission), so
a street-name plate cannot displace the regulatory sign below it on the same pole.
Street names, directional plates and unreadable text are excluded from curb-rule
association. Completeness of a JSON response is not sufficient: an illegible
reading is flagged and capped at a 0.25 score. A failed/uncertain track can retry
up to three times after additional observations and a materially better crop.

New tracks are classified before deduplication. An existing sign requires both a
compatible location/direction and matching sign type/text; proximity alone cannot
reuse a different sign's reading. The in-memory read cache uses exact crop hashes
and direction, not GPS alone. Newly validated rules also update already-open spots
without extending their availability timestamps.

Scanner rule evidence retains raw time/date text. Supported explicit daily,
weekly, and single nth-weekday monthly time windows are evaluated in
`America/Los_Angeles`, including the observed third-Tuesday 11 AM–1 PM restriction.
The restriction is not stored as an all-day ban. Ambiguous clocks, multiple distinct
windows, permit eligibility, holidays, last-weekday and other unsupported schedules
remain unknown. No validated parking sign also means legality is unknown. The map
can show observed unsigned openings as availability estimates; known illegal zones
are excluded, and unsigned details make no legality claim. Nearby reads, details, and realtime
zone payloads share this interpretation; maintenance publishes time-boundary changes
while a spot is fresh.

Polling event cursors start from a JavaScript-safe microsecond timestamp rather
than zero, so an installed phone's cursor can advance after a normal API restart.
To repair older scanner data after these changes, the area-scoped helper preserves
source text and observation times and retires old segment-ID aliases:

```sh
cd server
PYTHONPATH=. .venv/bin/python scripts/repair_scan_rules.py --lat 37.8043 --lng -122.4484 --radius-m 100
```

## Troubleshooting and profiling

- **Upload unavailable/tunnel errors:** `EXPO_PUBLIC_API_URL` is inlined into the
  JavaScript bundle, and `getApi()` caches the client for that app runtime. After
  changing `mobile/.env`, perform a full app reload; Fast Refresh is insufficient.
  An installed embedded bundle needs a new JS build/update to change its URL.
  From the repository root, check the origin before checking the public tunnel:

  ```sh
  curl --fail --show-error http://127.0.0.1:8000/health
  curl --fail --show-error https://YOUR_CONFIGURED_API_HOST/health
  pgrep -fl 'ngrok|cloudflared|uvicorn'
  ```

  Local health must return 200 first. If public health fails while local health
  works, inspect the tunnel process, its upstream port, configured hostname, and
  account credentials. If needed, start the local API from `server/` with
  `../.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000`. Keep both API
  and tunnel processes running. This repository cannot restore missing tunnel
  credentials or an unavailable reserved endpoint. Confirm public health returns
  200 before reloading the phone; do not treat local health alone as proof of
  device connectivity. [Expo environment-variable guidance](https://docs.expo.dev/guides/environment-variables/)
  explains full reloads and bundled public values.
- **Missing models/native inference error:** export both exact names, clean
  prebuild, and rebuild. Inspect `CurbVisionModels.bundle` in the app product for
  both `.mlmodelc` directories. A stale binary cannot see newly exported models.
  Read the camera error/Xcode console; never replace errors with empty detections.
  Orientation errors require physical rotation as configured above.
- **Pods/codegen/HybridObject errors:** run `npm ci`, check the `curb-vision` file
  dependency, and clean prebuild. Avoid duplicate module `node_modules` trees and
  manual Xcode references. After changing Nitro specs, run `npm exec -- nitrogen`
  from `mobile/modules/curb-vision/`, review generated bindings, and rebuild.
  Check `pod --version` and prebuild's autolinking output.
- **Permission:** grant camera access in the prompt or iOS Settings. Check
  `NSCameraUsageDescription` in `app.json`; rebuild after changes. Use an iPhone
  for camera/inference validation and allow foreground location for live scanning.
- **Signing/install:** check workspace, team, unique bundle identifier,
  provisioning, device registration/trust, and Developer Mode. These depend on
  your Apple account; the simulator command uses `CODE_SIGNING_ALLOWED=NO`.
- **Resource-fork/Finder metadata signing error:** inspect the failing generated
  bundle with `xattr -lr <bundle>` and clear its metadata with `xattr -cr <bundle>`
  as described in [Apple QA1940](https://developer.apple.com/library/archive/qa/qa1940/_index.html).
  If a cloud-managed Documents/Desktop folder adds it again, keep the checkout
  and dependency build output outside that synced folder, reinstall dependencies,
  and regenerate. Expo's JSI build creates its own nested build output, so changing
  only the app's DerivedData path may be insufficient.
- **Device profiling:** select a physical iPhone and profile a Release build with
  Xcode **Product → Profile**. Use Instruments' **Core ML** instrument alongside
  Time Profiler, Allocations, and thermal/energy tools on representative streets.
  Add the Neural Engine instrument to correlate model calls with ANE activity.
  Inspect each prediction's compute-device/operation placement; use Xcode's model
  performance report or Core ML compute plan to investigate CPU fallbacks.
  `.cpuAndNeuralEngine` permits CPU and ANE; it does not prove every operation
  runs on ANE. Measure inference time, processed/dropped frames, upload latency,
  memory, thermals, physical orientation/mirroring, crop alignment, and sign quality
  over sustained runs. Exercise Settings return, focus/background transitions,
  and worklet HybridObject serialization on the device.

No physical-iPhone FPS or ANE-placement measurement has been recorded. Simulator
compilation and macOS real-model smoke inference do not establish a 15–30 FPS rate.

## Repository checks

```sh
cd mobile
npm test -- --runInBand
npm run typecheck
npm run lint
npx expo-doctor
cd ..
PYTHONPATH=server .venv/bin/python -m pytest -c server/pytest.ini server/tests -q
npm test                      # all workspace suites, including payments/contracts
npm run typecheck
git diff --check
```

References: [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/),
[Continuous Native Generation](https://docs.expo.dev/workflow/continuous-native-generation/),
[local builds](https://docs.expo.dev/guides/local-app-development/), and
[VisionCamera frame outputs](https://visioncamera.margelo.com/docs/frame-output),
[Apple model performance reports](https://developer.apple.com/documentation/coreml/analyzing-a-core-ml-model-s-performance-in-xcode),
and [Core ML Instruments](https://developer.apple.com/videos/play/wwdc2022/10027/).

## Scanner gap outlines

The scanner uses monochrome gap outlines: dashed for candidates and solid for
confirmed openings. Gap labels appear in both compact and expanded camera views;
expanded diagnostics show duration, pixel width, sign text and server feedback.
The 3D car is no longer mounted in the live scanner. The native module and licensed
asset remain in the repository for reference.

Curb display summaries are separate from the complete OCR evidence used for
schedule evaluation. Next-change rows include the calendar date and Pacific time,
so a monthly restriction is not displayed as a bare “11 AM”. Fenced OCR JSON is
accepted; malformed replies show a readable retry message rather than JSON.


## Live preview feedback and OCR scheduling

Sign OCR runs in bounded background jobs (one per session, two external calls at
a time), outside the live tracking lock. Results are applied under the mutation
lock and arrive in subsequent frame feedback. Slow sign reading cannot hold a
camera response past the three-second geometry freshness limit. Shutdown and
session cleanup cancel their jobs.

Each client receipt retains an immutable snapshot of submitted geometry without
crop images. Gap geometry expires three seconds after capture and is hidden on
camera orientation changes. Scan details and the next upload report gap-detection
status in `preview_status`. `/v1/debug/state` retains 120 recent frame summaries
with processing time, confirmed interior gaps and pending OCR.

New openings publish their zone before the space. The client maintains an
event-time snapshot so batched messages do not lose their legality context before
React renders. A two-second polling safety net remains active alongside Web
PubSub; identical entity/type/version messages are deduplicated. New-opening
banners exclude previously known or announced spots and explicitly illegal curbs.
