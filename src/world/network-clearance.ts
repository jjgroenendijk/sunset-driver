/**
 * The ground the network laid so far claims, as the tracer sees it while it
 * lays the next road (spec section 6).
 *
 * This is the half of the road network (`road-network.ts`) that holds its
 * edges as segments, with the width of their tier. A trace that only knew the
 * points of the network could run along another road's carriageway or stop in
 * the middle of one and never know. The segments answer the questions that
 * keep two roads off each other's ground:
 *
 * - May a step be taken? Near another road a step has to cross it or leave it
 *   at {@link MIN_MEET} or more, and a margin besides. A step that runs along it is refused.
 * - May a road end here? Not where its footprint stands on another road's.
 * - May a road meet another at a shared point? Only where it leaves every road
 *   already there at {@link MIN_MEET} or more.
 * - May a step cross a highway? Only under one of its slots, where the deck
 *   `highway-plan.ts` planned is level over the segment and both beside it.
 *
 * Two roads therefore touch only where they share a node or cross, both at an
 * angle a junction or an overpass can be built at.
 */
import { atan2, hypot } from '../core/libm.ts';
import { clamp, directionDelta } from '../core/math.ts';
import { CLEARANCE } from './overpass.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/** Where a straight run crosses a segment of a laid curve. */
export interface SegmentCrossing {
  curve: number;
  /** The index of the crossed segment in its curve. */
  segment: number;
  x: number;
  y: number;
}

/** The least angle, in radians, at which one road may meet, cross or leave another. */
export const MIN_MEET = Math.PI / 6;
/**
 * Radians the tracer asks for beyond {@link MIN_MEET}. A road added to the
 * network gives a crossing its junction up to `CROSSING_SNAP` from where the
 * two cross (`crossing-plan.ts`), which turns their lines a little there, so a
 * crossing traced at exactly the least angle can be joined a hair under it.
 */
const MEET_MARGIN = (5 * Math.PI) / 180;
const TRACE_MEET = MIN_MEET + MEET_MARGIN;

/** Metres within which two road points are the same place. The network snaps a point to a node by the same figure. */
export const SAME_PLACE = 0.01;

/** Side of one bucket, in metres. */
const CELL = 60;

/**
 * Where a road has crossed others so far: x, y, the curve crossed and its half
 * width, four numbers to a crossing. {@link NetworkClearance.stepOk} reads and
 * extends it.
 */
export type Crossings = number[];

/** The road laid so far, as the next step of it is vetted. */
export interface Trail {
  crossed: Crossings;
  /** Where the road began. A junction there is the road's own, so its steps may stay near it. */
  start?: Point;
}

/** Where along the stored segment the last {@link closest} came nearest, from 0 at its start to 1 at its end. */
let closestT = 0;

export class NetworkClearance {
  private readonly origin: number;
  private readonly n: number;
  private readonly buckets: number[][] = [];
  /** Both ends of every segment, four numbers to a segment. */
  private readonly ends: number[] = [];
  private readonly halfWidth: number[] = [];
  /** The curve each segment belongs to. */
  private readonly curve: number[] = [];
  /** Whether each end of a segment is an end of its curve, two flags to a segment. */
  private readonly terminal: boolean[] = [];
  /** Whether another road may cross each segment: not a highway away from its slots, nor the ramp of a raise. */
  private readonly crossable: boolean[] = [];
  /** Segments of a reservation given up, or of a segment cut in two, which nothing keeps off any more. */
  private readonly released: boolean[] = [];
  /** The last query each segment was visited by, so a segment filed twice is seen once. */
  private readonly stamp: number[] = [];
  /** The stored segments of each laid curve, by the index of the segment in the curve. */
  private readonly segmentsOf: number[][] = [];
  private query = 0;
  private widest = 0;

  constructor(size: number) {
    this.origin = -size / 2 - 2 * CELL;
    this.n = Math.ceil((size + 4 * CELL) / CELL) + 1;
    for (let i = 0; i < this.n * this.n; i++) this.buckets.push([]);
  }

