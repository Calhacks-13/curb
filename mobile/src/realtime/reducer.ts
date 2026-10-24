// Pure, versioned reducer for realtime events (spec section 13). An event is
// applied only when its entity_version is newer than what we already hold, so
// duplicate or out-of-order delivery can never roll an entity back.

import { toLaHhmm } from "@/lib/laTime";

import type { Booking, CurbZone, Driveway, Garage, NearbyParkingResponse, ParkingSpace, RealtimeEvent } from "@/api/types";

export type ParkingState = {
  zones: Record<string, CurbZone>;
  spaces: Record<string, ParkingSpace>;
  driveways: Record<string, Driveway>;
  bookings: Record<string, Booking>;
  garages: Record<string, Garage>;
  /** Highest version seen per entity id. */
  versions: Record<string, number>;
};

export const emptyParkingState: ParkingState = { zones: {}, spaces: {}, driveways: {}, bookings: {}, garages: {}, versions: {} };

function byId<T extends { id: string; version: number }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

/** Seeds state from a nearby query, keeping any newer versions already applied. */
export function fromNearby(prev: ParkingState, res: NearbyParkingResponse): ParkingState {
  const versions = { ...prev.versions };
  const keepNewer = <T extends { id: string; version: number }>(incoming: Record<string, T>, current: Record<string, T>) => {
    const out: Record<string, T> = { ...incoming };
    for (const [id, item] of Object.entries(incoming)) {
      const cur = current[id];
      if (cur && cur.version > item.version) out[id] = cur;
      versions[id] = Math.max(versions[id] ?? 0, out[id].version);
    }
    return out;
  };
  return {
    zones: keepNewer(byId(res.zones), prev.zones),
    spaces: keepNewer(byId(res.spaces), prev.spaces),
    driveways: keepNewer(byId(res.driveways), prev.driveways),
    bookings: prev.bookings,
    garages: res.garages?.length ? keepNewer(byId(res.garages), prev.garages) : prev.garages,
    versions,
  };
}

/**
 * Server events carry the contract's `{ driveway: DrivewayView }`, whose
 * availability is full timestamps; the app keeps LA "HH:MM", so those are
 * converted on the way in.
 */
function contractDriveway(payload: object): Partial<Driveway> | null {
  const view = (payload as { driveway?: Record<string, unknown> }).driveway;
  if (!view || typeof view !== "object") return null;
  const out: Partial<Driveway> = {
    state: view.state as Driveway["state"],
    held_by_user_id: (view.held_by_user_id as string | null) ?? null,
    version: view.version as number,
  };
  // Owner edits change price and window; convert the window to LA "HH:MM".
  if (typeof view.price_usdc === "string") out.price_usdc = view.price_usdc;
  if (typeof view.availability_start === "string") out.availability_start = toLaHhmm(view.availability_start);
  if (typeof view.availability_end === "string") out.availability_end = toLaHhmm(view.availability_end);
  return out;
}

export function applyRealtimeEvent(state: ParkingState, event: RealtimeEvent): ParkingState {
  const held = state.versions[event.entity_id] ?? 0;
  if (event.entity_version <= held) return state;

  const versions = { ...state.versions, [event.entity_id]: event.entity_version };
  const patch = { ...event.payload, version: event.entity_version };

  switch (event.type) {
    case "space.opened":
    case "space.refreshed":
    case "space.occupied":
    case "space.expired": {
      const prev = state.spaces[event.entity_id];
      const internal_state =
        event.type === "space.occupied" ? "OCCUPIED" : event.type === "space.expired" ? "UNKNOWN" : "OPEN";
      // A space we've never seen needs its full payload; ignore partial unknowns.
      if (!prev && !("stall_geometry" in event.payload)) return { ...state, versions };
      const space = { ...(prev ?? {}), ...patch, internal_state } as ParkingSpace;
      return { ...state, versions, spaces: { ...state.spaces, [event.entity_id]: space } };
    }
    case "driveway.updated":
    case "driveway.held":
    case "driveway.released": {
      const prev = state.driveways[event.entity_id];
      const wrapped = contractDriveway(event.payload);
      if (wrapped) {
        if (!prev) return { ...state, versions };
        const driveway = { ...prev, ...wrapped, version: event.entity_version };
        return { ...state, versions, driveways: { ...state.driveways, [event.entity_id]: driveway } };
      }
      if (!prev && !("location" in event.payload)) return { ...state, versions };
      const driveway = { ...(prev ?? {}), ...patch } as Driveway;
      return { ...state, versions, driveways: { ...state.driveways, [event.entity_id]: driveway } };
    }
    case "booking.confirmed":
    case "payment.failed": {
      const prev = state.bookings[event.entity_id];
      const payload = event.payload as Record<string, unknown>;
      // Contract shape: { booking, driveway }; legacy shape: flat booking fields.
      const fields = payload.booking && typeof payload.booking === "object" ? (payload.booking as Partial<Booking>) : patch;
      const booking = { ...(prev ?? {}), ...fields, version: event.entity_version } as Booking;
      let next: ParkingState = { ...state, versions, bookings: { ...state.bookings, [event.entity_id]: booking } };
      const dw = contractDriveway(payload);
      const dwId = (payload.driveway as { id?: string } | undefined)?.id;
      if (dw && dwId && next.driveways[dwId] && (dw.version ?? 0) > (next.versions[dwId] ?? 0)) {
        next = {
          ...next,
          versions: { ...next.versions, [dwId]: dw.version! },
          driveways: { ...next.driveways, [dwId]: { ...next.driveways[dwId], ...dw } },
        };
      }
      return next;
    }
    case "sign_rule.updated": {
      const prev = state.zones[event.entity_id];
      if (!("geometry" in event.payload)) return { ...state, versions };
      const zone = { ...(prev ?? {}), ...patch } as CurbZone;
      return { ...state, versions, zones: { ...state.zones, [event.entity_id]: zone } };
    }
    case "garage.detected": {
      const prev = state.garages[event.entity_id];
      if (!("location" in event.payload)) return { ...state, versions };
      const garage = { ...(prev ?? {}), ...patch } as Garage;
      return { ...state, versions, garages: { ...state.garages, [event.entity_id]: garage } };
    }
    default:
      return state;
  }
}
