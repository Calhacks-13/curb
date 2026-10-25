// Mapbox GL layer specs for parking supply and the route. Plain data, handed to
// the WebView as JSON. Semantics follow the MVP spec (section 7.3):
//   fresh       green bay   "Likely open"        (seen <= 90 s ago)
//   aging       yellow bay  "May still be open"  (<= 3 min)
//   stale       gray bay    "Stale observation"  (<= 5 min)
//   driveway    purple bay  guaranteed after payment
// Colors are paired with callout text and chip shapes in the WebView.
//
// Day/night colors are written per frame by the runtime (see PALETTE), so these
// specs carry the day values. feature-state on "stalls": fade 0..1 (new
// opening), sel 0..1 (selected), pulse 0..1 + target 0|1 (route target).

import { ink, status as S } from "../config/tokens";

/** Mapbox GL renders 512px tiles: meters per pixel at zoom z (lat 37.8) = 61850 / 2^z. */
const px = (meters: number, z: number) => (meters * 2 ** z) / 61850;

type Expr = unknown[];
type Layer = Record<string, unknown>;

const state = (key: string, fallback: unknown): Expr => ["coalesce", ["feature-state", key], fallback];

/** At least `minPx` wide; about `m` meters when zoomed in. */
const hairline = (minPx: number, m: number): Expr => ["interpolate", ["exponential", 2], ["zoom"], 15, minPx, 20, Math.max(minPx, px(m, 20))];

export type StallKind = "fresh" | "aging" | "stale" | "driveway";

/** Day and night color per semantic; the runtime cross-fades between them. */
export const PALETTE = {
  fresh: { day: S.fresh, night: S.freshNight },
  aging: { day: S.aging, night: S.agingNight },
  stale: { day: S.stale, night: S.staleNight },
  driveway: { day: S.driveway, night: S.drivewayNight },
  select: { day: ink.black, night: ink.white },
} as const;

export const STALL_FILL_ID = "stall-fill";

/** Builds the kind -> color match for a given mood mix (0 day .. 1 night). */
export function stallColorExpr(pick: (c: { day: string; night: string }) => string): Expr {
  return [
    "match",
    ["get", "kind"],
    "fresh",
    pick(PALETTE.fresh),
    "aging",
    pick(PALETTE.aging),
    "stale",
    pick(PALETTE.stale),
    pick(PALETTE.driveway),
  ];
}

export const SUPPLY_LAYERS: Layer[] = [
  {
    id: STALL_FILL_ID,
    type: "fill",
    source: "stalls",
    slot: "middle",
    paint: {
      "fill-color": stallColorExpr((c) => c.day),
      "fill-opacity": ["*", 0.95, state("fade", 1)],
      // Keeps colors true under the night light preset; it doesn't glow.
      "fill-emissive-strength": 1,
    },
  },
  {
    id: "stall-select",
    type: "line",
    source: "stalls",
    slot: "middle",
    layout: { "line-join": "round" },
    paint: {
      "line-color": PALETTE.select.day,
      "line-width": hairline(2.2, 0.28),
      "line-opacity": state("sel", 0),
      "line-emissive-strength": 1,
    },
  },
  {
    id: "stall-pulse",
    type: "line",
    source: "stalls",
    slot: "middle",
    layout: { "line-join": "round" },
    paint: {
      "line-color": stallColorExpr((c) => c.day),
      "line-width": ["interpolate", ["linear"], ["zoom"], 15, ["+", 1, ["*", 4, state("pulse", 0)]], 20, ["+", 2, ["*", 12, state("pulse", 0)]]],
      "line-opacity": ["*", ["-", 1, state("pulse", 0)], state("target", 0)],
      "line-emissive-strength": 1,
    },
  },
];

const ROUTE_NIGHT: Expr = state("glow", 0);
const routeWidth = (atZ17: number): Expr => ["interpolate", ["exponential", 1.6], ["zoom"], 14, atZ17 * 0.35, 17, atZ17, 20, atZ17 * 3.2];

export const ROUTE_LAYERS: Layer[] = [
  {
    id: "route-casing",
    type: "line",
    source: "route",
    slot: "middle",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["interpolate", ["linear"], ROUTE_NIGHT, 0, ink.white, 1, ink.black],
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
      "line-color": ["interpolate", ["linear"], ROUTE_NIGHT, 0, ink.black, 1, ink.white],
      "line-width": routeWidth(6),
      "line-emissive-strength": 1,
    },
  },
];
