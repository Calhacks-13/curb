// Route here: one Mapbox Directions route drawn in-app (no turn-by-turn), plus
// the rule for suggesting a replacement when the target goes away. The route
// never changes until the driver confirms.

import type { LngLat } from "@/api/types";
import { distanceM } from "@/data/geo";

import type { FindOption } from "./options";

export type Route = { line: LngLat[]; durationS: number; distanceM: number };

const DIRECTIONS = "https://api.mapbox.com/directions/v5/mapbox/driving";

export async function requestRoute(origin: LngLat, destination: LngLat, token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? ""): Promise<Route> {
  const coords = `${origin[0]},${origin[1]};${destination[0]},${destination[1]}`;
  const url = `${DIRECTIONS}/${coords}?geometries=geojson&overview=full&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Directions failed (${res.status})`);
  const body = (await res.json()) as { routes?: { geometry: { coordinates: LngLat[] }; duration: number; distance: number }[] };
  const best = body.routes?.[0];
  if (!best?.geometry?.coordinates || best.geometry.coordinates.length < 2) throw new Error("No route found");
  // End exactly at the bay so the line meets the highlighted stall.
  return { line: [...best.geometry.coordinates, destination], durationS: best.duration, distanceM: best.distance };
}

export function formatDuration(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  return `${min} min`;
}

/** Displayed percentage below which a routed curb spot prompts for an alternative. */
export const REPLACEMENT_CONFIDENCE_PERCENT = 50;

export type ReplacementReason = "taken" | "confidence";

export type Replacement = { reason: ReplacementReason; alternative: FindOption | null };

const FRESHNESS_ORDER: Record<FindOption["kind"], number> = { fresh: 0, aging: 1, stale: 2, driveway: 3 };

/**
 * Should we offer a different spot? Yes when the routed opening disappeared
 * (taken or expired) or its displayed confidence fell below 50%. Uses the
 * already-rounded percentage so "50% open" never counts as below 50. Driveways
 * don't trigger this; a booked driveway is guaranteed.
 */
export function replacementFor(targetId: string, targetPosition: LngLat, options: FindOption[]): Replacement | null {
  const current = options.find((o) => o.id === targetId);
  if (current?.kind === "driveway") return null;
  if (current && (current.confidencePercent ?? 0) >= REPLACEMENT_CONFIDENCE_PERCENT) return null;
  // Rank by distance from where the driver was heading, not from the driver.
  const candidates = options.filter(
    (o) => o.id !== targetId && o.kind !== "driveway" && (o.confidencePercent ?? 0) >= REPLACEMENT_CONFIDENCE_PERCENT,
  );
  const alternative =
    candidates.sort(
      (a, b) =>
        FRESHNESS_ORDER[a.kind] - FRESHNESS_ORDER[b.kind] ||
        distanceM(targetPosition, a.position) - distanceM(targetPosition, b.position),
    )[0] ?? null;
  return { reason: current ? "confidence" : "taken", alternative };
}

/** Whole points the routed score has fallen since routing began; zero if it held or rose. */
export function confidenceDrop(initialPercent: number | null, currentPercent: number | null): number {
  if (initialPercent == null || currentPercent == null) return 0;
  return Math.max(0, initialPercent - currentPercent);
}

/** Bounding box of a line, for fitting the camera. */
export function boundsOf(line: LngLat[]): [LngLat, LngLat] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lng, lat] of line) {
    w = Math.min(w, lng);
    e = Math.max(e, lng);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  return [
    [w, s],
    [e, n],
  ];
}
