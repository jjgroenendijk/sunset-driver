/**
 * The airfields, drawn (spec section 8.4).
 *
 * An airfield is a plan of boxes in its own frame (`airfield-frame.ts`): the
 * paved surfaces, the markings on them and the buildings that stand on them.
 * Each box is grown here into a geometry with its colour on its vertices, and
 * every airfield of the map is merged into one mesh, drawn in one call. A map
 * has a handful of airfields, so building them once at the start of a session
 * is cheaper than cutting them into the chunks the way the roads are.
 *
 * The surfaces lie a few centimetres over the levelled ground, each kind at
 * its own height, so two that meet or overlap never fight over one depth. The
 * ramp from the rectangle out to the gate climbs the graded hillside, so it is
 * a strip laid on the ground's own heights rather than a box.
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, Matrix4, Mesh, MeshStandardMaterial } from 'three';
import { airfieldRamp } from '../world/airfield-frame.ts';
import { RAMP_HALF } from '../world/airfields.ts';
import type { Airfield, AirfieldPart, Point } from '../world/types.ts';
import { coloured, merged } from './traffic.ts';

/** One box of an airfield, in its frame: `u` along the runway, `v` across it, `y` up from the level. */
export interface AirfieldBox {
  u: number;
  v: number;
  halfU: number;
  halfV: number;
  /** The bottom and the top of the box over the airfield's level. */
  y0: number;
  y1: number;
  colour: number;
}

/** The colour of each part. An airstrip's runway is packed dirt and takes {@link DIRT} instead. */
const PAINT: Record<AirfieldPart['kind'], number> = {
  runway: 0x34363a,
  taxiway: 0x44464a,
  apron: 0x6a6c6e,
  forecourt: 0x5c5e62,
  pad: 0x3c4a44,
  terminal: 0xc9ccd0,
  tower: 0xdcdcd6,
  hangar: 0x8a949c,
  shed: 0x8c7a5c,
  fence: 0x9aa0a4,
  windsock: 0xd8d8d8,
  deck: 0x7a5a3a,
  compound: 0,
};
const DIRT = 0x8a7454;
const WHITE = 0xf0f0ea;
const YELLOW = 0xe8c030;
const GLASS = 0x2c4a60;
const SOCK = 0xf06a20;

/**
 * Centimetres each surface lies over the level, so the one laid on another
 * wins the depth: an apron under a taxiway, a pad on the apron.
 */
const LIFT: Partial<Record<AirfieldPart['kind'], number>> = { apron: 0.06, forecourt: 0.06, taxiway: 0.08, runway: 0.1, pad: 0.12 };

/** Metres a surface slab reaches below the level, so it covers the ground where the grading rounds off. */
const SLAB_DEPTH = 0.4;

/** The dashes of a runway's centreline, and the stripes of the threshold at each end. */
const DASH = 18;
const DASH_GAP = 14;
const DASH_WIDTH = 0.9;
const THRESHOLD_BARS = 8;

/** The height of a mark painted on a surface, over the surface. */
const PAINT_LIFT = 0.015;

function box(u: number, v: number, halfU: number, halfV: number, y0: number, y1: number, colour: number): AirfieldBox {
  return { u, v, halfU, halfV, y0, y1, colour };
}

/** The boxes of one airfield: its surfaces, the paint on them and what stands on them. */
export function airfieldBoxes(field: Airfield): AirfieldBox[] {
  const out: AirfieldBox[] = [];
  for (const part of field.parts) {
    if (part.kind === 'compound') continue;
    const lift = LIFT[part.kind];
    if (lift !== undefined) {
      const colour = part.kind === 'runway' && field.kind === 'airstrip' ? DIRT : PAINT[part.kind];
      out.push(box(part.u, part.v, part.halfU, part.halfV, -SLAB_DEPTH, lift, colour));
      out.push(...markings(field, part, lift + PAINT_LIFT));
      continue;
    }
    out.push(...standing(part));
  }
  return out;
}

/** The paint on one surface: a paved runway's centreline and thresholds, a taxiway's line, a pad's H. */
function markings(field: Airfield, part: AirfieldPart, top: number): AirfieldBox[] {
  const out: AirfieldBox[] = [];
  const at = (u: number, v: number, halfU: number, halfV: number, colour: number): void => {
    out.push(box(part.u + u, part.v + v, halfU, halfV, top - PAINT_LIFT, top, colour));
  };
  if (part.kind === 'runway' && field.kind !== 'airstrip') {
    runwayPaint(part, at);
  } else if (part.kind === 'taxiway') {
    const alongU = part.halfU >= part.halfV;
    at(0, 0, alongU ? part.halfU - 2 : 0.25, alongU ? 0.25 : part.halfV - 2, YELLOW);
  } else if (part.kind === 'pad') {
    const h = Math.min(part.halfU, part.halfV) * 0.5;
    at(-h * 0.6, 0, 0.8, h, WHITE);
    at(h * 0.6, 0, 0.8, h, WHITE);
    at(0, 0, h * 0.6, 0.8, WHITE);
  }
  return out;
}

