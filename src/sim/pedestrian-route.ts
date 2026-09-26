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
 *
 * A person does not walk the middle of the pavement. Each keeps a lane of
 * their own, `shift` metres right of it in the way they walk, so two people
 * who meet on one pavement pass each other on their right. And a leg may
 * change sides in the middle of a run: a jaywalker leaves one pavement at a
 * cut along the edge and crosses to the other on a slant, {@link JAY_RUN}
 * metres further on. The next leg is the same edge on the other side.
 */
import { hypot } from '../core/libm.ts';
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

/**
 * How far from the node a corner may stand, in pavement offsets, before the
 * lines are joined instead. A square corner stands at the square root of two;
 * two arms that meet at a narrow angle cross far out, over the block between
 * them.
 */
export const CORNER_REACH = 1.5;

/** Metres along the road a jaywalker's slant across it covers. */
const JAY_RUN = 5;

/** One leg of a loop as it is asked for: an edge, the pavement it is walked on, and where it leaves a jaywalked run. */
export interface WalkLeg {
  edge: number;
  /** +1 on the pavement right of the edge's direction, -1 on the left. */
  side: number;
  /** Metres along the edge a jaywalker leaves this pavement for the other. The next leg is the same edge. */
  cut?: number;
}

/** One loop of pavement, ready to walk. */
export interface WalkRoute {
  /** The edges in the order they are walked; the last one ends where the first starts. */
  edges: Int32Array;
  /** The side each leg is walked on: +1 right of the edge's direction, -1 left. */
  sides: Int8Array;
  /** 1 on a leg that ends by jaywalking across its own road. */
  jay: Uint8Array;
  /** Metres right of the middle of the pavement, in the way of travel, the walk keeps to. */
  shift: number;
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

  /** Lay a loop of legs out as a walk, `shift` metres right of the middle of each pavement. */
  route(legs: readonly WalkLeg[], shift = 0): WalkRoute {
    const count = legs.length;
    const route: WalkRoute = {
      edges: Int32Array.from(legs, (leg) => leg.edge),
      sides: Int8Array.from(legs, (leg) => leg.side),
      jay: Uint8Array.from(legs, (leg) => (leg.cut === undefined ? 0 : 1)),
      shift,
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
    for (let i = 0; i < count; i++) {
      const leg = legs[i] as WalkLeg;
      if (leg.cut !== undefined) this.slant(route, i, leg.cut, leave, enter);
      else this.corner(route, i, leave, enter);
    }
    for (let i = 0; i < count; i++) {
      const edge = this.edge(route.edges[i] as number);
      const from = clamp(enter[(i + count - 1) % count] as number, 0, edge.length);
      route.from[i] = from;
      route.to[i] = clamp(leave[i] as number, from, edge.length);
    }
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      route.start[i] = route.length;
      route.length += (route.to[i] as number) - (route.from[i] as number);
      route.toCorner[i] = route.length;
      const end = this.pavementPoint(route, i, route.to[i] as number, this.a);
      route.length += hypot((route.cornerX[i] as number) - end.x, (route.cornerY[i] as number) - end.y);
      route.fromCorner[i] = route.length;
      const begin = this.pavementPoint(route, next, route.from[next] as number, this.b);
      route.length += hypot(begin.x - (route.cornerX[i] as number), begin.y - (route.cornerY[i] as number));
    }
    return route;
  }

  /** Metres right of an edge's centreline, in its own direction, leg `i` of a route is walked at. */
  offsetOf(route: WalkRoute, i: number): number {
    return (route.sides[i] as number) * pavementOffset(this.edge(route.edges[i] as number)) + route.shift;
  }

  /** The point a distance round a route, which wraps. */
  sample(route: WalkRoute, distance: number, out: WalkPoint): WalkPoint {
    let d = distance % route.length;
    if (d < 0) d += route.length;
    const leg = lastAtOrBelow(route.start, d);
    const edge = route.edges[leg] as number;
    const toCorner = route.toCorner[leg] as number;
    const fromCorner = route.fromCorner[leg] as number;
    if (d < toCorner) {
      const s = (route.from[leg] as number) + d - (route.start[leg] as number);
      const at = this.pavementPoint(route, leg, s, this.a);
      out.x = at.x;
      out.y = at.y;
      // A pavement that runs straight on over a junction crosses the road that meets it there.
      const run = this.edge(edge);
      const node = nodeNear(run, s);
      out.height = at.height + (node >= 0 && this.onCarriageway(node, at.x, at.y) ? CARRIAGEWAY_RISE : PAVEMENT_RISE);
      return out;
    }
    const next = (leg + 1) % route.edges.length;
    const stop = next === 0 ? route.length : (route.start[next] as number);
    if (route.jay[leg] === 1) return this.across(route, leg, (d - toCorner) / (stop - toCorner), out);
    const cx = route.cornerX[leg] as number;
    const cy = route.cornerY[leg] as number;
    const node = this.edge(edge).to;
    if (d < fromCorner) {
      const end = this.pavementPoint(route, leg, route.to[leg] as number, this.a);
      return this.between(end, cx, cy, (d - toCorner) / (fromCorner - toCorner), node, out);
    }
    const begin = this.pavementPoint(route, next, route.from[next] as number, this.a);
    // The line from the corner is walked towards the next leg, so it is read from that end.
    return this.between(begin, cx, cy, (stop - d) / (stop - fromCorner), node, out);
  }

