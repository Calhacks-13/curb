# /// script
# requires-python = ">=3.11,<3.12"
# dependencies = [
#   "ultralytics==8.3.237",
#   "coremltools==9.0",
#   "torch==2.7.0",
#   "torchvision==0.22.0",
#   "numpy==2.2.6",
#   "clip @ git+https://github.com/ultralytics/CLIP.git@7ffa84b3bfa40c42ecc1c77147a855e69cb2dd40",
# ]
# ///
"""Export real checkpoint detection branches with embedded Apple CoreML NMS.

Run from any directory: uv run --python 3.11 mobile/scripts/export-coreml-models.py
All downloads/intermediate exports live in a temporary directory. Only validated
packages replace the final local artifacts, so reruns cannot nest stale packages.
"""

import json
import os
from pathlib import Path
import shutil
import tempfile

import coremltools as ct
import torch
from ultralytics import YOLO, YOLOWorld
from ultralytics.nn.modules import Detect, Segment


SIGN_PROMPTS = [
    "parking sign",
    "no parking sign",
    "traffic sign",
    "parking meter",
    "parking garage sign",
    "parking lot sign",
    "parking arrow sign",
]
MODEL_DIR = Path(__file__).resolve().parents[1] / "modules" / "curb-vision" / "models"


def detection_branch(seg):
    """Keep the segmentation checkpoint's trained box/class branch exactly.

    Ultralytics 8.3.237 ignores nms=True for segmentation CoreML exports. Segment
    subclasses Detect and adds only `proto`/`cv4` mask branches. Switch that head
    to its Detect parent, removing only mask modules, so the official exporter
    wraps the original detection branch in Apple's confidence/coordinates NMS.
    Verify equivalence before exporting instead of substituting another model.
    """
    head = seg.model.model[-1]
    if type(head) is not Segment or head.nc != 80:
        raise RuntimeError("Expected the 80-class Segment head from yolov8s-seg.pt")
    seg.model.eval()
    example = torch.zeros(1, 3, 640, 640)
    with torch.no_grad():
        original = seg.model(example)[0][:, :84].clone()
    head.__class__ = Detect
    del head.proto
    del head.cv4
    seg.task = seg.model.task = "detect"
    with torch.no_grad():
        torch.testing.assert_close(seg.model(example)[0], original, rtol=0, atol=0)
    print("Verified yolov8s-seg trained box/class branch is bit-identical; removed masks only", flush=True)
    return seg


def inspect_package(path):
    if not path.is_dir() or path.suffix != ".mlpackage":
        raise RuntimeError(f"CoreML export package missing: {path}")
    model = ct.models.MLModel(str(path), skip_model_load=True)
    spec = model.get_spec()
    outputs = {feature.name for feature in spec.description.output}
    if not {"confidence", "coordinates"}.issubset(outputs):
        raise RuntimeError(f"{path}: expected embedded NMS outputs, found {outputs}")
    if not spec.HasField("pipeline") or not any(
        submodel.HasField("nonMaximumSuppression") for submodel in spec.pipeline.models
    ):
        raise RuntimeError(f"{path}: embedded CoreML NMS pipeline missing")
    print(f"\nValidated {path.name}", flush=True)
    for direction in ("input", "output"):
        for feature in getattr(spec.description, direction):
            print(f"  {direction} {feature.name}: {feature.type}", flush=True)
    return model


def publish(model, stem, class_names):
    result = model.export(format="coreml", imgsz=640, nms=True, conf=0.25, iou=0.45)
    if not result:
        raise RuntimeError(f"{stem}: CoreML export did not produce a package")
    exported = Path(result)
    validated = inspect_package(exported)
    # YOLO-World's seven channels are padded to 80 by this pinned upstream
    # exporter to avoid a CoreML NMS bug. Padding channels have zero confidence.
    validated.user_defined_metadata["curb.class_names"] = json.dumps(class_names)
    validated.user_defined_metadata["curb.source_checkpoint"] = f"{stem}.pt"
    staged = MODEL_DIR / f".{stem}.staging.mlpackage"
    destination = MODEL_DIR / f"{stem}.mlpackage"
    if staged.exists():
        shutil.rmtree(staged)
    validated.save(str(staged))
    inspect_package(staged)
    if destination.exists():
        shutil.rmtree(destination)
    staged.rename(destination)
    print(f"Saved {destination}", flush=True)


def main():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    previous_directory = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="curb-coreml-export-") as work:
        os.chdir(work)
        try:
            vehicles = detection_branch(YOLO("yolov8s-seg.pt"))
            publish(vehicles, "yolov8s-seg", list(vehicles.names.values()))
            signs = YOLOWorld("yolov8m-worldv2.pt")
            signs.set_classes(SIGN_PROMPTS)
            if list(signs.names.values()) != SIGN_PROMPTS:
                raise RuntimeError("YOLO-World class order does not match SIGN_PROMPTS")
            publish(signs, "yolov8m-worldv2", SIGN_PROMPTS)
        finally:
            os.chdir(previous_directory)


if __name__ == "__main__":
    main()
