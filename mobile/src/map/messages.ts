// Typed bridge between the React Native app and the map renderer (currently a
// Mapbox GL JS WebView). A native @rnmapbox/maps renderer would implement the
// same messages, so UI components never depend on the WebView.

import type { CurbSegment } from "../data/types";
import type { Stall } from "./curbScene";
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

export type PillKind = "free" | "metered" | "driveway";

export type MapPill = {
  segmentId: string;
  kind: PillKind;
  label: string; // "P Free", "$3.50/hr", "$8"
  position: LngLat;
};

export type AppToMap =
  | { type: "setMood"; mood: Mood; animate: boolean }
  | { type: "setReduceMotion"; reduceMotion: boolean }
  | { type: "setSegments"; segments: CurbSegment[] }
  | { type: "setPills"; pills: MapPill[] }
  | { type: "setDestination"; position: LngLat; label: string }
  /** Bays for open / likely / driveway spots, derived from segments (see map/curbScene.ts). */
  | { type: "setStalls"; stalls: Stall[] }
  | { type: "selectSpot"; segmentId: string | null }
  | { type: "flyTo"; camera: CameraTarget }
  /** Pixel insets covered by native chrome, so the map centers in the visible area. */
  | { type: "setPadding"; padding: CameraPadding }
  | { type: "startNav"; route: LngLat[]; targetSegmentId: string }
  | { type: "stopNav" }
  | { type: "setCarPosition"; position: LngLat; heading: number; follow: boolean };

export type MapToApp =
  | { type: "mapReady" }
  | { type: "spotTapped"; segmentId: string }
  | { type: "cameraChanged"; center: LngLat; zoom: number; pitch: number; bearing: number }
  | { type: "mapError"; message: string };

export interface MapController {
  send(message: AppToMap): void;
}
