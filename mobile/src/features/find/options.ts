// Turns parking state into what the Find screen shows: map payloads and a ranked
// list of options. Pure, so it's easy to test and cheap to recompute each tick.

import type { CurbZone, Driveway, LngLat } from "@/api/types";
import { distanceM } from "@/data/geo";
import { formatHhmm, inLaWindow } from "@/lib/laTime";
import type { StallKind } from "@/map/curbLayers";
import type { MapPill, MapStall, MapZone } from "@/map/messages";
import type { ParkingState } from "@/realtime/reducer";

import { FRESHNESS_LABEL, formatAge, visibleSpaces } from "./freshness";

export type FindOption = {
  id: string;
  kind: StallKind;
  /** Spec label: "Likely open", "May still be open", "Stale observation", "Guaranteed driveway". */
  title: string;
  detail: string;
  /** Right-aligned value: price for driveways, distance for curb. */
  trailing: string;
  position: LngLat;
  ring: LngLat[];
  distanceM: number;
  /** A driveway this driver holds or has booked. */
  mine?: boolean;
};

const RANK: Record<StallKind, number> = { fresh: 0, driveway: 1, aging: 2, stale: 3 };
const WALK_M_PER_MIN = 80;

export function formatDistance(m: number): string {
  const ft = m * 3.28084;
  return ft < 1000 ? `${Math.max(50, Math.round(ft / 50) * 50)} ft` : `${(m / 1609.34).toFixed(1)} mi`;
}

/** "$8" for whole dollars, "$8.50" otherwise. */
export function formatUsdc(amount: string): string {
  const n = Number(amount);
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export function walkMinutes(m: number): number {
  return Math.max(1, Math.round(m / WALK_M_PER_MIN));
}

/**
 * Driveways to show a driver: bookable now (available, inside their window), plus
 * any this driver is holding or has booked so their own checkout never vanishes.
 */
export function visibleDriveways(state: ParkingState, now: number, userId: string | null): Driveway[] {
  return Object.values(state.driveways).filter(
    (d) =>
      (d.state === "AVAILABLE" && inLaWindow(d.availability_start, d.availability_end, new Date(now))) ||
      (userId != null && d.held_by_user_id === userId && (d.state === "HELD" || d.state === "BOOKED")),
  );
}

export function findOptions(state: ParkingState, now: number, from: LngLat, userId: string | null = null): FindOption[] {
  const curb = visibleSpaces(Object.values(state.spaces), state.zones, now).map(
    ({ space, freshness, ageSeconds }): FindOption => {
      const d = distanceM(from, space.location.coordinates);
      return {
        id: space.id,
        kind: freshness,
        title: FRESHNESS_LABEL[freshness],
        detail: `Seen ${formatAge(ageSeconds)} · ${walkMinutes(d)} min walk`,
        trailing: formatDistance(d),
        position: space.location.coordinates,
        ring: space.stall_geometry.coordinates[0],
        distanceM: d,
      };
    },
  );
  const driveways = visibleDriveways(state, now, userId).map((dw): FindOption => {
    const d = distanceM(from, dw.location.coordinates);
    const mine = dw.held_by_user_id === userId && dw.state !== "AVAILABLE";
    return {
      id: dw.id,
      kind: "driveway",
      title: mine ? (dw.state === "BOOKED" ? "Your driveway" : "Driveway on hold for you") : "Guaranteed driveway",
      detail: `${formatHhmm(dw.availability_start)} to ${formatHhmm(dw.availability_end)} · ${formatDistance(d)}`,
      trailing: formatUsdc(dw.price_usdc),
      position: dw.location.coordinates,
      ring: drivewayRing(dw.location.coordinates),
      distanceM: d,
      mine,
    };
  });
  return [...curb, ...driveways].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.distanceM - b.distanceM);
}

/** Small square bay drawn at a driveway's point. */
function drivewayRing([lng, lat]: LngLat): LngLat[] {
  const dLat = 2.2 / 111_320;
  const dLng = 2.2 / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat - dLat],
    [lng + dLng, lat + dLat],
    [lng - dLng, lat + dLat],
    [lng - dLng, lat - dLat],
  ];
}

export function mapZones(zones: Record<string, CurbZone>): MapZone[] {
  return Object.values(zones)
    .filter((z) => z.legal_status_now === "LEGAL")
    .map((z) => ({ id: z.id, coordinates: z.geometry.coordinates }));
}

export function mapStalls(options: FindOption[]): MapStall[] {
  return options.map((o) => ({ id: o.id, kind: o.kind, ring: o.ring }));
}

const PILL_LABEL: Record<StallKind, string> = {
  fresh: "Likely open",
  aging: "May be open",
  stale: "Stale",
  driveway: "",
};

export function mapPills(options: FindOption[]): MapPill[] {
  return options.map((o) => ({
    id: o.id,
    kind: o.kind,
    label: o.kind !== "driveway" ? PILL_LABEL[o.kind] : o.mine ? "Your driveway" : `${o.trailing} · Reserve`,
    position: o.position,
    mine: o.mine,
  }));
}

/** Changes only when what the map draws changes (not every clock tick). */
export function mapSignature(options: FindOption[]): string {
  return options.map((o) => `${o.id}:${o.kind}${o.mine ? ":mine" : ""}`).join("|");
}
