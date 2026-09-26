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

/** True when a person's next step takes them further from the middle of a footprint. */
export function away(box: Footprint, person: Stepping): boolean {
  const was = (person.x - box.x) ** 2 + (person.y - box.y) ** 2;
  return (person.nextX - box.x) ** 2 + (person.nextY - box.y) ** 2 > was;
}

/** The square of the distance between the middles of two footprints. */
export function apart(a: Footprint, b: Footprint): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
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
    if (!meets(other, other.cos, other.sin, 0, person.x, person.y) || !away(other, person)) return true;
  }
  return false;
}

/** True when a step from `here` to `there` metres along an edge crosses the stop line at `stop`. */
export function crossesStop(here: number, there: number, stop: number): boolean {
  return here <= stop + 1e-6 && there > stop + 1e-6;
}
