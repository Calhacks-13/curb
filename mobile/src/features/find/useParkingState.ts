import { useCallback, useEffect, useReducer, useState } from "react";

import { getApi, type RealtimeStatus } from "@/api/client";
import { FIND_RADIUS_M, type LngLat, type NearbyParkingResponse, type RealtimeEvent } from "@/api/types";
import { applyRealtimeEvent, emptyParkingState, fromNearby, type ParkingState } from "@/realtime/reducer";

type Action = { type: "nearby"; res: NearbyParkingResponse } | { type: "event"; event: RealtimeEvent };

function reduce(state: ParkingState, action: Action): ParkingState {
  return action.type === "nearby" ? fromNearby(state, action.res) : applyRealtimeEvent(state, action.event);
}

export type ParkingLoad = "loading" | "ready" | "error";

/** Nearby supply around `center`, kept current by versioned realtime events. */
export function useParkingState(center: LngLat | null) {
  const api = getApi();
  const [state, dispatch] = useReducer(reduce, emptyParkingState);
  const [load, setLoad] = useState<ParkingLoad>("loading");
  const [realtime, setRealtime] = useState<RealtimeStatus>("connecting");

  const refresh = useCallback(async () => {
    if (!center) return;
    try {
      const res = await api.nearby(center[1], center[0], FIND_RADIUS_M);
      dispatch({ type: "nearby", res });
      setLoad("ready");
    } catch {
      setLoad((l) => (l === "ready" ? l : "error"));
    }
  }, [api, center]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const conn = api.connectRealtime((event) => dispatch({ type: "event", event }), setRealtime);
    return () => conn.close();
  }, [api]);

  return { state, load, realtime, refresh, mode: api.mode };
}
