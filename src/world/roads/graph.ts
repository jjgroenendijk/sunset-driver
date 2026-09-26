/**
 * The road graph (spec section 6.5): the traced curves as nodes and edges that
 * traffic, police, navigation, the minimap and pathfinding can ask questions
 * of. It is not render geometry.
 *
 * A node stands where roads meet: both ends of every curve, and every point two
 * curves share. The tracer's network (`road-network.ts`) decides that when it
 * adds a road, and writes it into `RoadCurve.nodes`, which is all this reads.
 * Two roads that only cross on the map without sharing a node do not meet on
 * the ground either — one is carried over the other — so grade separation
 * holds by construction and an overpass is never turned into a junction (spec
 * section 6.2). Those crossings are found in `grade-crossings.ts` and listed in
 * {@link RoadGraph.crossings}, and both of the runs that meet at one carry its
 * index, so traffic and navigation can tell an overpass from a turn. The
 * spatial index behind the nearest-point queries is in `graph-index.ts`.
 *
 * An edge is the run of one curve between two nodes, in one direction of
 * travel. A road is two-way, so its edges come in pairs that point at each
 * other through `twin`; the ramp of an interchange is one-way, and its edge
 * has none. Width, lanes, speed limit and permitted traffic
 * come from the tier table in `tiers.ts`.
 *
 * Building and querying are pure: the same curves give the same graph, and the
 * same query gives the same answer. {@link RoadGraph.shortestPath} is Dijkstra
 * over travel time, and it breaks ties by node id, so a route never depends on
 * the order a heap happened to pop equal costs in.
 */
import { hypot } from '../../core/libm.ts';
import { compareNumbers } from '../../core/sort.ts';
import { findCrossings } from '../junctions/grade-crossings.ts';
import { boundsOf, Buckets, INDEX_CELL } from './graph-index.ts';
import { TIERS } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from '../types.ts';

/** A place where roads meet, or the free end of one. */
export interface RoadNode {
  id: number;
  x: number;
  y: number;
  /** The edges that leave this node, ascending. */
  edges: number[];
  /**
   * One edge for every run of road that meets this node, ascending: the edge
   * that leaves it, or on a one-way ramp that only arrives, the edge that
   * arrives. Its junction degree is their count. {@link mouthAt} says which
   * way each run leaves the node.
   */
  runs: number[];
}

/** One run of a curve between two nodes, in one direction of travel. */
export interface RoadEdge {
  id: number;
  from: number;
  to: number;
  /** The same run the other way, or -1 where a road runs one way only. */
  twin: number;
  /** The curve this run is part of. */
  curve: number;
  /**
   * The run inside that curve: `points[start]` to `points[end]`, in the
   * direction of travel. `start` is above `end` when the edge runs against the
   * curve's own direction.
   */
  start: number;
  end: number;
  tier: RoadTier;
  /** Lanes in this direction. */
  lanes: number;
  /** Metres per second. */
  speedLimit: number;
  /** Metres along the curve, not the straight line between the nodes. */
  length: number;
  /** True when any part of the run is carried on a bridge deck. */
  bridge: boolean;
  /** True when any part of the run is bored through the ground. */
  tunnel: boolean;
  /**
   * The grade-separated crossings on this run, as indices into
   * {@link RoadGraph.crossings}, ascending. Empty on a run that crosses no
   * other road, which is nearly all of them.
   */
  crossings: number[];
}

/**
 * Where one road passes over another without meeting it (spec section 6.2). The
 * two curves share no point there, so no node stands at the crossing and
 * neither road can turn onto the other.
 */
export interface GradeCrossing {
  /** The run carried over the top. One of a two-way pair; its `twin` is the other. */
  over: number;
  /** The run that passes underneath, likewise one of a pair. */
  under: number;
  /** Where the two centrelines cross. */
  x: number;
  y: number;
}

/** The nearest point of an edge to somewhere. */
export interface EdgeHit {
  edge: number;
  /** The point on the edge, not the query point. */
  x: number;
  y: number;
  distance: number;
}

/** A driven route: the nodes it visits, the edges between them, and what it costs. */
export interface RoadRoute {
  /** From the start node to the goal, both included. */
  nodes: number[];
  /** The edges between those nodes; one shorter than `nodes`. */
  edges: number[];
  /** Metres driven. */
  length: number;
  /** Seconds at the speed limits of the edges. */
  time: number;
}

