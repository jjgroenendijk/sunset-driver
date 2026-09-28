/**
 * The shapes giving way (`give-way.ts`) measures with: the lane ahead of a
 * car, and whether a point or another footprint stands in it.
 */
import type { Footprint } from './traffic.ts';

/** The share of its own width a car looks ahead over, so a car in the next lane is not in the way. */
const LANE_SHARE = 0.8;

/** Metres a person keeps from a car, and seconds of a moving car's speed they keep out of in front of it. */
export const PERSON_ROOM = 0.4;
export const CROSS_TIME = 0.8;

/** What a car stops for that is not a car of the traffic, with the cosine and sine of its heading and its speed. */
export type Other = Footprint & { cos: number; sin: number; speed: number };

/** Where a person stands now and where their next step takes them. */
export interface Stepping {
  x: number;
  y: number;
  nextX: number;
  nextY: number;
}

/** The lane ahead of a car's front bumper, `room` metres long. The car heads along `(fx, fy)`. */
export function setAhead(out: Footprint, box: Footprint, fx: number, fy: number, room: number): void {
  const reach = box.halfLength + room / 2;
  out.x = box.x + fx * reach;
  out.y = box.y + fy * reach;
  out.heading = box.heading;
  out.halfLength = room / 2;
  out.halfWidth = box.halfWidth * LANE_SHARE;
}

/**
 * True when a person's next step takes them further from the body of a
 * footprint heading along `(fx, fy)`. The middle is no measure: somebody
 * walking along the side of a bus moves away from its middle and into it.
 * Only somebody already inside it is measured from the middle.
 */
export function away(box: Footprint, fx: number, fy: number, person: Stepping): boolean {
  const was = outside(box, fx, fy, person.x, person.y);
  const will = outside(box, fx, fy, person.nextX, person.nextY);
  if (was > 0 || will > 0) return will > was;
  // Somebody inside it walks out the nearest way: away from its middle.
  return (person.nextX - box.x) ** 2 + (person.nextY - box.y) ** 2 > (person.x - box.x) ** 2 + (person.y - box.y) ** 2;
}

/** The square of how far a point stands outside a footprint heading along `(fx, fy)`, 0 inside it. */
export function outside(box: Footprint, fx: number, fy: number, x: number, y: number): number {
  const rx = x - box.x;
  const ry = y - box.y;
  const along = Math.max(0, Math.abs(rx * fx + ry * fy) - box.halfLength);
  const across = Math.max(0, Math.abs(-rx * fy + ry * fx) - box.halfWidth);
  return along * along + across * across;
}

/** True when two footprints stand near enough that their boxes may touch. */
export function close(a: Footprint, b: Footprint, pad: number): boolean {
  const r = a.halfLength + a.halfWidth + b.halfLength + b.halfWidth + pad;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= r * r;
}

/** True when a point stands within `pad` of a footprint whose heading is `(fx, fy)`. */
export function within(box: Footprint, fx: number, fy: number, x: number, y: number, pad: number): boolean {
  const rx = x - box.x;
  const ry = y - box.y;
  return Math.abs(rx * fx + ry * fy) <= box.halfLength + pad && Math.abs(-rx * fy + ry * fx) <= box.halfWidth + pad;
}

/**
 * True when a point is within a person's room of a footprint heading along
 * `(fx, fy)`, or of the road it is about to cover at `speed`.
 */
export function meets(box: Footprint, fx: number, fy: number, speed: number, x: number, y: number): boolean {
  const rx = x - box.x;
  const ry = y - box.y;
  const along = rx * fx + ry * fy;
  const across = Math.abs(-rx * fy + ry * fx);
  if (across > box.halfWidth + PERSON_ROOM) return false;
  return along >= -box.halfLength - PERSON_ROOM && along <= box.halfLength + PERSON_ROOM + speed * CROSS_TIME;
}

/**
 * True when a person's next step takes them into one of the others: the
 * player, their car, a wreck or an emergency unit. Somebody already against
 * one walks on only when the step takes them away from it.
 */
export function othersBlock(others: readonly Other[], person: Stepping): boolean {
  for (const other of others) {
    if (!meets(other, other.cos, other.sin, 0, person.nextX, person.nextY)) continue;
    if (!meets(other, other.cos, other.sin, 0, person.x, person.y) || !away(other, other.cos, other.sin, person)) return true;
  }
  return false;
}

/** True when a step from `here` to `there` metres along an edge crosses the stop line at `stop`. */
export function crossesStop(here: number, there: number, stop: number): boolean {
  return here <= stop + 1e-6 && there > stop + 1e-6;
}

/**
 * Metres between two footprints whose headings have cosines and sines `ca, sa`
 * and `cb, sb`: the widest gap along the axes of either, negative where they
 * overlap. Two footprints touch with a margin exactly where it is no more than that.
 */
export function gapBetween(a: Footprint, ca: number, sa: number, b: Footprint, cb: number, sb: number): number {
  return Math.max(gapAlong(a, ca, sa, b, cb, sb, ca, sa), gapAlong(a, ca, sa, b, cb, sb, -sa, ca), gapAlong(a, ca, sa, b, cb, sb, cb, sb), gapAlong(a, ca, sa, b, cb, sb, -sb, cb));
}

function gapAlong(a: Footprint, ca: number, sa: number, b: Footprint, cb: number, sb: number, ax: number, ay: number): number {
  const reach = reachAlong(a, ca, sa, ax, ay) + reachAlong(b, cb, sb, ax, ay);
  return Math.abs((b.x - a.x) * ax + (b.y - a.y) * ay) - reach;
}

/** Half the length of a box heading along `(fx, fy)` along an axis. */
function reachAlong(box: Footprint, fx: number, fy: number, ax: number, ay: number): number {
  return box.halfLength * Math.abs(fx * ax + fy * ay) + box.halfWidth * Math.abs(-fy * ax + fx * ay);
}
