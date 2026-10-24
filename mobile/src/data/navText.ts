// Strings for the navigation UI, derived from a route and the live target segment.

import { formatClock, formatSeen } from "./prediction";
import type { Route, RouteStep } from "./provider";
import type { CurbSegment } from "./types";

const FT_PER_M = 3.28084;
/** Assumed city driving speed for the ETA. */
const ETA_SPEED_MPS = 7;

export function formatDistance(meters: number): string {
  const ft = meters * FT_PER_M;
  if (ft < 1000) return `${Math.max(50, Math.round(ft / 50) * 50)} ft`;
  return `${(meters / 1609.34).toFixed(1)} mi`;
}

export function nextStep(route: Route, traveledM: number): RouteStep {
  return route.steps.find((s) => s.atM > traveledM + 3) ?? route.steps[route.steps.length - 1];
}

export function instructionFor(step: RouteStep): string {
  if (step.maneuver === "arrive") return `Your spot is ahead on ${step.street}`;
  if (step.maneuver === "straight") return `Continue on ${step.street}`;
  return `Turn ${step.maneuver} onto ${step.street}`;
}

export function eta(route: Route, traveledM: number, now: Date) {
  const remaining = Math.max(0, route.lengthM - traveledM);
  const minutes = Math.max(1, Math.ceil(remaining / ETA_SPEED_MPS / 60));
  return {
    minutes,
    distanceLabel: formatDistance(remaining),
    arrivalTime: formatClock(new Date(now.getTime() + minutes * 60_000)),
  };
}

export function spotStatusText(segment: CurbSegment | undefined): string {
  if (!segment) return "Checking your spot.";
  switch (segment.status) {
    case "open":
      return `Your spot is still open, ${formatSeen(segment.lastSeenSeconds)}.`;
    case "likely":
      return "Your spot is likely open based on recent turnover.";
    case "driveway":
      return `Your driveway is held for you, ${segment.rule?.toLowerCase() ?? "tonight"}.`;
    default:
      return "Your spot was just taken.";
  }
}
