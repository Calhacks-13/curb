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
    detection_confidence: 0.88,
    version: 1,
  });
  const zones = {
    legal: zone("legal", "LEGAL"),
    illegal: zone("illegal", "ILLEGAL"),
    illegalUnsigned: zone("illegalUnsigned", "ILLEGAL", null),
    norule: zone("norule", "LEGAL", null),
    unknown: zone("unknown", "UNKNOWN", null),
  };

  it("shows fresh-enough openings unless their zone is explicitly illegal", () => {
    const shown = visibleSpaces(
      [
        space("ok", "legal", "OPEN", 30),
        space("occupied", "legal", "OCCUPIED", 10),
        space("expired", "legal", "OPEN", 400),
        space("illegal", "illegal", "OPEN", 10),
        space("illegalUnsigned", "illegalUnsigned", "OPEN", 10),
        space("unvalidated", "norule", "OPEN", 10),
        space("unsigned", "unknown", "OPEN", 120),
      ],
      zones,
      NOW,
    );
    expect(shown.map((s) => [s.space.id, s.freshness])).toEqual([
      ["ok", "fresh"],
      ["unvalidated", "fresh"],
      ["unsigned", "aging"],
    ]);
  });

  it("keeps the inclusive five-minute boundary but excludes unusable timestamps", () => {
    const exactBoundary = space("boundary", "legal", "OPEN", 300);
    const missing = { ...space("missing", "legal", "OPEN", 10), last_observed_at: null };
    const invalid = { ...space("invalid", "legal", "OPEN", 10), last_observed_at: "invalid" };

    const shown = visibleSpaces([exactBoundary, missing, invalid], zones, NOW);

    expect(shown.map(({ space: visible }) => visible.id)).toEqual(["boundary"]);
  });
});
