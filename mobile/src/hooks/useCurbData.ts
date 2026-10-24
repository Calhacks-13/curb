import { useEffect, useState } from "react";

import { getCurbProvider, MARINA_BOUNDS, type Bounds } from "@/data/provider";
import type { CurbSegment } from "@/data/types";

export function useCurbData(bounds: Bounds = MARINA_BOUNDS): CurbSegment[] {
  const [segments, setSegments] = useState<CurbSegment[]>([]);
  useEffect(() => getCurbProvider().subscribe(bounds, setSegments), [bounds]);
  return segments;
}
