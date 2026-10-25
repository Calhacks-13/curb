# Local CoreML resources

The iOS build requires both local model packages. Model binaries are ignored by
Git because this repository does not use Git LFS. Regenerate from the repository
root on macOS with Python 3.11 (the script pins its dependencies):

```sh
UV_CACHE_DIR=/tmp/curb-uv-cache uv run --python 3.11 mobile/scripts/export-coreml-models.py
```

The script downloads `yolov8s-seg.pt` and `yolov8m-worldv2.pt`, exports at 640×640
with `nms=True`, and validates the saved specifications and embedded NMS. Outputs:

- `models/yolov8s-seg.mlpackage`
- `models/yolov8m-worldv2.mlpackage`

Ultralytics 8.3.237 does not embed Apple NMS for segmentation models. The script
therefore removes only the segmentation checkpoint's mask-specific `proto` and
`cv4` head branches and exports the original trained detection branch through
Ultralytics' detection/NMS exporter. It first checks that all 84 box/class output
channels are bit-identical on a 640px input. No detection checkpoint is substituted.
Segmentation masks are not needed by Curb's API.

YOLO-World embeds these prompts in this exact zero-based order:

```text
0 parking sign
1 no parking sign
2 traffic sign
3 parking meter
4 parking garage sign
5 parking lot sign
6 parking arrow sign
```

The pinned exporter pads the seven sign confidence channels to 80 with zeros as
a workaround for Apple's MLProgram NMS bug. The first seven retain the ordering
above. The vehicle model uses the original 80-class COCO order; Curb retains only
`2 car`, `3 motorcycle`, `5 bus`, and `7 truck`. Both exports embed a confidence
threshold of 0.25 and IoU threshold of 0.45. Swift also enforces confidence ≥0.25.
The script stores `curb.class_names` and `curb.source_checkpoint` metadata, which
the native loader validates. Normalized `coordinates` are `[cx, cy, w, h]` from
the top-left; `confidence` is `[candidate, class]`.

The podspec adds both packages to `CurbVisionModels.bundle`. Xcode compiles them
to these exact runtime names within that bundle:

- `yolov8s-seg.mlmodelc`
- `yolov8m-worldv2.mlmodelc`

Run Expo prebuild/CocoaPods again after adding the local module, then rebuild the
development app. Never copy sources or model resources into generated `mobile/ios`
by hand. Missing/unloadable resources throw a native inference error.

Task 5 must configure `useFrameOutput({ enablePhysicalBufferRotation: true, ... })`.
`detect` rejects frames whose orientation is not `up` or whose mirroring still
requires a transform. Its frame dimensions, returned top-left pixel boxes, and
crop JPEGs all refer to that physically oriented source buffer. Vision scales
the full buffer to 640×640 with `scaleFill`. Only sign crops are JPEG encoded.
Call `getCurbVision()` on the RN runtime on iOS and capture that HybridObject in
the frame worklet. Always dispose the frame in `finally` after `detect` returns.

Nitrogen 0.37.1 cannot bridge a four-number Swift tuple. The generated ABI uses
`number[]`/`[Double]`; Swift constructs exactly four finite ordered coordinates,
and `src/index.ts` exposes the public `[number, number, number, number]` tuple.
