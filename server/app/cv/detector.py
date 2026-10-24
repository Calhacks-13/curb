"""
YOLO-based parking spot detector.

Receives JPEG bytes + GPS, returns detected objects:
- vehicles (car, truck, bus, motorcycle)
- empty curb gaps (inferred from spacing between vehicles)
- parking signs (triggers Claude Vision pipeline)
"""

import io
import numpy as np
from PIL import Image
from ultralytics import YOLO

# Vehicle class IDs in COCO: car=2, motorcycle=3, bus=5, truck=7
VEHICLE_CLASSES = {2, 3, 5, 7}
SIGN_CONFIDENCE_THRESHOLD = 0.4
VEHICLE_CONFIDENCE_THRESHOLD = 0.5

_model = None


def get_model() -> YOLO:
    global _model
    if _model is None:
        _model = YOLO("yolov8n.pt")  # nano for speed (~20-30ms)
    return _model


def detect_from_frame(image_bytes: bytes) -> dict:
    """
    Run YOLO on a single frame.

    Returns:
        {
            "vehicles": [{"bbox": [x1,y1,x2,y2], "class": "car", "conf": 0.92}, ...],
            "signs": [{"bbox": [x1,y1,x2,y2], "conf": 0.71, "crop_bytes": bytes}, ...],
            "gap_estimate": int  # number of potential open spots inferred
        }
    """
    model = get_model()
    image = Image.open(io.BytesIO(image_bytes))
    results = model(image, verbose=False)[0]

    vehicles = []
    signs = []

    for box in results.boxes:
        cls_id = int(box.cls[0])
        conf = float(box.conf[0])
        bbox = box.xyxy[0].tolist()

        if cls_id in VEHICLE_CLASSES and conf >= VEHICLE_CONFIDENCE_THRESHOLD:
            vehicles.append({
                "bbox": bbox,
                "class": results.names[cls_id],
                "conf": round(conf, 3),
            })

        # COCO class 11 = stop sign (closest proxy; fine-tune later for parking signs)
        if cls_id == 11 and conf >= SIGN_CONFIDENCE_THRESHOLD:
            crop = _crop_bbox(image, bbox)
            signs.append({
                "bbox": bbox,
                "conf": round(conf, 3),
                "crop_bytes": crop,
            })

    gap_estimate = _estimate_gaps(vehicles, image.width)

    return {
        "vehicles": vehicles,
        "signs": signs,
        "gap_estimate": gap_estimate,
    }


def _crop_bbox(image: Image.Image, bbox: list[float]) -> bytes:
    """Crop a bounding box region and return as JPEG bytes."""
    cropped = image.crop((int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])))
    buf = io.BytesIO()
    cropped.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


def _estimate_gaps(vehicles: list[dict], frame_width: int) -> int:
    """
    Rough gap estimation: sort vehicles by x-position,
    count gaps wide enough to fit a car (~15% of frame width).
    """
    if len(vehicles) < 2:
        return 1 if len(vehicles) == 0 else 0

    min_gap = frame_width * 0.15
    sorted_v = sorted(vehicles, key=lambda v: v["bbox"][0])
    gaps = 0
    for i in range(len(sorted_v) - 1):
        right_edge = sorted_v[i]["bbox"][2]
        left_edge = sorted_v[i + 1]["bbox"][0]
        if left_edge - right_edge >= min_gap:
            gaps += 1
    return gaps
