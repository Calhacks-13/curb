import type { CurbZone, ParkingSpace } from "@/api/types";
import { freshnessOf, visibleSpaces } from "@/features/find/freshness";

const NOW = Date.parse("2026-10-24T18:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

describe("freshnessOf", () => {
  it.each([
    [0, "fresh"],
    [90, "fresh"],
    [90.5, "aging"],
    [180, "aging"],
    [180.5, "stale"],
    [300, "stale"],
    [300.5, "expired"],
  ] as const)("%s s old is %s", (age, expected) => {
    expect(freshnessOf(ago(age), NOW)).toBe(expected);
  });

  it("treats a never-observed space as expired", () => {
    expect(freshnessOf(null, NOW)).toBe("expired");
  });
});

describe("visibleSpaces", () => {
  const zone = (id: string, legal: CurbZone["legal_status_now"], rule: string | null = "r1"): CurbZone => ({
    id,
    geometry: { type: "LineString", coordinates: [] },
    sign_rule_id: rule,
    legal_status_now: legal,
    next_change_at: null,
    version: 1,
  });
  const space = (id: string, zoneId: string, state: ParkingSpace["internal_state"], age: number): ParkingSpace => ({
    id,
    zone_id: zoneId,
    location: { type: "Point", coordinates: [0, 0] },
    stall_geometry: { type: "Polygon", coordinates: [] },
    internal_state: state,
    last_observed_at: ago(age),
    base_confidence: 0.9,
    version: 1,
  });
  const zones = { legal: zone("legal", "LEGAL"), illegal: zone("illegal", "ILLEGAL"), norule: zone("norule", "LEGAL", null) };

  it("shows only fresh-enough openings in zones that are legal now under a validated rule", () => {
    const shown = visibleSpaces(
      [
        space("ok", "legal", "OPEN", 30),
        space("occupied", "legal", "OCCUPIED", 10),
        space("expired", "legal", "OPEN", 400),
        space("illegal", "illegal", "OPEN", 10),
        space("unvalidated", "norule", "OPEN", 10),
      ],
      zones,
      NOW,
    );
    expect(shown.map((s) => s.space.id)).toEqual(["ok"]);
    expect(shown[0].freshness).toBe("fresh");
  });
});
