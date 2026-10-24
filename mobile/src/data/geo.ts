// Small flat-earth helpers. Good to well under a meter at neighborhood scale.

export type LngLat = [lng: number, lat: number];

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

export function distanceM(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * mPerDegLng((a[1] + b[1]) / 2);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** Compass bearing in degrees, 0 = north, clockwise. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * mPerDegLng((a[1] + b[1]) / 2);
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

export function lerp(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Moves a point `meters` toward compass `bearing`. */
export function offsetPoint(p: LngLat, bearing: number, meters: number): LngLat {
  const r = (bearing * Math.PI) / 180;
  return [p[0] + (Math.sin(r) * meters) / mPerDegLng(p[1]), p[1] + (Math.cos(r) * meters) / M_PER_DEG_LAT];
}

export function lineLengthM(line: LngLat[]): number {
  let d = 0;
  for (let i = 1; i < line.length; i++) d += distanceM(line[i - 1], line[i]);
  return d;
}

/** Point and heading at `meters` along a polyline (clamped to its ends). */
export function pointAtDistance(line: LngLat[], meters: number): { point: LngLat; heading: number } {
  let left = Math.max(0, meters);
  for (let i = 1; i < line.length; i++) {
    const seg = distanceM(line[i - 1], line[i]);
    if (left <= seg || i === line.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, left / seg);
      return { point: lerp(line[i - 1], line[i], t), heading: bearingDeg(line[i - 1], line[i]) };
    }
    left -= seg;
  }
  return { point: line[line.length - 1], heading: 0 };
}

/**
 * A point on the curb: `fraction` along the segment, pushed `offsetM` to its side.
 * Mirrors the map's line-offset so markers sit on the drawn curb line.
 */
export function curbPoint(coords: LngLat[], side: "left" | "right", fraction: number, offsetM: number): LngLat {
  const { point, heading } = pointAtDistance(coords, lineLengthM(coords) * fraction);
  return offsetPoint(point, heading + (side === "right" ? 90 : -90), offsetM);
}
