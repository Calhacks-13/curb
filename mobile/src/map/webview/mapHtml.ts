import { ink, status } from "../../config/tokens";
import { PALETTE, ROUTE_LAYERS, STALL_FILL_ID, SUPPLY_LAYERS, ZONE_LAYER_ID } from "../curbLayers";
import {
  BASEMAP_STATIC_CONFIG,
  HOME_CAMERA,
  INTRO_CAMERA,
  INTRO_DURATION_MS,
  MAPBOX_GL_VERSION,
  MAX_PIXEL_RATIO,
  STYLE_URL,
} from "../mapConfig";
import { EGO_LAYER, EGO_MODEL, HEADING_TO_ROTATION, MODELS } from "../modelLayers";
import { MOOD_TRANSITION_MS, MOODS, type Mood } from "../moods";
import { MAP_RUNTIME_JS } from "./runtime";

export type MapHtmlOptions = {
  token: string;
  mood: Mood;
  reduceMotion: boolean;
};

// Map callouts: flat, white, black type, one small status
// chip. The map-side half of the design system; keep in step with config/tokens.ts.
const MARKER_CSS = `
  /* Mapbox positions .pin with an inline transform; scale the inner wrapper instead. */
  .pin { appearance: none; background: none; border: 0; padding: 0; margin: 0; color: inherit; font: inherit; cursor: pointer; }
  .pin-inner { display: flex; flex-direction: column; align-items: center;
    transform: scale(var(--pin-scale, 1)); transform-origin: 50% 100%; }
  .callout { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px 0 6px; border-radius: 8px;
    background: ${ink.white}; color: ${ink.black}; font: 700 14px/1 Overpass, -apple-system, sans-serif;
    white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
  .callout span:last-child { padding-top: 2px; }
  .tail { width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent;
    border-top: 6px solid ${ink.white}; margin-top: -1px; filter: drop-shadow(0 2px 1px rgba(0,0,0,.08)); }
  .pin:focus-visible .callout { outline: 2px solid ${ink.black}; outline-offset: 2px; }
  .chip { display: inline-grid; place-items: center; width: 16px; height: 16px; box-sizing: border-box; flex: none; }
  /* Shapes carry meaning alongside color: solid dot, ringed dot, hollow dashed ring, locked square. */
  .chip-fresh { border-radius: 50%; background: ${status.fresh}; }
  .chip-aging { border-radius: 50%; border: 2.5px solid ${status.aging}; }
  .chip-aging::after { content: ""; width: 5px; height: 5px; border-radius: 50%; background: ${status.aging}; }
  .chip-stale { border-radius: 50%; border: 2px dashed ${status.stale}; }
  .chip-driveway { border-radius: 4px; background: ${status.driveway}; color: ${ink.white}; width: 18px; height: 18px; }
  .pin.is-selected .callout { background: ${ink.black}; color: ${ink.white}; }
  .pin.is-selected .tail { border-top-color: ${ink.black}; }
  /* Night: callouts invert so the selected one is the brightest thing on the map. */
  .night .callout { background: ${ink.grey900}; color: ${ink.white}; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
  .night .tail { border-top-color: ${ink.grey900}; }
  .night .chip-fresh { background: ${status.freshNight}; }
  .night .chip-aging { border-color: ${status.agingNight}; }
  .night .chip-aging::after { background: ${status.agingNight}; }
  .night .chip-stale { border-color: ${status.staleNight}; }
  .night .chip-driveway { background: ${status.drivewayNight}; }
  .night .pin.is-selected .callout { background: ${ink.white}; color: ${ink.black}; }
  .night .pin.is-selected .tail { border-top-color: ${ink.white}; }
`;
/** Builds the full HTML document loaded into the map WebView. */
export function buildMapHtml({ token, mood, reduceMotion }: MapHtmlOptions): string {
  const config = {
    token,
    mood,
    reduceMotion,
    styleUrl: STYLE_URL,
    moods: MOODS,
    basemapStatic: BASEMAP_STATIC_CONFIG,
    homeCamera: HOME_CAMERA,
    introCamera: INTRO_CAMERA,
    introDurationMs: INTRO_DURATION_MS,
    moodTransitionMs: MOOD_TRANSITION_MS,
    supplyLayers: SUPPLY_LAYERS,
    palette: PALETTE,
    zoneLayerId: ZONE_LAYER_ID,
    stallFillId: STALL_FILL_ID,
    routeLayers: ROUTE_LAYERS,
    models: MODELS,
    egoLayer: EGO_LAYER,
    egoModel: EGO_MODEL,
    headingToRotation: HEADING_TO_ROTATION,
    maxPixelRatio: MAX_PIXEL_RATIO,
  };
  // Escape "<" so config strings can never close the script tag.
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  const v = MAPBOX_GL_VERSION;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
<link rel="stylesheet" href="https://api.mapbox.com/mapbox-gl-js/v${v}/mapbox-gl.css" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Overpass:wght@400;600;700;800&display=swap" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: ${MOODS[mood].background};
    font-family: Overpass, -apple-system, system-ui, sans-serif; -webkit-tap-highlight-color: transparent;
    -webkit-user-select: none; user-select: none; transition: background 600ms ease; }
  #map { position: absolute; inset: 0; }
  .mapboxgl-ctrl-bottom-left, .mapboxgl-ctrl-bottom-right { bottom: var(--curb-bottom, 0px); transition: bottom 250ms ease; }
  .mapboxgl-ctrl-attrib.mapboxgl-compact { opacity: 0.6; }
  ${MARKER_CSS}
</style>
<script src="https://api.mapbox.com/mapbox-gl-js/v${v}/mapbox-gl.js"></script>
</head>
<body>
<div id="map"></div>
<script>window.__CURB__ = ${json};</script>
<script>${MAP_RUNTIME_JS}</script>
</body>
</html>`;
}
