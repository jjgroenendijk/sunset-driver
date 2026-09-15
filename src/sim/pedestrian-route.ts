/**
 * The line a pedestrian walks round a loop of road edges (spec section 13.1).
 *
 * A pedestrian keeps to one side of the road: the middle of the pavement on
 * the right of the edge's direction, or on its left. Where one leg of the loop
 * meets the next, the two pavement lines are cut at the point they cross, the
 * corner. On a right turn — a left turn for a pedestrian on the left side — the
 * corner is the inside corner of the pavement, and the walk goes round it
 * without leaving the kerb. On the other turn the corner is the far corner of
 * the junction, so the walk crosses one road and then the other, the way a
 * person turns at a crossing. Two lines that do not cross near the junction,
 * such as a road going straight on or turning back at a dead end, are joined
 * by the straight line between their ends.
 *
 * So a leg is three pieces: the pavement from the last corner, the line from
 * the end of the pavement to the next corner, and the line from that corner to
 * where the next leg's pavement starts. A line inside a straight junction has
 * no length, and nothing is walked there.
 */
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import { TIERS } from '../world/tiers.ts';
import type { Point, RoadCurve } from '../world/types.ts';

/**
 * Metres a pedestrian stands above the road bed on a pavement: the raise of
 * the carriageway and the rise of the kerb in `src/render/road-section.ts`.
 */
export const PAVEMENT_RISE = 0.2;

/** Metres a pedestrian crossing a carriageway stands above the bed: its raise alone. */
export const CARRIAGEWAY_RISE = 0.06;

/**
 * The sine of the smallest angle at which two pavement lines are cut at their
 * crossing. Below it the lines run nearly straight on, and they are joined.
 */
const MIN_TURN = 0.25;

/**
 * Metres from a node inside which a pavement can cross a road that meets it:
 * half the widest carriageway and a little more.
 */
const NODE_REACH = 16;

/** How many pavement widths from the junction a corner may stand before the lines are joined instead. */
const CORNER_REACH = 3;

/** One loop of pavement, ready to walk. */
export interface WalkRoute {
  /** The edges in the order they are walked; the last one ends where the first starts. */
  edges: Int32Array;
  /** Metres along each edge's centreline its pavement piece starts and ends. */
  from: Float64Array;
  to: Float64Array;
  /** The corner each leg ends at, where it meets the next leg. */
  cornerX: Float64Array;
  cornerY: Float64Array;
  /** Metres round the loop each leg's pavement starts, its line to the corner starts, and its line from the corner starts. */
  start: Float64Array;
  toCorner: Float64Array;
  fromCorner: Float64Array;
  /** Metres once round. */
  length: number;
}

/** A point on the ground a pedestrian stands at, and the height they stand at. */
export interface WalkPoint {
  x: number;
  y: number;
  height: number;
}

/** A point, a direction and a road height on the centreline of an edge. */
interface Along {
  x: number;
  y: number;
  dx: number;
  dy: number;
  height: number;
}

/** The pavements of a road network, as a pedestrian walks them. */
export class Pavements {
  private readonly roads: readonly RoadCurve[];
  private readonly graph: RoadGraph;
  private readonly heightAt: (curve: number, segment: number, t: number, x: number, y: number) => number;
  /** Cumulative metres at each point of each edge, in its direction of travel. */
  private readonly runs: (Float64Array | undefined)[] = [];
  private readonly a: Along = { x: 0, y: 0, dx: 1, dy: 0, height: 0 };
  private readonly b: Along = { x: 0, y: 0, dx: 1, dy: 0, height: 0 };

  constructor(roads: readonly RoadCurve[], graph: RoadGraph, heightAt: (curve: number, segment: number, t: number, x: number, y: number) => number) {
    this.roads = roads;
    this.graph = graph;
    this.heightAt = heightAt;
  }