/** Build the road graph of a network of curves. Pure: same curves, same graph. */
export function buildRoadGraph(roads: readonly RoadCurve[]): RoadGraph {
  return new RoadGraph(roads);
}

export class RoadGraph {
  readonly nodes: readonly RoadNode[];
  readonly edges: readonly RoadEdge[];
  /** Every place one road is carried over another, in a fixed order. */
  readonly crossings: readonly GradeCrossing[];
  private readonly curves: readonly RoadCurve[];
  /** Forward edges by the ground they cover; a twin covers the same ground. */
  private readonly edgeIndex: Buckets;
  private readonly nodeIndex: Buckets;
  /** Scratch for {@link shortestPath}, allocated once and reused: one entry per edge. */
  private readonly cost: Float64Array;
  private readonly cameEdge: Int32Array;
  private readonly settled: Uint8Array;
  /** The direction each edge leaves its first node in and arrives at its last, two numbers each, for {@link turnAllowed}. */
  private readonly heads: Float64Array;
  private readonly tails: Float64Array;
  /** The edges that arrive at each node, ascending. */
  private readonly incoming: number[][];

  constructor(roads: readonly RoadCurve[]) {
    this.curves = roads;
    const nodes: RoadNode[] = [];
    const edges: RoadEdge[] = [];
    build(roads, nodes, edges);
    this.nodes = nodes;
    this.edges = edges;
    this.crossings = findCrossings(roads, edges);
    this.cost = new Float64Array(edges.length);
    this.cameEdge = new Int32Array(edges.length);
    this.settled = new Uint8Array(edges.length);
    this.incoming = nodes.map(() => []);
    for (const edge of edges) (this.incoming[edge.to] as number[]).push(edge.id);
    this.heads = new Float64Array(edges.length * 2);
    this.tails = new Float64Array(edges.length * 2);
    for (const edge of edges) {
      const points = (roads[edge.curve] as RoadCurve).points;
      const step = edge.end >= edge.start ? 1 : -1;
      unit(points[edge.start] as Point, points[edge.start + step] as Point, this.heads, edge.id);
      unit(points[edge.end - step] as Point, points[edge.end] as Point, this.tails, edge.id);
    }

    const bounds = boundsOf(nodes);
    this.nodeIndex = new Buckets(bounds, INDEX_CELL);
    for (const node of nodes) this.nodeIndex.add(node.id, node.x, node.y, node.x, node.y);
    this.edgeIndex = new Buckets(bounds, INDEX_CELL);
    for (const edge of edges) {
      // One of a pair is enough: the twin stands on the same ground.
      if (edge.twin >= 0 && edge.twin < edge.id) continue;
      const points = (roads[edge.curve] as RoadCurve).points;
      const lo = Math.min(edge.start, edge.end);
      const hi = Math.max(edge.start, edge.end);
      for (let i = lo; i < hi; i++) {
        const a = points[i] as Point;
        const b = points[i + 1] as Point;
        this.edgeIndex.add(
          edge.id,
          Math.min(a.x, b.x),
          Math.min(a.y, b.y),
          Math.max(a.x, b.x),
          Math.max(a.y, b.y),
        );
      }
    }
  }

  /** How many runs of road meet at a node: 1 at a dead end, 2 on a bend, 3 or more at a junction. */
  degree(node: number): number {
    return (this.nodes[node] as RoadNode).runs.length;
  }

  /**
   * The point of its curve a run stands on the node at, and the way along the
   * curve it leaves the node by: 1 towards the curve's end, -1 towards its
   * start. `edge` is one of the node's {@link RoadNode.runs}.
   */
  mouthAt(edge: number, node: number): { point: number; direction: 1 | -1 } {
    const e = this.edges[edge] as RoadEdge;
    const forward = e.end >= e.start;
    if (e.from === node) return { point: e.start, direction: forward ? 1 : -1 };
    return { point: e.end, direction: forward ? -1 : 1 };
  }

  /** The edges that leave a node, ascending. */
  edgesFrom(node: number): readonly number[] {
    return (this.nodes[node] as RoadNode).edges;
  }

  /** The edges that arrive at a node, ascending. On a two-way road each is the twin of one that leaves. */
  edgesInto(node: number): readonly number[] {
    return this.incoming[node] as number[];
  }

