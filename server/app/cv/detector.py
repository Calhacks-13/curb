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

import logging
from ultralytics import YOLO, YOLOWorld

from app.config import settings
from app.models import VehicleDetection, SignDetection, RawDetection, GapMeasurement
from app.cv.depth import estimate_depth, measure_gap_width_meters, is_available as depth_is_available, is_metric as depth_is_metric

# Vehicle class IDs in COCO: car=2, motorcycle=3, bus=5, truck=7
VEHICLE_CLASSES = {2, 3, 5, 7}
COCO_SIGN_CLASS = 11  # stop sign — fallback proxy

_seg_model: YOLO | None = None
_vehicle_model: YOLO | None = None
_sign_model: YOLO | None = None
_sign_model_available: bool | None = None
_seg_model_available: bool | None = None

# Frame counter + cached results for skip-frame logic
_frame_count: int = 0
_cached_depth_map: np.ndarray | None = None
_cached_signs: list[SignDetection] = []
_cached_sign_raws: list[RawDetection] = []


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


logger = logging.getLogger(__name__)


def get_sign_model() -> YOLO | None:
    """Load sign model: fine-tuned first, then YOLO-World open-vocabulary fallback."""
    global _sign_model, _sign_model_available
    if _sign_model_available is not None:
        return _sign_model if _sign_model_available else None

    # Try fine-tuned sign model first
    if os.path.exists(settings.sign_model_path):
        try:
            _sign_model = YOLO(settings.sign_model_path)
            _sign_model_available = True
            logger.info("Loaded fine-tuned sign model: %s", settings.sign_model_path)
            return _sign_model
        except Exception as e:
            logger.warning("Failed to load fine-tuned sign model: %s", e)

    # Fallback: YOLO-World open-vocabulary
    if os.path.exists(settings.sign_world_model_path):
        try:
            _sign_model = YOLOWorld(settings.sign_world_model_path)
            _sign_model.set_classes(settings.sign_world_classes)
            _sign_model_available = True
            logger.info("Loaded YOLO-World sign model: %s with classes %s",
                        settings.sign_world_model_path, settings.sign_world_classes)
            return _sign_model
        except Exception as e:
            logger.warning("Failed to load YOLO-World sign model: %s", e)

    _sign_model_available = False
    return None


