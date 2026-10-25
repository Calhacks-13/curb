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
later submissions/confirmations. There is no offline queue. JSON goes to
`POST /v1/vision/detections`:

```json
{
  "device_id": "device-id",
  "session_id": "session-id",
  "captured_at": "2026-10-24T18:00:00.000Z",
  "lat": 37.8,
  "lng": -122.4,
  "heading": 180,
  "frame_width": 1280,
  "frame_height": 720,
  "vehicles": [{ "bbox": [10, 20, 200, 300], "cls": "car", "confidence": 0.85 }],
  "signs": [{ "bbox": [400, 80, 440, 160], "confidence": 0.7, "crop_b64": "<sign JPEG only>" }]
}
```

Payload size varies with detections/crops. Full frames never leave the device.
FastAPI validates bounds/confidence/strict base64, decodes crops, and calls
`Pipeline.process_detections`. Empty lists age trackers. The server keeps
VehicleTracker, GapTracker, SignTracker, sign triangulation, best-crop Claude
reading, confirmed-space lifecycle, Cosmos, and Web PubSub. It loads no YOLO/depth
models and accepts no binary camera inference stream.

## Troubleshooting and profiling

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
