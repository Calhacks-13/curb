// The HTTP API uses canonical contracts; the replay/UI retain their compact
// view models. Keep translation at this boundary rather than in map components.
import type { DrivewayView, NearbyParkingResponse as WireNearby, SpaceDetail as WireDetail } from "@curb/contracts/domain";

import { laParts } from "@/lib/laTime";
import type { Driveway, NearbyParkingResponse, ParkingSpace, SpaceDetail } from "./types";

function laHhmm(iso: string): string {
  const { hour, minute } = laParts(new Date(iso));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeDriveway(wire: DrivewayView | Driveway): Driveway {
  // Legacy/replay-shaped responses already have LA wall-clock display values.
  if (!wire.availability_start.includes("T")) return wire;
  return {
    ...wire,
    availability_start: laHhmm(wire.availability_start),
    availability_end: laHhmm(wire.availability_end),
    availability_window: { start: wire.availability_start, end: wire.availability_end },
  };
}

export function normalizeParkingSpace(
  wire: ParkingSpace | WireNearby["spaces"][number],
): ParkingSpace {
  return {
    ...wire,
    detection_confidence: wire.detection_confidence ?? 0,
  } as ParkingSpace;
}

export function normalizeNearby(wire: WireNearby | NearbyParkingResponse): NearbyParkingResponse {
  // Zone/space identity, coordinates, observation times and versions already
  // match. The server's additional ranking/freshness fields can pass through.
  return {
    ...wire,
    spaces: wire.spaces.map(normalizeParkingSpace),
    driveways: wire.driveways.map(normalizeDriveway),
  };
}

export function normalizeSpaceDetail(wire: WireDetail | SpaceDetail): SpaceDetail {
  if ("space" in wire) return { ...wire, space: normalizeParkingSpace(wire.space) };
  const { sign_rule: rule, current_rules, max_minutes, next_change_at, ...space } = wire;
  if (!rule) return { space: normalizeParkingSpace(space), rule: null };
  return {
    space: normalizeParkingSpace(space),
    rule: {
      id: rule.id,
      summary: current_rules,
      max_minutes,
      next_change_at,
      // The canonical API gives the change time, not a description of that change.
      next_change_summary: null,
      payment_text: rule.payment_rules.required ? rule.payment_rules.price_text ?? "Payment required" : null,
      permit_text: rule.permit_rules.required ? `Permit required${rule.permit_rules.permitted_labels.length ? `: ${rule.permit_rules.permitted_labels.join(", ")}` : ""}` : null,
      interpretation_confidence: rule.interpretation_confidence,
      last_validated_at: rule.last_validated_at,
    },
  };
}