  /** File the segments of a curve the network has just taken. */
  protected fileSegments(curve: RoadCurve): void {
    const slots = curve.slots ?? [];
    const lift = curve.lift ?? [];
    // A crossing is only allowed well inside a run of slots. A road that
    // crosses may be moved by a snap as it is added, and the crossing moves
    // along the highway with it; it has to stay under the level deck. Any
    // other road is crossed on the ground or under the level top of a raise,
    // never on a ramp.
    const open = (i: number): boolean => {
      if (curve.tier === 'highway') return slots.includes(i - 1) && slots.includes(i) && slots.includes(i + 1);
      const low = Math.min(lift[i] ?? 0, lift[i + 1] ?? 0);
      const high = Math.max(lift[i] ?? 0, lift[i + 1] ?? 0);
      return high === 0 || low >= CLEARANCE;
    };
    const first = this.halfWidth.length;
    this.lay(curve.id, curve.tier, curve.points, open);
    const own: number[] = [];
    for (let s = first; s < this.halfWidth.length; s++) own.push(s);
    this.segmentsOf[curve.id] = own;
  }

  /**
   * Cut segment `segment` of a curve in two at the point the curve has just
   * taken after it. The one stored segment is given up and two take its place,
   * each as crossable as the one they replace.
   */
  protected splitSegment(curve: RoadCurve, segment: number): void {
    const own = this.segmentsOf[curve.id] as number[];
    const s = own[segment] as number;
    this.released[s] = true;
    const first = this.halfWidth.length;
    const points = curve.points.slice(segment, segment + 3);
    this.lay(curve.id, curve.tier, points, () => this.crossable[s] === true);
    const last = curve.points.length - 1;
    this.terminal[first * 2] = segment === 0;
    this.terminal[first * 2 + 1] = false;
    this.terminal[(first + 1) * 2] = false;
    this.terminal[(first + 1) * 2 + 1] = segment + 2 === last;
    own.splice(segment, 1, first, first + 1);
  }

