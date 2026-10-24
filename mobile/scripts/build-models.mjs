// Generates the low-poly glTF model of the user's car and writes it as base64 data URIs to
// src/map/models/generated.ts, so the WebView needs no asset loading.
//
//   node scripts/build-models.mjs
//
// Units are meters. glTF is Y-up; cars point along +X.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../src/map/models/generated.ts");

// --- geometry ---------------------------------------------------------------

/** A primitive is { positions: number[], normals: number[], indices: number[], material }. */
function prim(material) {
  return { positions: [], normals: [], indices: [], material };
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

/** Flat-shaded convex polygon (verts in any winding); faces toward `outward`. */
function face(p, verts, outward) {
  const n = norm(outward);
  const base = p.positions.length / 3;
  for (const v of verts) { p.positions.push(...v); p.normals.push(...n); }
  for (let i = 1; i < verts.length - 1; i++) {
    const a = verts[0], b = verts[i], c = verts[i + 1];
    const ok = dot(cross(sub(b, a), sub(c, a)), n) >= 0;
    p.indices.push(base, base + (ok ? i : i + 1), base + (ok ? i + 1 : i));
  }
}

/** Extrudes a convex side profile [[x, y], ...] (x forward, y up) across z0..z1. */
function extrude(p, profile, z0, z1) {
  const cx = profile.reduce((s, q) => s + q[0], 0) / profile.length;
  const cy = profile.reduce((s, q) => s + q[1], 0) / profile.length;
  face(p, profile.map(([x, y]) => [x, y, z1]), [0, 0, 1]);
  face(p, profile.map(([x, y]) => [x, y, z0]), [0, 0, -1]);
  for (let i = 0; i < profile.length; i++) {
    const [ax, ay] = profile[i];
    const [bx, by] = profile[(i + 1) % profile.length];
    const mid = [(ax + bx) / 2 - cx, (ay + by) / 2 - cy];
    let n = [by - ay, -(bx - ax)];
    if (n[0] * mid[0] + n[1] * mid[1] < 0) n = [-n[0], -n[1]];
    face(p, [[ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z1]], [n[0], n[1], 0]);
  }
}

function box(p, [x0, y0, z0], [x1, y1, z1]) {
  extrude(p, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z1);
}

/** Cylinder along Z (wheels). */
function cylinderZ(p, cx, cy, r, z0, z1, seg = 18) {
  const ring = [...Array(seg)].map((_, i) => {
    const t = (i / seg) * Math.PI * 2;
    return [cx + Math.cos(t) * r, cy + Math.sin(t) * r];
  });
  extrude(p, ring, z0, z1);
}

// --- glTF writer --------------------------------------------------------------

function glb(primitives, materials) {
  const chunks = [];
  const accessors = [];
  const bufferViews = [];
  let offset = 0;
  const push = (typed, target) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes, Buffer.alloc(pad));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    offset += bytes.length + pad;
    return bufferViews.length - 1;
  };
  const meshPrims = primitives.map((p) => {
    const pos = new Float32Array(p.positions);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
    accessors.push({ bufferView: push(pos, 34962), componentType: 5126, count: pos.length / 3, type: "VEC3", min, max });
    const posA = accessors.length - 1;
    accessors.push({ bufferView: push(new Float32Array(p.normals), 34962), componentType: 5126, count: pos.length / 3, type: "VEC3" });
    const nA = accessors.length - 1;
    accessors.push({ bufferView: push(new Uint16Array(p.indices), 34963), componentType: 5123, count: p.indices.length, type: "SCALAR" });
    return { attributes: { POSITION: posA, NORMAL: nA }, indices: accessors.length - 1, material: p.material };
  });
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: "2.0", generator: "curb build-models" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: meshPrims }],
    materials,
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

const mat = (name, rgb, { rough = 0.7, metal = 0, emissive = [0, 0, 0] } = {}) => ({
  name,
  pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: metal, roughnessFactor: rough },
  emissiveFactor: emissive,
});

// --- models -------------------------------------------------------------------

// Sedan side profiles (x forward, y up), meters. Length 4.7, width 1.86.
const BODY = [
  [-2.34, 0.3], [2.3, 0.3], [2.38, 0.5], [2.3, 0.72], [1.95, 0.84], [1.15, 0.94],
  [-1.3, 0.97], [-2.15, 0.93], [-2.36, 0.74],
];
const GREENHOUSE = [[-1.38, 0.95], [1.12, 0.93], [0.42, 1.43], [-0.62, 1.45]];
const HALF_W = 0.93;

function sedan({ body, lights }) {
  // Materials: 0 body, 1 glass, 2 tires, 3 front light, 4 rear light
  const materials = [
    body,
    mat("glass", [0.07, 0.075, 0.085], { rough: 0.15, metal: 0.4 }),
    mat("tire", [0.05, 0.05, 0.055], { rough: 0.95 }),
    mat("headlight", [0.95, 0.95, 0.95], { rough: 0.3, emissive: lights ? [1, 1, 1] : [0, 0, 0] }),
    mat("taillight", [0.55, 0.05, 0.05], { rough: 0.3, emissive: lights ? [1, 0.08, 0.06] : [0, 0, 0] }),
  ];
  const pBody = prim(0), pGlass = prim(1), pTire = prim(2), pFront = prim(3), pRear = prim(4);

  extrude(pBody, BODY, -HALF_W, HALF_W);
  // Glass cabin slightly narrower than the body, with a body-colored roof slab on top.
  extrude(pGlass, GREENHOUSE, -HALF_W + 0.12, HALF_W - 0.12);
  box(pBody, [-0.55, 1.43, -HALF_W + 0.16], [0.38, 1.47, HALF_W - 0.16]);

  for (const x of [-1.42, 1.42]) for (const z of [-1, 1]) {
    cylinderZ(pTire, x, 0.34, 0.34, z < 0 ? -HALF_W - 0.02 : HALF_W - 0.22, z < 0 ? -HALF_W + 0.22 : HALF_W + 0.02);
  }
  // Full-width light bars, front and back.
  box(pFront, [2.27, 0.66, -HALF_W + 0.1], [2.33, 0.72, HALF_W - 0.1]);
  box(pRear, [-2.38, 0.76, -HALF_W + 0.08], [-2.31, 0.82, HALF_W - 0.08]);

  const prims = [pBody, pGlass, pTire, pFront, pRear];
  return glb(prims, materials);
}

// Only the user's car is a model; everything else on the map stays flat.
const models = {
  CAR_EGO_DARK: sedan({ body: mat("paint", [0.09, 0.095, 0.105], { rough: 0.45, metal: 0.4 }), lights: false }),
  CAR_EGO_LIGHT: sedan({ body: mat("paint", [0.9, 0.9, 0.91], { rough: 0.45, metal: 0.3 }), lights: false }),
};

mkdirSync(dirname(OUT), { recursive: true });
const lines = [
  "// Generated by scripts/build-models.mjs. Do not edit by hand.",
  "",
  ...Object.entries(models).map(
    ([k, buf]) => `export const ${k} = "data:model/gltf-binary;base64,${buf.toString("base64")}";`,
  ),
  "",
];
writeFileSync(OUT, lines.join("\n"));
for (const [k, buf] of Object.entries(models)) console.log(k.padEnd(14), (buf.length / 1024).toFixed(1), "KB");
