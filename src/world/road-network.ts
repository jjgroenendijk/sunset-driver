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
 *
 * The points of the network are filed in buckets, so "is there a road here?"
 * costs a handful of comparisons. The segments and the rules of the ground they
 * claim are {@link NetworkClearance}, which this extends.
 */
import { clamp, dist } from '../core/math.ts';
import { NetworkClearance, SAME_PLACE } from './network-clearance.ts';
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

/** A node of the network, and every curve point that stands on it. */
interface NetworkNode {
  x: number;
  y: number;
  on: { curve: number; index: number }[];
}

export class RoadNetwork extends NetworkClearance {
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

  constructor(size: number, islandOf: (x: number, y: number) => number, cell = CELL) {
    super(size);
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
   * Add a road to the graph. It is joined to the nodes it stands on and splits
   * the edges whose points it stands on. Undefined where the network refuses
   * the road: fewer than two points, or a road that lies over itself.
   */
  add(draft: RoadDraft): RoadCurve | undefined {
    if (draft.points.length < 2) return undefined;
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
    const curve: RoadCurve = { ...draft, id, points, nodes };
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
