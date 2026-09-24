/**
 * The grade-separated crossings of the road graph (spec section 6.2): every
 * place one road passes over another without meeting it, which road is carried
 * on top, and the runs that meet there. `graph.ts` calls this once when it
 * builds the graph and re-exports what callers need.
 */
import { hypot } from '../core/libm.ts';
import type { GradeCrossing, RoadEdge } from './graph.ts';
import { Buckets, INDEX_CELL, type Bounds } from './graph-index.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/**
 * Metres a crossing has to stand clear of the ends of both segments. Roads that
 * meet share a point exactly, so a junction is not a crossing at all; but a road
 * that leaves another one at a shallow angle can put a crossing a fraction of a
 * millimetre from the point they share, and that is the same place, not an
 * overpass.
 */
const END_CLEARANCE = 0.01;
/**
 * Which road is carried over the other where two cross. A deck is on top of
 * whatever it passes and a bore is under it; between roads on the ground the
 * hierarchy decides, because a highway is not the road that stops.
 */
const CARRY_RANK: Record<RoadTier, number> = { highway: 5, arterial: 4, ramp: 3, street: 2, alley: 1, dirt: 0 };
const DECK_RANK = 6;
const BORE_RANK = -1;

/**
 * Every place two curves cross without sharing a point, and which road is
 * carried over the other there. A deck is always on top and a bore always
 * underneath; otherwise the wider tier goes over, and between two roads of one
 * tier the older keeps the ground. Both runs of both roads are marked, so the
 * crossing is on the graph whichever way a car is driving.
 *
 * Segments are looked up in a grid of buckets rather than compared with every
 * other segment, so this costs one walk over the network.
 */
export function findCrossings(roads: readonly RoadCurve[], edges: readonly RoadEdge[]): GradeCrossing[] {
  const segments = new Segments(roads, edges);
  if (segments.count === 0) return [];
  const grid = new Buckets(segments.bounds, INDEX_CELL);
  for (let s = 0; s < segments.count; s++) {
    const a = segments.head(s);
    const b = segments.tail(s);
    grid.add(s, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
  }

  // Only pairs that really cross are remembered, so the set stays small. A pair
  // found in a second shared bucket is tested again and dropped here.
  const found = new Set<number>();
  const crossings: GradeCrossing[] = [];
  for (let s = 0; s < segments.count; s++) {
    if (segments.edgeOf(s) < 0) continue;
    const from = segments.head(s);
    const to = segments.tail(s);
    grid.each(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.max(from.x, to.x), Math.max(from.y, to.y), (t) => {
      if (t <= s || segments.curveOf(t) === segments.curveOf(s) || segments.edgeOf(t) < 0) return;
      const at = crossPoint(from, to, segments.head(t), segments.tail(t));
      if (at === undefined) return;
      const key = s * segments.count + t;
      if (found.has(key)) return;
      found.add(key);
      const high = segments.carry(s) >= segments.carry(t) ? s : t;
      const low = high === s ? t : s;
      crossings.push({ over: segments.edgeOf(high), under: segments.edgeOf(low), x: at.x, y: at.y });
    });
  }

  crossings.sort((a, b) => a.over - b.over || a.under - b.under || a.x - b.x || a.y - b.y);
  for (let k = 0; k < crossings.length; k++) {
    const crossing = crossings[k] as GradeCrossing;
    markCrossing(edges, crossing.over, k);
    markCrossing(edges, crossing.under, k);
  }
  return crossings;
}

/** Note a crossing on one run and on the same run the other way. */
function markCrossing(edges: readonly RoadEdge[], edge: number, crossing: number): void {
  const run = edges[edge] as RoadEdge;
  run.crossings.push(crossing);
  if (run.twin >= 0) (edges[run.twin] as RoadEdge).crossings.push(crossing);
}

/**
 * The segments of every curve as one numbered list, with the run that covers
 * each and how readily it is carried over another road.
 */
class Segments {
  readonly count: number;
  readonly bounds: Bounds;
  private readonly roads: readonly RoadCurve[];
  private readonly curve: Int32Array;
  private readonly index: Int32Array;
  private readonly edge: Int32Array;
  private readonly rank: Int32Array;

  constructor(roads: readonly RoadCurve[], edges: readonly RoadEdge[]) {
    this.roads = roads;
    let count = 0;
    for (const road of roads) count += Math.max(0, road.points.length - 1);
    this.count = count;
    this.curve = new Int32Array(count);
    this.index = new Int32Array(count);
    this.edge = new Int32Array(count).fill(-1);
    this.rank = new Int32Array(count);
    const first = new Int32Array(roads.length);
    const head = (roads[0] as RoadCurve | undefined)?.points[0];
    const bounds: Bounds = { minX: head?.x ?? 0, minY: head?.y ?? 0, maxX: head?.x ?? 0, maxY: head?.y ?? 0 };
    let at = 0;
    for (const road of roads) {
      first[road.id] = at;
      for (let i = 0; i + 1 < road.points.length; i++, at++) {
        this.curve[at] = road.id;
        this.index[at] = i;
        this.rank[at] = road.bridges.includes(i) ? DECK_RANK : road.tunnels.includes(i) ? BORE_RANK : CARRY_RANK[road.tier];
      }
      for (const p of road.points) {
        if (p.x < bounds.minX) bounds.minX = p.x;
        if (p.y < bounds.minY) bounds.minY = p.y;
        if (p.x > bounds.maxX) bounds.maxX = p.x;
        if (p.y > bounds.maxY) bounds.maxY = p.y;
      }
    }
    this.bounds = bounds;
    // One of a two-way pair covers each segment; the twin stands on the same ground.
    for (const edge of edges) {
      if (edge.twin >= 0 && edge.twin < edge.id) continue;
      const base = first[edge.curve] as number;
      for (let i = Math.min(edge.start, edge.end); i < Math.max(edge.start, edge.end); i++) {
        this.edge[base + i] = edge.id;
      }
    }
  }

  curveOf(s: number): number {
    return this.curve[s] as number;
  }

  edgeOf(s: number): number {
    return this.edge[s] as number;
  }

  carry(s: number): number {
    // Between two runs of equal standing the older road keeps the ground.
    return (this.rank[s] as number) * (this.roads.length + 1) + (this.curve[s] as number);
  }

  head(s: number): Point {
    return (this.roads[this.curve[s] as number] as RoadCurve).points[this.index[s] as number] as Point;
  }

  tail(s: number): Point {
    return (this.roads[this.curve[s] as number] as RoadCurve).points[(this.index[s] as number) + 1] as Point;
  }
}

/**
 * Where two segments cross, or undefined when they do not cross away from their
 * own ends. Two roads that share a point meet at the end of a segment on both
 * sides, so a shared point is never a crossing, and a point within
 * {@link END_CLEARANCE} of any of the four ends is that same place too.
 */
function crossPoint(a: Point, b: Point, c: Point, d: Point): Point | undefined {
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
  const x = a.x + rx * t;
  const y = a.y + ry * t;
  if (nearPoint(x, y, a) || nearPoint(x, y, b) || nearPoint(x, y, c) || nearPoint(x, y, d)) return undefined;
  return { x, y };
}

/** True when a place stands within {@link END_CLEARANCE} of a road point. */
function nearPoint(x: number, y: number, p: Point): boolean {
  return hypot(x - p.x, y - p.y) < END_CLEARANCE;
}
