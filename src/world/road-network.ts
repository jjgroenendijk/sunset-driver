/**
 * The road network while it is traced: one planar graph that every road is
 * added to, and that every question about the roads laid so far is asked of
 * (spec section 6.5).
 *
 * A node is a place where roads meet, or the free end of one. An edge is the
 * run of a curve between two of its nodes, with the curve's tier and polyline.
 * Each curve carries the node every point stands on in `RoadCurve.nodes`, so
 * the graph is stored with the roads and `graph.ts` reads it from there. No
 * code after this one works out where roads meet from their coordinates.
 *
 * A road goes in through {@link RoadNetwork.add}, and the edit is decided there:
 *
 * - A point on a node of the network joins that node.
 * - A point on a point of another curve that is not a node yet splits that
 *   curve's edge there, and both roads join the new node.
 * - Both ends of a road are nodes, whether they meet anything or not.
 * - A road that lies over its own carriageway is refused (`self-overlap.ts`).
 * - Every place the road crosses a laid one is decided now: a junction both
 *   take a point at, a crossing already a clearance apart, a raise of the new
 *   road, or a road shortened back from the crossing (`crossing-plan.ts`).
 * - A road carried over a highway at one of its interchanges takes the four
 *   ramps of a diamond with it, laid here in the same call (`ramps.ts`).
 *
 * The points of the network are filed in buckets, so "is there a road here?"
 * costs a handful of comparisons. The segments and the rules of the ground they
 * claim are {@link NetworkClearance}, which this extends.
 */
import { clamp, dist, lerp } from '../core/math.ts';
import { compareNumbers } from '../core/sort.ts';
import { deckApart, settleCrossings, type DraftLine } from './crossing-plan.ts';
import type { CrossingNetwork } from './crossing-rules.ts';
import { NetworkClearance, SAME_PLACE } from './network-clearance.ts';
import { RAMP_TIER, type DiamondPlan, type RampEnd } from './ramps.ts';
import { selfOverlap } from './self-overlap.ts';
import { mayJoin } from './tiers.ts';
import type { Interchange, Point, RoadCurve, RoadTier } from './types.ts';

/** Side of one bucket of the points, in metres. Small enough that a bucket holds few streets. */
const CELL = 60;

/** A point of the network already laid: where it stands, and the curve and index it is. */
export interface NetworkHit {
  x: number;
  y: number;
  curve: number;
  index: number;
}

/**
 * A road as it is proposed: everything the network does not decide. Its
 * interchanges are point indices; the network turns each into the structure the
 * curve carries once the road is laid.
 */
export type RoadDraft = DraftLine;

/** The ground a network decides its crossings on. */
export interface NetworkGround {
  /** True where a road of this tier may run straight from `a` to `b`: dry, and no steeper than the tier allows. */
  canRun(a: Point, b: Point, tier: RoadTier): boolean;
  /** The natural ground at a place. */
  heightAt(x: number, y: number): number;
}

/** Dry, level ground everywhere: what a network built by hand stands on. */
const FLAT_GROUND: NetworkGround = { canRun: () => true, heightAt: () => 0 };

/** A node of the network, and every curve point that stands on it. */
interface NetworkNode {
  x: number;
  y: number;
  on: { curve: number; index: number }[];
}

export class RoadNetwork extends NetworkClearance implements CrossingNetwork {
  /** Every road laid, by id. */
  readonly curves: RoadCurve[] = [];
  private readonly nodes: NetworkNode[] = [];
  private readonly pointCell: number;
  private readonly rows: number;
  private readonly pointOrigin: number;
  /** The points of every curve, as curve and index pairs, two numbers to an entry. */
  private readonly pointBuckets: number[][] = [];
  /** The island each point stands on, by curve and index. */
  private readonly islands: number[][] = [];
  private readonly islandOf: (x: number, y: number) => number;
  private readonly ground: NetworkGround;

  constructor(size: number, islandOf: (x: number, y: number) => number, cell = CELL, ground: NetworkGround = FLAT_GROUND) {
    super(size);
    this.ground = ground;
    this.pointCell = cell;
    this.pointOrigin = -size / 2 - 2 * cell;
    this.rows = Math.ceil((size + 4 * cell) / cell) + 1;
    this.islandOf = islandOf;
    for (let i = 0; i < this.rows * this.rows; i++) this.pointBuckets.push([]);
  }

