import type { ParkingSpace } from "@/api/types";

export const OPEN_CONFIDENCE_LIFETIME_SECONDS = 300;

/**
 * Returns the age-adjusted fraction that a curb space is still open at `now`,
 * decaying the server base confidence linearly to zero over five minutes.
 * Returns `null` when the timestamp is missing, invalid, or older than five minutes.
 */
export function currentOpenConfidence(space: ParkingSpace, now: number): number | null {
  if (!space.last_observed_at || !Number.isFinite(now) || !Number.isFinite(space.base_confidence)) {
    return null;
  }
  const observedAt = Date.parse(space.last_observed_at);
  if (!Number.isFinite(observedAt)) return null;

  const ageSeconds = Math.max(0, (now - observedAt) / 1000);
  if (ageSeconds > OPEN_CONFIDENCE_LIFETIME_SECONDS) return null;

  const ageMultiplier = Math.max(
    0,
    1 - ageSeconds / OPEN_CONFIDENCE_LIFETIME_SECONDS,
  );
  return Math.max(0, Math.min(1, space.base_confidence * ageMultiplier));
}

/**
 * Returns the whole-number percentage shown on every curb surface, or `null`
 * when the space should not be shown.
 */
export function displayOpenPercent(space: ParkingSpace, now: number): number | null {
  const confidence = currentOpenConfidence(space, now);
  return confidence === null ? null : Math.round(confidence * 100);
}
