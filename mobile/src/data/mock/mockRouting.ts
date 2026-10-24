// Mock routing over the Marina street grid. Stand-in for a real directions
// service: returns a polyline plus turn-by-turn steps.

import { bearingDeg, distanceM, lineLengthM, type LngLat } from "../geo";
import type { CurbSegment } from "../types";
import { INTERSECTIONS, type Node } from "./marina";

export type Maneuver = "left" | "right" | "straight" | "arrive";

export type RouteStep = {
  /** Meters from the route start where this maneuver happens. */
  atM: number;
  maneuver: Maneuver;
  street: string;
};

export type Route = {
  line: LngLat[];
  lengthM: number;
  steps: RouteStep[];
};

const nodes = Object.keys(INTERSECTIONS) as Node[];
const ew = (n: Node) => n.split("|")[0];
const ns = (n: Node) => n.split("|")[1];

/** Neighbors are the nearest intersections in each direction along both streets. */
function neighbors(n: Node): Node[] {
  const here = INTERSECTIONS[n];
  const best: Record<string, { m: Node; d: number }> = {};
  for (const m of nodes) {
    if (m === n) continue;
    const sameEW = ew(m) === ew(n);
    if (!sameEW && ns(m) !== ns(n)) continue;
    const b = bearingDeg(here, INTERSECTIONS[m]);
    const dir = sameEW ? (b < 180 ? "e" : "w") : b < 90 || b > 270 ? "n" : "s";
    const d = distanceM(here, INTERSECTIONS[m]);
    if (!best[dir] || d < best[dir].d) best[dir] = { m, d };
  }
  return Object.values(best).map((v) => v.m);
}

function shortestPath(from: Node, to: Node): Node[] {
  const dist = new Map<Node, number>([[from, 0]]);
  const prev = new Map<Node, Node>();
  const open = new Set<Node>([from]);
  while (open.size) {
    let cur: Node | null = null;
    for (const n of open) if (cur === null || dist.get(n)! < dist.get(cur)!) cur = n;
    open.delete(cur!);
    if (cur === to) break;
    for (const nb of neighbors(cur!)) {
      const d = dist.get(cur!)! + distanceM(INTERSECTIONS[cur!], INTERSECTIONS[nb]);
      if (d < (dist.get(nb) ?? Infinity)) {
        dist.set(nb, d);
        prev.set(nb, cur!);
        open.add(nb);
      }
    }
  }
  const path: Node[] = [to];
  while (path[0] !== from) {
    const p = prev.get(path[0]);
    if (!p) return [from, to];
    path.unshift(p);
  }
  return path;
}

function streetBetween(a: Node, b: Node): string {
  return `${ew(a) === ew(b) ? ew(a) : ns(a)} St`;
}

function turn(fromHeading: number, toHeading: number): Maneuver {
  const d = ((toHeading - fromHeading + 540) % 360) - 180;
  if (d > 35) return "right";
  if (d < -35) return "left";
  return "straight";
}

/** Route from the car to the middle of a curb segment. */
export function routeToSegment(start: LngLat, startNext: Node, segment: CurbSegment): Route {
  const mid = segment.coordinates[Math.floor(segment.coordinates.length / 2)];
  // Enter the target block from whichever of its two end intersections is shorter.
  const ends = blockEnds(mid);
  let bestPath: Node[] = [];
  let bestLen = Infinity;
  for (const end of ends) {
    const path = shortestPath(startNext, end);
    const line = [start, ...path.map((n) => INTERSECTIONS[n] as LngLat), mid];
    const len = lineLengthM(line);
    if (len < bestLen) {
      bestLen = len;
      bestPath = path;
    }
  }

  const line: LngLat[] = [start, ...bestPath.map((n) => INTERSECTIONS[n] as LngLat), mid];
  const steps: RouteStep[] = [];
  let at = distanceM(start, line[1]);
  for (let i = 1; i < line.length - 1; i++) {
    const inH = bearingDeg(line[i - 1], line[i]);
    const outH = bearingDeg(line[i], line[i + 1]);
    const m = turn(inH, outH);
    // line[i] is bestPath[i - 1]; the edge leaving it is either the next path edge or the target block.
    const street = i < bestPath.length ? streetBetween(bestPath[i - 1], bestPath[i]) : targetStreet(segment);
    if (m !== "straight") steps.push({ atM: at, maneuver: m, street });
    at += distanceM(line[i], line[i + 1]);
  }
  steps.push({ atM: lineLengthM(line), maneuver: "arrive", street: targetStreet(segment) });
  return { line, lengthM: lineLengthM(line), steps };
}

/** Distance in meters from p to the segment a-b (flat approximation). */
function distToEdge(p: LngLat, a: LngLat, b: LngLat): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const [px, py] = [(p[0] - a[0]) * k, p[1] - a[1]];
  const [bx, by] = [(b[0] - a[0]) * k, b[1] - a[1]];
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by)));
  return Math.hypot(px - bx * t, py - by * t) * 111_320;
}

/** The two intersections bounding the block a point lies on. */
function blockEnds(p: LngLat): Node[] {
  let best: [Node, Node] = [nodes[0], nodes[1]];
  let bestD = Infinity;
  for (const a of nodes) {
    for (const b of neighbors(a)) {
      const d = distToEdge(p, INTERSECTIONS[a], INTERSECTIONS[b]);
      if (d < bestD) {
        bestD = d;
        best = [a, b];
      }
    }
  }
  return best;
}

function targetStreet(segment: CurbSegment): string {
  const name = segment.id.split("-")[0];
  return `${name[0].toUpperCase()}${name.slice(1)} St`;
}
