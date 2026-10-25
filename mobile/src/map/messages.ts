// Typed bridge between the React Native app and the map renderer (currently a
// Mapbox GL JS WebView). A native @rnmapbox/maps renderer would implement the
// same messages, so UI components never depend on the WebView.

import type { StallKind } from "./curbLayers";
import type { Mood } from "./moods";

export type LngLat = [lng: number, lat: number];

export type CameraPadding = { top: number; bottom: number; left: number; right: number };

export type CameraTarget = {
  center: LngLat;
  zoom?: number;
  pitch?: number;
  bearing?: number;
  padding?: Partial<CameraPadding>;
  durationMs?: number;
};

/** A legal-now curb zone (blue line), already on the curb face. */
export type MapZone = { id: string; coordinates: LngLat[] };

/** A bay to fill: an opening (by freshness) or a driveway. `id` is the space or driveway id. */
export type MapStall = { id: string; kind: StallKind; ring: LngLat[] };

/** A callout. Curb labels carry the shared age-adjusted "N% open" value. */
export type MapPill = { id: string; kind: StallKind; label: string; position: LngLat; mine?: boolean; muted?: boolean };

export type AppToMap =
  | { type: "setMood"; mood: Mood; animate: boolean }
  | { type: "setReduceMotion"; reduceMotion: boolean }
  | { type: "setZones"; zones: MapZone[] }
  | { type: "setStalls"; stalls: MapStall[] }
  | { type: "setPills"; pills: MapPill[] }
  | { type: "selectSpot"; id: string | null }
  | { type: "flyTo"; camera: CameraTarget }
  /** Pixel insets covered by native chrome, so the map centers in the visible area. */
  | { type: "setPadding"; padding: CameraPadding }
  /** Draws one route line to a target bay and frames it; null clears it. */
  | { type: "setRoute"; route: LngLat[] | null; targetId: string | null; fit?: boolean }
  | { type: "setCarPosition"; position: LngLat; heading: number };

export type MapToApp =
  | { type: "mapReady" }
  | { type: "spotTapped"; id: string }
  | { type: "cameraChanged"; center: LngLat; zoom: number; pitch: number; bearing: number }
  | { type: "mapError"; message: string };

export interface MapController {
  send(message: AppToMap): void;
}
