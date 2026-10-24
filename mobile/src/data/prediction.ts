// Availability prediction helpers. Pure functions over CurbSegment so the
// backend can later return the same numbers and the UI won't change.

import type { CurbSegment, CurbStatus } from "./types";

/** Baseline chance a spot is open right now, by status. */
export const STATUS_P_OPEN: Record<CurbStatus, number> = {
  open: 0.9,
  likely: 0.55,
  full: 0.08,
  no_parking: 0,
  loading: 0,
  driveway: 1,
};

/** Statuses whose color changes with predicted availability. */
export const VARIABLE_STATUSES: readonly CurbStatus[] = ["open", "likely", "full"];

export const TIME_STOPS = [0, 15, 30, 60] as const;
export const MAX_MINUTES_AHEAD = 60;

/** pOpen for a segment `minutesAhead` from now, linearly interpolated between predictions. */
export function pOpenAt(segment: CurbSegment, minutesAhead: number): number {
  const now = STATUS_P_OPEN[segment.status];
  if (!VARIABLE_STATUSES.includes(segment.status) || minutesAhead <= 0) return now;
  const points = [{ minutesAhead: 0, pOpen: now }, ...(segment.predicted ?? [])].sort(
    (a, b) => a.minutesAhead - b.minutesAhead,
  );
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (minutesAhead <= b.minutesAhead) {
      const t = (minutesAhead - a.minutesAhead) / (b.minutesAhead - a.minutesAhead);
      return a.pOpen + (b.pOpen - a.pOpen) * t;
    }
  }
  return points[points.length - 1].pOpen;
}

export function pOpenMap(segments: CurbSegment[], minutesAhead: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of segments) out[s.id] = pOpenAt(s, minutesAhead);
  return out;
}

/**
 * How much to trust a sighting, 0..1. The map applies the same curve as a style
 * expression (see map/curbLayers.ts) so lines fade as data ages.
 */
export const CONFIDENCE_BY_AGE: [seconds: number, confidence: number][] = [
  [0, 1],
  [120, 0.92],
  [600, 0.7],
  [1800, 0.45],
];

export function confidence(lastSeenSeconds: number | undefined): number {
  const s = lastSeenSeconds ?? 90;
  for (let i = 1; i < CONFIDENCE_BY_AGE.length; i++) {
    const [s0, c0] = CONFIDENCE_BY_AGE[i - 1];
    const [s1, c1] = CONFIDENCE_BY_AGE[i];
    if (s <= s1) return c0 + ((c1 - c0) * (s - s0)) / (s1 - s0);
  }
  return CONFIDENCE_BY_AGE[CONFIDENCE_BY_AGE.length - 1][1];
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function predictedLabel(minutesAhead: number, now = new Date()): string {
  if (minutesAhead < 1) return "Live now";
  return `Predicted for ${formatClock(new Date(now.getTime() + minutesAhead * 60_000))}`;
}

export function formatSeen(lastSeenSeconds: number | undefined): string {
  if (lastSeenSeconds == null) return "predicted";
  if (lastSeenSeconds < 60) return `seen ${Math.max(1, Math.round(lastSeenSeconds))} sec ago`;
  return `seen ${Math.round(lastSeenSeconds / 60)} min ago`;
}
