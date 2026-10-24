// Turns curb segments into the bays worth showing: open, likely open, and
// rentable driveways. Taken curb isn't drawn at all. Visualization only; the
// data contract stays CurbSegment.

import { curbPoint, lineLengthM } from "../data/geo";
import type { CurbSegment } from "../data/types";
import { CURB_OFFSET_M } from "./curbLayers";
import type { LngLat } from "./messages";

export type StallKind = "open" | "likely" | "driveway";

export type Stall = {
  id: string;
  segmentId: string;
  kind: StallKind;
  /** Closed ring, lng/lat. */
  ring: LngLat[];
  lastSeenSeconds: number | null;
};

/** Bay depth from the curb toward the road, and length along the curb. */
const BAY_DEPTH_M = 2.3;
const BAY_LENGTH_M = 5.6;
const SLOT_M = 6.2;
const END_MARGIN_M = 2.5;

/** Where markers for a bay sit: its center line, half a bay off the curb. */
export const BAY_CENTER_OFFSET_M = CURB_OFFSET_M - BAY_DEPTH_M / 2;

function bayRing(seg: CurbSegment, len: number, from: number, to: number): LngLat[] {
  const at = (d: number, off: number) => curbPoint(seg.coordinates, seg.side, d / len, off);
  const inner = CURB_OFFSET_M - BAY_DEPTH_M;
  const ring = [at(from, CURB_OFFSET_M), at(to, CURB_OFFSET_M), at(to, inner), at(from, inner)];
  return [...ring, ring[0]];
}

/** Which bays of a segment are free: the middle stretch, sized by status. */
function freeSlots(seg: CurbSegment, slots: number): number[] {
  const mid = (slots - 1) / 2;
  const reach = seg.status === "open" ? Math.max(0.5, slots * 0.2) : 0.5;
  return [...Array(slots).keys()].filter((i) => Math.abs(i - mid) <= reach);
}

export function buildStalls(segments: CurbSegment[]): Stall[] {
  const stalls: Stall[] = [];
  for (const seg of segments) {
    const len = lineLengthM(seg.coordinates);
    const seen = seg.lastSeenSeconds ?? null;

    if (seg.status === "driveway") {
      stalls.push({ id: `${seg.id}#0`, segmentId: seg.id, kind: "driveway", ring: bayRing(seg, len, 0.4, len - 0.4), lastSeenSeconds: seen });
      continue;
    }
    if (seg.status !== "open" && seg.status !== "likely") continue;

    const slots = Math.floor((len - END_MARGIN_M * 2) / SLOT_M);
    if (slots < 1) continue;
    const start = (len - slots * SLOT_M) / 2;
    for (const i of freeSlots(seg, slots)) {
      const s0 = start + i * SLOT_M + (SLOT_M - BAY_LENGTH_M) / 2;
      stalls.push({
        id: `${seg.id}#${i}`,
        segmentId: seg.id,
        kind: seg.status,
        ring: bayRing(seg, len, s0, s0 + BAY_LENGTH_M),
        lastSeenSeconds: seen,
      });
    }
  }
  return stalls;
}
