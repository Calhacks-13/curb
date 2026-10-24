// Deterministic demo-replay fixture: a small calibrated area around Steiner and
// Chestnut in the Marina, shaped exactly like the backend's nearby response.
// Geometry comes from OpenStreetMap-fitted intersections, so it sits on real
// curbs. Everything built from this file must be labeled "Demo replay".

import { DEMO_IDS, type CurbZone, type Driveway, type LngLat, type ParkingSpace, type SignRuleView } from "@/api/types";
import { bearingDeg, distanceM, lerp, offsetPoint } from "@/data/geo";
import { INTERSECTIONS, type Node } from "@/data/mock/marina";
import { nextLaTime } from "@/lib/laTime";

/** Meters from the street centerline to the curb face. */
const CURB_M = 5.2;
const CORNER_TRIM_M = 11;
const STALL_DEPTH_M = 2.3;
const STALL_LENGTH_M = 5.6;
const SLOT_M = 6.2;

type ZoneSpec = {
  id: string;
  a: Node;
  b: Node;
  /** Which curb, relative to a -> b. */
  side: "left" | "right";
  /** Extra meters to the curb on wide streets. */
  widen?: number;
  rule: string;
  legal: boolean;
};

const ZONES: ZoneSpec[] = [
  { id: "zone_demo_1", a: "Lombard|Steiner", b: "Chestnut|Steiner", side: "right", rule: "rule_res_2hr", legal: true },
  { id: "zone_demo_2", a: "Chestnut|Pierce", b: "Chestnut|Steiner", side: "right", rule: "rule_meter", legal: true },
  { id: "zone_demo_3", a: "Chestnut|Steiner", b: "Chestnut|Fillmore", side: "left", rule: "rule_meter", legal: true },
  { id: "zone_demo_4", a: "Chestnut|Fillmore", b: "Francisco|Fillmore", side: "left", widen: 3, rule: "rule_res_2hr", legal: true },
  { id: "zone_demo_5", a: "Chestnut|Steiner", b: "Francisco|Steiner", side: "right", rule: "rule_permit", legal: true },
  { id: "zone_demo_6", a: "Lombard|Steiner", b: "Lombard|Fillmore", side: "right", widen: 6, rule: "rule_tow", legal: false },
];

/** Openings at fixture time: [zone id, stall index, seconds since observed]. */
const OPENINGS: [string, number, number][] = [
  ["zone_demo_1", 3, 20],
  ["zone_demo_2", 2, 120],
  ["zone_demo_3", 4, 220],
  ["zone_demo_4", 1, 45],
];

/** Stalls the replay script changes: one opens later, one aging opening gets taken. */
export const REPLAY_TARGETS = { newOpening: ["zone_demo_1", 5], occupiedLater: ["zone_demo_2", 2] } as const;

function curbLine(z: ZoneSpec): LngLat[] {
  const a = INTERSECTIONS[z.a] as LngLat;
  const b = INTERSECTIONS[z.b] as LngLat;
  const len = distanceM(a, b);
  const t = CORNER_TRIM_M / len;
  const h = bearingDeg(a, b);
  const off = (z.side === "right" ? 90 : -90) + h;
  const m = CURB_M + (z.widen ?? 0);
  return [lerp(a, b, t), lerp(a, b, 1 - t)].map((p) => offsetPoint(p, off, m));
}

function stallsFor(z: ZoneSpec, line: LngLat[]) {
  const [a, b] = line;
  const len = distanceM(a, b);
  const h = bearingDeg(a, b);
  // Bays extend from the curb toward the street center.
  const inward = h + (z.side === "right" ? -90 : 90);
  const slots = Math.floor(len / SLOT_M);
  const start = (len - slots * SLOT_M) / 2;
  return [...Array(slots).keys()].map((i) => {
    const s0 = start + i * SLOT_M + (SLOT_M - STALL_LENGTH_M) / 2;
    const p0 = lerp(a, b, s0 / len);
    const p1 = lerp(a, b, (s0 + STALL_LENGTH_M) / len);
    const ring = [p0, p1, offsetPoint(p1, inward, STALL_DEPTH_M), offsetPoint(p0, inward, STALL_DEPTH_M), p0];
    const center = offsetPoint(lerp(p0, p1, 0.5), inward, STALL_DEPTH_M / 2);
    return { ring, center };
  });
}

