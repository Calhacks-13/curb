// Mood presets for the Mapbox Standard basemap, tuned after an in-car nav look:
// cool light grey with white roads by day, neutral graphite by night. Plain data: the map renderer
// cross-fades between these, the app only picks which one.

export type MoodSetting = "auto" | "clay" | "glow";
export type Mood = "clay" | "dusk" | "glow";

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
  lightPreset: "day" | "dusk" | "night";
  /**
   * Standard theme. Night/dusk use "monochrome" because the default theme's
   * night lights are blue-tinted (hsl 225); monochrome's are neutral.
   */
  theme: "default" | "monochrome";
  colors: BasemapColors;
  /** Page background behind the map while tiles load. */
  background: string;
  /** 0 = matte curb lines (clay), 1 = emissive strips with halo (glow). */
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
  dusk: {
    lightPreset: "dusk",
    theme: "monochrome",
    background: "#333336",
    glow: 0.6,
    colors: {
      colorLand: "#3A3A3D",
      colorBuildings: "#58585C",
      colorRoads: "#5E5E62",
      colorTrunks: "#68686C",
      colorMotorways: "#68686C",
      colorWater: "#2A2E33",
      colorGreenspace: "#3A3F3A",
      colorRoadLabels: "#B4B4B8",
      colorCommercial: "#3A3A3D",
      colorEducation: "#3A3A3D",
      colorMedical: "#3A3A3D",
      colorIndustrial: "#3A3A3D",
    },
  },
  glow: {
    lightPreset: "night",
    theme: "monochrome",
    background: "#161618",
    glow: 1,
    colors: {
      colorLand: "#1C1C1E",
      colorBuildings: "#3E3E42",
      colorRoads: "#4C4C50",
      colorTrunks: "#57575B",
      colorMotorways: "#57575B",
      colorWater: "#121417",
      colorGreenspace: "#1F2220",
      colorRoadLabels: "#9A9A9E",
      colorCommercial: "#1C1C1E",
      colorEducation: "#1C1C1E",
      colorMedical: "#1C1C1E",
      colorIndustrial: "#1C1C1E",
    },
  },
};

/** Clock hours (local) for each mood when the setting is "auto". */
export function moodForHour(hour: number): Mood {
  if (hour >= 7 && hour < 17) return "clay";
  if ((hour >= 17 && hour < 19.5) || (hour >= 5.5 && hour < 7)) return "dusk";
  return "glow";
}

export function resolveMood(setting: MoodSetting, now = new Date()): Mood {
  if (setting !== "auto") return setting;
  return moodForHour(now.getHours() + now.getMinutes() / 60);
}

export const MOOD_TRANSITION_MS = 1400;
