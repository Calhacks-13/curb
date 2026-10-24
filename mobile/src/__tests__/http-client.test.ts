import type { NearbyParkingResponse as WireNearby, SpaceDetail as WireDetail } from "@curb/contracts/domain";

import { getApi } from "@/api/client";
import { findOptions, mapPills } from "@/features/find/options";
import { emptyParkingState, fromNearby } from "@/realtime/reducer";

const NOW = Date.parse("2026-10-24T21:00:00Z");
const point = { type: "Point" as const, coordinates: [-122.43597, 37.79932] as [number, number] };
const wireNearby: WireNearby = {
  generated_at: "2026-10-24T21:00:00Z",
  zones: [{ id: "zone-1", geometry: { type: "LineString", coordinates: [point.coordinates, [-122.43597, 37.7998]] }, sign_rule_id: "rule-1", legal_status_now: "LEGAL", current_rules: "Metered parking allowed for two hours.", next_change_at: "2026-10-25T01:00:00Z", version: 4 }],
  spaces: [{ id: "space-1", zone_id: "zone-1", location: point, stall_geometry: { type: "Polygon", coordinates: [[point.coordinates, [-122.43594, 37.79932], [-122.43594, 37.79935], point.coordinates]] }, internal_state: "OPEN", last_observed_at: "2026-10-24T20:59:40Z", base_confidence: 0.94, freshness: "FRESH", status_label: "Likely open", distance_m: 0, version: 7 }],
  driveways: [{ id: "driveway-1", owner_id: "owner", location: point, photo_url: "https://curb.test/driveway.jpg", price_usdc: "8.50", availability_start: "2026-10-24T15:00:00Z", availability_end: "2026-10-25T05:00:00Z", availability_timezone: "America/Los_Angeles", state: "AVAILABLE", held_by_user_id: null, active_booking: null, available_now: true, distance_m: 0, version: 3 }],
};
const wireDetail: WireDetail = {
  ...wireNearby.spaces[0],
  sign_rule: { id: "rule-1", zone_id: "zone-1", weekly_schedule: [{ days: ["SATURDAY"], start_local: "08:00", end_local: "18:00", kind: "METERED" }], max_minutes: 120, payment_rules: { required: true, price_text: "$3.50/hr" }, permit_rules: { required: true, permitted_labels: ["Area C"] }, exceptions: ["Except holidays"], evidence_text: "2 HOUR PARKING 8AM–6PM", interpretation_confidence: 0.96, last_validated_at: "2026-10-24T18:00:00Z", version: 2 },
  current_rules: "Metered parking allowed for two hours.", max_minutes: 120, next_change_at: "2026-10-25T01:00:00Z",
};
const session = { user: { id: "driver", display_name: "Driver", demo_profile: "driver" }, token: "seeded-bearer-token" };
const mockFetch = jest.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes("/sessions") ? session : url.includes("/spaces/") ? wireDetail : wireNearby }));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_URL = "https://curb.test";
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockClear();
  getApi().setToken(null);
});
afterAll(() => { globalThis.fetch = originalFetch; });

it("normalizes canonical nearby supply into curb and driveway map pins with LA display times", async () => {
  const nearby = await getApi().nearby(37.79932, -122.43597);
  const options = findOptions(fromNearby(emptyParkingState, nearby), NOW, point.coordinates);
  expect(mapPills(options)).toEqual([
    expect.objectContaining({ id: "space-1", kind: "fresh", label: "Likely open" }),
    expect.objectContaining({ id: "driveway-1", kind: "driveway", label: "$8.50 • Reserve" }),
  ]);
  expect(options[1].detail).toBe("8 AM to 10 PM • 50 ft");
  expect(nearby.spaces[0]).toMatchObject({ id: "space-1", version: 7, base_confidence: 0.94, last_observed_at: "2026-10-24T20:59:40Z" });
});

it("retains the canonical driveway's dated UTC window instead of reopening it every day", async () => {
  const nearby = await getApi().nearby(37.79932, -122.43597);
  const state = fromNearby(emptyParkingState, nearby);
  const drivewayIds = (at: string) => findOptions(state, Date.parse(at), point.coordinates).filter((o) => o.kind === "driveway").map((o) => o.id);
  expect(drivewayIds("2026-10-24T15:00:00Z")).toEqual(["driveway-1"]);
  expect(drivewayIds("2026-10-25T04:59:59.999Z")).toEqual(["driveway-1"]);
  expect(drivewayIds("2026-10-25T05:00:00Z")).toEqual([]);
  expect(drivewayIds("2026-10-25T21:00:00Z")).toEqual([]);
});

it("normalizes a canonical flat detail into the sheet's current rule and observation data", async () => {
  const detail = await getApi().space("space-1");
  expect(detail.space).toMatchObject({ id: "space-1", base_confidence: 0.94, version: 7 });
  expect(detail.rule).toEqual({ id: "rule-1", summary: "Metered parking allowed for two hours.", max_minutes: 120, next_change_at: "2026-10-25T01:00:00Z", next_change_summary: null, payment_text: "$3.50/hr", permit_text: "Permit required: Area C", interpretation_confidence: 0.96, last_validated_at: "2026-10-24T18:00:00Z" });
});

it("sends the selected session's bearer token on nearby/detail requests and removes it at sign-out", async () => {
  const api = getApi();
  const started = await api.startSession("driver");
  api.setToken(started.token);
  await api.nearby(37.79932, -122.43597);
  expect(mockFetch).toHaveBeenLastCalledWith("https://curb.test/v1/parking/nearby?lat=37.79932&lng=-122.43597&radius_m=804.672", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer seeded-bearer-token" }) }));
  api.setToken("owner-token");
  await api.space("space-1");
  expect(mockFetch).toHaveBeenLastCalledWith("https://curb.test/v1/spaces/space-1", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer owner-token" }) }));
  api.setToken(null);
  await api.nearby(37.79932, -122.43597);
  expect(mockFetch).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ headers: { "Content-Type": "application/json" } }));
});
