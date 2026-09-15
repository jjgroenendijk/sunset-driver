/**
 * Where the curves of a road network cross each other on the ground, found in
 * one walk over a grid of buckets: the question `connect.ts` starts from.
 *
 * A deck and a bore are not on the ground, and a pair of tiers that may not
 * junction is never offered, so neither ever becomes a meeting.
 */
import { compareNumbers } from '../core/sort.ts';
import { mayJoin } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/** Side of one bucket of the segment index, in metres. */
const INDEX_CELL = 60;

/** A place two curves are to meet, and the segment of each that carries it. */
export interface Meeting {
  curve: number;
  segment: number;
  other: number;
  otherSegment: number;
  x: number;
  y: number;
}

/**
 * Every place two curves cross where a junction is allowed, one entry per
 * crossing, in an order that does not depend on how the buckets were walked.
 */
export function crossingsOf(roads: readonly RoadCurve[]): Meeting[] {
  const segments = new SegmentIndex(roads);
  const out: Meeting[] = [];
  segments.eachPair((s, t) => {
    // A crossing never stands on an interchange, so a highway crossing any
    // other road stays a crossing: spec section 6.2 allows it no junction.
    if (!mayJoin(segments.tierOf(s), segments.tierOf(t), false)) return;
    if (!mayJoin(segments.tierOf(t), segments.tierOf(s), false)) return;
    const at = crossPoint(segments.head(s), segments.tail(s), segments.head(t), segments.tail(t));
    if (at === undefined) return;
    const first = segments.curveOf(s);
    const second = segments.curveOf(t);
    out.push({
      curve: first,
      segment: segments.indexOf(s),
      other: second,
      otherSegment: segments.indexOf(t),
      x: at.x,
      y: at.y,
    });
  });
  out.sort(
    (m, n) =>
      compareNumbers(m.curve, n.curve) ||
      compareNumbers(m.segment, n.segment) ||
      compareNumbers(m.other, n.other) ||
      compareNumbers(m.otherSegment, n.otherSegment),
  );
  return out;
}

/**
 * Where two segments cross, or nothing. A crossing at an end of either segment
 * is no crossing: the two roads already share that point, or they meet at the
 * next segment along.
 */
export function crossPoint(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (denominator === 0) return undefined;
  const ox = c.x - a.x;
  const oy = c.y - a.y;
  const t = (ox * sy - oy * sx) / denominator;
  const u = (ox * ry - oy * rx) / denominator;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return undefined;
  return { x: a.x + rx * t, y: a.y + ry * t };
}

/**
 * The segments of the whole network in a grid of buckets, so the crossings are
 * found in one walk rather than by comparing every pair. Only segments on the
 * ground whose tiers may junction are in it, so a deck, a bore and a highway
 * are never offered as a pair.
 */
class SegmentIndex {
  private readonly points: Point[] = [];
  private readonly curve: number[] = [];
  private readonly index: number[] = [];
  private readonly tier: RoadTier[] = [];
  private readonly cell = INDEX_CELL;
  private readonly buckets: number[][] = [];
  private readonly nx: number;
  private readonly ny: number;
  private readonly originX: number;
  private readonly originY: number;

  constructor(roads: readonly RoadCurve[]) {
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (const road of roads) {
      // A deck and a bore are not on the ground, so nothing crosses them there.
      const off = new Uint8Array(Math.max(0, road.points.length - 1));
      for (const at of road.bridges) if (at >= 0 && at < off.length) off[at] = 1;
      for (const at of road.tunnels) if (at >= 0 && at < off.length) off[at] = 1;
      for (let i = 0; i + 1 < road.points.length; i++) {
        const a = road.points[i] as Point;
        const b = road.points[i + 1] as Point;
        minX = Math.min(minX, a.x, b.x);
        minY = Math.min(minY, a.y, b.y);
        maxX = Math.max(maxX, a.x, b.x);
        maxY = Math.max(maxY, a.y, b.y);
        if (off[i] === 1) continue;
        this.points.push(a, b);
        this.curve.push(road.id);
        this.index.push(i);
        this.tier.push(road.tier);
      }
    }
    this.originX = minX - this.cell;
    this.originY = minY - this.cell;
    this.nx = Math.max(1, Math.ceil((maxX - this.originX) / this.cell) + 2);
    this.ny = Math.max(1, Math.ceil((maxY - this.originY) / this.cell) + 2);
    for (let i = 0; i < this.nx * this.ny; i++) this.buckets.push([]);
    for (let s = 0; s < this.curve.length; s++) {
      const a = this.head(s);
      const b = this.tail(s);
      this.fileIn(s, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    }
  }

  head(s: number): Point {
    return this.points[s * 2] as Point;
  }

  tail(s: number): Point {
    return this.points[s * 2 + 1] as Point;
  }

  curveOf(s: number): number {
    return this.curve[s] as number;
  }

  indexOf(s: number): number {
    return this.index[s] as number;
  }

  tierOf(s: number): RoadTier {
    return this.tier[s] as RoadTier;
  }

  /** Every pair of segments of two different curves that share a bucket, once each. */
  eachPair(visit: (s: number, t: number) => void): void {
    const seen = new Int32Array(this.curve.length).fill(-1);
    for (let s = 0; s < this.curve.length; s++) {
      const a = this.head(s);
      const b = this.tail(s);
      const x0 = this.column(Math.min(a.x, b.x), this.originX, this.nx);
      const x1 = this.column(Math.max(a.x, b.x), this.originX, this.nx);
      const y0 = this.column(Math.min(a.y, b.y), this.originY, this.ny);
      const y1 = this.column(Math.max(a.y, b.y), this.originY, this.ny);
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) {
          for (const t of this.buckets[iy * this.nx + ix] as number[]) {
            if (t <= s || this.curve[t] === this.curve[s]) continue;
            // A pair whose boxes cover several buckets is offered once for each
            // of them, and the same crossing must not be found twice.
            if (seen[t] === s) continue;
            seen[t] = s;
            visit(s, t);
          }
        }
      }
    }
  }

  private column(v: number, origin: number, count: number): number {
    const i = Math.floor((v - origin) / this.cell);
    return i < 0 ? 0 : i >= count ? count - 1 : i;
  }

  private fileIn(id: number, minX: number, minY: number, maxX: number, maxY: number): void {
    const x0 = this.column(minX, this.originX, this.nx);
    const x1 = this.column(maxX, this.originX, this.nx);
    const y0 = this.column(minY, this.originY, this.ny);
    const y1 = this.column(maxY, this.originY, this.ny);
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const bucket = this.buckets[iy * this.nx + ix] as number[];
        if (bucket[bucket.length - 1] !== id) bucket.push(id);
      }
    }
  }
}
