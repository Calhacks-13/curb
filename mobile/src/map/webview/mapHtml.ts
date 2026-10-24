import { ink, status } from "../../config/tokens";
import { CURB_PAINT_LAYERS, ROUTE_LAYERS, STALL_LAYERS } from "../curbLayers";
import {
  BASEMAP_STATIC_CONFIG,
  HOME_CAMERA,
  INTRO_CAMERA,
  INTRO_DURATION_MS,
  MAPBOX_GL_VERSION,
  MAX_PIXEL_RATIO,
  NAV_CAMERA,
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

// Map callouts and the destination pin: flat, white, black type, one small status
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
  .chip { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; box-sizing: border-box;
    font: 800 12px/1 Overpass, -apple-system, sans-serif; color: ${ink.white}; padding-top: 2px; }
  .chip-free { background: ${status.open}; }
  .chip-metered { background: ${ink.white}; border: 2px dashed ${status.open}; border-radius: 50%; width: 14px; height: 14px; margin: 0 2px; padding: 0; }
  .chip-driveway { background: ${status.driveway}; padding: 0; }
  .pin.is-selected .callout { background: ${ink.black}; color: ${ink.white}; }
  .pin.is-selected .tail { border-top-color: ${ink.black}; }
  .pin.is-selected .chip-metered { background: ${ink.black}; }
  /* Night: callouts invert so the selected one is the brightest thing on the map. */
  .night .callout { background: ${ink.grey900}; color: ${ink.white}; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
  .night .tail { border-top-color: ${ink.grey900}; }
  .night .chip-metered { background: ${ink.grey900}; }
  .night .pin.is-selected .callout { background: ${ink.white}; color: ${ink.black}; }
  .night .pin.is-selected .tail { border-top-color: ${ink.white}; }
  .night .pin.is-selected .chip-metered { background: ${ink.white}; }

  .dest { display: flex; flex-direction: column; align-items: center; pointer-events: none; }
  .dest-label { font: 700 13px/1 Overpass, -apple-system, sans-serif; color: ${ink.white}; background: ${ink.black};
    padding: 7px 9px 5px; border-radius: 6px; margin-bottom: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
  .dest-pin { width: 16px; height: 16px; background: ${ink.black}; display: grid; place-items: center;
    box-shadow: 0 1px 4px rgba(0,0,0,.3); }
  .dest-dot { width: 6px; height: 6px; background: ${ink.white}; }
  .night .dest-label, .night .dest-pin { background: ${ink.white}; color: ${ink.black}; }
  .night .dest-dot { background: ${ink.black}; }
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
    navCamera: NAV_CAMERA,
    curbLayers: CURB_PAINT_LAYERS.concat(STALL_LAYERS),
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
