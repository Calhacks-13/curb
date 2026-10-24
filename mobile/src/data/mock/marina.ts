// Mock curb data for ~15 blocks of the Marina. Geometry comes from street
// intersections fitted to OpenStreetMap centerlines (the grid here is rotated
// ~9 degrees from north), so segments sit on the real streets.

import { distanceM, type LngLat } from "../geo";
import type { CurbSegment, CurbStatus } from "../types";

// "EastWestStreet|NorthSouthStreet" -> [lng, lat]
export const INTERSECTIONS = {
  "Francisco|Divisadero": [-122.443054, 37.800917],
  "Francisco|Scott": [-122.441386, 37.801129],
  "Francisco|Pierce": [-122.439698, 37.801344],
  "Francisco|Steiner": [-122.438098, 37.801547],
  "Francisco|Fillmore": [-122.436502, 37.80175],
  "Francisco|Webster": [-122.434809, 37.801966],
  "Bay|Fillmore": [-122.436703, 37.802665],
  "Chestnut|Divisadero": [-122.442864, 37.799981],
  "Chestnut|Scott": [-122.441196, 37.800193],
  "Chestnut|Pierce": [-122.439522, 37.800406],
  "Chestnut|Steiner": [-122.437908, 37.800611],
  "Chestnut|Fillmore": [-122.436297, 37.800816],
  "Chestnut|Webster": [-122.434619, 37.801029],
  "Lombard|Divisadero": [-122.442667, 37.799007],
  "Lombard|Scott": [-122.441, 37.79922],
  "Lombard|Pierce": [-122.439339, 37.799432],
  "Lombard|Steiner": [-122.437711, 37.79964],
  "Lombard|Fillmore": [-122.436084, 37.799848],
  "Lombard|Webster": [-122.434422, 37.80006],
  "Greenwich|Divisadero": [-122.442487, 37.798122],
  "Greenwich|Scott": [-122.44082, 37.798334],
  "Greenwich|Pierce": [-122.439172, 37.798543],
  "Greenwich|Steiner": [-122.437531, 37.798752],
  "Greenwich|Fillmore": [-122.43589, 37.79896],
  "Greenwich|Webster": [-122.434242, 37.79917],
} as const satisfies Record<string, LngLat>;

export type Node = keyof typeof INTERSECTIONS;

/**
 * 2100 Chestnut St. The geocoder returns the building centroid (-122.4381, 37.800798),
 * which is hidden inside the 3D building; the pin sits on the sidewalk out front.
 */
export const DESTINATION = {
  label: "2100 Chestnut",
  address: "2100 Chestnut St",
  position: [-122.4381, 37.800667] as LngLat,
};

/** Where the user's car starts: northbound on Fillmore, just south of Lombard. */
export const CAR_START = {
  position: [-122.43597, 37.79932] as LngLat,
  heading: 351,
  nextNode: "Lombard|Fillmore" as Node,
};

type Piece = {
  from: number;
  to: number;
  status: CurbStatus;
  price?: string;
  rule?: string;
  seen?: number;
  /** pOpen at +15, +30, +60 min. Omitted -> flat at the status baseline. */
  trend?: [number, number, number];
};

type Block = {
  id: string;
  a: Node; // west or south end
  b: Node; // east or north end
  /** Meters to push past the map's base curb offset, for wide streets. */
  widen?: number;
  right: Piece[]; // south side of E-W streets, east side of N-S streets
  left: Piece[];
};

const METERED = { price: "$3.50/hr", rule: "2 hr, 9 AM to 6 PM" };
const RESIDENTIAL = { price: "Free", rule: "2 hr, until 6 PM" };
const TOW = { rule: "Tow away 4 to 7 PM" };

const LOMBARD: [Node, Node][] = [
  ["Lombard|Divisadero", "Lombard|Scott"],
  ["Lombard|Scott", "Lombard|Pierce"],
  ["Lombard|Pierce", "Lombard|Steiner"],
  ["Lombard|Steiner", "Lombard|Fillmore"],
  ["Lombard|Fillmore", "Lombard|Webster"],
];

