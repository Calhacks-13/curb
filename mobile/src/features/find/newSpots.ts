// "New spot opened" alerts: which realtime events deserve a banner, and how
// several openings in quick succession merge into one.

import type { LngLat, ParkingSpace, RealtimeEvent } from "@/api/types";
import { distanceM } from "@/data/geo";
import type { ParkingState } from "@/realtime/reducer";

import { freshnessOf } from "./freshness";
import { inArea, type SearchArea } from "./options";

export type SpotAlert = { ids: string[]; at: number };

/** Openings within this window merge into one banner. */
export const ALERT_MERGE_MS = 5000;

/**
 * A realtime event announces a new opening when it's `space.opened` (not a
 * re-sighting), the stall's zone is legal now under a validated rule, the
 * sighting is fresh, and it's inside the search area.
 */
export function newOpening(event: RealtimeEvent, state: ParkingState, area: SearchArea | null, now: number): { id: string; position: LngLat } | null {
  if (event.type !== "space.opened") return null;
  const known = state.spaces[event.entity_id];
  const space = { ...(known ?? {}), ...event.payload } as Partial<ParkingSpace>;
  const position = space.location?.coordinates;
  const zone = space.zone_id ? state.zones[space.zone_id] : undefined;
  if (!position || !zone || zone.legal_status_now !== "LEGAL" || !zone.sign_rule_id) return null;
  if (freshnessOf(space.last_observed_at ?? event.occurred_at, now) !== "fresh") return null;
  if (!inArea(position, area)) return null;
  return { id: event.entity_id, position };
}

/** While routing, only a spot closer to the driver than the current target is worth interrupting for. */
export function worthInterruptingRoute(spot: LngLat, driver: LngLat, targetDistanceM: number): boolean {
  return distanceM(driver, spot) < targetDistanceM;
}

export function mergeAlert(prev: SpotAlert | null, id: string, now: number): SpotAlert {
  if (prev && now - prev.at < ALERT_MERGE_MS) {
    return { ids: prev.ids.includes(id) ? prev.ids : [...prev.ids, id], at: now };
  }
  return { ids: [id], at: now };
}
