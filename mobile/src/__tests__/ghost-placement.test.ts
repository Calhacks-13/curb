import type { FrameAccepted, OnDeviceInference } from "@/api/types";
import { ghostPlacements } from "@/features/capture/ghostPlacement";
const inference: OnDeviceInference = { frameWidth: 1000, frameHeight: 600, signs: [], vehicles: [
  { bbox: [0, 200, 250, 500], cls: "car", confidence: 0.9 },
  { bbox: [700, 200, 1000, 500], cls: "car", confidence: 0.9 },
] };
const analysis: FrameAccepted = { frame_id: "1", accepted: true, frame_width: 1000, frame_height: 600,
  gap_bboxes: [[250, 0, 700, 600]], tracked_gaps: [{ bbox: [250, 0, 700, 600], left_track_id: 1, right_track_id: 2,
    confirmed: true, duration: 3, median_width_meters: null }] };
it("places a proportionate car at the neighboring vehicles' ground line", () => {
  const [preview] = ghostPlacements(inference, analysis);
  expect(preview.bbox[3]).toBeCloseTo(500);
  expect(preview.bbox[2] - preview.bbox[0]).toBeLessThan(450);
  expect(preview.bbox[1]).toBeGreaterThan(0);
  expect((preview.bbox[0] + preview.bbox[2]) / 2).toBeCloseTo(475);
  expect((preview.bbox[2] - preview.bbox[0]) / 450).toBeGreaterThanOrEqual(0.95);
});
it("suppresses a preview without fresh aligned analysis or visible anchors", () => {
  expect(ghostPlacements(inference, null)).toEqual([]);
  expect(ghostPlacements(inference, { ...analysis, frame_width: 600 })).toEqual([]);
  expect(ghostPlacements({ ...inference, vehicles: [] }, analysis)).toEqual([]);
  expect(ghostPlacements(inference, { ...analysis, gap_bboxes: [] })).toEqual([]);
});
it.each([{ confirmed: false }, { left_track_id: -1 }, { right_track_id: -2 }])("never illustrates candidate or frame-edge openings (%p)", (change) => {
  expect(ghostPlacements(inference, { ...analysis, tracked_gaps: [{ ...analysis.tracked_gaps![0], ...change }] })).toEqual([]);
});
it("does not squeeze a model into a narrow gap", () => {
  const gap = { ...analysis.tracked_gaps![0], bbox: [250, 0, 350, 600] as [number, number, number, number] };
  expect(ghostPlacements(inference, { ...analysis, gap_bboxes: [gap.bbox], tracked_gaps: [gap] })).toEqual([]);
});

it("fills a wider opening without capping its width to the neighboring car", () => {
  const wider: OnDeviceInference = { ...inference, frameWidth: 1500, vehicles: [
    inference.vehicles[0], { ...inference.vehicles[1], bbox: [1200, 200, 1500, 500] },
  ] };
  const gap = { ...analysis.tracked_gaps![0], bbox: [250, 0, 1200, 600] as [number, number, number, number] };
  const [preview] = ghostPlacements(wider, { ...analysis, frame_width: 1500, gap_bboxes: [gap.bbox], tracked_gaps: [gap] });
  expect(preview.bbox[2] - preview.bbox[0]).toBeCloseTo(950 * 0.96);
  expect(preview.bbox[3]).toBe(500);
});