  /** The nodes one edge away, ascending and without repeats. */
  neighbours(node: number): number[] {
    const out: number[] = [];
    for (const e of (this.nodes[node] as RoadNode).edges) {
      const to = (this.edges[e] as RoadEdge).to;
      if (!out.includes(to)) out.push(to);
    }
    out.sort(compareNumbers);
    return out;
  }

  /** The points of an edge, in the direction of travel. */
  edgePoints(edge: number): Point[] {
    const e = this.edges[edge] as RoadEdge;
    const points = (this.curves[e.curve] as RoadCurve).points;
    const out: Point[] = [];
    const step = e.end >= e.start ? 1 : -1;
    const count = Math.abs(e.end - e.start) + 1;
    for (let k = 0; k < count; k++) out.push(points[e.start + k * step] as Point);
    return out;
  }

  /** The node nearest a place. Undefined only when the graph is empty. */
  nearestNode(x: number, y: number): number | undefined {
    const hit = this.nodeIndex.nearest(x, y, (id) => {
      const node = this.nodes[id] as RoadNode;
      return hypot(node.x - x, node.y - y);
    });
    return hit?.id;
  }

  /**
   * The nearest point of the network to a place, and the edge it is on. One of
   * a two-way pair is returned; `twin` reaches the other direction.
   */
  nearestEdge(x: number, y: number): EdgeHit | undefined {
    const hit = this.edgeIndex.nearest(x, y, (id) => this.distanceToEdge(id, x, y));
    if (hit === undefined) return undefined;
    const points = this.edgePoints(hit.id);
    let best = { x: (points[0] as Point).x, y: (points[0] as Point).y, d: Infinity };
    for (let i = 0; i + 1 < points.length; i++) {
      const p = closestOnSegment(x, y, points[i] as Point, points[i + 1] as Point);
      if (p.d < best.d) best = p;
    }
    return { edge: hit.id, x: best.x, y: best.y, distance: best.d };
  }

  /**
   * True where a car arriving on edge `from` may leave on edge `to`. Every turn
   * is open but at the landing of a ramp, where a ramp meets a highway: there a
   * car keeps to its own carriageway. It turns from the on-ramp only onto the
   * carriageway it merges into, and onto the off-ramp only from the one it
   * leaves — the turn less than a right angle — and never from one ramp onto
   * another, which would take it across the highway.
   */
  turnAllowed(from: number, to: number): boolean {
    const a = this.edges[from] as RoadEdge;
    const b = this.edges[to] as RoadEdge;
    const ramps = (a.tier === 'ramp' ? 1 : 0) + (b.tier === 'ramp' ? 1 : 0);
    if (ramps === 0) return true;
    const highway = a.tier === 'highway' || b.tier === 'highway' || this.edgesFrom(a.to).some((e) => (this.edges[e] as RoadEdge).tier === 'highway');
    if (!highway) return true;
    if (ramps === 2) return false;
    const dot = (this.tails[from * 2] as number) * (this.heads[to * 2] as number) + (this.tails[from * 2 + 1] as number) * (this.heads[to * 2 + 1] as number);
    return dot > 0;
  }

  /**
   * The fastest route between two nodes, or undefined when there is none.
   * Dijkstra over travel time: an edge costs its length at its speed limit, so
   * a highway detour beats a crawl down an alley. The search settles edges,
   * not nodes, so it can keep to {@link turnAllowed} and to the one way a ramp
   * runs. Edges of equal cost are settled in id order and only a strictly
   * cheaper route replaces one already found, so the answer never depends on
   * floating-point tie order.
   *
   * `allow` narrows the network the route may use, which is how a vehicle that
   * belongs to one tier — the tram on its arterials — is routed over the roads
   * that carry it. Without it every edge is open.
   */
  shortestPath(from: number, to: number, allow?: (edge: RoadEdge) => boolean): RoadRoute | undefined {
    const count = this.nodes.length;
    if (from < 0 || to < 0 || from >= count || to >= count) return undefined;
    if (from === to) return { nodes: [from], edges: [], length: 0, time: 0 };
    const cost = this.cost;
    const cameEdge = this.cameEdge;
    const settled = this.settled;
    cost.fill(Infinity);
    cameEdge.fill(-1);
    settled.fill(0);
    const heap = new MinHeap();
    for (const e of (this.nodes[from] as RoadNode).edges) {
      const edge = this.edges[e] as RoadEdge;
      if (allow !== undefined && !allow(edge)) continue;
      cost[e] = edge.length / edge.speedLimit;
      heap.push(e, cost[e] as number);
    }
    while (heap.size > 0) {
      const at = heap.pop();
      if (settled[at] === 1) continue;
      settled[at] = 1;
      const arrived = this.edges[at] as RoadEdge;
      if (arrived.to === to) return this.routeTo(from, at);
      this.relax(heap, at, arrived, allow);
    }
    return undefined;
  }

