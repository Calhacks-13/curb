"""
YOLO-based parking spot detector with segmentation + depth + BEV.

Dual-model: vehicle segmentation (yolov8m-seg) + sign detection (fine-tuned).
Falls back to bbox detection if seg model unavailable.
Falls back to COCO class 11 proxy if fine-tuned sign model is missing.
"""

import asyncio
import io
import math
import os
import numpy as np
import cv2
from PIL import Image

# ultralytics 8.2.0 predates torch 2.6+ weights_only=True default
import torch
_orig_load = torch.load
torch.load = lambda *a, **kw: _orig_load(*a, **{**kw, "weights_only": False})

from ultralytics import YOLO

from app.config import settings
from app.models import VehicleDetection, SignDetection, RawDetection, GapMeasurement
from app.cv.depth import estimate_depth, measure_gap_width_meters, is_available as depth_is_available

# Vehicle class IDs in COCO: car=2, motorcycle=3, bus=5, truck=7
VEHICLE_CLASSES = {2, 3, 5, 7}
COCO_SIGN_CLASS = 11  # stop sign — fallback proxy

_seg_model: YOLO | None = None
_vehicle_model: YOLO | None = None
_sign_model: YOLO | None = None
_sign_model_available: bool | None = None
_seg_model_available: bool | None = None


def get_seg_model() -> YOLO | None:
    """Load YOLOv8-seg model for instance segmentation."""
    global _seg_model, _seg_model_available
    if _seg_model_available is None:
        try:
            _seg_model = YOLO(settings.seg_model_path)
            _seg_model_available = True
        except Exception:
            _seg_model_available = False
    return _seg_model if _seg_model_available else None


def get_vehicle_model() -> YOLO:
    global _vehicle_model
    if _vehicle_model is None:
        _vehicle_model = YOLO(settings.vehicle_model_path)
    return _vehicle_model


def get_sign_model() -> YOLO | None:
    global _sign_model, _sign_model_available
    if _sign_model_available is None:
        _sign_model_available = os.path.exists(settings.sign_model_path)
    if not _sign_model_available:
        return None
    if _sign_model is None:
        _sign_model = YOLO(settings.sign_model_path)
    return _sign_model


