import { useCallback, useEffect, useState } from "react";

import { getApi } from "@/api/client";
import type { SpaceDetail } from "@/api/types";

export type DetailLoad = { status: "idle" | "loading" | "error" } | { status: "ready"; detail: SpaceDetail };

/** Loads a space's rule and zone for the detail sheet. */
export function useSpaceDetail(spaceId: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; detail: SpaceDetail | null } | null>(null);
  const key = spaceId ? `${spaceId}#${attempt}` : null;

  useEffect(() => {
    if (!key || !spaceId) return;
    let cancelled = false;
    getApi()
      .space(spaceId)
      .then((detail) => {
        if (cancelled) return;
        // Guard against malformed responses (e.g. {"error": "not found"})
        setResult({ key, detail: detail?.space ? detail : null });
      })
      .catch(() => !cancelled && setResult({ key, detail: null }));
    return () => {
      cancelled = true;
    };
  }, [key, spaceId]);

  const load: DetailLoad =
    !key ? { status: "idle" } : result?.key !== key ? { status: "loading" } : result.detail ? { status: "ready", detail: result.detail } : { status: "error" };

  return { load, retry: useCallback(() => setAttempt((a) => a + 1), []) };
}
