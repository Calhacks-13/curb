// Turns parking state into what the Find screen shows: map payloads and a ranked
// list of options. Pure, so it's easy to test and cheap to recompute each tick.

import type { Driveway, LngLat } from "@/api/types";
import { SEP } from "@/config/tokens";
import { distanceM } from "@/data/geo";
import { formatHhmm, inLaWindow } from "@/lib/laTime";
import type { StallKind } from "@/map/curbLayers";
import type { MapPill, MapStall } from "@/map/messages";
import type { ParkingState } from "@/realtime/reducer";

import { displayOpenPercent } from "./confidence";
import { formatAge, visibleSpaces } from "./freshness";

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
  /** Age-adjusted whole-number score shown consistently across curb surfaces. */
  confidencePercent?: number;
  /** A driveway this driver holds or has booked. */
  mine?: boolean;
  /** Held or booked by someone else: shown muted on the map, not offered. */
  booked?: boolean;
  /** The signed-in user's own listing: never reservable by them. */
  own?: boolean;
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
  return Object.values(state.driveways).filter((d) => {
    const inWindow = d.availability_window
      ? Date.parse(d.availability_window.start) <= now && now < Date.parse(d.availability_window.end)
      : inLaWindow(d.availability_start, d.availability_end, new Date(now));
    if (userId != null && d.held_by_user_id === userId && (d.state === "HELD" || d.state === "BOOKED")) return true;
    // Someone else's hold or booking stays on the map as a muted "Booked" pin.
    return inWindow && d.state !== "UNAVAILABLE";
  });
}

/** The driveway this driver has booked, if any, so Find can keep it in view. */
export function myReservation(options: FindOption[]): FindOption | null {
  return options.find((o) => o.kind === "driveway" && o.mine && o.title === "Your driveway") ?? null;
}

/** The Find search area: the spec's fixed 0.5-mile radius around the search center. */
export type SearchArea = { center: LngLat; radiusM: number };

export function inArea(point: LngLat, area: SearchArea | null): boolean {
  return !area || distanceM(area.center, point) <= area.radiusM;
}

/**
 * Ranked options within the search area. The backend already limits the nearby
 * query to the radius; filtering here too keeps out anything realtime pushes
 * from farther away, and anything left over after the driver moves.
 */
export function findOptions(
  state: ParkingState,
  now: number,
  from: LngLat,
  userId: string | null = null,
  area: SearchArea | null = null,
): FindOption[] {
  const curb = visibleSpaces(Object.values(state.spaces), state.zones, now)
    .filter(({ space }) => {
      const coords = space.location?.coordinates;
      return coords && inArea(coords, area);
    })
    .map(
    ({ space, freshness, ageSeconds }): FindOption => {
      const coords = space.location.coordinates as LngLat;
      const d = distanceM(from, coords);
      const confidencePercent = displayOpenPercent(space, now)!;
      return {
        id: space.id,
        kind: freshness,
        title: `${confidencePercent}% open`,
        detail: `Seen ${formatAge(ageSeconds)}${SEP}${walkMinutes(d)} min walk`,
        trailing: formatDistance(d),
        position: coords,
        ring: space.stall_geometry?.coordinates?.[0] ?? [coords],
        distanceM: d,
        confidencePercent,
      };
    },
  );
  const driveways = visibleDriveways(state, now, userId)
    // A driveway you're holding or booked stays visible even if you've moved away.
    .filter((dw) => dw.held_by_user_id === userId || inArea(dw.location.coordinates, area))
    .map((dw): FindOption => {
    const d = distanceM(from, dw.location.coordinates);
    const mine = dw.held_by_user_id === userId && dw.state !== "AVAILABLE";
    const booked = !mine && dw.state !== "AVAILABLE";
    const own = userId != null && dw.owner_id === userId;
    return {
      id: dw.id,
      kind: "driveway",
      title: mine
        ? dw.state === "BOOKED"
          ? "Your driveway"
          : "Driveway on hold for you"
        : booked
          ? "Booked driveway"
          : own
            ? "Your listing"
            : "Guaranteed driveway",
      detail: `${formatHhmm(dw.availability_start)} to ${formatHhmm(dw.availability_end)}${SEP}${formatDistance(d)}`,
      trailing: formatUsdc(dw.price_usdc),
      position: dw.location.coordinates,
      ring: drivewayRing(dw.location.coordinates),
      distanceM: d,
      mine,
      booked,
      own,
    };
  });
  // Booked driveways sort last: they're context on the map, not options.
  return [...curb, ...driveways].sort(
    (a, b) => Number(!!a.booked) - Number(!!b.booked)
      || RANK[a.kind] - RANK[b.kind]
      || (a.kind !== "driveway" && b.kind !== "driveway"
        ? (b.confidencePercent ?? 0) - (a.confidencePercent ?? 0)
        : 0)
      || a.distanceM - b.distanceM,
  );
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

export function mapStalls(options: FindOption[]): MapStall[] {
  return options.map((o) => ({ id: o.id, kind: o.kind, ring: o.ring }));
}

export function mapPills(options: FindOption[]): MapPill[] {
  return options.map((o) => ({
    id: o.id,
    kind: o.kind,
    label:
      o.kind !== "driveway"
        ? o.title
        : o.mine
          ? "Your driveway"
          : o.booked
            ? "Booked"
            : o.own
              ? "Your listing"
              : `${o.trailing}${SEP}Reserve`,
    position: o.position,
    mine: o.mine,
    muted: o.booked,
  }));
}

/** Changes only when what the map draws changes (not every clock tick). */
export function mapSignature(options: FindOption[]): string {
  return JSON.stringify([mapStalls(options), mapPills(options)]);
}
