/**
 * Where a road lies over its own carriageway (spec section 6.2).
 *
 * A curve overlaps itself where two places on it stand closer than the width
 * of its carriageway, so the carriageway around one reaches the carriageway
 * around the other, while the curve between them runs further than `π / 2`
 * times that width. That is the half turn of a bend whose inner kerb has just
 * shrunk to nothing, so a bend wide enough for the road is never counted, and
 * a curve that folds, loops, crosses itself or comes back beside itself is.
 *
 * Every place of a segment is tried, not only its ends, so a point added on a
 * straight stretch of a curve never changes the answer.
 *
 * The network refuses a road that overlaps itself (`road-network.ts`), the
 * trace stops before a step that would, and the seed sweep checks every road.
 */
import { hypot } from '../core/libm.ts';
import { TIERS } from './tiers.ts';
import type { Point, RoadTier } from './types.ts';

/** Metres of curve past the half turn before a return counts, for the rounding of a straight run. */
const SLACK = 0.5;
/** Metres between the places of a segment the test is tried at. */
const SAMPLE = 0.5;

/** The two segments of a curve that lie over each other, the earlier first. */
export interface SelfOverlap {
  first: number;
  second: number;
}

/**
 * The first pair of segments of a polyline, by the later segment, that lie on
 * each other's carriageway for a road of this tier. Undefined where the road
 * keeps clear of itself.
 */
export function selfOverlap(points: readonly Point[], tier: RoadTier): SelfOverlap | undefined {
  const along = distancesAlong(points);
  const reach = TIERS[tier].width;
  for (let j = 1; j + 1 < points.length; j++) {
    for (let i = 0; i < j; i++) {
      if (pairOverlaps(points, along, i, j, reach)) return { first: i, second: j };
    }
  }
  return undefined;
}

/**
 * True when a road of this tier that runs through `points` and then on to
 * `next` would lie over its own carriageway with that last step. A trace asks
 * it before each step, so it never has to cut a road it has already laid.
 * `before` is the road the points carry on from, ending where they start.
 */
export function stepOverlaps(points: readonly Point[], next: Point, tier: RoadTier, before: readonly Point[] = []): boolean {
  const n = points.length;
  if (n === 0) return false;
  const reach = TIERS[tier].width;
  const c = points[n - 1] as Point;
  const lj = hypot(next.x - c.x, next.y - c.y);
  // Walked back from the step, so the metres between the two segments add up
  // as they go and nothing is allocated: a trace asks this at every step.
  let apart = 0;
  // The road before the points, then the points, whose first is its last.
  const m = before.length;
  const skip = m > 0 ? 1 : 0;
  const at = (k: number): Point => (k < m ? before[k] : points[k - m + skip]) as Point;
  for (let i = m + n - skip - 2; i >= 0; i--) {
    const a = at(i);
    const b = at(i + 1);
    const li = hypot(b.x - a.x, b.y - a.y);
    apart += li;
    if (overlaps(a, b, c, next, li, lj, apart, reach)) return true;
  }
  return false;
}

/**
 * True when a point spliced into segment `segment` of a polyline, bending the
 * road through `spot`, would lay one of the two halves of that segment over the
 * road's own carriageway.
 */
export function bendOverlaps(points: readonly Point[], segment: number, spot: Point, tier: RoadTier): boolean {
  const line = [...points.slice(0, segment + 1), spot, ...points.slice(segment + 1)];
  const along = distancesAlong(line);
  const reach = TIERS[tier].width;
  for (const j of [segment, segment + 1]) {
    for (let i = 0; i + 1 < line.length; i++) {
      if (i !== j && pairOverlaps(line, along, Math.min(i, j), Math.max(i, j), reach)) return true;
    }
  }
  return false;
}

/** Metres along a polyline at each of its points. */
function distancesAlong(points: readonly Point[]): number[] {
  const along = [0];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    along.push((along[i] as number) + hypot(b.x - a.x, b.y - a.y));
  }
  return along;
}

/** {@link overlaps} for segments `i` and `j` of a polyline, `i` the earlier. */
function pairOverlaps(points: readonly Point[], along: readonly number[], i: number, j: number, reach: number): boolean {
  const li = (along[i + 1] as number) - (along[i] as number);
  const lj = (along[j + 1] as number) - (along[j] as number);
  const apart = (along[j] as number) - (along[i] as number);
  return overlaps(points[i] as Point, points[i + 1] as Point, points[j] as Point, points[j + 1] as Point, li, lj, apart, reach);
}

/**
 * True when a place of the segment from `c` to `d` stands within `reach` of a
 * place of the earlier segment from `a` to `b`, with more than a half turn of
 * curve between them. `li` and `lj` are the two lengths and `apart` the metres
 * of curve from `a` to `c`. For each place of the later segment the places of
 * the earlier one within reach are an interval, and the one furthest back
 * along the curve is its start.
 */
function overlaps(a: Point, b: Point, c: Point, d: Point, li: number, lj: number, apart: number, reach: number): boolean {
  // Boxes further apart than the reach hold no pair of places within it.
  if (Math.min(a.x, b.x) - Math.max(c.x, d.x) >= reach || Math.min(c.x, d.x) - Math.max(a.x, b.x) >= reach) return false;
  if (Math.min(a.y, b.y) - Math.max(c.y, d.y) >= reach || Math.min(c.y, d.y) - Math.max(a.y, b.y) >= reach) return false;
  const turn = (Math.PI / 2) * reach + SLACK;
  if (li === 0 || lj === 0 || apart + lj <= turn) return false;
  const ex = (b.x - a.x) / li;
  const ey = (b.y - a.y) / li;
  // Two segments that meet at a turn of a right angle or less stand further
  // apart than a half turn of curve between them anywhere.
  if (b.x === c.x && b.y === c.y && ex * (d.x - c.x) + ey * (d.y - c.y) >= 0) return false;
  const steps = Math.ceil(lj / SAMPLE);
  for (let k = 0; k <= steps; k++) {
    const s = (lj * k) / steps;
    const px = c.x + ((d.x - c.x) * s) / lj - a.x;
    const py = c.y + ((d.y - c.y) * s) / lj - a.y;
    const t0 = px * ex + py * ey;
    const room = reach * reach - (px * px + py * py - t0 * t0);
    if (room <= 0) continue;
    const back = Math.max(0, t0 - Math.sqrt(room));
    if (back > Math.min(li, t0 + Math.sqrt(room))) continue;
    if (apart + s - back > turn) return true;
  }
  return false;
}

/** How many folds {@link untangle} cuts out of one road before it gives up. */
const UNTANGLE_CUTS = 8;

/**
 * A polyline with the stretches that come back over the road's own carriageway
 * cut out, or undefined where that cannot be done. Where two segments lie over
 * each other, the road runs straight from the start of the first to the end of
 * the second, and `joins` says whether a road may run there. A spike of one
 * point and a loop are both cut this way. The two ends are never moved, so a
 * road still starts and ends where it was proposed to.
 */
export function untangle(points: readonly Point[], tier: RoadTier, joins: (a: Point, b: Point) => boolean): Point[] | undefined {
  let line = points.slice();
  for (let cut = 0; cut < UNTANGLE_CUTS; cut++) {
    const fold = selfOverlap(line, tier);
    if (fold === undefined) return line;
    const a = line[fold.first] as Point;
    const b = line[fold.second + 1] as Point;
    if (!joins(a, b)) return undefined;
    line = [...line.slice(0, fold.first + 1), ...line.slice(fold.second + 1)];
  }
  return selfOverlap(line, tier) === undefined ? line : undefined;
}