  /**
   * Every segment of a laid curve that the straight run from `a` to `b` crosses
   * strictly inside both, with the place they cross. A reservation is no road,
   * so it crosses nothing here.
   */
  crossingsAlong(a: Point, b: Point): SegmentCrossing[] {
    const out: SegmentCrossing[] = [];
    this.visit(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), 0, (s) => {
      const curve = this.curve[s] as number;
      if (curve < 0) return;
      const e = this.ends;
      const k = s * 4;
      const c = { x: e[k] as number, y: e[k + 1] as number };
      const d = { x: e[k + 2] as number, y: e[k + 3] as number };
      const at = crossPoint(a, b, c, d);
      if (at === undefined) return;
      out.push({ curve, segment: (this.segmentsOf[curve] as number[]).indexOf(s), x: at.x, y: at.y });
    });
    return out;
  }

  /**
   * Hold a line for a road of this tier that is not laid yet, so the roads laid
   * before it keep off its ground as if it were. `id` is negative, so it is
   * never the id of a curve. {@link release} gives the ground back.
   */
  reserve(id: number, tier: RoadTier, points: readonly Point[]): void {
    this.lay(id, tier, points);
  }

  release(id: number): void {
    for (let s = 0; s < this.curve.length; s++) if (this.curve[s] === id) this.released[s] = true;
  }

  private lay(id: number, tier: RoadTier, points: readonly Point[], open: (segment: number) => boolean = () => true): void {
    const half = footprintHalfWidth(tier);
    this.widest = Math.max(this.widest, half);
    const last = points.length - 1;
    for (let i = 0; i < last; i++) {
      const a = points[i] as Point;
      const b = points[i + 1] as Point;
      const s = this.halfWidth.length;
      this.ends.push(a.x, a.y, b.x, b.y);
      this.halfWidth.push(half);
      this.curve.push(id);
      this.released.push(false);
      this.crossable.push(open(i));
      this.terminal.push(i === 0, i + 1 === last);
      this.stamp.push(0);
      const x0 = this.column(Math.min(a.x, b.x));
      const x1 = this.column(Math.max(a.x, b.x));
      const y0 = this.column(Math.min(a.y, b.y));
      const y1 = this.column(Math.max(a.y, b.y));
      for (let iy = y0; iy <= y1; iy++) {
        for (let ix = x0; ix <= x1; ix++) (this.buckets[iy * this.n + ix] as number[]).push(s);
      }
    }
  }

  /** True where a road of this tier may end: its footprint stands on no other road's. */
  clearAt(x: number, y: number, tier: RoadTier): boolean {
    const half = footprintHalfWidth(tier);
    let clear = true;
    const p = { x, y };
    this.visit(x, y, x, y, half, (s) => {
      if (!clear) return;
      const reach = half + (this.halfWidth[s] as number);
      if (apart(this.ends, s * 4, p, p, reach)) return;
      if (closest(x, y, x, y, this.ends, s) < reach) clear = false;
    });
    return clear;
  }

  /**
   * True where a road of this tier may be driven from `a` to `b`: wherever the
   * step comes within reach of another road, it crosses or leaves that road at
   * {@link MIN_MEET} or more. It may not come near the end of a road at all,
   * other than by leaving or meeting it there, and it may not cross two roads
   * where they cross each other, or one road twice where it bends back: that
   * is a junction it passes through without meeting. `trail` is the road laid
   * so far: its crossings, so two steps cannot do that either, and its start,
   * whose junction the step may stay near. The step adds its own crossings.
   * The line of a segment that touches `meet` is left to {@link meets}.
   */
  stepOk(a: Point, b: Point, tier: RoadTier, trail: Trail = { crossed: [] }, meet?: Point): boolean {
    const half = footprintHalfWidth(tier);
    const heading = atan2(b.y - a.y, b.x - a.x);
    const crossed = trail.crossed;
    const before = crossed.length;
    let ok = true;
    this.visit(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), half, (s) => {
      if (!ok) return;
      const e = this.ends;
      const k = s * 4;
      const reach = half + (this.halfWidth[s] as number);
      // A segment whose box stands a reach clear of the step's is further
      // than a reach from every part of it, so nothing below can refuse it.
      if (apart(e, k, a, b, reach)) return;
      // The end of a road that met nothing stands on whatever passes within
      // reach of it, crossing or not, so a step keeps that far from it. A step
      // from that end, or meeting a road on it, is a junction there instead.
      for (const [flag, end] of [[s * 2, k], [s * 2 + 1, k + 2]] as const) {
        if (this.terminal[flag] !== true || touches(e, end, a) || (meet !== undefined && touches(e, end, meet))) continue;
        if (trail.start !== undefined && touches(e, end, trail.start)) continue;
        if (toSegment(e[end] as number, e[end + 1] as number, a.x, a.y, b.x, b.y) < reach) {
          ok = false;
          return;
        }
      }
      if (meet !== undefined && (touches(e, k, meet) || touches(e, k + 2, meet))) return;
      const distance = closest(a.x, a.y, b.x, b.y, e, s);
      const t = closestT;
      if (distance >= reach) return;
      // Near only a corner of the segment, the step does not run beside its
      // line; the segment on the other side of the corner answers for that.
      if (distance > 0 && (t <= 0 || t >= 1)) return;
      const along = atan2((e[k + 3] as number) - (e[k + 1] as number), (e[k + 2] as number) - (e[k] as number));
      if (directionDelta(heading, along) < TRACE_MEET) {
        ok = false;
        return;
      }
      if (distance > 0) return;
      const x = (e[k] as number) + ((e[k + 2] as number) - (e[k] as number)) * t;
      const y = (e[k + 1] as number) + ((e[k + 3] as number) - (e[k + 1] as number)) * t;
      const width = this.halfWidth[s] as number;
      // A step that starts on a road, or ends on one, touches it there: that is
      // the junction, not a crossing.
      if (hypot(x - a.x, y - a.y) <= SAME_PLACE || hypot(x - b.x, y - b.y) <= SAME_PLACE) return;
      // Nor may it cross a road beside the junction it started from or ends on.
      for (const junction of [trail.start, meet]) {
        if (junction !== undefined && hypot(x - junction.x, y - junction.y) < width + half) ok = false;
      }
      if (!ok) return;
      // A highway is crossed at one of its slots or not at all (spec section 6.2).
      if (this.crossable[s] !== true) {
        ok = false;
        return;
      }
      for (let c = 0; c < crossed.length; c += 4) {
        if (hypot((crossed[c] as number) - x, (crossed[c + 1] as number) - y) < width + (crossed[c + 3] as number)) ok = false;
      }
      crossed.push(x, y, this.curve[s] as number, width);
    });
    if (!ok) crossed.length = before;
    return ok;
  }

  /**
   * True where a straight run from `a` to `b` crosses no highway away from its
   * slots. It asks nothing else: the deck of an island link spans a strait and
   * is carried over what stands at the shore, but a highway still keeps the
   * rule of spec section 6.2.
   */
  crossesAtSlots(a: Point, b: Point, tier: RoadTier): boolean {
    let ok = true;
    this.visit(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), footprintHalfWidth(tier), (s) => {
      if (!ok || this.crossable[s] === true) return;
      if (closest(a.x, a.y, b.x, b.y, this.ends, s) > 0) return;
      const e = this.ends;
      const k = s * 4;
      const x = (e[k] as number) + ((e[k + 2] as number) - (e[k] as number)) * closestT;
      const y = (e[k + 1] as number) + ((e[k + 3] as number) - (e[k + 1] as number)) * closestT;
      // A run that starts or ends on the highway joins it there.
      if (hypot(x - a.x, y - a.y) > SAME_PLACE && hypot(x - b.x, y - b.y) > SAME_PLACE) ok = false;
    });
    return ok;
  }

  /**
   * True where a road of this tier arriving from `from` may end on `at`: it
   * leaves every road with a point there at {@link MIN_MEET} or more, stands
   * clear of every road it has crossed on the way, and the last step keeps off
   * every other road.
   */
  meets(at: Point, from: Point, tier: RoadTier, trail: Trail = { crossed: [] }): boolean {
    const ray = atan2(from.y - at.y, from.x - at.x);
    let ok = true;
    this.visit(at.x, at.y, at.x, at.y, 0, (s) => {
      const e = this.ends;
      const k = s * 4;
      for (const [near, far] of [[k, k + 2], [k + 2, k]] as const) {
        if (!touches(e, near, at)) continue;
        const other = atan2((e[far + 1] as number) - at.y, (e[far] as number) - at.x);
        let turn = Math.abs(ray - other) % (2 * Math.PI);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn < TRACE_MEET) ok = false;
      }
    });
    // A road that has just crossed another one meets nothing beside that
    // crossing: the two places would stand inside one junction.
    const half = footprintHalfWidth(tier);
    const crossed = trail.crossed;
    for (let c = 0; c < crossed.length; c += 4) {
      if (hypot((crossed[c] as number) - at.x, (crossed[c + 1] as number) - at.y) < half + (crossed[c + 3] as number)) return false;
    }
    return ok && this.stepOk(from, at, tier, { crossed: [...crossed], start: trail.start }, at);
  }

  /** Every segment filed near a box grown by `reach` plus the widest road, once each. */
  private visit(minX: number, minY: number, maxX: number, maxY: number, reach: number, fn: (s: number) => void): void {
    const grow = reach + this.widest + SAME_PLACE;
    const x0 = this.column(minX - grow);
    const x1 = this.column(maxX + grow);
    const y0 = this.column(minY - grow);
    const y1 = this.column(maxY + grow);
    const query = ++this.query;
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        for (const s of this.buckets[iy * this.n + ix] as number[]) {
          if (this.stamp[s] === query || this.released[s] === true) continue;
          this.stamp[s] = query;
          fn(s);
        }
      }
    }
  }

  private column(v: number): number {
    return clamp(Math.floor((v - this.origin) / CELL), 0, this.n - 1);
  }
}