  /** Offer every edge a car may leave on after edge `at`, where it is cheaper than the route found to it so far. */
  private relax(heap: MinHeap, at: number, arrived: RoadEdge, allow: ((edge: RoadEdge) => boolean) | undefined): void {
    const cost = this.cost;
    for (const e of (this.nodes[arrived.to] as RoadNode).edges) {
      if (this.settled[e] === 1) continue;
      const edge = this.edges[e] as RoadEdge;
      if (allow !== undefined && !allow(edge)) continue;
      if (!this.turnAllowed(at, e)) continue;
      const through = (cost[at] as number) + edge.length / edge.speedLimit;
      if (through >= (cost[e] as number)) continue;
      cost[e] = through;
      this.cameEdge[e] = at;
      heap.push(e, through);
    }
  }

  /** Walk the search tree back from the last edge of the route and add up what the route costs. */
  private routeTo(from: number, last: number): RoadRoute {
    const edges: number[] = [];
    for (let e = last; e >= 0; e = this.cameEdge[e] as number) edges.push(e);
    edges.reverse();
    const nodes: number[] = [from];
    let length = 0;
    let time = 0;
    for (const e of edges) {
      const edge = this.edges[e] as RoadEdge;
      nodes.push(edge.to);
      length += edge.length;
      time += edge.length / edge.speedLimit;
    }
    return { nodes, edges, length, time };
  }

  private distanceToEdge(edge: number, x: number, y: number): number {
    const e = this.edges[edge] as RoadEdge;
    const points = (this.curves[e.curve] as RoadCurve).points;
    const lo = Math.min(e.start, e.end);
    const hi = Math.max(e.start, e.end);
    let best = Infinity;
    for (let i = lo; i < hi; i++) {
      const d = closestOnSegment(x, y, points[i] as Point, points[i + 1] as Point).d;
      if (d < best) best = d;
    }
    return best;
  }
}

/**
 * Cut every curve into runs between its nodes, and lay a pair of edges along
 * each run. A point is a node where the curve says so in `nodes`, and both ends
 * of a curve are nodes whatever it says. The nodes are numbered in the order
 * the curves reach them.
 */
function build(roads: readonly RoadCurve[], nodes: RoadNode[], edges: RoadEdge[]): void {
  const nodeOf = new Map<number, number>();
  const nodeAt = (road: RoadCurve, i: number): number => {
    const p = road.points[i] as Point;
    // An end the curve gave no node is a free end of its own.
    const key = road.nodes[i] ?? -1;
    const known = key >= 0 ? nodeOf.get(key) : undefined;
    if (known !== undefined) return known;
    const id = nodes.length;
    if (key >= 0) nodeOf.set(key, id);
    nodes.push({ id, x: p.x, y: p.y, edges: [], runs: [] });
    return id;
  };
  for (const road of roads) buildRuns(road, nodes, edges, nodeAt);
}

/** A mask of `length` segments, 1 at every index listed. */
function segmentMask(indices: readonly number[], length: number): Uint8Array {
  const mask = new Uint8Array(length);
  for (const at of indices) if (at >= 0 && at < mask.length) mask[at] = 1;
  return mask;
}

