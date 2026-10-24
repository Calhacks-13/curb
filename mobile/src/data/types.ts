// Shared contract between the map UI and the data teams (backend / CV / payments).
// No UI imports here so it can be copied into other packages as-is.

export type CurbStatus = "open" | "likely" | "no_parking" | "loading" | "driveway" | "full";

export type CurbSegment = {
  id: string;
  /**
   * lng, lat along the block, ordered in the direction `side` is measured from.
   * The map pushes the line onto the curb with line-offset, so street centerline
   * coordinates are fine.
   */
  coordinates: [number, number][];
  side: "left" | "right";
  status: CurbStatus;
  price?: string; // "Free", "$3.50/hr", "$8"
  rule?: string; // "2 hr, until 6 PM"
  lastSeenSeconds?: number;
  predicted?: { minutesAhead: number; pOpen: number }[];
};