def detect_from_frame(image_bytes: bytes, camera_pitch: float = 0.0, hfov: float | None = None) -> dict:
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
        results = seg_model(image, verbose=False, imgsz=settings.yolo_imgsz, half=settings.yolo_half)[0]
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
        results = model(image, verbose=False, imgsz=settings.yolo_imgsz, half=settings.yolo_half)[0]

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

    # If fine-tuned sign model exists, run it every Nth frame (signs are static)
    global _frame_count, _cached_signs, _cached_sign_raws
    _frame_count += 1
    run_signs = (_frame_count % settings.sign_every_n == 0)

    sign_model = get_sign_model()
    if sign_model is not None and run_signs:
        sign_results = sign_model(image, verbose=False, imgsz=settings.yolo_imgsz, half=settings.yolo_half)[0]
        _cached_signs = []
        _cached_sign_raws = []
        for box in sign_results.boxes:
            conf = float(box.conf[0])
            bbox = box.xyxy[0].tolist()
            if conf >= settings.sign_confidence:
                crop = _crop_bbox(image, bbox)
                _cached_signs.append(SignDetection(
                    bbox=bbox, confidence=round(conf, 3), crop_bytes=crop,
                ))
                _cached_sign_raws.append(RawDetection(
                    bbox=bbox, cls="sign", confidence=round(conf, 3),
                    accepted=True, reason="sign",
                ))
    # Use cached signs on skip frames
    signs.extend(_cached_signs)
    raw_detections.extend(_cached_sign_raws)

    # Estimate gaps — segmentation-based or bbox-based
    if used_segmentation and vehicle_masks is not None and vehicle_masks.any():
        gap_bboxes = _gaps_from_segmentation(vehicle_masks, img_w, img_h)
    else:
        gap_bboxes = _gaps_from_bboxes(vehicles, img_w, img_h)

    # Depth estimation for gap sizing + viewer visualization (every Nth frame, cached)
    global _cached_depth_map
    depth_map = None
    bev = None  # reused for both gap measurement and viz
    gap_measurements: list[GapMeasurement] = []
    run_depth = (_frame_count % settings.depth_every_n == 0)
    if depth_is_available():
        if run_depth:
            depth_map = estimate_depth(image)
            _cached_depth_map = depth_map
        else:
            depth_map = _cached_depth_map
    if depth_map is not None:
        used_depth = True

    # Compute BEV once — used for gap measurement and viz panel
    if used_segmentation and vehicle_masks is not None and vehicle_masks.any():
        bev = _perspective_to_bev(vehicle_masks, camera_pitch, img_w, img_h)

    if depth_map is not None and gap_bboxes:
        # Apply BEV if we have camera pitch — re-find gaps in top-down view
        bev_masks = None
        if bev is not None and abs(camera_pitch) > 1.0:
            bev_masks = bev

        # Use BEV-based gap bboxes when available (more accurate top-down geometry)
        measure_bboxes = gap_bboxes
        measure_width = img_w
        if bev_masks is not None and bev_masks.any():
            bev_size = settings.bev_output_size
            bev_gap_bboxes = _gaps_from_segmentation(bev_masks, bev_size, bev_size)
            if bev_gap_bboxes:
                measure_bboxes = bev_gap_bboxes
                measure_width = bev_size

        for gbbox in measure_bboxes:
            width_m = measure_gap_width_meters(depth_map, gbbox, measure_width, camera_hfov_deg=hfov)
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

    # --- Visualization data (for viewer panel, not overlaid on camera) ---

    # Per-vehicle depth sampling
    if depth_map is not None:
        _metric = depth_is_metric()
        for v in vehicles:
            cx = int((v.bbox[0] + v.bbox[2]) / 2)
            cy = int((v.bbox[1] + v.bbox[3]) / 2)
            cy = max(0, min(cy, depth_map.shape[0] - 1))
            cx = max(0, min(cx, depth_map.shape[1] - 1))
            r = 3
            patch = depth_map[
                max(0, cy - r):min(depth_map.shape[0], cy + r),
                max(0, cx - r):min(depth_map.shape[1], cx + r),
            ]
            sampled = float(np.median(patch)) if patch.size > 0 else 0.0
            if _metric:
                v.depth_m = round(sampled, 1) if sampled > 0.1 else None
            else:
                v.depth_m = round(3.0 / (sampled + 0.05), 1) if sampled > 0.01 else None

    # Encode depth map as small colorized JPEG for viewer side-panel
    depth_jpeg: bytes | None = None
    if depth_map is not None:
        depth_jpeg = _encode_depth_viz(depth_map)

    # Encode BEV mask as small JPEG for viewer side-panel
    bev_jpeg: bytes | None = None
    if bev is not None and bev.any():
        bev_jpeg = _encode_bev_viz(bev)

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
        "depth_jpeg": depth_jpeg,
        "bev_jpeg": bev_jpeg,
    }


