// Mapbox GL layer specs for the curb data and the nav route. Plain data, handed
// to the WebView as JSON.
//
// Visual language (flat, no glow): color only where you can park.
//   open      solid green bay
//   likely    green-outlined bay with a light fill
//   driveway  solid blue bay
//   no parking / loading   thin painted curb edge (red / white), like SF curbs
//   taken     not drawn
//
// feature-state on "stalls": night 0..1 (day/night palette), fade 0..1 after an
// update, sel 0..1 selected, pulse 0..1 + target 0|1 for the nav target.

import { CONFIDENCE_BY_AGE } from "../data/prediction";
import { status as C, ink } from "../config/tokens";

/** Meters from the street centerline to the curb face. */
export const CURB_OFFSET_M = 5.2;

/** Mapbox GL renders 512px tiles: meters per pixel at zoom z (lat 37.8) = 61850 / 2^z. */
const M_PER_PX_Z0 = 61850;
const px = (meters: number, z: number) => (meters * 2 ** z) / M_PER_PX_Z0;

type Expr = unknown[];
type Layer = Record<string, unknown>;

const state = (key: string, fallback: unknown): Expr => ["coalesce", ["feature-state", key], fallback];
const NIGHT: Expr = state("glow", 0);
const FADE: Expr = state("fade", 1);
const SEL: Expr = state("sel", 0);

const dayNight = (day: string, night: string): Expr => ["interpolate", ["linear"], NIGHT, 0, day, 1, night];

/** Lines that should stay crisp: at least `minPx` wide, ~`m` meters when zoomed in. */
const hairline = (minPx: number, m: number): Expr => [
  "interpolate",
  ["exponential", 2],
  ["zoom"],
  15,
  minPx,
  20,
  Math.max(minPx, px(m, 20)),
];

/** line-offset that puts a centerline-based segment on its curb face. */
const CURB_FACE_OFFSET: Expr = [
  "interpolate",
  ["exponential", 2],
  ["zoom"],
  12,
  ["*", ["get", "sideSign"], px(CURB_OFFSET_M, 12)],
  22,
  ["*", ["get", "sideSign"], px(CURB_OFFSET_M, 22)],
];

const CONFIDENCE: Expr = [
  "interpolate",
  ["linear"],
  ["coalesce", ["get", "lastSeenSeconds"], 90],
  ...CONFIDENCE_BY_AGE.flat(),
];
const kindIs = (k: string): Expr => ["==", ["get", "kind"], k];
const statusIs = (s: string): Expr => ["==", ["get", "status"], s];

const curbPaint = (id: string, filter: Expr, color: unknown, width: Expr): Layer => ({
  id,
  type: "line",
  source: "curbs",
  slot: "middle",
  filter,
  layout: { "line-cap": "butt", "line-join": "round" },
  paint: { "line-offset": CURB_FACE_OFFSET, "line-color": color, "line-width": width, "line-emissive-strength": 1 },
});

/** Restrictions read like real painted curbs: thin, flat, no glow. */
export const CURB_PAINT_LAYERS: Layer[] = [
  curbPaint("curb-paint-loading-case", statusIs("loading"), C.loadingOutline, hairline(2.6, 0.45)),
  curbPaint("curb-paint-loading", statusIs("loading"), C.loading, hairline(1.4, 0.3)),
  // Night red is muted on purpose: restrictions shouldn't outshine open spots.
  curbPaint("curb-paint-red", statusIs("no_parking"), dayNight(C.noParking, "#A8433B"), hairline(1.6, 0.3)),
];

const stallLine = (id: string, filter: Expr, paint: Record<string, unknown>): Layer => ({
  id,
  type: "line",
  source: "stalls",
  slot: "middle",
  filter,
  layout: { "line-join": "round", "line-cap": "round" },
  paint: { "line-emissive-strength": 1, ...paint },
});

const stallFill = (id: string, filter: Expr, color: Expr, opacity: unknown): Layer => ({
  id,
  type: "fill",
  source: "stalls",
  slot: "middle",
  filter,
  // emissive 1 keeps the colors true under the night light preset; it doesn't glow.
  paint: { "fill-color": color, "fill-opacity": opacity, "fill-emissive-strength": 1 },
});

const GREEN = dayNight(C.open, C.openNight);

export const STALL_LAYERS: Layer[] = [
  // Open bays: solid. Older sightings are lighter; a fresh one fades in.
  stallFill("stall-open", kindIs("open"), GREEN, ["*", ["+", 0.25, ["*", 0.75, CONFIDENCE]], FADE]),
  // Likely: light fill + solid edge.
  stallFill("stall-likely-fill", kindIs("likely"), GREEN, ["*", 0.16, FADE]),
  stallLine("stall-likely-edge", kindIs("likely"), {
    "line-color": GREEN,
    "line-width": hairline(1.5, 0.2),
    "line-opacity": FADE,
  }),
  stallFill("stall-driveway", kindIs("driveway"), dayNight(C.driveway, C.drivewayNight), 0.95),
  // Selected bay: black outline (white at night).
  stallLine("stall-select", ["has", "kind"], {
    "line-color": dayNight(ink.black, ink.white),
    "line-width": hairline(2.2, 0.28),
    "line-opacity": SEL,
  }),
  // Nav target: a ring that expands and fades. Flat, no blur.
  stallLine("stall-pulse", ["has", "kind"], {
    "line-color": GREEN,
    "line-width": [
      "interpolate",
      ["linear"],
      ["zoom"],
      15,
      ["+", 1, ["*", 4, state("pulse", 0)]],
      20,
      ["+", 2, ["*", 12, state("pulse", 0)]],
    ],
    "line-opacity": ["*", ["-", 1, state("pulse", 0)], state("target", 0)],
  }),
];

const ROUTE_GLOW: Expr = state("glow", 0);
const routeWidth = (atZ17: number): Expr => [
  "interpolate",
  ["exponential", 1.6],
  ["zoom"],
  14,
  atZ17 * 0.35,
  17,
  atZ17,
  20,
  atZ17 * 3.2,
];

export const ROUTE_LAYERS: Layer[] = [
  {
    id: "route-casing",
    type: "line",
    source: "route",
    slot: "middle",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["interpolate", ["linear"], ROUTE_GLOW, 0, ink.white, 1, ink.black],
      "line-width": routeWidth(9),
      "line-emissive-strength": 1,
    },
  },
  {
    id: "route-line",
    type: "line",
    source: "route",
    slot: "middle",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["interpolate", ["linear"], ROUTE_GLOW, 0, ink.black, 1, ink.white],
      "line-width": routeWidth(6),
      "line-emissive-strength": 1,
    },
  },
];
