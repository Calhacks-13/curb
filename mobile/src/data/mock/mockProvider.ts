import type { CurbDataProvider } from "../provider";
import type { CurbSegment } from "../types";
import { buildMarinaSegments } from "./marina";

const TICK_MS = 5000;
/** Segments the demo relies on; the simulator never flips these. */
const PINNED = new Set(["steiner-lombard-chestnut-r1", "fillmore-chestnut-francisco-l1", "chestnut-pierce-steiner-r0"]);

/** In-memory provider that ages sightings and now and then flips a spot, like live CV would. */
export function createMockProvider(): CurbDataProvider {
  let segments = buildMarinaSegments();
  const listeners = new Set<(s: CurbSegment[]) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let tick = 0;

  function step() {
    tick++;
    segments = segments.map((s) =>
      s.lastSeenSeconds == null ? s : { ...s, lastSeenSeconds: s.lastSeenSeconds + TICK_MS / 1000 },
    );
    // Pinned spots get re-seen so "seen 20 sec ago" stays true during a demo.
    segments = segments.map((s) => (PINNED.has(s.id) && (s.lastSeenSeconds ?? 0) > 40 ? { ...s, lastSeenSeconds: 8 } : s));
    if (tick % 2 === 0) {
      const flippable = segments.filter((s) => (s.status === "open" || s.status === "full") && !PINNED.has(s.id));
      const pick = flippable[(tick * 7) % flippable.length];
      segments = segments.map((s) =>
        s.id === pick.id ? { ...s, status: s.status === "open" ? "full" : "open", lastSeenSeconds: 0 } : s,
      );
    }
    listeners.forEach((fn) => fn(segments));
  }

  return {
    async getSegments() {
      return segments;
    },
    subscribe(_bounds, onChange) {
      listeners.add(onChange);
      onChange(segments);
      timer ??= setInterval(step, TICK_MS);
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}