/**
 * Where two segments cross, or undefined. A crossing within {@link SAME_PLACE}
 * of an end of either is no crossing: the two roads share that point, or meet
 * at the segment beside it.
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
  const at = { x: a.x + rx * t, y: a.y + ry * t };
  for (const end of [a, b, c, d]) if (hypot(at.x - end.x, at.y - end.y) < SAME_PLACE) return undefined;
  return at;
}

/** True when the end of a segment stored at `k` stands on a place. */
function touches(ends: readonly number[], k: number, p: Point): boolean {
  return Math.abs((ends[k] as number) - p.x) <= SAME_PLACE && Math.abs((ends[k + 1] as number) - p.y) <= SAME_PLACE;
}

/**
 * True when the box of the stored segment at `k` and the box of the segment
 * from `a` to `b` stand at least `reach` apart along one axis.
 */
function apart(ends: readonly number[], k: number, a: Point, b: Point, reach: number): boolean {
  const cx = ends[k] as number;
  const cy = ends[k + 1] as number;
  const dx = ends[k + 2] as number;
  const dy = ends[k + 3] as number;
  return (
    Math.min(cx, dx) - Math.max(a.x, b.x) >= reach ||
    Math.min(a.x, b.x) - Math.max(cx, dx) >= reach ||
    Math.min(cy, dy) - Math.max(a.y, b.y) >= reach ||
    Math.min(a.y, b.y) - Math.max(cy, dy) >= reach
  );
}

