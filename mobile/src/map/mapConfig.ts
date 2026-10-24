// Map style + camera config shared by the map renderer. Plain data only.

import type { CameraTarget, LngLat } from "./messages";

export const MAPBOX_GL_VERSION = "3.33.0";
export const STYLE_URL = "mapbox://styles/mapbox/standard";

/** Chestnut St & Fillmore St, Marina District. */
export const MARINA_CENTER: LngLat = [-122.4366, 37.8007];

/** Where the camera settles after load. Bearing roughly follows the street grid (~9 deg). */
export const HOME_CAMERA: Required<Omit<CameraTarget, "durationMs" | "padding">> = {
  center: [-122.4372, 37.8005],
  zoom: 17,
  pitch: 55,
  bearing: -28,
};

/** Starting point of the one-time settle on load: a little wider and flatter. */
export const INTRO_CAMERA: Required<Omit<CameraTarget, "durationMs" | "padding">> = {
  center: [-122.4374, 37.8002],
  zoom: 16.3,
  pitch: 40,
  bearing: -36,
};

export const INTRO_DURATION_MS = 1800;

/** Basemap config applied once; moods change theme, light preset and colors. */
export const BASEMAP_STATIC_CONFIG = {
  showPointOfInterestLabels: false,
  showTransitLabels: false,
  showPlaceLabels: false,
  showRoadLabels: true,
  showLandmarkIcons: false,
  showLandmarkIconLabels: false,
  showPedestrianRoads: false,
  showAdminBoundaries: false,
  show3dObjects: true,
  show3dBuildings: true,
  show3dTrees: false,
  show3dLandmarks: false,
  show3dFacades: false,
} as const;

/** Camera when a spot is selected on the home sheet. */
export const SPOT_CAMERA = { zoom: 17.6, pitch: 58, durationMs: 1300 } as const;


// --- performance budget (the map runs in a WebView on phones) ----------------

/** Cap on canvas pixel density. */
export const MAX_PIXEL_RATIO = 2;

/**
 * Mapbox logo and attribution. Hidden at the team's request for the demo build.
 * Mapbox's terms and the OpenStreetMap license require them, so set this back
 * to true before any public release.
 */
export const SHOW_MAP_ATTRIBUTION = false;
