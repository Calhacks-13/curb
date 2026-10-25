import type { ParkingSpace } from "@/api/types";
import {
  currentOpenConfidence,
  displayOpenPercent,
} from "@/features/find/confidence";

const NOW = Date.parse("2026-10-24T18:00:00Z");

function space(observedAt: string | null, baseConfidence = 0.8): ParkingSpace {
  return {
    id: "space",
    zone_id: "zone",
    location: { type: "Point", coordinates: [-122.44, 37.8] },
    stall_geometry: { type: "Polygon", coordinates: [] },
    internal_state: "OPEN",
    last_observed_at: observedAt,
    base_confidence: baseConfidence,
    detection_confidence: 0.75,
    version: 1,
  };
}

const observed = (ageSeconds: number) => new Date(NOW - ageSeconds * 1000).toISOString();

describe("currentOpenConfidence", () => {
  it("starts at the server base confidence", () => {
    expect(currentOpenConfidence(space(observed(0)), NOW)).toBeCloseTo(0.8);
  });

  it("decays linearly over five minutes", () => {
    expect(currentOpenConfidence(space(observed(150)), NOW)).toBeCloseTo(0.4);
  });

  it("clamps future observations to zero age", () => {
    expect(currentOpenConfidence(space(observed(-30)), NOW)).toBeCloseTo(0.8);
  });

  it("returns zero at exactly five minutes and excludes older observations", () => {
    expect(currentOpenConfidence(space(observed(300)), NOW)).toBe(0);
    expect(currentOpenConfidence(space(observed(300.001)), NOW)).toBeNull();
  });

  it.each([null, "not-a-timestamp"])("excludes missing or invalid timestamp %s", (timestamp) => {
    expect(currentOpenConfidence(space(timestamp), NOW)).toBeNull();
    expect(displayOpenPercent(space(timestamp), NOW)).toBeNull();
  });

  it("provides one rounded whole-number percentage for every consumer", () => {
    expect(displayOpenPercent(space(observed(0), 0.496), NOW)).toBe(50);
  });
});
