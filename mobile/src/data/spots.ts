// Picks the three options offered on the home sheet. Lives with the data layer
// because a real backend would likely rank these server-side.

import { curbPoint, distanceM, type LngLat } from "./geo";
import { confidence, pOpenAt } from "./prediction";
import type { CurbSegment } from "./types";

export type SpotKind = "street" | "likely" | "driveway";

export type SpotOption = {
  kind: SpotKind;
  segmentId: string;
  title: string;
  price: string;
  detail: string;
  walkMinutes: number;
  /** Point on the curb where the pill and the camera go. */
  anchor: LngLat;
};

const WALK_M_PER_MIN = 80;

const TITLES: Record<SpotKind, string> = {
  street: "Street spot",
  likely: "Likely open",
  driveway: "Driveway",
};

function score(seg: CurbSegment, anchor: LngLat, destination: LngLat, minutesAhead: number) {
  // Prefer likely-open spots we trust, then a short walk.
  const trust = seg.status === "likely" ? 0.85 : confidence(seg.lastSeenSeconds);
  return pOpenAt(seg, minutesAhead) * trust * 2 - distanceM(anchor, destination) / 250;
}

export function pickSpotOptions(
  segments: CurbSegment[],
  destination: LngLat,
  curbOffsetM: number,
  minutesAhead = 0,
): SpotOption[] {
  const groups: Record<SpotKind, (s: CurbSegment) => boolean> = {
    street: (s) => s.status === "open" && s.price === "Free",
    likely: (s) => s.status === "likely" && !!s.price && s.price !== "Free",
    driveway: (s) => s.status === "driveway",
  };
  const out: SpotOption[] = [];
  for (const kind of ["street", "likely", "driveway"] as SpotKind[]) {
    let best: { seg: CurbSegment; anchor: LngLat; s: number } | null = null;
    for (const seg of segments.filter(groups[kind])) {
      const anchor = curbPoint(seg.coordinates, seg.side, 0.5, curbOffsetM);
      const s = score(seg, anchor, destination, minutesAhead);
      if (!best || s > best.s) best = { seg, anchor, s };
    }
    if (!best) continue;
    const walk = Math.max(1, Math.round(distanceM(best.anchor, destination) / WALK_M_PER_MIN));
    out.push({
      kind,
      segmentId: best.seg.id,
      title: TITLES[kind],
      price: best.seg.price ?? "",
      detail: best.seg.rule ?? "",
      walkMinutes: walk,
      anchor: best.anchor,
    });
  }
  return out;
}