  get empty(): boolean {
    return this.curves.length === 0;
  }

  /**
   * Add a road to the graph. It is joined to the nodes it stands on, splits the
   * edges whose points it stands on, and has each of its crossings decided. The
   * curve that comes back can be shorter than the road proposed, or raised in
   * places, and a road carried over a highway brings the ramps of a diamond
   * with it. Undefined where the network refuses the road: fewer than two
   * points, a road that lies over itself, or a crossing no piece of it can be
   * kept clear of. A road asked for `whole` is refused rather than shortened.
   */
  add(proposed: RoadDraft, whole = false): RoadCurve | undefined {
    if (proposed.points.length < 2 || selfOverlap(proposed.points, proposed.tier) !== undefined) return undefined;
    const settled = settleCrossings(this, proposed, whole);
    if (settled === undefined) return undefined;
    // From the last point back, so an index still to be used never moves.
    const edits = [...settled.edits].sort((m, n) => m.curve - n.curve || n.segment - m.segment || n.at - m.at);
    for (const edit of edits) {
      this.insertPoint(edit.curve, edit.segment, edit);
      if (edit.interchange === true) this.markInterchange(edit.curve, edit.segment + 1);
    }
    const curve = this.layCurve(settled.road);
    for (const diamond of settled.diamonds) this.layDiamond(diamond, curve);
    return curve;
  }

  /** Put a settled road into the graph: its nodes, its segments and the ground its points stand on. */
  private layCurve(draft: DraftLine): RoadCurve {
    const id = this.curves.length;
    const points = draft.points.slice();
    const nodes = new Array<number>(points.length).fill(-1);
    for (let k = 0; k < points.length; k++) {
      const p = points[k] as Point;
      const hit = this.pointAt(p.x, p.y);
      if (hit === undefined) continue;
      const node = this.nodeOf(hit.curve, hit.index);
      const at = this.nodes[node] as NetworkNode;
      nodes[k] = node;
      points[k] = { x: at.x, y: at.y };
    }
    for (const k of [0, points.length - 1]) {
      if (nodes[k] !== -1) continue;
      const p = points[k] as Point;
      nodes[k] = this.nodes.length;
      this.nodes.push({ x: p.x, y: p.y, on: [] });
    }
    const interchanges = draft.interchanges.map((at) => ({ at, ramps: [], heads: [] }));
    const curve: RoadCurve = { ...draft, id, points, nodes, interchanges };
    for (let k = 0; k < points.length; k++) {
      const node = nodes[k] as number;
      if (node >= 0) (this.nodes[node] as NetworkNode).on.push({ curve: id, index: k });
    }
    this.curves.push(curve);
    this.fileSegments(curve);
    const islands: number[] = [];
    for (let k = 0; k < points.length; k++) {
      const p = points[k] as Point;
      islands.push(this.islandOf(p.x, p.y));
      (this.pointBuckets[this.pointColumn(p.y) * this.rows + this.pointColumn(p.x)] as number[]).push(id, k);
    }
    this.islands.push(islands);
    return curve;
  }

  /**
   * Lay the four ramps of a diamond and file them on the highway's
   * interchange. Each ramp stands on a point the highway or the new road
   * already has, so the ends join those nodes; the curve between them was
   * vetted against the network while the road was still a draft (`ramps.ts`),
   * and the ends move by no more than the snap that makes a node.
   */
  /**
   * Note a point of a highway as an interchange of its own. A crossing that
   * could carry no diamond is joined on the flat instead (`crossing-plan.ts`),
   * and a highway is joined only at an interchange, so the place the two roads
   * met is one.
   */
  private markInterchange(id: number, index: number): void {
    const road = this.curves[id] as RoadCurve;
    if (road.interchanges.some((x) => x.at === index)) return;
    road.interchanges.push({ at: index, ramps: [], heads: [] });
    road.interchanges.sort((m, n) => m.at - n.at);
  }

