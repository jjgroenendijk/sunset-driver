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
 *
 * The points of the network are filed in buckets, so "is there a road here?"
 * costs a handful of comparisons. The segments and the rules of the ground they
 * claim are {@link NetworkClearance}, which this extends.
 */
import { clamp, dist, lerp } from '../core/math.ts';
import { toSegment } from './crossing-line.ts';
import { curveDistances } from './ribbon.ts';
import { deckApart, settleCrossings, type DraftLine, type PointEdit } from './crossing-plan.ts';
import type { CrossingNetwork } from './crossing-rules.ts';
import { cutBack, dropPoint, FOOT_MARGIN, HALF_FEET, nudgeOff, onRamp, overpassFeet, rampsAt, sliceLine, withPointAlong, type HighwayMeet, type RampPlan } from './diamonds.ts';
import { NetworkClearance, SAME_PLACE } from './network-clearance.ts';
import { pointOnFill } from './overpass.ts';
import { selfOverlap } from './self-overlap.ts';
import { mayJoin } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/** Side of one bucket of the points, in metres. Small enough that a bucket holds few streets. */
const CELL = 60;

/** A point of the network already laid: where it stands, and the curve and index it is. */
export interface NetworkHit {
  x: number;
  y: number;
  curve: number;
  index: number;
}