  /**
   * True when a place stands on the carriageway of a road that leaves a node,
   * and which road: the edge whose carriageway it is, or -1.
   */
  carriagewayAt(node: number, x: number, y: number): number {
    const at = this.graph.nodes[node];
    if (at === undefined) return -1;
    for (const id of at.edges) {
      const edge = this.edge(id);
      const along = this.alongEdge(id, 0, this.b, false);
      const vx = x - along.x;
      const vy = y - along.y;
      const forward = vx * along.dx + vy * along.dy;
      if (forward < -TIERS[edge.tier].width / 2 || forward > edge.length) continue;
      if (Math.abs(vx * along.dy - vy * along.dx) < TIERS[edge.tier].width / 2) return id;
    }
    return -1;
  }

  /**
   * True when a place stands on the carriageway of a road that leaves a node,
   * which is what a walk across a junction steps down onto.
   */
  onCarriageway(node: number, x: number, y: number): boolean {
    return this.carriagewayAt(node, x, y) >= 0;
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
   * A point `t` of the way over a jaywalker's slant, from the end of leg
   * `leg`'s pavement to the start of the next leg's on the other side of the
   * road. Over the carriageway it stands on the road; either side, on the kerb.
   */
  private across(route: WalkRoute, leg: number, t: number, out: WalkPoint): WalkPoint {
    const f = Number.isFinite(t) ? clamp(t, 0, 1) : 0;
    const next = (leg + 1) % route.edges.length;
    const end = this.pavementPoint(route, leg, route.to[leg] as number, this.a);
    const begin = this.pavementPoint(route, next, route.from[next] as number, this.b);
    out.x = end.x + (begin.x - end.x) * f;
    out.y = end.y + (begin.y - end.y) * f;
    const edge = this.edge(route.edges[leg] as number);
    const lateral = this.offsetOf(route, leg) + (this.offsetOf(route, next) - this.offsetOf(route, leg)) * f;
    const bed = end.height + (begin.height - end.height) * f;
    out.height = bed + (Math.abs(lateral) < TIERS[edge.tier].width / 2 ? CARRIAGEWAY_RISE : PAVEMENT_RISE);
    return out;
  }

  /**
   * Cut leg `i`'s pavement line against the next leg's. Writes the corner, and
   * how far along each edge's centreline the cut stands.
   */
  private corner(route: WalkRoute, i: number, leave: Float64Array, enter: Float64Array): void {
    const next = (i + 1) % route.edges.length;
    const first = route.edges[i] as number;
    const second = route.edges[next] as number;
    const edgeA = this.edge(first);
    const offA = this.offsetOf(route, i);
    const offB = this.offsetOf(route, next);
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
      const cx = ax + a.dx * t;
      const cy = ay + a.dy * t;
      // `a` is the end of the first edge, which is the node the two turn at.
      if (hypot(cx - a.x, cy - a.y) <= reach) {
        route.cornerX[i] = cx;
        route.cornerY[i] = cy;
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

  /**
   * Leg `i`'s slant across its own road: it leaves this pavement at `cut` and
   * reaches the other {@link JAY_RUN} metres on, and its corner is the middle
   * of the road between the two.
   */
  private slant(route: WalkRoute, i: number, cut: number, leave: Float64Array, enter: Float64Array): void {
    const next = (i + 1) % route.edges.length;
    const a = this.pavementPoint(route, i, cut, this.a);
    const ax = a.x;
    const ay = a.y;
    const b = this.pavementPoint(route, next, cut + JAY_RUN, this.b);
    route.cornerX[i] = (ax + b.x) / 2;
    route.cornerY[i] = (ay + b.y) / 2;
    leave[i] = cut;
    enter[i] = cut + JAY_RUN;
  }

  /** The point a leg of a route is walked at a distance along its edge, and the road height there. */
  private pavementPoint(route: WalkRoute, i: number, s: number, out: Along): Along {
    const id = route.edges[i] as number;
    const along = this.alongEdge(id, s, out);
    const offset = this.offsetOf(route, i);
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
    const length = hypot(q.x - p.x, q.y - p.y) || 1;
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
      run[k] = (run[k - 1] as number) + hypot(b.x - a.x, b.y - a.y);
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

/** The node at the end of `run` that `s` metres along it is within reach of, or -1 for neither. */
function nodeNear(run: RoadEdge, s: number): number {
  if (s < NODE_REACH) return run.from;
  if (run.length - s < NODE_REACH) return run.to;
  return -1;
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
