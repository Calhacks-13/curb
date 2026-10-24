// Marina street grid: intersections fitted to OpenStreetMap centerlines (the
// grid here is rotated ~9 degrees from north). Used by the demo replay fixture.

import type { LngLat } from "../geo";

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

/** Demo replay driver: northbound on Fillmore, just south of Lombard. */
export const DEMO_DRIVER = {
  position: [-122.43597, 37.79932] as LngLat,
  heading: 351,
};