def detect_from_frame(image_bytes: bytes, camera_pitch: float = 0.0) -> dict:
    """
    Run detection on a single frame.

    Tries segmentation first (pixel-precise masks), falls back to bbox detection.
    Optionally runs depth estimation for gap sizing in meters.
    Optionally applies BEV transform for accurate measurement.

    Returns dict with vehicles, signs, gap_estimate, gap_bboxes,
    gap_measurements, raw_detections, scene_valid, used_segmentation, used_depth.
    """
    image = Image.open(io.BytesIO(image_bytes))
    img_w, img_h = image.size

    vehicles: list[VehicleDetection] = []
    signs: list[SignDetection] = []
    raw_detections: list[RawDetection] = []
    used_segmentation = False
    used_depth = False

    # Try segmentation model first
    seg_model = get_seg_model()
    vehicle_masks = None  # combined binary mask of all vehicles

    if seg_model is not None:
        results = seg_model(image, verbose=False)[0]
        used_segmentation = True
        vehicle_masks = np.zeros((img_h, img_w), dtype=np.uint8)

        for i, box in enumerate(results.boxes):
            cls_id = int(box.cls[0])
            conf = float(box.conf[0])
            bbox = box.xyxy[0].tolist()
            cls_name = results.names[cls_id]

            if cls_id in VEHICLE_CLASSES and conf >= settings.vehicle_confidence:
                vehicles.append(VehicleDetection(
                    bbox=bbox, cls=cls_name, confidence=round(conf, 3),
                ))
                raw_detections.append(RawDetection(
                    bbox=bbox, cls=cls_name, confidence=round(conf, 3),
                    accepted=True, reason="vehicle-seg",
                ))
                # Add instance mask to combined vehicle mask
                if results.masks is not None and i < len(results.masks.data):
                    mask = results.masks.data[i].cpu().numpy()
                    # Resize mask to image dimensions (masks may be at model resolution)
                    if mask.shape != (img_h, img_w):
                        mask = cv2.resize(mask, (img_w, img_h), interpolation=cv2.INTER_NEAREST)
                    vehicle_masks[mask > 0.5] = 1

            elif cls_id in VEHICLE_CLASSES:
                raw_detections.append(RawDetection(
                    bbox=bbox, cls=cls_name, confidence=round(conf, 3),
                    accepted=False, reason="below threshold",
                ))
            elif cls_id == COCO_SIGN_CLASS and conf >= settings.sign_confidence:
                crop = _crop_bbox(image, bbox)
                signs.append(SignDetection(
                    bbox=bbox, confidence=round(conf, 3), crop_bytes=crop,
                ))
                raw_detections.append(RawDetection(
                    bbox=bbox, cls="sign", confidence=round(conf, 3),
                    accepted=True, reason="sign",
                ))
            else:
                raw_detections.append(RawDetection(
                    bbox=bbox, cls=cls_name, confidence=round(conf, 3),
                    accepted=False, reason="not vehicle class",
                ))
    else:
        # Fallback: bbox-only detection
        model = get_vehicle_model()
        results = model(image, verbose=False)[0]

        for box in results.boxes:
            cls_id = int(box.cls[0])
            conf = float(box.conf[0])
            bbox = box.xyxy[0].tolist()
            cls_name = results.names[cls_id]

            if cls_id in VEHICLE_CLASSES and conf >= settings.vehicle_confidence:
                vehicles.append(VehicleDetection(
                    bbox=bbox, cls=cls_name, confidence=round(conf, 3),
                ))
                raw_detections.append(RawDetection(
                    bbox=bbox, cls=cls_name, confidence=round(conf, 3),
                    accepted=True, reason="vehicle",
                ))
            elif cls_id in VEHICLE_CLASSES:
                raw_detections.append(RawDetection(
                    bbox=bbox, cls=cls_name, confidence=round(conf, 3),
                    accepted=False, reason="below threshold",
                ))
            elif cls_id == COCO_SIGN_CLASS and conf >= settings.sign_confidence:
                crop = _crop_bbox(image, bbox)
                signs.append(SignDetection(
                    bbox=bbox, confidence=round(conf, 3), crop_bytes=crop,
                ))
                raw_detections.append(RawDetection(
                    bbox=bbox, cls="sign", confidence=round(conf, 3),
                    accepted=True, reason="sign",
                ))
            else:
                raw_detections.append(RawDetection(
                    bbox=bbox, cls=cls_name, confidence=round(conf, 3),
                    accepted=False, reason="not vehicle class",
                ))

    # If fine-tuned sign model exists, run it separately
    sign_model = get_sign_model()
    if sign_model is not None:
        sign_results = sign_model(image, verbose=False)[0]
        for box in sign_results.boxes:
            conf = float(box.conf[0])
            bbox = box.xyxy[0].tolist()
            if conf >= settings.sign_confidence:
                crop = _crop_bbox(image, bbox)
                signs.append(SignDetection(
                    bbox=bbox, confidence=round(conf, 3), crop_bytes=crop,
                ))
                raw_detections.append(RawDetection(
                    bbox=bbox, cls="sign", confidence=round(conf, 3),
                    accepted=True, reason="sign",
                ))

    # Estimate gaps — segmentation-based or bbox-based
    if used_segmentation and vehicle_masks is not None and vehicle_masks.any():
        gap_bboxes = _gaps_from_segmentation(vehicle_masks, img_w, img_h)
    else:
        gap_bboxes = _gaps_from_bboxes(vehicles, img_w, img_h)

    # Depth estimation for gap sizing
    depth_map = None
    gap_measurements: list[GapMeasurement] = []
    if depth_is_available() and gap_bboxes:
        depth_map = estimate_depth(image)
        if depth_map is not None:
            used_depth = True
            # Apply BEV if we have camera pitch
            bev_masks = None
            if used_segmentation and vehicle_masks is not None and abs(camera_pitch) > 1.0:
                bev_masks = _perspective_to_bev(vehicle_masks, camera_pitch, img_w, img_h)

            for gbbox in gap_bboxes:
                width_m = measure_gap_width_meters(depth_map, gbbox, img_w)
                is_valid = width_m is not None and width_m >= settings.min_gap_meters
                gap_measurements.append(GapMeasurement(
                    bbox=gbbox,
                    width_meters=width_m,
                    width_pixels=int(gbbox[2] - gbbox[0]),
                    is_valid_spot=is_valid,
                ))

    if not gap_measurements:
        # No depth — fall back to pixel heuristic for validity
        for gbbox in gap_bboxes:
            gap_measurements.append(GapMeasurement(
                bbox=gbbox,
                width_pixels=int(gbbox[2] - gbbox[0]),
                is_valid_spot=True,  # assume valid without depth info
            ))

    # Count valid gaps
    if gap_measurements and any(gm.width_meters is not None for gm in gap_measurements):
        gap_estimate = sum(1 for gm in gap_measurements if gm.is_valid_spot)
    else:
        gap_estimate = len(gap_bboxes)

    scene_valid = len(vehicles) > 0 or len(signs) > 0

    return {
        "vehicles": vehicles,
        "signs": signs,
        "gap_estimate": gap_estimate,
        "gap_bboxes": [gm.bbox for gm in gap_measurements],
        "gap_measurements": gap_measurements,
        "raw_detections": raw_detections,
        "scene_valid": scene_valid,
        "used_segmentation": used_segmentation,
        "used_depth": used_depth,
        "frame_width": img_w,
        "frame_height": img_h,
    }


