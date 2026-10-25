import type { DetectionBox, FrameAccepted, OnDeviceInference } from "@/api/types";
import type { DeepReadonly } from "./DetectionUploadController";

export type GhostPlacement = { key: string; bbox: DetectionBox; yaw: number };

/** Image-relative scale from adjacent cars. Never infer metres or vehicle fit. */
export function ghostPlacements(inference: OnDeviceInference | null, analysis: DeepReadonly<FrameAccepted> | null): GhostPlacement[] {
  if (!inference || !analysis || inference.frameWidth !== analysis.frame_width || inference.frameHeight !== analysis.frame_height) return [];
  const cars = inference.vehicles.filter((car) => ["car", "truck", "bus"].includes(car.cls) && car.confidence >= 0.6);
  const result: GhostPlacement[] = [];
  for (const gap of analysis.tracked_gaps ?? []) {
    if (!gap.confirmed || gap.left_track_id < 0 || gap.right_track_id < 0) continue;
    if (!analysis.gap_bboxes?.some((box) => box.every((value, axis) => value === gap.bbox[axis]))) continue;
    const [left, , right] = gap.bbox;
    const width = right - left;
    if (width <= 0) continue;
    const before = cars.filter((car) => car.bbox[0] < left && Math.abs(car.bbox[2] - left) < inference.frameWidth * 0.08)
      .sort((a, b) => Math.abs(a.bbox[2] - left) - Math.abs(b.bbox[2] - left))[0];
    const after = cars.filter((car) => car.bbox[2] > right && Math.abs(car.bbox[0] - right) < inference.frameWidth * 0.08)
      .sort((a, b) => Math.abs(a.bbox[0] - right) - Math.abs(b.bbox[0] - right))[0];
    if (!before || !after) continue;
    const a = before.bbox, b = after.bbox;
    const height = ((a[3] - a[1]) + (b[3] - b[1])) / 2;
    if (height <= 0 || Math.abs(a[3] - b[3]) > height * 0.4) continue;
    const carWidth = ((a[2] - a[0]) + (b[2] - b[0])) / 2;
    // Avoid squeezing a car into a narrow detection or amplifying far-away noise.
    if (width < carWidth * 0.75 || height < inference.frameHeight * 0.06) continue;
    const center = (left + right) / 2;
    // Occupy the opening itself, with a small clearance at each boundary.
    // Derive height from the 3D car's proportions rather than stretching it.
    const previewWidth = width * 0.96;
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
  return result.slice(0, 2);
}
