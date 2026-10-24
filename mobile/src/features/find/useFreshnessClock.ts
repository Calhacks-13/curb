import { useEffect, useState } from "react";

import type { ParkingSpace } from "@/api/types";
import { FRESHNESS_BOUNDS } from "./freshness";

const NO_SPACES: Record<string, ParkingSpace> = {};

/** Refresh age text each second and pins immediately after each inclusive bound. */
export function useFreshnessClock(spaces: Record<string, ParkingSpace> = NO_SPACES): number {
  const [now, setNow] = useState(() => Date.now());
  // Realtime can replace `spaces` faster than once a second. Keep the regular
  // tick independent of those updates so rescheduling boundaries cannot starve it.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    let id: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      const current = Date.now();
      let next = Infinity;
      for (const space of Object.values(spaces)) {
        if (space.internal_state !== "OPEN" || !space.last_observed_at) continue;
        const observed = Date.parse(space.last_observed_at);
        for (const bound of Object.values(FRESHNESS_BOUNDS)) {
          const transition = observed + bound * 1000 + 1;
          if (transition > current) next = Math.min(next, transition);
        }
      }
      if (!Number.isFinite(next)) return;
      id = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, next - current);
    }
    schedule();
    return () => clearTimeout(id);
  }, [spaces]);
  return now;
}