const BLOCKS: Block[] = [
  // Chestnut St, Divisadero to Webster: the commercial strip, metered.
  {
    id: "chestnut-div-scott",
    a: "Chestnut|Divisadero",
    b: "Chestnut|Scott",
    right: [
      { from: 0, to: 0.7, status: "full", ...METERED, seen: 140, trend: [0.15, 0.3, 0.55] },
      { from: 0.7, to: 1, status: "loading", rule: "Loading 7 to 11 AM" },
    ],
    left: [{ from: 0, to: 1, status: "full", ...METERED, seen: 300, trend: [0.1, 0.12, 0.35] }],
  },
  {
    id: "chestnut-scott-pierce",
    a: "Chestnut|Scott",
    b: "Chestnut|Pierce",
    right: [{ from: 0, to: 1, status: "likely", ...METERED, trend: [0.5, 0.35, 0.2] }],
    left: [
      { from: 0, to: 0.25, status: "no_parking", rule: "Bus zone" },
      { from: 0.25, to: 1, status: "full", ...METERED, seen: 90, trend: [0.2, 0.45, 0.7] },
    ],
  },
  {
    id: "chestnut-pierce-steiner",
    a: "Chestnut|Pierce",
    b: "Chestnut|Steiner",
    right: [
      { from: 0, to: 0.55, status: "likely", ...METERED, trend: [0.62, 0.7, 0.55] },
      { from: 0.55, to: 0.75, status: "loading", rule: "Loading 7 to 11 AM" },
      { from: 0.75, to: 1, status: "full", ...METERED, seen: 45 },
    ],
    left: [
      { from: 0, to: 0.6, status: "full", ...METERED, seen: 30, trend: [0.25, 0.6, 0.8] },
      { from: 0.6, to: 1, status: "open", ...METERED, seen: 25, trend: [0.7, 0.4, 0.2] },
    ],
  },
  {
    id: "chestnut-steiner-fillmore",
    a: "Chestnut|Steiner",
    b: "Chestnut|Fillmore",
    right: [{ from: 0, to: 1, status: "full", ...METERED, seen: 60, trend: [0.1, 0.25, 0.6] }],
    left: [
      { from: 0, to: 0.2, status: "no_parking", rule: "Bus zone" },
      { from: 0.2, to: 1, status: "likely", ...METERED, trend: [0.45, 0.3, 0.3] },
    ],
  },
  {
    id: "chestnut-fillmore-webster",
    a: "Chestnut|Fillmore",
    b: "Chestnut|Webster",
    right: [{ from: 0, to: 1, status: "open", ...METERED, seen: 15, trend: [0.75, 0.5, 0.3] }],
    left: [
      { from: 0, to: 0.5, status: "full", ...METERED, seen: 200 },
      { from: 0.5, to: 1, status: "loading", rule: "Commercial loading, 30 min" },
    ],
  },

  // Lombard St (US 101): wide, tow-away at commute.
  ...LOMBARD.map(
    ([a, b], i): Block => ({
      id: `lombard-${i}`,
      a,
      b,
      widen: 6,
      right: [{ from: 0, to: 1, status: "no_parking", ...TOW }],
      left:
        i === 3
          ? [
              { from: 0, to: 0.7, status: "no_parking", ...TOW },
              { from: 0.7, to: 0.75, status: "driveway", price: "$6", rule: "Until 9 PM", seen: 600 },
              { from: 0.75, to: 1, status: "no_parking", ...TOW },
            ]
          : [{ from: 0, to: 1, status: "no_parking", ...TOW }],
    }),
  ),

  // Fillmore St, Greenwich to Bay.
  {
    id: "fillmore-greenwich-lombard",
    a: "Greenwich|Fillmore",
    b: "Lombard|Fillmore",
    widen: 3,
    right: [{ from: 0, to: 1, status: "full", ...METERED, seen: 400, trend: [0.2, 0.3, 0.5] }],
    left: [{ from: 0, to: 1, status: "likely", ...METERED, trend: [0.55, 0.6, 0.65] }],
  },
  {
    id: "fillmore-lombard-chestnut",
    a: "Lombard|Fillmore",
    b: "Chestnut|Fillmore",
    widen: 3,
    right: [
      { from: 0, to: 0.7, status: "full", ...METERED, seen: 35, trend: [0.2, 0.2, 0.4] },
      { from: 0.7, to: 1, status: "no_parking", rule: "No stopping" },
    ],
    left: [{ from: 0, to: 1, status: "open", ...METERED, seen: 50, trend: [0.65, 0.45, 0.35] }],
  },
  {
    id: "fillmore-chestnut-francisco",
    a: "Chestnut|Fillmore",
    b: "Francisco|Fillmore",
    widen: 3,
    right: [{ from: 0, to: 1, status: "full", ...RESIDENTIAL, seen: 120, trend: [0.15, 0.4, 0.6] }],
    left: [
      { from: 0, to: 0.3, status: "full", ...RESIDENTIAL, seen: 80 },
      { from: 0.3, to: 0.38, status: "driveway", price: "$8", rule: "Until 10 PM", seen: 20 },
      { from: 0.38, to: 1, status: "likely", ...RESIDENTIAL, trend: [0.5, 0.55, 0.7] },
    ],
  },
  {
    id: "fillmore-francisco-bay",
    a: "Francisco|Fillmore",
    b: "Bay|Fillmore",
    widen: 3,
    right: [{ from: 0, to: 1, status: "open", ...RESIDENTIAL, seen: 240, trend: [0.7, 0.75, 0.8] }],
    left: [{ from: 0, to: 1, status: "full", ...RESIDENTIAL, seen: 900, trend: [0.3, 0.45, 0.6] }],
  },

  // Residential side streets off Chestnut: free, 2 hr limit.
  {
    id: "steiner-lombard-chestnut",
    a: "Lombard|Steiner",
    b: "Chestnut|Steiner",
    right: [
      { from: 0, to: 0.45, status: "full", ...RESIDENTIAL, seen: 70 },
      { from: 0.45, to: 0.85, status: "open", ...RESIDENTIAL, seen: 20, trend: [0.85, 0.7, 0.5] },
      { from: 0.85, to: 1, status: "no_parking", rule: "Red curb" },
    ],
    left: [{ from: 0, to: 1, status: "full", ...RESIDENTIAL, seen: 150, trend: [0.2, 0.35, 0.55] }],
  },
  {
    id: "steiner-chestnut-francisco",
    a: "Chestnut|Steiner",
    b: "Francisco|Steiner",
    right: [{ from: 0, to: 1, status: "likely", ...RESIDENTIAL, trend: [0.6, 0.65, 0.7] }],
    left: [
      { from: 0, to: 0.4, status: "full", ...RESIDENTIAL, seen: 500 },
      { from: 0.4, to: 1, status: "open", ...RESIDENTIAL, seen: 1100, trend: [0.5, 0.4, 0.4] },
    ],
  },
  {
    id: "pierce-chestnut-francisco",
    a: "Chestnut|Pierce",
    b: "Francisco|Pierce",
    right: [{ from: 0, to: 1, status: "full", ...RESIDENTIAL, seen: 60, trend: [0.3, 0.5, 0.75] }],
    left: [{ from: 0, to: 1, status: "likely", ...RESIDENTIAL, trend: [0.55, 0.5, 0.45] }],
  },
  {
    id: "scott-chestnut-francisco",
    a: "Chestnut|Scott",
    b: "Francisco|Scott",
    right: [{ from: 0, to: 1, status: "open", ...RESIDENTIAL, seen: 400, trend: [0.6, 0.45, 0.3] }],
    left: [{ from: 0, to: 1, status: "full", ...RESIDENTIAL, seen: 260 }],
  },
];

