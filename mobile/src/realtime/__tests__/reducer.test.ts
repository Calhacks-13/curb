import type { CurbZone, ParkingSpace, RealtimeEvent } from "@/api/types";
import { visibleDriveways } from "@/features/find/options";
import { applyRealtimeEvent, emptyParkingState, fromNearby } from "@/realtime/reducer";

const space: ParkingSpace = {
  id: "space_demo_1",
  zone_id: "zone_demo_1",
  location: { type: "Point", coordinates: [-122.4378, 37.8003] },
  stall_geometry: { type: "Polygon", coordinates: [] },
  internal_state: "OPEN",
  last_observed_at: "2026-10-24T18:00:00Z",
  base_confidence: 0.9,
  version: 3,
};

const seeded = fromNearby(emptyParkingState, { generated_at: "", zones: [], spaces: [space], driveways: [] });

const event = (type: RealtimeEvent["type"], version: number, payload: object = {}): RealtimeEvent => ({
  type,
  entity_id: space.id,
  entity_version: version,
  occurred_at: "2026-10-24T18:00:05Z",
  payload: payload as Record<string, unknown>,
});

describe("applyRealtimeEvent", () => {
  it("applies a newer occupied event and hides the opening", () => {
    const next = applyRealtimeEvent(seeded, event("space.occupied", 4));
    expect(next.spaces[space.id].internal_state).toBe("OCCUPIED");
    expect(next.versions[`space:${space.id}`]).toBe(4);
  });

  it("ignores duplicate and older versions", () => {
    expect(applyRealtimeEvent(seeded, event("space.occupied", 3))).toBe(seeded);
    expect(applyRealtimeEvent(seeded, event("space.occupied", 2))).toBe(seeded);
  });

  it("never rolls back when events arrive out of order", () => {
    const occupied = applyRealtimeEvent(seeded, event("space.occupied", 5));
    const late = applyRealtimeEvent(occupied, event("space.refreshed", 4, { last_observed_at: "2026-10-24T18:00:04Z" }));
    expect(late.spaces[space.id].internal_state).toBe("OCCUPIED");
  });

  it("expired leaves the space unknown (blue zone only)", () => {
    expect(applyRealtimeEvent(seeded, event("space.expired", 4)).spaces[space.id].internal_state).toBe("UNKNOWN");
  });

  it("a later nearby response does not overwrite a newer realtime version", () => {
    const occupied = applyRealtimeEvent(seeded, event("space.occupied", 6));
    const refetched = fromNearby(occupied, { generated_at: "", zones: [], spaces: [space], driveways: [] });
    expect(refetched.spaces[space.id].internal_state).toBe("OCCUPIED");
  });
});

describe("entity-scoped versions", () => {
  const sharedSpace = { ...space, id: "shared", zone_id: "shared", version: 1 };
  const zone: CurbZone = {
    id: "shared",
    geometry: { type: "LineString", coordinates: [[-122.4378, 37.8003], [-122.4377, 37.8003]] },
    sign_rule_id: "rule",
    legal_status_now: "LEGAL",
    next_change_at: null,
    version: 1,
  };
  const update = (type: RealtimeEvent["type"], version: number, payload: object = {}): RealtimeEvent => ({
    type, entity_id: "shared", entity_version: version, occurred_at: "2026-10-24T18:00:05Z",
    payload: payload as Record<string, unknown>,
  });

  it.each([false, true])("keeps a same-ID space and zone with zone-first=%s", (zoneFirst) => {
    const opened = update("space.opened", 1, sharedSpace);
    const rule = update("sign_rule.updated", 1, zone);
    const events = zoneFirst ? [rule, opened] : [opened, rule];
    const next = events.reduce(applyRealtimeEvent, emptyParkingState);
    expect(next.spaces.shared).toEqual(sharedSpace);
    expect(next.zones.shared).toEqual(zone);
  });

  it("advances zone and space independently after nearby seeds their shared ID", () => {
    const base = fromNearby(emptyParkingState, { generated_at: "", zones: [zone], spaces: [sharedSpace], driveways: [] });
    const refreshed = applyRealtimeEvent(base, update("space.refreshed", 5, { last_observed_at: "2026-10-24T18:00:05Z" }));
    const illegal = applyRealtimeEvent(refreshed, update("sign_rule.updated", 2, { ...zone, legal_status_now: "ILLEGAL" }));
    expect(illegal.zones.shared).toMatchObject({ version: 2, legal_status_now: "ILLEGAL" });
    expect(illegal.spaces.shared).toMatchObject({ version: 5, last_observed_at: "2026-10-24T18:00:05Z" });
    expect(applyRealtimeEvent(illegal, update("sign_rule.updated", 1, zone))).toBe(illegal);
    expect(applyRealtimeEvent(illegal, update("space.occupied", 4))).toBe(illegal);
    const occupied = applyRealtimeEvent(illegal, update("space.occupied", 6));
    expect(occupied.spaces.shared.internal_state).toBe("OCCUPIED");
    expect(applyRealtimeEvent(occupied, update("space.opened", 6, sharedSpace))).toBe(occupied);
    expect(applyRealtimeEvent(occupied, update("space.refreshed", 5, sharedSpace))).toBe(occupied);
    expect(applyRealtimeEvent(occupied, update("sign_rule.updated", 3, zone)).zones.shared.version).toBe(3);
  });

  it("retains each collection's newer state when nearby returns older shared-ID data", () => {
    const base = fromNearby(emptyParkingState, { generated_at: "", zones: [{ ...zone, version: 4 }], spaces: [sharedSpace], driveways: [] });
    const occupied = applyRealtimeEvent(base, update("space.occupied", 2));
    expect(occupied.spaces.shared).toMatchObject({ version: 2, internal_state: "OCCUPIED" });
    const refetched = fromNearby(occupied, { generated_at: "", zones: [zone], spaces: [sharedSpace], driveways: [] });
    expect(refetched.zones.shared.version).toBe(4);
    expect(refetched.spaces.shared).toMatchObject({ version: 2, internal_state: "OCCUPIED" });
    expect(applyRealtimeEvent(refetched, update("space.refreshed", 3)).spaces.shared.version).toBe(3);
  });
});

