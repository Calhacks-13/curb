# On-Device CV Migration Guide

## Goal
Move YOLO inference from the server to the iPhone. This eliminates network latency and gets us 15-30fps real-time detection.

## What stays the same
- **Server** (`server/app/`) — still needed for:
  - Sign reading (Claude Vision API call — too expensive/large for on-device)
  - Cosmos DB storage (spots, signs, blocks)
  - Web PubSub broadcasting (sharing spots between users)
  - `/signs/*` endpoints, `/v1/nearby`, `/v1/debug/state`
- **Pipeline logic** — tracking, gap confirmation, sign triangulation all stay on server
- **Mobile app UI** — map, spots, camera overlay all stay

## What changes

### 1. Export YOLO models to CoreML

On any machine with Python + ultralytics:

```python
from ultralytics import YOLO, YOLOWorld

# Vehicle segmentation model
seg = YOLO("yolov8s-seg.pt")  # use small for phone
seg.export(format="coreml", imgsz=640, nms=True)
# produces: yolov8s-seg.mlpackage

# Sign detection (YOLO-World)
sign = YOLOWorld("yolov8m-worldv2.pt")
sign.set_classes([
    "parking sign", "no parking sign", "traffic sign", "parking meter",
    "parking garage sign", "parking lot sign", "parking arrow sign",
])
sign.export(format="coreml", imgsz=640, nms=True)
# produces: yolov8m-worldv2.mlpackage
```

Copy both `.mlpackage` files into the iOS project.

### 2. Eject from Expo Go to native build

```bash
cd mobile
npx expo prebuild --platform ios
```

This generates the `ios/` folder with an Xcode project. Open in Xcode, build to device.

### 3. Replace expo-camera with react-native-vision-camera

Install:
```bash
npm install react-native-vision-camera
cd ios && pod install
```

react-native-vision-camera gives you:
- 30fps frame access via frame processors
- Direct access to camera buffers (no JPEG encode/decode)
- Plugin system for running ML models per frame

### 4. Create a frame processor plugin

Install the ML plugin:
```bash
npm install react-native-vision-camera-mlkit
# OR use a CoreML frame processor plugin
```

The frame processor runs YOLO on every frame on-device:

```typescript
// Pseudocode — exact API depends on plugin choice
import { useFrameProcessor } from 'react-native-vision-camera';

const frameProcessor = useFrameProcessor((frame) => {
  'worklet';
  const detections = runYOLO(frame);  // CoreML, runs on Neural Engine

  // detections = [{ bbox, cls, confidence, mask }, ...]
  // Send ONLY detections (not the full frame) to server
}, []);
```

### 5. Change what gets sent to the server

Instead of uploading full JPEG frames, send only:
- Vehicle detections (bbox, class, confidence)
- Sign detections (bbox, confidence, small crop JPEG of just the sign)
- GPS + heading metadata

New endpoint (replace `/v1/vision/frames`):

```
POST /v1/vision/detections
{
  "session_id": "...",
  "lat": 37.xxx,
  "lng": -122.xxx,
  "heading": 180.0,
  "vehicles": [
    {"bbox": [x1,y1,x2,y2], "cls": "car", "confidence": 0.85}
  ],
  "signs": [
    {"bbox": [x1,y1,x2,y2], "confidence": 0.7, "crop_b64": "..."}
  ],
  "frame_width": 1280,
  "frame_height": 720
}
```

This payload is ~1KB vs ~100-300KB for a full JPEG. Network is no longer a bottleneck.

### 6. Server-side changes

The pipeline (`app/cv/pipeline.py`) already separates detection from tracking. The changes:

- **Remove**: `detect_from_frame_async()` call in pipeline.process_frame()
- **Add**: accept pre-computed detections as input
- **Keep**: VehicleTracker, GapTracker, SignTracker, sign triangulation, Claude calls, Cosmos storage — all unchanged

Rough change to `pipeline.process_frame()`:
```python
async def process_frame(
    # OLD: image_bytes, then run YOLO
    # NEW: pre-computed detections from phone
    vehicles: list[dict],  # [{bbox, cls, confidence}]
    signs: list[dict],     # [{bbox, confidence, crop_bytes}]
    frame_width: int,
    frame_height: int,
    lat: float,
    lng: float,
    session_id: str,
    heading: float = 0.0,
) -> dict:
```

### 7. Sign reading stays server-side

When the sign tracker confirms a sign (3 frames), the phone has been sending small sign crops. The server:
1. Triangulates sign position (same as now)
2. Sends best crop to Claude Vision (same as now)
3. Stores in Cosmos, broadcasts via Web PubSub (same as now)

## Requirements
- Mac with Xcode 15+
- iPhone plugged in for dev builds (or TestFlight for distribution)
- Apple Developer account (free account works for dev builds to your own phone)
- ~1 day of work for someone familiar with react-native-vision-camera

## Expected result
- 15-30fps on-device detection (iPhone Neural Engine)
- ~1KB per server call instead of ~200KB
- Server calls only needed for tracking state + sign reading
- Detection works offline (spots just won't sync until connected)