async def detect_from_frame_async(image_bytes: bytes, camera_pitch: float = 0.0) -> dict:
    return await asyncio.to_thread(detect_from_frame, image_bytes, camera_pitch)


def _crop_bbox(image: Image.Image, bbox: list[float]) -> bytes:
    cropped = image.crop((int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])))
    buf = io.BytesIO()
    cropped.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


def _gaps_from_segmentation(
    vehicle_masks: np.ndarray, img_w: int, img_h: int
) -> list[list[float]]:
    """
    Find gaps from segmentation masks.
    Projects vehicle mask to a 1D occupancy strip (bottom 60% of frame = road level),
    then finds connected empty regions.
    """
    # Focus on bottom 60% where road/vehicles are
    road_start = int(img_h * 0.4)
    road_mask = vehicle_masks[road_start:, :]

    # Collapse to 1D: for each column, is there a vehicle pixel?
    column_occupied = road_mask.any(axis=0).astype(np.uint8)

    # Find runs of unoccupied columns
    gap_bboxes: list[list[float]] = []
    min_gap_pixels = img_w * settings.min_gap_fraction

    in_gap = False
    gap_start = 0
    for x in range(img_w):
        if column_occupied[x] == 0 and not in_gap:
            in_gap = True
            gap_start = x
        elif column_occupied[x] == 1 and in_gap:
            in_gap = False
            gap_width = x - gap_start
            if gap_width >= min_gap_pixels:
                gap_bboxes.append([float(gap_start), float(road_start), float(x), float(img_h)])

    # Handle gap at right edge
    if in_gap:
        gap_width = img_w - gap_start
        if gap_width >= min_gap_pixels:
            gap_bboxes.append([float(gap_start), float(road_start), float(img_w), float(img_h)])

    return gap_bboxes


def _gaps_from_bboxes(
    vehicles: list[VehicleDetection], frame_width: int, frame_height: int
) -> list[list[float]]:
    """Legacy bbox gap estimation (fallback)."""
    min_gap = frame_width * settings.min_gap_fraction
    gap_bboxes: list[list[float]] = []

    if not vehicles:
        return []

    sorted_v = sorted(vehicles, key=lambda v: v.bbox[0])

    if sorted_v[0].bbox[0] >= min_gap:
        gap_bboxes.append([0, 0, sorted_v[0].bbox[0], frame_height])

    for i in range(len(sorted_v) - 1):
        right_edge = sorted_v[i].bbox[2]
        left_edge = sorted_v[i + 1].bbox[0]
        if left_edge - right_edge >= min_gap:
            gap_bboxes.append([right_edge, 0, left_edge, frame_height])

    if frame_width - sorted_v[-1].bbox[2] >= min_gap:
        gap_bboxes.append([sorted_v[-1].bbox[2], 0, frame_width, frame_height])

    return gap_bboxes


def _perspective_to_bev(
    mask: np.ndarray, camera_pitch: float, img_w: int, img_h: int
) -> np.ndarray | None:
    """
    Warp segmentation mask from perspective view to bird's eye view.
    Uses a homography based on camera pitch angle.
    """
    bev_size = settings.bev_output_size

    # Source points: trapezoid from perspective view (bottom wider, top narrower)
    # Adjusted based on camera pitch
    pitch_factor = max(0.1, min(0.9, 0.5 + camera_pitch / 90.0))
    top_margin = img_w * (0.3 + 0.2 * pitch_factor)

    src_pts = np.float32([
        [top_margin, int(img_h * 0.4)],           # top-left
        [img_w - top_margin, int(img_h * 0.4)],   # top-right
        [0, img_h],                                 # bottom-left
        [img_w, img_h],                             # bottom-right
    ])

    dst_pts = np.float32([
        [0, 0],
        [bev_size, 0],
        [0, bev_size],
        [bev_size, bev_size],
    ])

    M = cv2.getPerspectiveTransform(src_pts, dst_pts)
    bev = cv2.warpPerspective(mask, M, (bev_size, bev_size), flags=cv2.INTER_NEAREST)
    return bev
