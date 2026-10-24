import type { ParkingSpace, RealtimeEvent } from "@/api/types";
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
    expect(next.versions[space.id]).toBe(4);
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
