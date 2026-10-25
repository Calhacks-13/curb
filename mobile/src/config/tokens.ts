// Design tokens. UI chrome is black and white; color is reserved for parking status.

export const ink = {
  black: "#0B0B0C",
  white: "#FFFFFF",
  grey900: "#1C1C1E",
  grey700: "#3A3A3C",
  grey500: "#6E6E73",
  grey300: "#C7C7CC",
  grey100: "#F2F2F4",
  live: "#E5372B",
} as const;

/**
 * Parking semantics from the MVP spec (section 7.3). Color is always paired with
 * a label and a distinct shape; never rely on color alone.
 */
export const status = {
  /** Seen open within 90 s: "Likely open". */
  fresh: "#1F8F4E",
  freshNight: "#3BE08A",
  /** 90 s to 3 min: "May still be open". */
  aging: "#C99400",
  agingNight: "#F2C230",
  /** 3 to 5 min: "Stale observation". */
  stale: "#8E8E93",
  staleNight: "#7C7C82",
  /** Private driveway, guaranteed after payment. */
  driveway: "#7A3FE0",
  drivewayNight: "#A07BFF",
} as const;

export const radius = {
  button: 12,
  control: 10,
  sheet: 18,
  pill: 999,
} as const;

export const font = {
  regular: "Overpass_400Regular",
  semibold: "Overpass_600SemiBold",
  bold: "Overpass_700Bold",
  extrabold: "Overpass_800ExtraBold",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const shadow = {
  floating: {
    shadowColor: "#000",
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
} as const;

/**
 * Separator for inline metadata ("Seen 20 sec ago • 2 min walk"). Overpass draws
 * its middle dot off-center, so we use a bullet, which sits evenly.
 */
export const SEP = " • ";