/** Metres from a point to the segment from (ax, ay) to (bx, by). */
function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const rx = bx - ax;
  const ry = by - ay;
  const span = rx * rx + ry * ry;
  const u = span === 0 ? 0 : clamp(((px - ax) * rx + (py - ay) * ry) / span, 0, 1);
  return hypot(ax + rx * u - px, ay + ry * u - py);
}

/**
 * Metres between the segment from (ax, ay) to (bx, by) and the stored segment
 * `s`, with where along `s` they come closest in {@link closestT}. Two segments
 * that cross are no distance apart. It allocates nothing, because the tracer
 * asks it for every segment near every step.
 */
function closest(ax: number, ay: number, bx: number, by: number, ends: readonly number[], s: number): number {
  const k = s * 4;
  const cx = ends[k] as number;
  const cy = ends[k + 1] as number;
  const dx = ends[k + 2] as number;
  const dy = ends[k + 3] as number;
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denominator = rx * sy - ry * sx;
  if (denominator !== 0) {
    const u = ((cx - ax) * ry - (cy - ay) * rx) / denominator;
    const v = ((cx - ax) * sy - (cy - ay) * sx) / denominator;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
      closestT = u;
      return 0;
    }
  }
  // Apart, the closest pair has an end of one of the two segments in it.
  let best = Infinity;
  let bestT = 0;
  const along = sx * sx + sy * sy;
  const ta = along === 0 ? 0 : clamp(((ax - cx) * sx + (ay - cy) * sy) / along, 0, 1);
  const da = hypot(ax - cx - sx * ta, ay - cy - sy * ta);
  if (da < best) {
    best = da;
    bestT = ta;
  }
  const tb = along === 0 ? 0 : clamp(((bx - cx) * sx + (by - cy) * sy) / along, 0, 1);
  const db = hypot(bx - cx - sx * tb, by - cy - sy * tb);
  if (db < best) {
    best = db;
    bestT = tb;
  }
  const dc = toSegment(cx, cy, ax, ay, bx, by);
  if (dc < best) {
    best = dc;
    bestT = 0;
  }
  const dd = toSegment(dx, dy, ax, ay, bx, by);
  if (dd < best) {
    best = dd;
    bestT = 1;
  }
  closestT = bestT;
  return best;
}
