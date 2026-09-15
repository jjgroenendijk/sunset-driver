/**
 * Where a road lies over its own carriageway (spec section 6.2).
 *
 * A curve overlaps itself where one place on it stands on the carriageway of
 * another place on it that the curve only reaches by going away and coming
 * back. The test is the one a half turn sets: along a bend of radius `r` the
 * curve covers `π r` to come back `2 r` from where it was, so a road that
 * covers more than `π / 2` times the gap to come back has turned more than
 * half round. Where that gap is also under half the carriageway, the two
 * places are on the same ground. A curve that crosses itself has no gap at
 * all, so it overlaps wherever it comes back.
 *
 * The tracer asks this of every road it proposes, and the seed sweep asks it
 * of every road laid.
 */
import { clamp } from '../core/math.ts';
import { TIERS } from './tiers.ts';
import type { Point, RoadTier } from './types.ts';

/** Metres of curve past the half-turn rule before a return counts, for the rounding of a straight run. */
const SLACK = 0.5;

/** Where a curve comes back onto itself: the two segments, and the gap between them. */
export interface SelfOverlap {
  first: number;
  second: number;
  gap: number;
}

/**
 * The first pair of segments of a polyline, by the later segment, that lie on
 * each other's carriageway for a road of this tier. Undefined where the road
 * keeps clear of itself.
 */
export function selfOverlap(points: readonly Point[], tier: RoadTier): SelfOverlap | undefined {
  const half = TIERS[tier].width / 2;
  const along = [0];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    along.push((along[i] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  for (let j = 1; j + 1 < points.length; j++) {
    const c = points[j] as Point;
    const d = points[j + 1] as Point;
    for (let i = 0; i < j; i++) {
      const a = points[i] as Point;
      const b = points[i + 1] as Point;
      // The boxes of two segments further apart than the carriageway hold no
      // place of one on the other.
      if (Math.min(a.x, b.x) - Math.max(c.x, d.x) >= half || Math.min(c.x, d.x) - Math.max(a.x, b.x) >= half) continue;
      if (Math.min(a.y, b.y) - Math.max(c.y, d.y) >= half || Math.min(c.y, d.y) - Math.max(a.y, b.y) >= half) continue;
      const gap = returnGap(points, along, i, j, half);
      if (gap !== undefined) return { first: i, second: j, gap };
    }
  }
  return undefined;
}

/**
 * The gap at which segment `j` comes back onto segment `i`, or undefined where
 * it does not. Each end of either segment is measured against the other
 * segment, and two segments that cross and share no end are a gap of nothing.
 */
function returnGap(points: readonly Point[], along: readonly number[], i: number, j: number, half: number): number | undefined {
  const a = points[i] as Point;
  const b = points[i + 1] as Point;
  const c = points[j] as Point;
  const d = points[j + 1] as Point;
  if (j > i + 1 && crosses(a, b, c, d)) return 0;
  let worst: number | undefined;
  const test = (p: Point, at: number, s: Point, e: Point, from: number, length: number): void => {
    const { gap, t } = toSegment(p, s, e);
    if (gap >= half) return;
    const curve = Math.abs(at - (from + t * length));
    if (curve > (Math.PI / 2) * gap + SLACK && (worst === undefined || gap < worst)) worst = gap;
  };
  const li = (along[i + 1] as number) - (along[i] as number);
  const lj = (along[j + 1] as number) - (along[j] as number);
  // The end the two share, where they are adjacent, is on both and says nothing.
  if (j > i + 1) test(c, along[j] as number, a, b, along[i] as number, li);
  test(d, along[j + 1] as number, a, b, along[i] as number, li);
  test(a, along[i] as number, c, d, along[j] as number, lj);
  if (j > i + 1) test(b, along[i + 1] as number, c, d, along[j] as number, lj);
  return worst;
}

/** Metres from a point to a segment, and how far along the segment the nearest place is, from 0 to 1. */
function toSegment(p: Point, a: Point, b: Point): { gap: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = dx * dx + dy * dy;
  const t = span === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / span, 0, 1);
  return { gap: Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y), t };
}

/** True when two segments cross away from their ends. */
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (denominator === 0) return false;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denominator;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denominator;
  return t > 0 && t < 1 && u > 0 && u < 1;
}
