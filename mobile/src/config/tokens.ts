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

export const status = {
  open: "#1F8F4E",
  openNight: "#3BE08A",
  noParking: "#D93025",
  noParkingNight: "#FF5A4F",
  driveway: "#2F6BDE",
  drivewayNight: "#5B8DFF",
  loading: "#FFFFFF",
  loadingOutline: "#8E8E93",
  full: "#A3A19C",
  fullNight: "#55575E",
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
