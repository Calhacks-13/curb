import { buildDemoFixture } from "@/demo/fixtures";
import { findOptions, mapZones } from "@/features/find/options";
import { emptyParkingState, fromNearby } from "@/realtime/reducer";

// 2 PM PDT: inside the demo driveway's 7 AM to 3 AM window.
const NOW = Date.parse("2026-10-24T21:00:00Z");

function stateAt(now: number) {
  const f = buildDemoFixture(new Date(now));
  return fromNearby(emptyParkingState, { generated_at: "", zones: f.zones, spaces: f.spaces, driveways: f.driveways });
}

describe("findOptions", () => {
  const from: [number, number] = [-122.43597, 37.79932];

  it("ranks fresh curb first, then the driveway, then aging and stale, and hides occupied", () => {
    const kinds = findOptions(stateAt(NOW), NOW, from).map((o) => o.kind);
    expect(kinds[0]).toBe("fresh");
    expect(kinds.indexOf("driveway")).toBeGreaterThan(kinds.lastIndexOf("fresh"));
    expect(kinds.indexOf("aging")).toBeGreaterThan(kinds.indexOf("driveway"));
    expect(kinds).toEqual(expect.arrayContaining(["fresh", "aging", "stale", "driveway"]));
  });

  it("shows the driveway late at night inside its overnight window", () => {
    const midnight = Date.parse("2026-10-25T07:30:00Z"); // 12:30 AM PDT
    expect(findOptions(stateAt(midnight), midnight, from).map((o) => o.kind)).toContain("driveway");
  });

  it("drops openings once they're older than five minutes", () => {
    const later = NOW + 6 * 60_000;
    const kinds = findOptions(stateAt(NOW), later, from).map((o) => o.kind);
    expect(kinds).toEqual(["driveway"]);
  });

  it("hides the driveway outside its availability window", () => {
    const lateNight = Date.parse("2026-10-25T11:30:00Z"); // 4:30 AM PDT
    const kinds = findOptions(stateAt(lateNight), lateNight, from).map((o) => o.kind);
    expect(kinds).not.toContain("driveway");
  });

  it("draws only zones that are legal now", () => {
    const ids = mapZones(stateAt(NOW).zones).map((z) => z.id);
    expect(ids).not.toContain("zone_demo_6");
    expect(ids).toContain("zone_demo_1");
  });
});
