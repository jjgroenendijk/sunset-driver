/**
 * An airfield's own frame (spec section 8.4): `u` along the runway's heading
 * and `v` across it, to the left. The planner lays the parts out in it, and
 * everything that asks whether a place is on an airfield asks through here.
 */
import { cos, sin } from '../core/libm.ts';
import type { Airfield, Point } from './types.ts';

/** What the frame needs of an airfield. */
type Frame = Pick<Airfield, 'x' | 'y' | 'heading'>;

/** A point of an airfield's frame, on the map. */
export function fromLocal(field: Frame, u: number, v: number): Point {
  const c = cos(field.heading);
  const s = sin(field.heading);
  return { x: field.x + u * c - v * s, y: field.y + u * s + v * c };
}

/** A point of the map, in an airfield's frame, written into `out`. */
export function toLocal(field: Frame, x: number, y: number, out: { u: number; v: number }): { u: number; v: number } {
  const c = cos(field.heading);
  const s = sin(field.heading);
  const dx = x - field.x;
  const dy = y - field.y;
  out.u = dx * c + dy * s;
  out.v = -dx * s + dy * c;
  return out;
}

const scratch = { u: 0, v: 0 };

/**
 * The airfield whose rectangle, grown by `margin`, holds a place, or undefined.
 * A dock is left out unless `docks` is set: it claims water, which the roads
 * and the parcels keep off anyway.
 */
export function airfieldAt(fields: readonly Airfield[], x: number, y: number, margin = 0, docks = false): Airfield | undefined {
  for (const field of fields) {
    if (field.kind === 'dock' && !docks) continue;
    const reach = field.halfU + field.halfV + margin;
    if (Math.abs(x - field.x) > reach || Math.abs(y - field.y) > reach) continue;
    toLocal(field, x, y, scratch);
    if (Math.abs(scratch.u) <= field.halfU + margin && Math.abs(scratch.v) <= field.halfV + margin) return field;
  }
  return undefined;
}

/** Metres across one cell of an {@link AirfieldMask}. */
const MASK_CELL = 64;

/**
 * {@link airfieldAt} for a question asked millions of times, as the road router
 * asks it: a coarse grid over the map marks the cells an airfield's rectangle
 * may reach, and only a place in a marked cell is measured.
 */
export class AirfieldMask {
  private readonly fields: readonly Airfield[];
  private readonly margin: number;
  private readonly cells: Uint8Array;
  private readonly columns: number;
  private readonly origin: number;

  constructor(fields: readonly Airfield[], margin: number, size: number) {
    this.fields = fields.filter((field) => field.kind !== 'dock');
    this.margin = margin;
    this.origin = -size / 2 - MASK_CELL;
    this.columns = Math.ceil(size / MASK_CELL) + 2;
    this.cells = new Uint8Array(this.columns * this.columns);
    for (const field of this.fields) {
      const corners = airfieldCorners(field, margin);
      const column = (x: number): number => this.cell(x);
      const c0 = column(Math.min(...corners.map((p) => p.x)));
      const c1 = column(Math.max(...corners.map((p) => p.x)));
      const r0 = column(Math.min(...corners.map((p) => p.y)));
      const r1 = column(Math.max(...corners.map((p) => p.y)));
      for (let row = r0; row <= r1; row++) for (let c = c0; c <= c1; c++) this.cells[row * this.columns + c] = 1;
    }
  }

  /** True where a place is inside an airfield's rectangle grown by the margin. */
  has(x: number, y: number): boolean {
    if (this.cells[this.cell(y) * this.columns + this.cell(x)] !== 1) return false;
    return airfieldAt(this.fields, x, y, this.margin) !== undefined;
  }

  private cell(at: number): number {
    return Math.max(0, Math.min(this.columns - 1, Math.floor((at - this.origin) / MASK_CELL)));
  }
}

/** The four corners of an airfield's rectangle grown by `margin`, wound anticlockwise. */
export function airfieldCorners(field: Frame & Pick<Airfield, 'halfU' | 'halfV'>, margin = 0): Point[] {
  const u = field.halfU + margin;
  const v = field.halfV + margin;
  return [fromLocal(field, -u, -v), fromLocal(field, u, -v), fromLocal(field, u, v), fromLocal(field, -u, v)];
}

/**
 * The ramp from an airfield's rectangle out to its gate, wound anticlockwise:
 * `halfWidth` each side of the straight line from the nearest side of the
 * rectangle to the gate. The gate stands past the blend, on the ground as it
 * was, so the ramp is the one stretch that climbs what the levelling made.
 */
export function airfieldRamp(field: Pick<Airfield, 'x' | 'y' | 'heading' | 'halfU' | 'halfV' | 'gate'>, halfWidth: number): Point[] {
  const at = toLocal(field, field.gate.x, field.gate.y, { u: 0, v: 0 });
  // The side the gate stands off is the one it is furthest past.
  const acrossV = Math.abs(at.v) - field.halfV >= Math.abs(at.u) - field.halfU;
  if (acrossV) {
    const edge = Math.sign(at.v) * field.halfV;
    const ring = [fromLocal(field, at.u - halfWidth, edge), fromLocal(field, at.u + halfWidth, edge), fromLocal(field, at.u + halfWidth, at.v), fromLocal(field, at.u - halfWidth, at.v)];
    return at.v > 0 ? ring : ring.reverse();
  }
  const edge = Math.sign(at.u) * field.halfU;
  const ring = [fromLocal(field, edge, at.v - halfWidth), fromLocal(field, at.u, at.v - halfWidth), fromLocal(field, at.u, at.v + halfWidth), fromLocal(field, edge, at.v + halfWidth)];
  return at.u > 0 ? ring : ring.reverse();
}

/** Metres in from the end of a runway a plane is put down at, clear of the overrun. */
const LINE_UP = 30;

/**
 * The end of the runway nearest a place, lined up along it: where a plane the
 * debug picker puts down stands, ready to roll. Undefined on a map with no
 * runway at all.
 */
export function runwayStart(fields: readonly Airfield[], x: number, y: number): { x: number; y: number; heading: number } | undefined {
  let best: { x: number; y: number; heading: number } | undefined;
  let bestDistance = Infinity;
  for (const field of fields) {
    for (const at of runwayEnds(field)) {
      const distance = (at.x - x) ** 2 + (at.y - y) ** 2;
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = at;
    }
  }
  return best;
}

/** Both ends of every runway of one field, in order, each lined up to roll toward the other end. */
function runwayEnds(field: Airfield): { x: number; y: number; heading: number }[] {
  const ends: { x: number; y: number; heading: number }[] = [];
  for (const part of field.parts) {
    if (part.kind !== 'runway') continue;
    for (const end of [-1, 1]) {
      const at = fromLocal(field, part.u + end * (part.halfU - LINE_UP), part.v);
      ends.push({ x: at.x, y: at.y, heading: end < 0 ? field.heading : field.heading + Math.PI });
    }
  }
  return ends;
}
