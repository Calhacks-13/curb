import { useCallback, useEffect, useState } from "react";

import { getApi } from "@/api/client";
import type { SpaceDetail } from "@/api/types";

export type DetailLoad = { status: "idle" | "loading" | "error" } | { status: "ready"; detail: SpaceDetail };

/** Loads a space's rule and zone for the detail sheet. */
export function useSpaceDetail(spaceId: string | null) {
  const [load, setLoad] = useState<DetailLoad>({ status: "idle" });

  const fetchDetail = useCallback(async () => {
    if (!spaceId) return setLoad({ status: "idle" });
    setLoad({ status: "loading" });
    try {
      setLoad({ status: "ready", detail: await getApi().space(spaceId) });
    } catch {
      setLoad({ status: "error" });
    }
  }, [spaceId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  return { load, retry: fetchDetail };
}
