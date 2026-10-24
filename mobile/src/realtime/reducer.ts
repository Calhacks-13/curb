// Pure, versioned reducer for realtime events (spec section 13). An event is
// applied only when its entity_version is newer than what we already hold, so
// duplicate or out-of-order delivery can never roll an entity back.

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
    garages: prev.garages,
    versions,
  };
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
      if (!prev && !("location" in event.payload)) return { ...state, versions };
      const driveway = { ...(prev ?? {}), ...patch } as Driveway;
      return { ...state, versions, driveways: { ...state.driveways, [event.entity_id]: driveway } };
    }
    case "booking.confirmed":
    case "payment.failed": {
      const prev = state.bookings[event.entity_id];
      const booking = { ...(prev ?? {}), ...patch } as Booking;
      return { ...state, versions, bookings: { ...state.bookings, [event.entity_id]: booking } };
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