/** Cut one curve into runs between its nodes, and lay the edges of each run. */
function buildRuns(road: RoadCurve, nodes: RoadNode[], edges: RoadEdge[], nodeAt: (road: RoadCurve, i: number) => number): void {
  const points = road.points;
  const last = points.length - 1;
  const deck = segmentMask(road.bridges, Math.max(0, last));
  const bore = segmentMask(road.tunnels, Math.max(0, last));

  let startIndex = 0;
  let startNode = nodeAt(road, 0);
  let length = 0;
  let bridge = false;
  let tunnel = false;
  for (let i = 1; i <= last; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    length += hypot(b.x - a.x, b.y - a.y);
    if (deck[i - 1] === 1) bridge = true;
    if (bore[i - 1] === 1) tunnel = true;
    if (i !== last && (road.nodes[i] ?? -1) < 0) continue;
    const endNode = nodeAt(road, i);
    // A run of no length is no road: two curves can share two points a
    // rounding apart, and an edge between them would only confuse a route.
    if (length > 0) {
      addPair(edges, nodes, road, startIndex, i, startNode, endNode, length, bridge, tunnel);
    }
    startIndex = i;
    startNode = endNode;
    length = 0;
    bridge = false;
    tunnel = false;
  }
}

/**
 * The edges of one run: one each way, pointing at each other. A ramp is driven
 * one way only, from its first point to its last, so it has the one edge and
 * that edge has no twin.
 */
function addPair(
  edges: RoadEdge[],
  nodes: RoadNode[],
  road: RoadCurve,
  startIndex: number,
  endIndex: number,
  fromNode: number,
  toNode: number,
  length: number,
  bridge: boolean,
  tunnel: boolean,
): void {
  const spec = TIERS[road.tier];
  const forward = edges.length;
  const shared = { curve: road.id, tier: road.tier, lanes: spec.lanes, speedLimit: spec.speedLimit, length, bridge, tunnel };
  if (road.ramp !== undefined) {
    edges.push({ id: forward, from: fromNode, to: toNode, twin: -1, start: startIndex, end: endIndex, crossings: [], ...shared });
    (nodes[fromNode] as RoadNode).edges.push(forward);
    (nodes[fromNode] as RoadNode).runs.push(forward);
    (nodes[toNode] as RoadNode).runs.push(forward);
    return;
  }
  const backward = forward + 1;
  edges.push({ id: forward, from: fromNode, to: toNode, twin: backward, start: startIndex, end: endIndex, crossings: [], ...shared });
  edges.push({ id: backward, from: toNode, to: fromNode, twin: forward, start: endIndex, end: startIndex, crossings: [], ...shared });
  (nodes[fromNode] as RoadNode).edges.push(forward);
  (nodes[toNode] as RoadNode).edges.push(backward);
  (nodes[fromNode] as RoadNode).runs.push(forward);
  (nodes[toNode] as RoadNode).runs.push(backward);
}

/** Write the unit direction from `a` to `b` into two slots of `out` for edge `id`. */
function unit(a: Point, b: Point, out: Float64Array, id: number): void {
  const length = hypot(b.x - a.x, b.y - a.y);
  out[id * 2] = length > 0 ? (b.x - a.x) / length : 0;
  out[id * 2 + 1] = length > 0 ? (b.y - a.y) / length : 0;
}

/** The point of a segment nearest a place, and how far away it is. */
function closestOnSegment(px: number, py: number, a: Point, b: Point): { x: number; y: number; d: number } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((px - a.x) * vx + (py - a.y) * vy) / l2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const x = a.x + vx * t;
  const y = a.y + vy * t;
  return { x, y, d: hypot(px - x, py - y) };
}

/**
 * A binary heap of ids by cost. Equal costs come out in id order, which is
 * what keeps a route the same from run to run.
 */
class MinHeap {
  private readonly nodes: number[] = [];
  private readonly costs: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  private before(i: number, j: number): boolean {
    const ci = this.costs[i] as number;
    const cj = this.costs[j] as number;
    return ci !== cj ? ci < cj : (this.nodes[i] as number) < (this.nodes[j] as number);
  }

  private swap(i: number, j: number): void {
    const n = this.nodes[i] as number;
    const c = this.costs[i] as number;
    this.nodes[i] = this.nodes[j] as number;
    this.costs[i] = this.costs[j] as number;
    this.nodes[j] = n;
    this.costs[j] = c;
  }

  push(node: number, cost: number): void {
    this.nodes.push(node);
    this.costs.push(cost);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.nodes[0] as number;
    const lastNode = this.nodes.pop() as number;
    const lastCost = this.costs.pop() as number;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.costs[0] = lastCost;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let small = i;
        if (left < this.nodes.length && this.before(left, small)) small = left;
        if (right < this.nodes.length && this.before(right, small)) small = right;
        if (small === i) break;
        this.swap(i, small);
        i = small;
      }
    }
    return top;
  }
}