export function buildDemoFixture(now: Date) {
  const zones: CurbZone[] = [];
  const spaces: ParkingSpace[] = [];
  let n = 0;
  for (const z of ZONES) {
    const line = curbLine(z);
    zones.push({
      id: z.id,
      geometry: { type: "LineString", coordinates: line },
      sign_rule_id: z.rule,
      legal_status_now: z.legal ? "LEGAL" : "ILLEGAL",
      next_change_at: null,
      version: 1,
    });
    stallsFor(z, line).forEach((stall, i) => {
      n++;
      const opening = OPENINGS.find(([zid, idx]) => zid === z.id && idx === i);
      spaces.push({
        id: `space_demo_${n}`,
        zone_id: z.id,
        location: { type: "Point", coordinates: stall.center },
        stall_geometry: { type: "Polygon", coordinates: [stall.ring] },
        internal_state: opening ? "OPEN" : "OCCUPIED",
        last_observed_at: opening ? new Date(now.getTime() - opening[2] * 1000).toISOString() : null,
        base_confidence: opening ? 0.86 : 0,
        version: 1,
      });
    });
  }

  // Private driveway on Fillmore, just north of Chestnut.
  const fA = INTERSECTIONS["Chestnut|Fillmore"] as LngLat;
  const fB = INTERSECTIONS["Francisco|Fillmore"] as LngLat;
  const drivewayPos = offsetPoint(lerp(fA, fB, 0.68), bearingDeg(fA, fB) - 90, CURB_M + 4.5);
  const token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? "";
  const driveway: Driveway = {
    id: DEMO_IDS.driveway,
    owner_id: DEMO_IDS.owner,
    location: { type: "Point", coordinates: drivewayPos },
    photo_url: token
      ? `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${drivewayPos[0]},${drivewayPos[1]},19.4,0/640x360@2x?access_token=${token}`
      : null,
    price_usdc: "8.00",
    // Overnight window so the demo works for late testing and an early judging slot.
    availability_start: "07:00",
    availability_end: "03:00",
    availability_timezone: "America/Los_Angeles",
    state: "AVAILABLE",
    held_by_user_id: null,
    version: 1,
  };

  return { zones, spaces, driveways: [driveway], rules: buildRules(now) };
}

/** Space ids for a zone's stall index (stable across builds). */
export function spaceIdFor(spaces: ParkingSpace[], zoneId: string, index: number): string | undefined {
  return spaces.filter((s) => s.zone_id === zoneId)[index]?.id;
}

function buildRules(now: Date): Record<string, SignRuleView> {
  const validated = new Date(now.getTime() - 3 * 3600_000).toISOString();
  const at = (h: number) => nextLaTime(h, 0, now).toISOString();
  return {
    rule_res_2hr: {
      id: "rule_res_2hr",
      summary: "2-hour parking until 6 PM. No limit after 6 PM and on Sundays.",
      max_minutes: 120,
      next_change_at: at(18),
      next_change_summary: "No time limit",
      payment_text: null,
      permit_text: "Area A permit holders exempt",
      interpretation_confidence: 0.94,
      last_validated_at: validated,
    },
    rule_meter: {
      id: "rule_meter",
      summary: "Metered 2-hour parking until 6 PM. Free after 6 PM.",
      max_minutes: 120,
      next_change_at: at(18),
      next_change_summary: "Meter off, free parking",
      payment_text: "$3.50/hr, pay at meter or by app",
      permit_text: null,
      interpretation_confidence: 0.91,
      last_validated_at: validated,
    },
    rule_permit: {
      id: "rule_permit",
      summary: "2-hour parking until 9 PM except with an Area C permit.",
      max_minutes: 120,
      next_change_at: at(21),
      next_change_summary: "No time limit",
      payment_text: null,
      permit_text: "Area C permit holders exempt",
      interpretation_confidence: 0.88,
      last_validated_at: validated,
    },
    rule_tow: {
      id: "rule_tow",
      summary: "No parking 4 PM to 7 PM, Monday to Friday. Tow-away zone.",
      max_minutes: null,
      next_change_at: at(19),
      next_change_summary: "Parking allowed",
      payment_text: null,
      permit_text: null,
      interpretation_confidence: 0.96,
      last_validated_at: validated,
    },
  };
}