/** A paved runway's paint: the threshold bars at each end, then the dashed centreline. */
function runwayPaint(part: AirfieldPart, at: (u: number, v: number, halfU: number, halfV: number, colour: number) => void): void {
  const bar = part.halfV * 0.06;
  const pitch = (2 * part.halfV) / THRESHOLD_BARS;
  for (const end of [-1, 1]) {
    for (let k = 0; k < THRESHOLD_BARS; k++) {
      const v = -part.halfV + pitch * (k + 0.5);
      if (Math.abs(v) < pitch / 2) continue;
      at(end * (part.halfU - 20), v, 15, bar, WHITE);
    }
  }
  const reach = part.halfU - 50;
  for (let u = -reach + DASH / 2; u <= reach - DASH / 2; u += DASH + DASH_GAP) at(u, 0, DASH / 2, DASH_WIDTH / 2, WHITE);
}

/** What stands on the ground: the buildings, the fence, the windsock and the dock's deck. */
function standing(part: AirfieldPart): AirfieldBox[] {
  const { u, v, halfU, halfV, height } = part;
  const colour = PAINT[part.kind];
  if (part.kind === 'windsock') {
    const pole = box(u, v, 0.1, 0.1, 0, height, colour);
    return [pole, box(u + 1.4, v, 1.3, 0.35, height - 0.9, height - 0.2, SOCK)];
  }
  if (part.kind === 'deck') return [box(u, v, halfU, halfV, height - 0.3, height, colour)];
  if (part.kind === 'tower') {
    // A shaft with a glazed cab on top, wider than the shaft.
    const cab = 5;
    return [box(u, v, halfU * 0.6, halfV * 0.6, 0, height - cab, colour), box(u, v, halfU, halfV, height - cab, height - 1, GLASS), box(u, v, halfU + 0.4, halfV + 0.4, height - 1, height, colour)];
  }
  if (part.kind === 'terminal') {
    // A band of glass along the airside face, which is `-v`.
    return [box(u, v, halfU, halfV, 0, height, colour), box(u, v - halfV, halfU - 2, 0.2, 2, height - 3, GLASS)];
  }
  if (part.kind === 'hangar') {
    // The door on the apron side, dark against the cladding.
    return [box(u, v, halfU, halfV, 0, height, colour), box(u, v - halfV, halfU - 3, 0.2, 0, height - 3, 0x3c4246)];
  }
  return [box(u, v, halfU, halfV, 0, height, colour)];
}

/** One box as a geometry in the airfield's frame, turned and moved onto the map by `place`. */
function geometryOf(part: AirfieldBox, place: Matrix4): BufferGeometry {
  const geometry = new BoxGeometry(2 * part.halfU, part.y1 - part.y0, 2 * part.halfV).toNonIndexed();
  geometry.translate(part.u, (part.y0 + part.y1) / 2, part.v);
  geometry.applyMatrix4(place);
  return coloured(geometry, part.colour);
}

/** Metres between two rows of the ramp's strip. */
const RAMP_STEP = 4;

/** The ramp from an airfield out to its gate, laid on the ground's heights. */
function rampOf(field: Airfield, heightAt: (x: number, y: number) => number): BufferGeometry {
  const [p, q, r, s] = airfieldRamp(field, RAMP_HALF) as [Point, Point, Point, Point];
  // The two long sides of the ring are the ones the strip runs along.
  const across = Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(s.x - p.x, s.y - p.y);
  const [a, b, c, d] = across ? [p, q, r, s] : [p, s, r, q];
  const length = Math.hypot(d.x - a.x, d.y - a.y);
  const rows = Math.max(1, Math.ceil(length / RAMP_STEP));
  const lift = LIFT.apron as number;
  const point = (from: Point, to: Point, t: number): number[] => {
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    return [x, heightAt(x, y) + lift, y];
  };
  const positions: number[] = [];
  for (let i = 0; i < rows; i++) {
    const p0 = point(a, d, i / rows);
    const p1 = point(b, c, i / rows);
    const p2 = point(b, c, (i + 1) / rows);
    const p3 = point(a, d, (i + 1) / rows);
    // Two triangles per row, each wound to face up whichever way the ring runs.
    for (const tri of [[p0, p1, p2], [p0, p2, p3]]) {
      const [t0, t1, t2] = tri as [number[], number[], number[]];
      const up = ((t1[2] as number) - (t0[2] as number)) * ((t2[0] as number) - (t0[0] as number)) - ((t1[0] as number) - (t0[0] as number)) * ((t2[2] as number) - (t0[2] as number));
      positions.push(...t0, ...(up >= 0 ? [...t1, ...t2] : [...t2, ...t1]));
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
  geometry.computeVertexNormals();
  return coloured(geometry, PAINT.taxiway);
}

/** Every airfield of a map as one mesh, which casts and takes shadows as the buildings do. */
export function airfieldMesh(fields: readonly Airfield[], heightAt: (x: number, y: number) => number): Mesh {
  const parts: BufferGeometry[] = [];
  const place = new Matrix4();
  const turn = new Matrix4();
  for (const field of fields) {
    place.makeTranslation(field.x, field.level, field.y).multiply(turn.makeRotationY(-field.heading));
    for (const part of airfieldBoxes(field)) parts.push(geometryOf(part, place));
    if (field.kind !== 'dock') parts.push(rampOf(field, heightAt));
  }
  const mesh = new Mesh(merged(parts), new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