  private layDiamond(plan: DiamondPlan, road: RoadCurve): void {
    const highway = this.curves[plan.highway] as RoadCurve;
    const interchange = highway.interchanges.find((x) => dist((highway.points[x.at] as Point).x, (highway.points[x.at] as Point).y, plan.interchange.x, plan.interchange.y) <= SAME_PLACE);
    if (interchange === undefined) return;
    for (const ramp of plan.ramps) {
      const points = ramp.points.slice();
      points[points.length - 1] = this.rampEnd(ramp.to, road, points[points.length - 1] as Point);
      points[0] = this.rampEnd(ramp.from, road, points[0] as Point);
      const laid = this.layCurve({ tier: RAMP_TIER, points, bridges: [], tunnels: [], interchanges: [], oneWay: true });
      interchange.ramps.push(laid.id);
      const head = ramp.from.curve >= 0 ? points[0] : points[points.length - 1];
      const at = highway.points.findIndex((p) => dist(p.x, p.y, (head as Point).x, (head as Point).y) <= SAME_PLACE);
      if (at >= 0 && !interchange.heads.includes(at)) interchange.heads.push(at);
    }
    interchange.ramps.sort(compareNumbers);
    interchange.heads.sort(compareNumbers);
  }

  /**
   * Where a ramp ends now. A point of the road being added moves by the snap
   * that joins it to a node, which is less than `SAME_PLACE`, so the planned
   * place still finds it; a point of a laid curve has not moved at all, and
   * its index may have, so the place is what is kept and not the index.
   */
  private rampEnd(end: RampEnd, road: RoadCurve, planned: Point): Point {
    if (end.curve >= 0) return planned;
    const p = road.points[end.index] as Point;
    return { x: p.x, y: p.y };
  }

  /**
   * True where the point of a curve at `index` is a node another curve stands
   * on too: a junction there already.
   */
  sharedAt(curve: number, index: number): boolean {
    const node = (this.curves[curve] as RoadCurve).nodes[index] ?? -1;
    return node >= 0 && (this.nodes[node] as NetworkNode).on.some((o) => o.curve !== curve);
  }

  /** The curves standing on the node at a point of the network, ascending; empty where no node stands there. */
  curvesAt(p: Point): number[] {
    const hit = this.pointAt(p.x, p.y);
    if (hit === undefined) return [];
    const node = (this.curves[hit.curve] as RoadCurve).nodes[hit.index] ?? -1;
    if (node < 0) return [hit.curve];
    const out: number[] = [];
    for (const o of (this.nodes[node] as NetworkNode).on) if (!out.includes(o.curve)) out.push(o.curve);
    return out.sort((a, b) => a - b);
  }

  /**
   * The nearest road point within `radius`. One curve can be left out, which is
   * how a road ignores the road it branched off. With a `joiner` tier only
   * points that tier may junction at are returned; without one every point
   * counts, which is the question the fill asks about ground already covered.
   */
  nearest(x: number, y: number, radius: number, except = -1, joiner?: RoadTier): NetworkHit | undefined {
    let best: NetworkHit | undefined;
    let bestD = radius;
    this.eachPoint(x, y, radius, (curve, index, p) => {
      if (curve === except || !this.joinable(curve, index, joiner)) return;
      const d = dist(x, y, p.x, p.y);
      if (d > bestD) return;
      bestD = d;
      best = { x: p.x, y: p.y, curve, index };
    });
    return best;
  }

  /**
   * Every road point within `radius`, nearest first, on the terms of
   * {@link nearest}. Two points as near as each other come in the order they
   * were laid.
   */
  within(x: number, y: number, radius: number, except = -1, joiner?: RoadTier): NetworkHit[] {
    const found: { hit: NetworkHit; d: number }[] = [];
    this.eachPoint(x, y, radius, (curve, index, p) => {
      if (curve === except || !this.joinable(curve, index, joiner)) return;
      const d = dist(x, y, p.x, p.y);
      if (d <= radius) found.push({ hit: { x: p.x, y: p.y, curve, index }, d });
    });
    found.sort((a, b) => a.d - b.d || a.hit.curve - b.hit.curve || a.hit.index - b.hit.index);
    return found.map(({ hit }) => hit);
  }

