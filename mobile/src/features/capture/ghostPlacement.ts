import type { DetectionBox, FrameAccepted, OnDeviceInference } from "@/api/types";
import type { DeepReadonly } from "./DetectionUploadController";

export type PreviewState = { placements: GhostPlacement[]; detail: string };
export type GhostPlacement = { key: string; bbox: DetectionBox; yaw: number };

/** Image-relative scale from adjacent cars. Never infer metres or vehicle fit. */
export function ghostPreviewState(inference: DeepReadonly<OnDeviceInference> | null, analysis: DeepReadonly<FrameAccepted> | null,
  submitted: DeepReadonly<OnDeviceInference> | null = inference): PreviewState {
  const hidden = (detail: string): PreviewState => ({ placements: [], detail });
  if (!inference) return hidden("Waiting for camera detections");
  if (!analysis) return hidden("Waiting for fresh gap analysis");
  if (!submitted || inference.frameWidth !== analysis.frame_width || inference.frameHeight !== analysis.frame_height
    || submitted.frameWidth !== inference.frameWidth || submitted.frameHeight !== inference.frameHeight) return hidden("Camera orientation changed — refreshing analysis");
  if (!analysis.tracked_gaps?.some((gap) => gap.confirmed)) return hidden("Hold the opening in view to confirm it");
  if (!analysis.tracked_gaps.some((gap) => gap.confirmed && gap.left_track_id >= 0 && gap.right_track_id >= 0)) return hidden("Keep a car on each side of the opening in view");
  const cars = inference.vehicles.filter((car) => ["car", "truck", "bus"].includes(car.cls) && car.confidence >= 0.25);
  const sourceCars = submitted.vehicles.filter((car) => ["car", "truck", "bus"].includes(car.cls) && car.confidence >= 0.25);
  const result: GhostPlacement[] = [];
  let blocked = "Keep both neighboring cars in view";
  for (const gap of analysis.tracked_gaps ?? []) {
    if (!gap.confirmed || gap.left_track_id < 0 || gap.right_track_id < 0) continue;
    const tolerance = Math.max(2, inference.frameWidth * 0.015);
    if (!analysis.gap_bboxes?.some((box) => Math.abs(box[0] - gap.bbox[0]) <= tolerance && Math.abs(box[2] - gap.bbox[2]) <= tolerance)) continue;
    const [sourceLeft, , sourceRight] = gap.bbox;
    const width = sourceRight - sourceLeft;
    if (width <= 0) continue;
    const sourceBefore = sourceCars.filter((car) => car.bbox[0] < sourceLeft && Math.abs(car.bbox[2] - sourceLeft) < inference.frameWidth * 0.08)
      .sort((a, b) => Math.abs(a.bbox[2] - sourceLeft) - Math.abs(b.bbox[2] - sourceLeft))[0];
    const sourceAfter = sourceCars.filter((car) => car.bbox[2] > sourceRight && Math.abs(car.bbox[0] - sourceRight) < inference.frameWidth * 0.08)
      .sort((a, b) => Math.abs(a.bbox[0] - sourceRight) - Math.abs(b.bbox[0] - sourceRight))[0];
    if (!sourceBefore || !sourceAfter) continue;
    // Match the server's submitted anchors to the current native image. This
    // permits normal camera motion without painting an old gap over a new car.
    const match = (box: Readonly<DetectionBox>) => cars.map((car) => ({ car, overlap: boxOverlap(car.bbox, box) }))
      .sort((a, b) => b.overlap - a.overlap).find((item) => item.overlap >= 0.45)?.car;
    const before = match(sourceBefore.bbox), after = match(sourceAfter.bbox);
    if (!before || !after || before === after) { blocked = "Camera moved — waiting for matching cars"; continue; }
    const a = before.bbox, b = after.bbox;
    const height = ((a[3] - a[1]) + (b[3] - b[1])) / 2;
    if (height <= 0 || Math.abs(a[3] - b[3]) > height * 0.4) { blocked = "Aim along the same row of parked cars"; continue; }
    const left = a[2], right = b[0];
    const currentWidth = right - left;
    if (currentWidth < width * 0.5) { blocked = "Opening changed — refreshing analysis"; continue; }
    if (cars.some((car) => car !== before && car !== after && car.bbox[0] < right && car.bbox[2] > left
      && Math.min(car.bbox[3], Math.min(a[3], b[3])) > Math.max(car.bbox[1], Math.max(a[1], b[1])))) {
      blocked = "Vehicle in the opening"; continue;
    }
    const carWidth = ((a[2] - a[0]) + (b[2] - b[0])) / 2;
    // Avoid squeezing a car into a narrow detection or amplifying far-away noise.
    if (currentWidth < carWidth * 0.75 || height < inference.frameHeight * 0.06) { blocked = "Move closer to show the opening clearly"; continue; }
    const center = (left + right) / 2;
    // Occupy the opening itself, with a small clearance at each boundary.
    // Derive height from the 3D car's proportions rather than stretching it.
    const previewWidth = currentWidth * 0.96;
    const yaw = carWidth / height > 1.45 ? 1.15 : 0.35;
    const pitch = Math.atan2(1.65, 8);
    const modelWidth = 2.1 * Math.cos(yaw) + 4.4 * Math.sin(yaw);
    const modelDepth = 4.4 * Math.cos(yaw) + 2.1 * Math.sin(yaw);
    const modelHeight = 1.5 * Math.cos(pitch) + modelDepth * Math.sin(pitch);
    const previewHeight = previewWidth * modelHeight / modelWidth * 1.2;
    const bottom = (a[3] + b[3]) / 2;
    result.push({ key: `${gap.left_track_id}:${gap.right_track_id}`,
      bbox: [center - previewWidth / 2, bottom - previewHeight, center + previewWidth / 2, bottom],
      yaw });
  }
  return { placements: result.slice(0, 2), detail: result.length ? "Opening ready for 3D preview" : blocked };
}

function boxOverlap(a: Readonly<DetectionBox>, b: Readonly<DetectionBox>): number {
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection;
  return union > 0 ? intersection / union : 0;
}

export function ghostPlacements(inference: DeepReadonly<OnDeviceInference> | null, analysis: DeepReadonly<FrameAccepted> | null,
  submitted: DeepReadonly<OnDeviceInference> | null = inference): GhostPlacement[] {
  return ghostPreviewState(inference, analysis, submitted).placements;
}
