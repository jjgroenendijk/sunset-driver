/**
 * Every road point already laid, in a uniform grid of buckets, so "is there a
 * road here?" costs a handful of comparisons rather than a walk over the whole
 * network. `roads.ts` asks it at every step of every trace.
 */
import { clamp, dist } from '../core/math.ts';
import { mayJoin } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/** Metres within which two road points are the same place, and so the same junction. */
export const JOIN_EPSILON = 0.01;

/** A point of the network already laid, and the island it stands on. */
export interface NetworkHit {
  x: number;
  y: number;
  curve: number;
}

/**
 * Every road point in a uniform grid of buckets, so "is there already a road
 * here?" costs a handful of comparisons rather than a walk over the network.
 */
export class RoadIndex {
  private readonly cell: number;
  private readonly n: number;
  private readonly origin: number;
  private readonly buckets: number[][] = [];
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly curves: number[] = [];
  private readonly islands: number[] = [];
  /** The tier of the curve each point belongs to, and whether a road may join it there. */
  private readonly tiers: RoadTier[] = [];
  private readonly interchanges: boolean[] = [];
  private readonly islandOf: (x: number, y: number) => number;

  constructor(size: number, cell: number, islandOf: (x: number, y: number) => number) {
    this.cell = cell;
    this.origin = -size / 2 - 2 * cell;
    this.n = Math.ceil((size + 4 * cell) / cell) + 1;
    this.islandOf = islandOf;
    for (let i = 0; i < this.n * this.n; i++) this.buckets.push([]);
  }

  private column(v: number): number {
    return clamp(Math.floor((v - this.origin) / this.cell), 0, this.n - 1);
  }

  add(curve: RoadCurve): void {
    const points = curve.points;
    for (let k = 0; k < points.length; k++) {
      const p = points[k] as Point;
      const i = this.xs.length;
      this.xs.push(p.x);
      this.ys.push(p.y);
      this.curves.push(curve.id);
      this.tiers.push(curve.tier);
      this.interchanges.push(curve.interchanges.includes(k));
      this.islands.push(this.islandOf(p.x, p.y));
      (this.buckets[this.column(p.y) * this.n + this.column(p.x)] as number[]).push(i);
    }
  }

  /** True when a road of `joiner` may end on the point at `i`. */
  private joinable(i: number, joiner: RoadTier | undefined): boolean {
    if (joiner === undefined) return true;
    return mayJoin(joiner, this.tiers[i] as RoadTier, this.interchanges[i] === true);
  }

  get empty(): boolean {
    return this.xs.length === 0;
  }

  /**
   * The nearest road point within `radius`. One curve can be left out, which is
   * how a road ignores the road it branched off. With a `joiner` tier only
   * points that tier may junction at are returned; without one every point
   * counts, which is the question the fill asks about ground already covered.
   */
  nearest(x: number, y: number, radius: number, except = -1, joiner?: RoadTier): NetworkHit | undefined {
    const cx = this.column(x);
    const cy = this.column(y);
    const reach = Math.ceil(radius / this.cell);
    let best: NetworkHit | undefined;
    let bestD = radius;
    for (let iy = Math.max(0, cy - reach); iy <= Math.min(this.n - 1, cy + reach); iy++) {
      for (let ix = Math.max(0, cx - reach); ix <= Math.min(this.n - 1, cx + reach); ix++) {
        for (const i of this.buckets[iy * this.n + ix] as number[]) {
          if (this.curves[i] === except) continue;
          if (!this.joinable(i, joiner)) continue;
          const d = dist(x, y, this.xs[i] as number, this.ys[i] as number);
          if (d > bestD) continue;
          bestD = d;
          best = { x: this.xs[i] as number, y: this.ys[i] as number, curve: this.curves[i] as number };
        }
      }
    }
    return best;
  }

  /**
   * True when a road of `joiner` may not begin where it stands, because a road
   * it is not allowed to junction with already has a point there. A fill road
   * starts at its seed, so a seed on such a point would junction there.
   */
  refuses(x: number, y: number, joiner: RoadTier): boolean {
    const cx = this.column(x);
    const cy = this.column(y);
    for (let iy = Math.max(0, cy - 1); iy <= Math.min(this.n - 1, cy + 1); iy++) {
      for (let ix = Math.max(0, cx - 1); ix <= Math.min(this.n - 1, cx + 1); ix++) {
        for (const i of this.buckets[iy * this.n + ix] as number[]) {
          if (this.joinable(i, joiner)) continue;
          if (dist(x, y, this.xs[i] as number, this.ys[i] as number) <= JOIN_EPSILON) return true;
        }
      }
    }
    return false;
  }

  /** The nearest road point standing on one island that `joiner` may junction at, at any distance. */
  nearestOnIsland(x: number, y: number, island: number, joiner: RoadTier): NetworkHit | undefined {
    let best: NetworkHit | undefined;
    let bestD = Infinity;
    for (let i = 0; i < this.xs.length; i++) {
      if (this.islands[i] !== island) continue;
      if (!this.joinable(i, joiner)) continue;
      const d = dist(x, y, this.xs[i] as number, this.ys[i] as number);
      if (d >= bestD) continue;
      bestD = d;
      best = { x: this.xs[i] as number, y: this.ys[i] as number, curve: this.curves[i] as number };
    }
    return best;
  }
}
