import { buildDemoFixture } from "@/demo/fixtures";
import { findOptions, mapPills, mapZones, myReservation } from "@/features/find/options";
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

  it("keeps only options inside the search area", () => {
    const all = findOptions(stateAt(NOW), NOW, from);
    const area = { center: [-122.4372, 37.8005] as [number, number], radiusM: 120 };
    const near = findOptions(stateAt(NOW), NOW, from, null, area);
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThan(all.length);
  });

  it("draws only zones that are legal now", () => {
    const ids = mapZones(stateAt(NOW).zones).map((z) => z.id);
    expect(ids).not.toContain("zone_demo_6");
    expect(ids).toContain("zone_demo_1");
  });

  describe("driveway ownership", () => {
    const withDriveway = (patch: object) => {
      const s = stateAt(NOW);
      const [id, dw] = Object.entries(s.driveways)[0];
      return { ...s, driveways: { ...s.driveways, [id]: { ...dw, ...patch } } };
    };
    const driveway = (state: ReturnType<typeof stateAt>, userId: string) =>
      findOptions(state, NOW, from, userId).find((o) => o.kind === "driveway");

    it("keeps someone else's booking on the map as a muted Booked pin, ranked last", () => {
      const state = withDriveway({ state: "BOOKED", held_by_user_id: "driver_other" });
      const options = findOptions(state, NOW, from, "driver_demo");
      const o = options.find((x) => x.kind === "driveway")!;
      expect(o).toMatchObject({ booked: true, title: "Booked driveway" });
      expect(options[options.length - 1].id).toBe(o.id);
      expect(mapPills([o])[0]).toMatchObject({ label: "Booked", muted: true });
    });

    it("pins the driver's own booking as their reservation", () => {
      const state = withDriveway({ state: "BOOKED", held_by_user_id: "driver_demo" });
      const options = findOptions(state, NOW, from, "driver_demo");
      expect(myReservation(options)?.title).toBe("Your driveway");
      expect(driveway(state, "driver_demo")?.booked).toBe(false);
    });

    it("marks the owner's listing as theirs, not reservable", () => {
      const state = stateAt(NOW);
      const owner = Object.values(state.driveways)[0].owner_id;
      const o = driveway(state, owner)!;
      expect(o).toMatchObject({ own: true, title: "Your listing" });
      expect(mapPills([o])[0].label).toBe("Your listing");
    });
  });
});