  /**
   * True when a road of `joiner` may not begin where it stands, because a road
   * it is not allowed to junction with already has a point there. A fill road
   * starts at its seed, so a seed on such a point would junction there.
   */
  refuses(x: number, y: number, joiner: RoadTier): boolean {
    let refused = false;
    this.eachPoint(x, y, SAME_PLACE, (curve, index, p) => {
      if (!refused && !this.joinable(curve, index, joiner) && dist(x, y, p.x, p.y) <= SAME_PLACE) refused = true;
    });
    return refused;
  }

  /** The nearest road point standing on one island that `joiner` may junction at, at any distance. */
  nearestOnIsland(x: number, y: number, island: number, joiner: RoadTier): NetworkHit | undefined {
    let best: NetworkHit | undefined;
    let bestD = Infinity;
    for (const curve of this.curves) {
      const islands = this.islands[curve.id] as number[];
      for (let k = 0; k < curve.points.length; k++) {
        if (islands[k] !== island || !this.joinable(curve.id, k, joiner)) continue;
        const p = curve.points[k] as Point;
        const d = dist(x, y, p.x, p.y);
        if (d >= bestD) continue;
        bestD = d;
        best = { x: p.x, y: p.y, curve: curve.id, index: k };
      }
    }
    return best;
  }

  /** The point of the network a new point stands on, within {@link SAME_PLACE}, or undefined. */
  private pointAt(x: number, y: number): NetworkHit | undefined {
    return this.nearest(x, y, SAME_PLACE);
  }