describe("contract-shaped driveway events", () => {
  const driveway = {
    id: "driveway_demo_1",
    owner_id: "owner_demo",
    price_usdc: "8",
    availability_start: "00:00",
    availability_end: "23:59",
    state: "AVAILABLE",
    held_by_user_id: null,
    version: 1,
  } as unknown as import("@/api/types").Driveway;
  const base = fromNearby(emptyParkingState, { generated_at: "", zones: [], spaces: [], driveways: [driveway] });
  const view = (state: string, version: number) => ({
    id: driveway.id,
    state,
    held_by_user_id: state === "AVAILABLE" ? null : "driver_demo",
    availability_start: "2026-10-24T07:00:00Z",
    availability_end: "2026-10-25T06:59:00Z",
    version,
  });

  it("takes the hold state from { driveway } and keeps the HH:MM window", () => {
    const held = applyRealtimeEvent(base, {
      type: "driveway.held",
      entity_id: driveway.id,
      entity_version: 2,
      occurred_at: "",
      payload: { driveway: view("HELD", 2) },
    });
    expect(held.driveways[driveway.id]).toMatchObject({
      state: "HELD",
      held_by_user_id: "driver_demo",
      version: 2,
      availability_start: "00:00",
      availability_end: "23:59",
    });
  });

  it("books the driveway from booking.confirmed { booking, driveway }", () => {
    const confirmed = applyRealtimeEvent(base, {
      type: "booking.confirmed",
      entity_id: "booking_1",
      entity_version: 3,
      occurred_at: "",
      payload: { booking: { id: "booking_1", state: "CONFIRMED", transaction_hash: "0xabc" }, driveway: view("BOOKED", 3) },
    });
    expect(confirmed.bookings.booking_1).toMatchObject({ state: "CONFIRMED", transaction_hash: "0xabc" });
    expect(confirmed.driveways[driveway.id]).toMatchObject({ state: "BOOKED", version: 3, availability_end: "23:59" });
  });

  it("applies a shared-ID booking and its driveway snapshot on independent version sequences", () => {
    const sharedBase = fromNearby(emptyParkingState, { generated_at: "", zones: [], spaces: [], driveways: [{ ...driveway, version: 5 }] });
    const confirmed = applyRealtimeEvent(sharedBase, {
      type: "booking.confirmed", entity_id: driveway.id, entity_version: 2, occurred_at: "",
      payload: { booking: { id: driveway.id, state: "CONFIRMED" }, driveway: view("BOOKED", 6) },
    });
    expect(confirmed.bookings[driveway.id]).toMatchObject({ state: "CONFIRMED", version: 2 });
    expect(confirmed.driveways[driveway.id]).toMatchObject({ state: "BOOKED", version: 6 });
    expect(applyRealtimeEvent(confirmed, {
      type: "driveway.released", entity_id: driveway.id, entity_version: 5, occurred_at: "",
      payload: { driveway: view("AVAILABLE", 5) },
    })).toBe(confirmed);
    const failed = applyRealtimeEvent(confirmed, {
      type: "payment.failed", entity_id: driveway.id, entity_version: 3, occurred_at: "",
      payload: { booking: { id: driveway.id, state: "CANCELLED" }, driveway: view("AVAILABLE", 5) },
    });
    expect(failed.bookings[driveway.id]).toMatchObject({ state: "CANCELLED", version: 3 });
    expect(failed.driveways[driveway.id]).toMatchObject({ state: "BOOKED", version: 6 });
  });

  it("replaces the dated availability window when a realtime owner edit changes it", () => {
    const dated = {
      ...driveway,
      availability_window: { start: "2026-10-24T07:00:00Z", end: "2026-10-24T08:00:00Z" },
    };
    const datedBase = fromNearby(emptyParkingState, { generated_at: "", zones: [], spaces: [], driveways: [dated] });
    const updated = applyRealtimeEvent(datedBase, {
      type: "driveway.updated",
      entity_id: driveway.id,
      entity_version: 2,
      occurred_at: "",
      payload: { driveway: { ...view("AVAILABLE", 2), availability_end: "2026-10-24T02:00:00Z" } },
    });

    expect(updated.driveways[driveway.id].availability_window).toEqual({
      start: "2026-10-24T07:00:00Z",
      end: "2026-10-24T02:00:00Z",
    });
    expect(visibleDriveways(updated, Date.parse("2026-10-24T03:00:00Z"), "driver_demo")).toEqual([]);
  });
});