  /** Lay a loop of edges out as a walk on one side: +1 on the right of travel, -1 on the left. */
  route(edges: readonly number[], side: number): WalkRoute {
    const count = edges.length;
    const route: WalkRoute = {
      edges: Int32Array.from(edges),
      from: new Float64Array(count),
      to: new Float64Array(count),
      cornerX: new Float64Array(count),
      cornerY: new Float64Array(count),
      start: new Float64Array(count),
      toCorner: new Float64Array(count),
      fromCorner: new Float64Array(count),
      length: 0,
    };
    // Where each leg's pavement line is cut: `enter` along the next leg, `leave` along this one.
    const leave = new Float64Array(count);
    const enter = new Float64Array(count);
    for (let i = 0; i < count; i++) this.corner(route, i, edges[i] as number, edges[(i + 1) % count] as number, side, leave, enter);
    for (let i = 0; i < count; i++) {
      const edge = this.edge(edges[i] as number);
      const from = clamp(enter[(i + count - 1) % count] as number, 0, edge.length);
      route.from[i] = from;
      route.to[i] = clamp(leave[i] as number, from, edge.length);
    }
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      route.start[i] = route.length;
      route.length += (route.to[i] as number) - (route.from[i] as number);
      route.toCorner[i] = route.length;
      const end = this.pavementPoint(edges[i] as number, route.to[i] as number, side, this.a);
      route.length += Math.hypot((route.cornerX[i] as number) - end.x, (route.cornerY[i] as number) - end.y);
      route.fromCorner[i] = route.length;
      const begin = this.pavementPoint(edges[next] as number, route.from[next] as number, side, this.b);
      route.length += Math.hypot(begin.x - (route.cornerX[i] as number), begin.y - (route.cornerY[i] as number));
    }
    return route;
  }

  /** The point a distance round a route, which wraps. */
  sample(route: WalkRoute, side: number, distance: number, out: WalkPoint): WalkPoint {
    let d = distance % route.length;
    if (d < 0) d += route.length;
    const leg = lastAtOrBelow(route.start, d);
    const edge = route.edges[leg] as number;
    const toCorner = route.toCorner[leg] as number;
    const fromCorner = route.fromCorner[leg] as number;
    if (d < toCorner) {
      const s = (route.from[leg] as number) + d - (route.start[leg] as number);
      const at = this.pavementPoint(edge, s, side, this.a);
      out.x = at.x;
      out.y = at.y;
      // A pavement that runs straight on over a junction crosses the road that meets it there.
      const run = this.edge(edge);
      const node = s < NODE_REACH ? run.from : run.length - s < NODE_REACH ? run.to : -1;
      out.height = at.height + (node >= 0 && this.onCarriageway(node, at.x, at.y) ? CARRIAGEWAY_RISE : PAVEMENT_RISE);
      return out;
    }
    const cx = route.cornerX[leg] as number;
    const cy = route.cornerY[leg] as number;
    const node = this.edge(edge).to;
    if (d < fromCorner) {
      const end = this.pavementPoint(edge, route.to[leg] as number, side, this.a);
      return this.between(end, cx, cy, (d - toCorner) / (fromCorner - toCorner), node, out);
    }
    const next = (leg + 1) % route.edges.length;
    const stop = next === 0 ? route.length : (route.start[next] as number);
    const begin = this.pavementPoint(route.edges[next] as number, route.from[next] as number, side, this.a);
    // The line from the corner is walked towards the next leg, so it is read from that end.
    return this.between(begin, cx, cy, (stop - d) / (stop - fromCorner), node, out);
  }

  /**
   * True when a place stands on the carriageway of a road that leaves a node,
   * which is what a walk across a junction steps down onto.
   */
  onCarriageway(node: number, x: number, y: number): boolean {
    const at = this.graph.nodes[node];
    if (at === undefined) return false;
    for (const id of at.edges) {
      const edge = this.edge(id);
      const along = this.alongEdge(id, 0, this.b, false);
      const vx = x - along.x;
      const vy = y - along.y;
      const forward = vx * along.dx + vy * along.dy;
      if (forward < -TIERS[edge.tier].width / 2 || forward > edge.length) continue;
      if (Math.abs(vx * along.dy - vy * along.dx) < TIERS[edge.tier].width / 2) return true;
    }
    return false;
  }

  /** A point on the line from one end of a corner line towards the corner, `t` of the way. */
  private between(end: WalkPoint, cx: number, cy: number, t: number, node: number, out: WalkPoint): WalkPoint {
    const f = Number.isFinite(t) ? clamp(t, 0, 1) : 0;
    const bed = end.height;
    out.x = end.x + (cx - end.x) * f;
    out.y = end.y + (cy - end.y) * f;
    out.height = bed + (this.onCarriageway(node, out.x, out.y) ? CARRIAGEWAY_RISE : PAVEMENT_RISE);
    return out;
  }

  /**
   * Cut leg `i`'s pavement line against the next leg's. Writes the corner, and
   * how far along each edge's centreline the cut stands.
   */
  private corner(route: WalkRoute, i: number, first: number, second: number, side: number, leave: Float64Array, enter: Float64Array): void {
    const edgeA = this.edge(first);
    const edgeB = this.edge(second);
    const offA = side * pavementOffset(edgeA);
    const offB = side * pavementOffset(edgeB);
    const a = this.alongEdge(first, edgeA.length, this.a);
    const b = this.alongEdge(second, 0, this.b);
    // A point on each pavement line: right of travel is (-dy, dx).
    const ax = a.x - a.dy * offA;
    const ay = a.y + a.dx * offA;
    const bx = b.x - b.dy * offB;
    const by = b.y + b.dx * offB;
    const cross = a.dx * b.dy - a.dy * b.dx;
    const reach = CORNER_REACH * Math.max(Math.abs(offA), Math.abs(offB));
    if (Math.abs(cross) >= MIN_TURN) {
      const wx = bx - ax;
      const wy = by - ay;
      const t = (wx * b.dy - wy * b.dx) / cross;
      const u = (wx * a.dy - wy * a.dx) / cross;
      if (Math.abs(t) <= reach && Math.abs(u) <= reach) {
        route.cornerX[i] = ax + a.dx * t;
        route.cornerY[i] = ay + a.dy * t;
        leave[i] = edgeA.length + t;
        enter[i] = u;
        return;
      }
    }
    route.cornerX[i] = (ax + bx) / 2;
    route.cornerY[i] = (ay + by) / 2;
    leave[i] = edgeA.length;
    enter[i] = 0;
  }

  /** The middle of the pavement a distance along an edge, on one side, and the road height there. */
  private pavementPoint(id: number, s: number, side: number, out: Along): Along {
    const along = this.alongEdge(id, s, out);
    const offset = side * pavementOffset(this.edge(id));
    const x = along.x - along.dy * offset;
    const y = along.y + along.dx * offset;
    along.x = x;
    along.y = y;
    return along;
  }

  /**
   * The centreline point a distance along an edge, its direction and its road
   * height, which is left alone when `height` is false. A distance before the
   * start or past the end runs on along the first or the last segment, where a
   * corner cut beyond the node needs it.
   */
  private alongEdge(id: number, s: number, out: Along, height = true): Along {
    const edge = this.edge(id);
    const run = this.runOf(edge);
    const last = run.length - 2;
    const k = s <= 0 ? 0 : Math.min(lastAtOrBelow(run, s), last);
    const span = (run[k + 1] as number) - (run[k] as number);
    const f = span > 0 ? (s - (run[k] as number)) / span : 0;
    const step = edge.end >= edge.start ? 1 : -1;
    const points = (this.roads[edge.curve] as RoadCurve).points;
    const p = points[edge.start + k * step] as Point;
    const q = points[edge.start + (k + 1) * step] as Point;
    const length = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    out.dx = (q.x - p.x) / length;
    out.dy = (q.y - p.y) / length;
    out.x = p.x + (q.x - p.x) * f;
    out.y = p.y + (q.y - p.y) * f;
    if (!height) return out;
    const t = clamp(f, 0, 1);
    out.height = step > 0 ? this.heightAt(edge.curve, edge.start + k, t, out.x, out.y) : this.heightAt(edge.curve, edge.start - k - 1, 1 - t, out.x, out.y);
    return out;
  }

  private runOf(edge: RoadEdge): Float64Array {
    const known = this.runs[edge.id];
    if (known !== undefined) return known;
    const points = (this.roads[edge.curve] as RoadCurve).points;
    const step = edge.end >= edge.start ? 1 : -1;
    const run = new Float64Array(Math.abs(edge.end - edge.start) + 1);
    for (let k = 1; k < run.length; k++) {
      const a = points[edge.start + (k - 1) * step] as Point;
      const b = points[edge.start + k * step] as Point;
      run[k] = (run[k - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y);
    }
    this.runs[edge.id] = run;
    return run;
  }

  private edge(id: number): RoadEdge {
    return this.graph.edges[id] as RoadEdge;
  }
}

/** Metres from the centreline to the middle of the pavement of an edge's tier. */
export function pavementOffset(edge: Pick<RoadEdge, 'tier'>): number {
  const spec = TIERS[edge.tier];
  return spec.width / 2 + spec.verge + spec.pavement / 2;
}

/** The last index whose value is at or below a number, in an ascending list that starts at 0. */
function lastAtOrBelow(starts: Float64Array, value: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
