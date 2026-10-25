import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { getApi, type RealtimeStatus } from "@/api/client";
import { FIND_RADIUS_M, type LngLat, type NearbyParkingResponse, type RealtimeEvent } from "@/api/types";
import { applyRealtimeEvent, emptyParkingState, fromNearby, type ParkingState } from "@/realtime/reducer";

type Action = { type: "nearby"; res: NearbyParkingResponse } | { type: "event"; event: RealtimeEvent };

function reduce(state: ParkingState, action: Action): ParkingState {
  return action.type === "nearby" ? fromNearby(state, action.res) : applyRealtimeEvent(state, action.event);
}

export type ParkingLoad = "loading" | "ready" | "error";

/** ~100 m grid, so a moving driver doesn't refetch on every location update. */
function centerKey(center: LngLat | null): string | null {
  return center ? `${center[0].toFixed(3)},${center[1].toFixed(3)}` : null;
}

/**
 * Nearby supply around `center`, kept current by versioned realtime events.
 * `onEvent` sees each realtime event as it arrives (e.g. to announce new openings).
 */
export function useParkingState(center: LngLat | null, onEvent?: (event: RealtimeEvent, before: ParkingState) => void) {
  const api = getApi();
  const [state, dispatch] = useReducer(reduce, emptyParkingState);
  const snapshot = useRef(emptyParkingState);
  const [result, setResult] = useState<{ key: string; ok: boolean } | null>(null);
  const [realtime, setRealtime] = useState<RealtimeStatus>("connecting");
  const [attempt, setAttempt] = useState(0);
  const key = centerKey(center);
  const fetchKey = key ? `${key}#${attempt}` : null;
  // Bucket only the trigger. Search with the actual GPS fix so the radius stays
  // centered on the driver rather than a rounded point up to ~70 m away.
  const centerRef = useRef(center);
  useEffect(() => {
    centerRef.current = center;
  }, [center]);

  useEffect(() => {
    if (!fetchKey || !centerRef.current) return;
    let cancelled = false;
    const [lng, lat] = centerRef.current;
    api
      .nearby(lat, lng, FIND_RADIUS_M)
      .then((res) => {
        if (cancelled) return;
        snapshot.current = fromNearby(snapshot.current, res);
        dispatch({ type: "nearby", res });
        setResult({ key: fetchKey, ok: true });
      })
      .catch(() => !cancelled && setResult({ key: fetchKey, ok: false }));
    return () => {
      cancelled = true;
    };
  }, [api, fetchKey]);

  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  // Maintain an event-time snapshot: a batch can contain zone + space before
  // React commits another render. Alerts must see the preceding zone event.
  const dispatchEvent = useCallback((event: RealtimeEvent) => {
    const before = snapshot.current;
    if (event.type !== "agent.position") {
      snapshot.current = applyRealtimeEvent(before, event);
      dispatch({ type: "event", event });
    }
    onEventRef.current?.(event, before);
  }, []);

  useEffect(() => {
    const conn = api.connectRealtime(dispatchEvent, setRealtime);
    return () => conn.close();
  }, [api, dispatchEvent]);

  // Once anything has loaded, keep showing it (last honest state) through later failures.
  const everLoaded = Object.keys(state.versions).length > 0;
  const load: ParkingLoad = everLoaded ? "ready" : result?.key === fetchKey ? (result.ok ? "ready" : "error") : "loading";
  const refresh = useCallback(() => setAttempt((a) => a + 1), []);

  return { state, load, realtime, refresh, dispatchEvent, mode: api.mode };
}
