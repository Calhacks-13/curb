// Basemap preset for Mapbox Standard: cool light grey with white roads, flat
// landuse, muted water and parks. Plain data; the renderer applies it at load.

/** Only the light day style ships; the renderer keeps the mood plumbing for a future night style. */
export type Mood = "clay";

export type BasemapColors = {
  colorLand: string;
  colorBuildings: string;
  colorRoads: string;
  colorTrunks: string;
  colorMotorways: string;
  colorWater: string;
  colorGreenspace: string;
  colorRoadLabels: string;
  // Landuse tints are flattened to the land color so only parking data carries color.
  colorCommercial: string;
  colorEducation: string;
  colorMedical: string;
  colorIndustrial: string;
};

export type MoodPreset = {
  lightPreset: "day";
  theme: "default" | "monochrome";
  colors: BasemapColors;
  /** Page background behind the map while tiles load. */
  background: string;
  /** Night mix for map overlays; 0 for the day style. */
  glow: number;
};

export const MOODS: Record<Mood, MoodPreset> = {
  clay: {
    lightPreset: "day",
    theme: "default",
    background: "#E6E7E9",
    glow: 0,
    colors: {
      colorLand: "#E6E7E9",
      colorBuildings: "#EEEFF1",
      colorRoads: "#FFFFFF",
      colorTrunks: "#FFFFFF",
      colorMotorways: "#FFFFFF",
      colorWater: "#B5CDE0",
      colorGreenspace: "#D3E2CC",
      colorRoadLabels: "#6B6E73",
      colorCommercial: "#E6E7E9",
      colorEducation: "#E6E7E9",
      colorMedical: "#E6E7E9",
      colorIndustrial: "#E6E7E9",
    },
  },
};

export const MOOD_TRANSITION_MS = 1400;
