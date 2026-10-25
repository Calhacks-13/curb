import { act, renderHook } from "@testing-library/react-native";

import type { Driveway, ParkingSpace } from "@/api/types";
import { freshnessOf } from "@/features/find/freshness";
import { findOptions } from "@/features/find/options";
import { useFreshnessClock } from "@/features/find/useFreshnessClock";
import { emptyParkingState } from "@/realtime/reducer";

const NOW = Date.parse("2026-10-24T21:00:00Z");
const space: ParkingSpace = {
  id: "space", zone_id: "zone", location: { type: "Point", coordinates: [-122.43597, 37.79932] },
  stall_geometry: { type: "Polygon", coordinates: [] }, internal_state: "OPEN",
  last_observed_at: new Date(NOW).toISOString(), base_confidence: 0.94, detection_confidence: 0.92, version: 1,
};
const driveway: Driveway = {
  id: "driveway", owner_id: "owner", location: space.location, photo_url: null, price_usdc: "8.00",
  availability_start: "08:00", availability_end: "14:00", availability_timezone: "America/Los_Angeles",
  availability_window: { start: "2026-10-24T15:00:00Z", end: "2026-10-24T21:00:01Z" },
  state: "AVAILABLE", held_by_user_id: null, version: 1,
};

it("advances time, expires dated driveway pins and ages curb pins despite continuous 2 Hz space updates", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  try {
    const { result, rerender, unmount } = await renderHook(
      ({ spaces }: { spaces: Record<string, ParkingSpace> }) => {
        const now = useFreshnessClock(spaces);
        const options = findOptions({ ...emptyParkingState, spaces, driveways: { driveway }, zones: {
          zone: { id: "zone", geometry: { type: "LineString", coordinates: [] }, sign_rule_id: "rule", legal_status_now: "LEGAL", next_change_at: null, version: 1 },
        } }, now, space.location.coordinates);
        return { now, options };
      }, { initialProps: { spaces: { space } } },
    );
    expect(result.current.options.map((o) => o.id)).toEqual(["space", "driveway"]);
    for (let elapsed = 500; elapsed <= 301_000; elapsed += 500) {
      await act(async () => { jest.advanceTimersByTime(500); });
      // A fresh object represents each committed realtime update, even if the
      // target stall's confirming observation itself has not changed.
      await rerender({ spaces: { space: { ...space, version: elapsed / 500 + 1 } } });
      if (elapsed === 1000) {
        expect(result.current.now).toBe(NOW + 1000);
        expect(result.current.options.some((o) => o.id === "driveway")).toBe(false);
      }
      if ([90_000, 90_500, 180_000, 180_500, 300_000, 300_500].includes(elapsed)) {
        const expected = elapsed <= 90_000 ? "fresh" : elapsed <= 180_000 ? "aging" : elapsed <= 300_000 ? "stale" : "expired";
        expect(freshnessOf(space.last_observed_at, result.current.now)).toBe(expected);
        expect(result.current.options.find((o) => o.id === "space")?.kind ?? "expired").toBe(expected);
      }
    }
    await unmount();
  } finally { jest.useRealTimers(); }
});
