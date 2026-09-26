/**
 * A road while the crossings of a new road are planned against it: its own
 * points, and the points the plan has given it so far (`crossing-plan.ts`).
 *
 * Nothing is written to the road until the whole plan holds, so a crossing
 * decided later sees the places an earlier one took on the same segment, and a
 * plan that is given up leaves every road as it was.
 */
import { atan2, hypot } from '../../core/libm.ts';
import { MIN_MEET, SAME_PLACE } from '../roads/network-clearance.ts';
import type { Point, RoadTier } from '../types.ts';

/** A place on a line: one of its own points, or a point the plan gives it. */
export interface Place extends Point {
  /** The segment the place stands on, and how far along it, from 0 to 1. An own point stands at 0 of its segment. */
  segment: number;
  at: number;
  /** The index among the line's own points, or -1 for a given point. */
  index: number;
}

export class PlannedLine {
  readonly points: readonly Point[];
  readonly tier: RoadTier;
  /** The points the plan has given the line, in the order they were given. */
  readonly given: Place[] = [];

  constructor(points: readonly Point[], tier: RoadTier) {
    this.points = points;
    this.tier = tier;
  }

  /** Every place along the line in order: its own points with the given ones between them. */
  sequence(): Place[] {
    const out: Place[] = this.points.map((p, i) => ({ x: p.x, y: p.y, segment: i, at: 0, index: i }));
    out.push(...this.given);
    return out.sort((m, n) => m.segment - n.segment || m.at - n.at);
  }

  /** The places either side of one on the line. */
  around(place: Place): Place[] {
    const seq = this.sequence();
    const i = seq.findIndex((p) => p === place || (p.index >= 0 && p.index === place.index));
    return [seq[i - 1], seq[i + 1]].filter((p): p is Place => p !== undefined);
  }

  /** The place a new point at `at` along `segment` would stand between. */
  halves(segment: number, at: number): [Place, Place] {
    let before: Place = { ...(this.points[segment] as Point), segment, at: 0, index: segment };
    let after: Place = { ...(this.points[segment + 1] as Point), segment: segment + 1, at: 0, index: segment + 1 };
    for (const other of this.given) {
      if (other.segment !== segment) continue;
      if (other.at <= at && (before.index >= 0 || other.at >= before.at)) before = other;
      if (other.at > at && (after.index >= 0 || other.at <= after.at)) after = other;
    }
    return [before, after];
  }

  /** The place of the line nearest a point within `reach`, own or given. */
  nearest(to: Point, reach: number): Place | undefined {
    let best: Place | undefined;
    let bestD = reach;
    for (const place of this.sequence()) {
      const d = hypot(place.x - to.x, place.y - to.y);
      if (d > bestD) continue;
      bestD = d;
      best = place;
    }
    return best;
  }

  /** The place the line already has at a point, to the rounding. */
  placeAt(p: Point): Place | undefined {
    return this.sequence().find((q) => hypot(q.x - p.x, q.y - p.y) <= SAME_PLACE);
  }

  /** The polyline as it stands, and the index `before` stands at: the segment a new point would split. */
  bentAt(before: Place): { line: Point[]; segment: number } {
    const seq = this.sequence();
    const i = seq.indexOf(before);
    return { line: seq.map((q) => ({ x: q.x, y: q.y })), segment: i < 0 ? seq.findIndex((q) => q.index === before.index) : i };
  }
}

/** How far along segment `a`–`b` a point stands, kept inside it. */
export function alongSegment(a: Point, b: Point, p: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = dx * dx + dy * dy;
  return span === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / span));
}

/** Metres from a point to a segment. */
export function toSegment(p: Point, a: Point, b: Point): number {
  const t = alongSegment(a, b, p);
  return hypot(p.x - a.x - (b.x - a.x) * t, p.y - a.y - (b.y - a.y) * t);
}

/**
 * True when two roads leave a place along lines closer than {@link MIN_MEET}:
 * there each lies in the other's carriageway, which no junction can be built on.
 */
export function shallow(at: Point, first: readonly Point[], second: readonly Point[]): boolean {
  for (const p of first) {
    for (const q of second) {
      if (hypot(p.x - at.x, p.y - at.y) <= SAME_PLACE || hypot(q.x - at.x, q.y - at.y) <= SAME_PLACE) continue;
      let turn = Math.abs(atan2(p.y - at.y, p.x - at.x) - atan2(q.y - at.y, q.x - at.x)) % (2 * Math.PI);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn < MIN_MEET) return true;
    }
  }
  return false;
}