  /**
   * Put a point into segment `segment` of a laid curve. Every index the curve
   * holds past it moves on by one: its nodes, decks, bores, slots,
   * interchanges and lift, and the entries the network files it under.
   */
  private insertPoint(id: number, segment: number, p: Point): void {
    const road = this.curves[id] as RoadCurve;
    const a = road.points[segment] as Point;
    const b = road.points[segment + 1] as Point;
    const span = dist(a.x, a.y, b.x, b.y);
    const t = span === 0 ? 0 : clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (span * span), 0, 1);
    const at = segment + 1;
    const shift = (segments: readonly number[]): number[] => {
      const out: number[] = [];
      for (const s of segments) {
        if (s < segment) out.push(s);
        else if (s === segment) out.push(s, s + 1);
        else out.push(s + 1);
      }
      return out;
    };
    // The entries filed past the new point move on by one, from the last back,
    // so no entry is moved onto one still to be moved.
    for (let k = road.points.length - 1; k >= at; k--) {
      const q = road.points[k] as Point;
      const bucket = this.pointBuckets[this.pointColumn(q.y) * this.rows + this.pointColumn(q.x)] as number[];
      for (let e = 0; e < bucket.length; e += 2) {
        if (bucket[e] === id && bucket[e + 1] === k) bucket[e + 1] = k + 1;
      }
      const node = road.nodes[k] as number;
      if (node < 0) continue;
      for (const entry of (this.nodes[node] as NetworkNode).on) if (entry.curve === id && entry.index === k) entry.index = k + 1;
    }
    road.points.splice(at, 0, { x: p.x, y: p.y });
    road.nodes.splice(at, 0, -1);
    road.bridges = shift(road.bridges);
    road.tunnels = shift(road.tunnels);
    if (road.slots !== undefined) road.slots = shift(road.slots);
    const move = (i: number): number => (i >= at ? i + 1 : i);
    road.interchanges = road.interchanges.map((x) => ({ at: move(x.at), ramps: x.ramps, heads: x.heads.map(move) }));
    if (road.lift !== undefined) road.lift.splice(at, 0, lerp(road.lift[segment] as number, road.lift[at] as number, t));
    (this.islands[id] as number[]).splice(at, 0, this.islandOf(p.x, p.y));
    (this.pointBuckets[this.pointColumn(p.y) * this.rows + this.pointColumn(p.x)] as number[]).push(id, at);
    this.splitSegment(road, segment);
  }

  // ------------------------------------------------------ what a plan asks

  /** The points the roads other than `except` run on to from a place. */
  neighboursAt(p: Point, except: number): Point[] {
    const hit = this.pointAt(p.x, p.y);
    if (hit === undefined) return [];
    const out: Point[] = [];
    for (const { curve, index } of this.pointsOn(hit)) {
      if (curve === except) continue;
      const road = this.curves[curve] as RoadCurve;
      for (const q of [road.points[index - 1], road.points[index + 1]]) if (q !== undefined) out.push(q);
    }
    return out;
  }

  /** True where a road of this tier may take a junction at every road point standing on a place. */
  joinableAt(p: Point, tier: RoadTier): boolean {
    const hit = this.pointAt(p.x, p.y);
    return hit === undefined || this.pointsOn(hit).every(({ curve, index }) => this.joinable(curve, index, tier));
  }

  /** The free ends of laid roads within `reach` of a place: ends no other road meets. */
  freeEnds(x: number, y: number, reach: number): { curve: number; at: Point }[] {
    const out: { curve: number; at: Point }[] = [];
    this.eachPoint(x, y, reach, (curve, index, p) => {
      const road = this.curves[curve] as RoadCurve;
      if (index !== 0 && index !== road.points.length - 1) return;
      if (this.pointsOn({ x: p.x, y: p.y, curve, index }).some((o) => o.curve !== curve)) return;
      out.push({ curve, at: p });
    });
    return out;
  }

  /** True where a deck from `a` to `b` stands a clearance apart from every road it crosses (`crossing-plan.ts`). */
  deckApart(a: Point, b: Point, tier: RoadTier): boolean {
    return deckApart(this, a, b, tier);
  }

  canRun(a: Point, b: Point, tier: RoadTier): boolean {
    return this.ground.canRun(a, b, tier);
  }

  heightAt(x: number, y: number): number {
    return this.ground.heightAt(x, y);
  }

  /** Every curve point on the node a point of the network stands on: the point alone where it is no node. */
  private pointsOn(hit: NetworkHit): { curve: number; index: number }[] {
    const node = (this.curves[hit.curve] as RoadCurve).nodes[hit.index] ?? -1;
    return node < 0 ? [{ curve: hit.curve, index: hit.index }] : (this.nodes[node] as NetworkNode).on;
  }

  /** The node at a point of a curve, made there first where the point is not one yet: the edge is split. */
  private nodeOf(curve: number, index: number): number {
    const road = this.curves[curve] as RoadCurve;
    const known = road.nodes[index] as number;
    if (known >= 0) return known;
    const p = road.points[index] as Point;
    const node = this.nodes.length;
    this.nodes.push({ x: p.x, y: p.y, on: [{ curve, index }] });
    road.nodes[index] = node;
    return node;
  }

  /** True when a road of `joiner` may end on the point of a curve at `index`. */
  private joinable(curve: number, index: number, joiner: RoadTier | undefined): boolean {
    if (joiner === undefined) return true;
    const road = this.curves[curve] as RoadCurve;
    // A raised point stands off the ground, and a junction is on it.
    if ((road.lift?.[index] ?? 0) > 0) return false;
    return mayJoin(joiner, road.tier, road.interchanges.some((x) => x.at === index));
  }

  /** Every point filed in a bucket within `radius` of a place, in the order they were laid bucket by bucket. */
  private eachPoint(x: number, y: number, radius: number, fn: (curve: number, index: number, p: Point) => void): void {
    const cx = this.pointColumn(x);
    const cy = this.pointColumn(y);
    const reach = Math.ceil(radius / this.pointCell);
    for (let iy = Math.max(0, cy - reach); iy <= Math.min(this.rows - 1, cy + reach); iy++) {
      for (let ix = Math.max(0, cx - reach); ix <= Math.min(this.rows - 1, cx + reach); ix++) {
        const bucket = this.pointBuckets[iy * this.rows + ix] as number[];
        for (let b = 0; b < bucket.length; b += 2) {
          const curve = bucket[b] as number;
          const index = bucket[b + 1] as number;
          fn(curve, index, (this.curves[curve] as RoadCurve).points[index] as Point);
        }
      }
    }
  }

  private pointColumn(v: number): number {
    return clamp(Math.floor((v - this.pointOrigin) / this.pointCell), 0, this.rows - 1);
  }
}