/** A road as it is proposed: everything the network does not decide. */
export type RoadDraft = Omit<RoadCurve, 'id' | 'nodes'>;

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
  /** The stretches of each highway, by id, that a road already passes under the slots of. */
  private readonly slotsUsed: number[][] = [];
  /** The ids of the ramps laid so far, which no other road may lie on (`onRamp`). */
  private readonly ramps: number[] = [];
  /** Every road committed since {@link takeLaid} was last asked, ramps and all. */
  private laid: RoadCurve[] = [];

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
   * places. Undefined where the network refuses the road: fewer than two
   * points, a road that lies over itself, or a crossing no piece of it can be
   * kept clear of. A road asked for `whole` is refused rather than shortened.
   */
  add(proposed: RoadDraft, whole = false): RoadCurve | undefined {
    if (proposed.points.length < 2 || selfOverlap(proposed.points, proposed.tier) !== undefined) return undefined;
    const meets = proposed.tier === 'arterial' && proposed.ramp === undefined ? this.interchangesOn(proposed.points) : [];
    if (meets.length > 1) return this.addPieces(proposed, meets, whole);
    if (meets.length === 1) return this.addWithDiamond(proposed, meets[0] as number, whole);
    const settled = settleCrossings(this, proposed, whole);
    if (settled === undefined || onRamp(this.ramps.map((id) => this.curves[id] as RoadCurve), settled.road)) return undefined;
    return this.commit(settled.road, settled.edits);
  }

  /**
   * The roads committed since the last call, which is more than {@link add}
   * returns: a diamond can lay an arterial in two halves, and an arterial that
   * reaches two interchanges is laid in pieces. The fill seeds the next
   * generation from every one of them.
   */
  takeLaid(): RoadCurve[] {
    const out = this.laid;
    this.laid = [];
    return out;
  }

  /** Write a settled road into the graph: the points the laid roads take for it first, then the road itself. */
  private commit(draft: DraftLine, edits: readonly PointEdit[]): RoadCurve {
    // From the last point back, so an index still to be used never moves.
    const sorted = [...edits].sort((m, n) => m.curve - n.curve || n.segment - m.segment || n.at - m.at);
    for (const edit of sorted) this.insertPoint(edit.curve, edit.segment, edit);
    const { overHighway: _, ...line } = draft;
    const id = this.curves.length;
    const points = line.points.slice();
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
    const curve: RoadCurve = { ...line, id, points, nodes };
    for (let k = 0; k < points.length; k++) {
      const node = nodes[k] as number;
      if (node >= 0) (this.nodes[node] as NetworkNode).on.push({ curve: id, index: k });
    }
    this.takeSlots(curve);
    this.laid.push(curve);
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
   * A stretch of a highway runs from one interchange to the next, and one road
   * at most passes under its slots (issue #676). A road that passes under a
   * highway is a severance, and two of them where no interchange stands
   * between are two severances the traffic could have used one ramp for.
   */
  override slotTaken(curve: number, segment: number): boolean {
    const road = this.curves[curve];
    if (road === undefined || road.tier !== 'highway') return false;
    return (this.slotsUsed[curve] ?? []).includes(stretchOf(road, segment));
  }

  /** Mark the stretches of highway a road about to be laid passes under the slots of. */
  private takeSlots(curve: RoadCurve): void {
    if (curve.tier === 'highway') return;
    for (let i = 0; i + 1 < curve.points.length; i++) {
      for (const hit of this.crossingsAlong(curve.points[i] as Point, curve.points[i + 1] as Point)) {
        const highway = this.curves[hit.curve] as RoadCurve;
        if (highway.tier !== 'highway' || !(highway.slots ?? []).includes(hit.segment)) continue;
        const used = (this.slotsUsed[hit.curve] ??= []);
        const stretch = stretchOf(highway, hit.segment);
        if (!used.includes(stretch)) used.push(stretch);
      }
    }
  }

  // ------------------------------------------------------ interchanges

  /** The points of a line that stand on a highway away from its ends: where an arterial would meet it at grade. */
  private interchangesOn(points: readonly Point[]): number[] {
    const out: number[] = [];
    for (let k = 0; k < points.length; k++) if (this.highwayAt(points[k] as Point) !== undefined) out.push(k);
    return out;
  }

  /**
   * The highways standing on a place, each with its point there: the ones the
   * place is inside first, then the ones that end there. Undefined unless it
   * is inside at least one, which is where an arterial would meet it at grade.
   */
  private highwayAt(p: Point): HighwayMeet[] | undefined {
    const hit = this.pointAt(p.x, p.y);
    if (hit === undefined) return undefined;
    const inside: HighwayMeet[] = [];
    const ends: HighwayMeet[] = [];
    for (const { curve, index } of this.pointsOn(hit)) {
      const road = this.curves[curve] as RoadCurve;
      if (road.tier !== 'highway') continue;
      (index > 0 && index < road.points.length - 1 ? inside : ends).push({ highway: road, at: index });
    }
    return inside.length === 0 ? undefined : [...inside, ...ends];
  }

  /**
   * Lay an arterial that reaches a highway's interchange at point `k`, with
   * the ramps of a diamond instead of a junction (`diamonds.ts`). An arterial
   * that ends there takes half a diamond. One that runs through is carried
   * over the highway and takes the whole diamond; where it cannot be, each
   * side of it takes half a diamond of its own. Undefined where no ramps fit.
   *
   * A road asked for `whole` is never split: half of it laid would reach
   * nothing it was laid for. Only an island link asks, and a link that ends on
   * an interchange leaves it for its deck at once, over the few metres of
   * shore a coastal highway leaves. Where no half diamond fits there, the link
   * meets the highway at grade, as a junction at an interchange (spec section
   * 6.2); without it the island is reached by no arterial.
   */
  private addWithDiamond(proposed: RoadDraft, k: number, whole: boolean): RoadCurve | undefined {
    const place = proposed.points[k] as Point;
    const last = proposed.points.length - 1;
    if (k === 0 || k === last) {
      const half = this.halfDiamond(proposed, k === 0, place, whole);
      if (half !== undefined || !whole || proposed.bridges.length === 0) return half;
      const settled = settleCrossings(this, proposed, whole);
      if (settled === undefined || onRamp(this.ramps.map((id) => this.curves[id] as RoadCurve), settled.road)) return undefined;
      return this.commit(settled.road, settled.edits);
    }
    const over = this.overpassDiamond(proposed, k, place, whole);
    if (over !== undefined || whole) return over;
    const one = this.halfDiamond(sliceLine(proposed, 0, k), false, place, whole);
    const two = this.halfDiamond(sliceLine(proposed, k, last), true, place, whole);
    if (one === undefined || two === undefined) return one ?? two;
    const length = (curve: RoadCurve): number => curveDistances(curve.points)[curve.points.length - 1] as number;
    return length(two) > length(one) ? two : one;
  }

  /**
   * An arterial that reaches more than one interchange, cut halfway between
   * each two into pieces that reach one each, and each piece laid with its own
   * diamond. The pieces meet end to end where they were cut. The longest piece
   * laid comes back.
   */
  private addPieces(proposed: RoadDraft, meets: readonly number[], whole: boolean): RoadCurve | undefined {
    const cuts = [0];
    for (let i = 0; i + 1 < meets.length; i++) cuts.push(Math.round(((meets[i] as number) + (meets[i + 1] as number)) / 2));
    cuts.push(proposed.points.length - 1);
    let longest: RoadCurve | undefined;
    let best = 0;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const piece = sliceLine(proposed, cuts[i] as number, cuts[i + 1] as number) as RoadDraft;
      const laid = this.add(piece, whole);
      if (laid === undefined) continue;
      const length = curveDistances(laid.points)[laid.points.length - 1] as number;
      if (length > best) {
        best = length;
        longest = laid;
      }
    }
    return longest;
  }

  /** An arterial that ends on the interchange at `place`, cut back to a foot that takes two ramps. */
  private halfDiamond(draft: DraftLine, atStart: boolean, place: Point, whole: boolean): RoadCurve | undefined {
    const meets = this.highwayAt(place);
    if (meets === undefined) return undefined;
    for (const foot of HALF_FEET) {
      const cut = cutBack(draft, atStart, foot, (p) => this.pointAt(p.x, p.y) !== undefined);
      if (cut === undefined || !this.footRuns(cut, atStart ? 0 : cut.points.length - 1)) continue;
      const settled = settleCrossings(this, cut, whole);
      if (settled === undefined) continue;
      const road = settled.road;
      const f = atStart ? 0 : road.points.length - 1;
      const want = cut.points[atStart ? 0 : cut.points.length - 1] as Point;
      const p = road.points[f] as Point;
      if (dist(p.x, p.y, want.x, want.y) > SAME_PLACE || this.pointAt(p.x, p.y) !== undefined) continue;
      if (this.interchangesOn(road.points).length > 0) continue;
      const ramps = rampsAt(this, road, f, meets);
      if (ramps === undefined) continue;
      const curve = this.commit(road, settled.edits);
      this.layRamps(ramps, curve.id);
      return curve;
    }
    return undefined;
  }

  /**
   * An arterial that runs through the interchange at point `k`, carried over
   * the highway there. Each foot of the overpass, moved {@link FOOT_MARGIN}
   * further out so the ramps' junction stands off its ramp, takes two ramps.
   */
  private overpassDiamond(draft: RoadDraft, k: number, place: Point, whole: boolean): RoadCurve | undefined {
    const meets = this.highwayAt(place);
    if (meets === undefined) return undefined;
    const trunk = meets[0] as HighwayMeet;
    const crosses = (line: DraftLine, from: number, to: number): boolean => {
      for (let i = from; i < to; i++) {
        if (this.crossingsAlong(line.points[i] as Point, line.points[i + 1] as Point).some((c) => c.curve === trunk.highway.id)) return true;
      }
      return false;
    };
    let dropped = dropPoint(draft, k);
    if (dropped !== undefined && !crosses(dropped, k - 1, k)) dropped = dropPoint(draft, k, nudgeOff(draft, k, trunk.highway, trunk.at));
    if (dropped === undefined) return undefined;
    if (!crosses(dropped, k - 1, k + 1)) return undefined;
    const settled = settleCrossings(this, { ...dropped, overHighway: true }, whole);
    if (settled === undefined) return undefined;
    if (this.interchangesOn(settled.road.points).length > 0) return undefined;
    const feet = overpassFeet(settled.road, place);
    if (feet === undefined) return undefined;
    const distances = curveDistances(settled.road.points);
    // The far foot first, so the near one's index does not move.
    const far = withPointAlong(settled.road, (distances[feet[1]] as number) + FOOT_MARGIN);
    if (far === undefined) return undefined;
    const near = withPointAlong(far.line, (distances[feet[0]] as number) - FOOT_MARGIN);
    if (near === undefined) return undefined;
    const road = near.line;
    const feetAt = [near.index, far.index + (near.index <= far.index ? 1 : 0)];
    for (const f of feetAt) {
      const p = road.points[f] as Point;
      if (this.pointAt(p.x, p.y) !== undefined || !this.footRuns(road, f)) return undefined;
    }
    const first = rampsAt(this, road, feetAt[0] as number, meets);
    if (first === undefined) return undefined;
    const second = rampsAt(this, road, feetAt[1] as number, meets, first);
    if (second === undefined) return undefined;
    const curve = this.commit(road, settled.edits);
    this.layRamps([...first, ...second], curve.id);
    return curve;
  }

  /**
   * True where the ground carries the arterial on each segment beside its foot
   * at point `f`. The foot is a point put into a segment, and a short piece of
   * a segment can climb harder than the whole of it did.
   */
  private footRuns(line: DraftLine, f: number): boolean {
    const p = line.points[f] as Point;
    for (const q of [line.points[f - 1], line.points[f + 1]]) if (q !== undefined && !this.canRun(q, p, line.tier)) return false;
    return true;
  }

  /** Lay the ramps of an interchange: each landing is made a point of the highway first, then the ramp joins it. */
  private layRamps(ramps: readonly RampPlan[], arterial: number): void {
    for (const ramp of ramps) {
      const highway = ramp.highway;
      if (this.pointAt(ramp.landing.x, ramp.landing.y) === undefined) {
        const points = (this.curves[highway] as RoadCurve).points;
        let segment = 0;
        let best = Infinity;
        for (let i = 0; i + 1 < points.length; i++) {
          const off = toSegment(ramp.landing, points[i] as Point, points[i + 1] as Point);
          if (off < best) {
            best = off;
            segment = i;
          }
        }
        this.insertPoint(highway, segment, ramp.landing);
      }
      const line: DraftLine = { tier: 'ramp', points: ramp.points, bridges: [], tunnels: [], interchanges: [], ramp: { highway, arterial, exit: ramp.exit } };
      this.ramps.push(this.commit(line, []).id);
    }
  }

  /**
   * True where {@link add} would lay a road joined to the network: its settled
   * line takes a junction with a laid road or stands on a point of one.
   * Nothing is written.
   */
  wouldJoin(proposed: RoadDraft, whole = false): boolean {
    if (proposed.points.length < 2 || selfOverlap(proposed.points, proposed.tier) !== undefined) return false;
    const settled = settleCrossings(this, proposed, whole);
    if (settled === undefined) return false;
    return settled.edits.length > 0 || settled.road.points.some((p) => this.pointAt(p.x, p.y) !== undefined);
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
    road.interchanges = road.interchanges.map((i) => (i >= at ? i + 1 : i));
    if (road.lift !== undefined) road.lift.splice(at, 0, lerp(road.lift[segment] as number, road.lift[at] as number, t));
    (this.islands[id] as number[]).splice(at, 0, this.islandOf(p.x, p.y));
    (this.pointBuckets[this.pointColumn(p.y) * this.rows + this.pointColumn(p.x)] as number[]).push(id, at);
    this.splitSegment(road, segment);
  }

  // ------------------------------------------------------ what a plan asks

  /**
   * Every curve point standing on the node a place is; the point it stands on
   * alone where that point is no node, and none where no road has a point
   * there. This is the node as `graph.ts` will read it, which is how a plan
   * knows the junction a place will carry (`plane-lift.ts`).
   */
  nodeAt(p: Point): { curve: number; index: number }[] {
    const hit = this.pointAt(p.x, p.y);
    return hit === undefined ? [] : this.pointsOn(hit);
  }

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
    // A point on a deck stands off the ground, and a junction is on it. A point
    // the embankment reaches does not: the carve makes the ground up to the
    // road there, and `bed.ts` levels the junction's plane to the height the
    // road drives, so a junction there is a junction on the ground. That is
    // what lets a street meet the road at the end of a bridge (issue #593).
    if ((road.lift?.[index] ?? 0) > 0 && !pointOnFill(road, index)) return false;
    // A ramp is one-way from end to end, and nothing joins it on the way.
    if (road.ramp !== undefined) return false;
    return mayJoin(joiner, road.tier, road.interchanges.includes(index));
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

/** The stretch of a highway a segment stands in: how many of its interchanges come at or before the segment's start. */
function stretchOf(highway: RoadCurve, segment: number): number {
  let count = 0;
  for (const i of highway.interchanges) if (i <= segment) count++;
  return count;
}
