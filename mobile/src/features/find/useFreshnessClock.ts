import { useEffect, useState } from "react";

/** Ticks once a second so freshness colors and expiry update locally. */
export function useFreshnessClock(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
