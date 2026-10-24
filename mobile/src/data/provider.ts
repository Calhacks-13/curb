// The seam between UI and data. Teammates replace the mock implementations
// returned by getCurbProvider / getRoutingProvider; nothing else changes.

import type { LngLat } from "./geo";
import { createMockProvider } from "./mock/mockProvider";
import { routeToSegment, type Route } from "./mock/mockRouting";
import { CAR_START } from "./mock/marina";
import type { CurbSegment } from "./types";

export type Bounds = [west: number, south: number, east: number, north: number];

export interface CurbDataProvider {
  /** One-shot fetch of segments in the bounds. */
  getSegments(bounds: Bounds): Promise<CurbSegment[]>;
  /**
   * Live updates (CV sightings, price changes). `onChange` gets the full current
   * list for the bounds every time anything changes. Returns unsubscribe.
   */
  subscribe(bounds: Bounds, onChange: (segments: CurbSegment[]) => void): () => void;
}

export interface RoutingProvider {
  routeTo(from: LngLat, heading: number, target: CurbSegment): Promise<Route>;
}

/** Marina bounds used by the home screen. */
export const MARINA_BOUNDS: Bounds = [-122.4445, 37.7975, -122.433, 37.8035];

let curbProvider: CurbDataProvider | null = null;

export function getCurbProvider(): CurbDataProvider {
  curbProvider ??= createMockProvider();
  return curbProvider;
}

export function getRoutingProvider(): RoutingProvider {
  return {
    async routeTo(from, _heading, target) {
      return routeToSegment(from, CAR_START.nextNode, target);
    },
  };
}

export type { Route, RouteStep, Maneuver } from "./mock/mockRouting";