/** Meters trimmed off each end of a block so curbs stop short of the crosswalk. */
const CORNER_TRIM_M = 11;

function blockLine(block: Block, from: number, to: number, side: "left" | "right"): LngLat[] {
  const [ax, ay] = INTERSECTIONS[block.a];
  const [bx, by] = INTERSECTIONS[block.b];
  const len = distanceM([ax, ay], [bx, by]);
  const trim = CORNER_TRIM_M / len;
  const f0 = trim + from * (1 - 2 * trim);
  const f1 = trim + to * (1 - 2 * trim);
  // Shift toward the curb for wide streets; the map adds its base offset on top.
  const widen = block.widen ?? 0;
  const s = side === "right" ? 1 : -1;
  const dxM = (bx - ax) * 111_320 * Math.cos((ay * Math.PI) / 180);
  const dyM = (by - ay) * 111_320;
  const nx = ((dyM / len) * s * widen) / (111_320 * Math.cos((ay * Math.PI) / 180));
  const ny = ((-dxM / len) * s * widen) / 111_320;
  const at = (f: number): LngLat => [ax + (bx - ax) * f + nx, ay + (by - ay) * f + ny];
  return [0, 0.5, 1].map((t) => at(f0 + (f1 - f0) * t));
}

const BASELINE: Record<CurbStatus, number> = {
  open: 0.9,
  likely: 0.55,
  full: 0.08,
  no_parking: 0,
  loading: 0,
  driveway: 1,
};

export function buildMarinaSegments(): CurbSegment[] {
  const out: CurbSegment[] = [];
  for (const block of BLOCKS) {
    for (const side of ["right", "left"] as const) {
      block[side].forEach((p, i) => {
        const base = BASELINE[p.status];
        const trend = p.trend ?? [base, base, base];
        const varies = p.status === "open" || p.status === "likely" || p.status === "full";
        out.push({
          id: `${block.id}-${side[0]}${i}`,
          coordinates: blockLine(block, p.from, p.to, side),
          side,
          status: p.status,
          price: p.price,
          rule: p.rule,
          lastSeenSeconds: p.seen,
          predicted: varies
            ? [
                { minutesAhead: 15, pOpen: trend[0] },
                { minutesAhead: 30, pOpen: trend[1] },
                { minutesAhead: 60, pOpen: trend[2] },
              ]
            : undefined,
        });
      });
    }
  }
  return out;
}
