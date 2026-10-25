import type { CurbZone, ParkingSpace, RealtimeEvent } from "@/api/types";
import { newOpening } from "@/features/find/newSpots";
import { emptyParkingState } from "@/realtime/reducer";

const now = Date.parse("2026-10-25T12:00:00Z");
const zone: CurbZone = { id: "zone", geometry: { type: "LineString", coordinates: [] },
  sign_rule_id: null, legal_status_now: "UNKNOWN", next_change_at: null, version: 1 };
const state = { ...emptyParkingState, zones: { zone } };
const event = (id: string): RealtimeEvent => ({
  type: "space.opened", entity_id: id, entity_version: 1,
  occurred_at: new Date(now).toISOString(),
  payload: { zone_id: "zone", location: { type: "Point", coordinates: [-122.4484, 37.803] },
    last_observed_at: new Date(now).toISOString() },
});
const area = { center: [-122.4484, 37.803] as [number, number], radiusM: 804.672 };

test("announces a spot once even when duplicate events arrive before a render", () => {
  const announced = new Set<string>();
  const first = newOpening(event("one"), state, area, now, announced);
  expect(first?.id).toBe("one");
  announced.add(first!.id);
  expect(newOpening(event("one"), state, area, now + 10000, announced)).toBeNull();
  expect(newOpening(event("two"), state, area, now + 10000, announced)?.id).toBe("two");
});

test("existing nearby spots and refresh events do not announce new supply", () => {
  const known = { ...state, spaces: { one: event("one").payload as ParkingSpace } };
  expect(newOpening(event("one"), known as typeof emptyParkingState, area, now)).toBeNull();
  expect(newOpening({ ...event("two"), type: "space.refreshed" }, emptyParkingState, area, now)).toBeNull();
});
