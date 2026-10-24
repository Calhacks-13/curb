// Freshness and visibility rules from the spec (section 7.5). Pure functions so
// the map can age markers locally without waiting for a server event.

import type { CurbZone, ParkingSpace } from "@/api/types";

export type Freshness = "fresh" | "aging" | "stale" | "expired";

/** Upper bounds in seconds, inclusive: green through 90 s, yellow through 180 s, gray through 300 s. */
export const FRESHNESS_BOUNDS = { fresh: 90, aging: 180, stale: 300 } as const;

export const FRESHNESS_LABEL: Record<Exclude<Freshness, "expired">, string> = {
  fresh: "Likely open",
  aging: "May still be open",
  stale: "Stale observation",
};

export function ageSeconds(observedAt: string | null, now: number): number {
  if (!observedAt) return Infinity;
  return Math.max(0, (now - Date.parse(observedAt)) / 1000);
}

export function freshnessOf(observedAt: string | null, now: number): Freshness {
  const age = ageSeconds(observedAt, now);
  if (age <= FRESHNESS_BOUNDS.fresh) return "fresh";
  if (age <= FRESHNESS_BOUNDS.aging) return "aging";
  if (age <= FRESHNESS_BOUNDS.stale) return "stale";
  return "expired";
}

export type VisibleSpace = {
  space: ParkingSpace;
  zone: CurbZone;
  freshness: Exclude<Freshness, "expired">;
  ageSeconds: number;
};

/**
 * Openings a driver may see: observed open, in a zone whose validated rule is
 * legal now, and not yet expired. Occupied and unknown stalls stay hidden.
 */
export function visibleSpaces(spaces: ParkingSpace[], zones: Record<string, CurbZone>, now: number): VisibleSpace[] {
  const out: VisibleSpace[] = [];
  for (const space of spaces) {
    if (space.internal_state !== "OPEN") continue;
    const zone = zones[space.zone_id];
    if (!zone || zone.legal_status_now !== "LEGAL" || !zone.sign_rule_id) continue;
    const freshness = freshnessOf(space.last_observed_at, now);
    if (freshness === "expired") continue;
    out.push({ space, zone, freshness, ageSeconds: ageSeconds(space.last_observed_at, now) });
  }
  return out;
}

/** "20 sec ago", "2 min ago". */
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return "not observed";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}