async def detect_from_frame_async(image_bytes: bytes, camera_pitch: float = 0.0, hfov: float | None = None) -> dict:
    return await asyncio.to_thread(detect_from_frame, image_bytes, camera_pitch, hfov)


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
    then finds connected empty regions BETWEEN occupied runs.
    Skips edge gaps (before first vehicle or after last vehicle) since the
    frame boundary may cut through a parked car.
    """
    # Focus on bottom 60% where road/vehicles are
    road_start = int(img_h * 0.4)
    road_mask = vehicle_masks[road_start:, :]

    # Collapse to 1D: for each column, is there a vehicle pixel?
    column_occupied = road_mask.any(axis=0).astype(np.uint8)

    # Find runs of occupied and unoccupied columns
    min_gap_pixels = img_w * settings.min_gap_fraction
    runs: list[tuple[bool, int, int]] = []  # (is_occupied, start_x, end_x)
    in_occupied = column_occupied[0] == 1
    run_start = 0
    for x in range(1, img_w):
        is_occ = column_occupied[x] == 1
        if is_occ != in_occupied:
            runs.append((in_occupied, run_start, x))
            in_occupied = is_occ
            run_start = x
    runs.append((in_occupied, run_start, img_w))

    # Only keep empty runs that are BETWEEN two occupied runs (skip edges)
    gap_bboxes: list[list[float]] = []
    for i, (is_occ, start_x, end_x) in enumerate(runs):
        if is_occ:
            continue
        gap_width = end_x - start_x
        if gap_width < min_gap_pixels:
            continue
        # Must have an occupied run on both sides
        has_left = any(r[0] for r in runs[:i])
        has_right = any(r[0] for r in runs[i + 1:])
        if has_left and has_right:
            gap_bboxes.append([float(start_x), float(road_start), float(end_x), float(img_h)])

    return gap_bboxes


def _gaps_from_bboxes(
    vehicles: list[VehicleDetection], frame_width: int, frame_height: int
) -> list[list[float]]:
    """Legacy bbox gap estimation (fallback).

    Only counts gaps BETWEEN two vehicles — skips frame-edge gaps.
    """
    min_gap = frame_width * settings.min_gap_fraction
    gap_bboxes: list[list[float]] = []

    if len(vehicles) < 2:
        return []

    sorted_v = sorted(vehicles, key=lambda v: v.bbox[0])

    for i in range(len(sorted_v) - 1):
        right_edge = sorted_v[i].bbox[2]
        left_edge = sorted_v[i + 1].bbox[0]
        if left_edge - right_edge >= min_gap:
            gap_bboxes.append([right_edge, 0, left_edge, frame_height])

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


# --- Visualization encoders (small images for viewer side-panel) ---

# Turbo-like colormap: close=red/orange, mid=green/cyan, far=blue/purple
_DEPTH_CMAP = None

def _get_depth_colormap() -> np.ndarray:
    """Build a 256-entry RGB colormap (close=warm, far=cool)."""
    global _DEPTH_CMAP
    if _DEPTH_CMAP is not None:
        return _DEPTH_CMAP
    cmap = np.zeros((256, 3), dtype=np.uint8)
    for i in range(256):
        t = i / 255.0
        # Warm-to-cool: red -> orange -> yellow -> cyan -> blue -> purple
        if t < 0.25:
            s = t / 0.25
            cmap[i] = [255, int(60 * s), int(20 * s)]
        elif t < 0.5:
            s = (t - 0.25) / 0.25
            cmap[i] = [int(255 * (1 - s)), int(60 + 180 * s), int(20 + 60 * s)]
        elif t < 0.75:
            s = (t - 0.5) / 0.25
            cmap[i] = [0, int(240 - 100 * s), int(80 + 175 * s)]
        else:
            s = (t - 0.75) / 0.25
            cmap[i] = [int(80 * s), int(140 - 100 * s), 255]
    _DEPTH_CMAP = cmap
    return _DEPTH_CMAP


def _encode_depth_viz(depth_map: np.ndarray) -> bytes:
    """Colorize depth map and encode as small JPEG for viewer."""
    h, w = depth_map.shape[:2]
    # Resize to small thumbnail (160px wide, keep aspect)
    viz_w = 160
    viz_h = max(1, int(h * viz_w / w))
    small = cv2.resize(depth_map, (viz_w, viz_h), interpolation=cv2.INTER_AREA)

    # Normalize to 0-255
    d_min, d_max = float(small.min()), float(small.max())
    if d_max - d_min > 1e-6:
        norm = ((small - d_min) / (d_max - d_min) * 255).astype(np.uint8)
    else:
        norm = np.zeros((viz_h, viz_w), dtype=np.uint8)

    # Apply colormap
    cmap = _get_depth_colormap()
    colored = cmap[norm]  # (H, W, 3)

    _, buf = cv2.imencode(".jpg", colored[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 75])
    return buf.tobytes()


def _encode_bev_viz(bev_mask: np.ndarray) -> bytes:
    """Colorize BEV vehicle mask and encode as small JPEG for viewer."""
    bev_size = bev_mask.shape[0]
    # Resize to 200px for viewer
    viz_size = 200
    small = cv2.resize(bev_mask, (viz_size, viz_size), interpolation=cv2.INTER_NEAREST)

    # Create dark background with green vehicle silhouettes
    viz = np.zeros((viz_size, viz_size, 3), dtype=np.uint8)
    viz[:] = [12, 12, 14]  # near-black background

    # Draw faint grid lines
    for r in [50, 100, 150]:
        cv2.circle(viz, (viz_size // 2, viz_size), r, (30, 30, 35), 1)

    # Vehicle silhouettes in green
    viz[small > 0] = [52, 211, 153]

    # "You" triangle at bottom center
    tri_cx, tri_cy = viz_size // 2, viz_size - 8
    pts = np.array([
        [tri_cx, tri_cy - 10],
        [tri_cx - 6, tri_cy + 4],
        [tri_cx + 6, tri_cy + 4],
    ], dtype=np.int32)
    cv2.fillPoly(viz, [pts], (96, 165, 250))

    _, buf = cv2.imencode(".jpg", viz, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return buf.tobytes()
