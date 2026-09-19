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
 * travel. Every road is two-way today, so edges come in pairs that point at
 * each other through `twin`. Width, lanes, speed limit and permitted traffic
 * come from the tier table in `tiers.ts`.
 *
 * Building and querying are pure: the same curves give the same graph, and the
 * same query gives the same answer. {@link RoadGraph.shortestPath} is Dijkstra
 * over travel time, and it breaks ties by node id, so a route never depends on
 * the order a heap happened to pop equal costs in.
 */
import { hypot } from '../core/libm.ts';
import { compareNumbers } from '../core/sort.ts';
import { findCrossings } from './grade-crossings.ts';
import { boundsOf, Buckets, INDEX_CELL } from './graph-index.ts';
import { TIERS } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/** A place where roads meet, or the free end of one. */
export interface RoadNode {
  id: number;
  x: number;
  y: number;
  /** The edges that leave this node, ascending. Its junction degree is their count. */
  edges: number[];
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
  /** Scratch for {@link shortestPath}, allocated once and reused. */
  private readonly cost: Float64Array;
  private readonly cameEdge: Int32Array;
  private readonly settled: Uint8Array;

  constructor(roads: readonly RoadCurve[]) {
    this.curves = roads;
    const nodes: RoadNode[] = [];
    const edges: RoadEdge[] = [];
    build(roads, nodes, edges);
    this.nodes = nodes;
    this.edges = edges;
    this.crossings = findCrossings(roads, edges);
    this.cost = new Float64Array(nodes.length);
    this.cameEdge = new Int32Array(nodes.length);
    this.settled = new Uint8Array(nodes.length);

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

  /** How many edges leave a node: 1 at a dead end, 2 on a bend, 3 or more at a junction. */
  degree(node: number): number {
    return (this.nodes[node] as RoadNode).edges.length;
  }

  /** The edges that leave a node, ascending. */
  edgesFrom(node: number): readonly number[] {
    return (this.nodes[node] as RoadNode).edges;
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
    for (let i = e.start; i !== e.end + step; i += step) out.push(points[i] as Point);
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
   * The fastest route between two nodes, or undefined when there is none.
   * Dijkstra over travel time: an edge costs its length at its speed limit, so
   * a highway detour beats a crawl down an alley. Nodes of equal cost are
   * settled in id order and only a strictly cheaper route replaces one already
   * found, so the answer never depends on floating-point tie order.
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
    cost[from] = 0;
    const heap = new MinHeap();
    heap.push(from, 0);
    while (heap.size > 0) {
      const at = heap.pop();
      if (settled[at] === 1) continue;
      settled[at] = 1;
      if (at === to) return this.routeTo(from, to);
      for (const e of (this.nodes[at] as RoadNode).edges) {
        const edge = this.edges[e] as RoadEdge;
        if (settled[edge.to] === 1) continue;
        if (allow !== undefined && !allow(edge)) continue;
        const through = (cost[at] as number) + edge.length / edge.speedLimit;
        if (through >= (cost[edge.to] as number)) continue;
        cost[edge.to] = through;
        cameEdge[edge.to] = e;
        heap.push(edge.to, through);
      }
    }
    return undefined;
  }

  /** Walk the search tree back from the goal and add up what the route costs. */
  private routeTo(from: number, to: number): RoadRoute {
    const edges: number[] = [];
    const nodes: number[] = [to];
    let at = to;
    while (at !== from) {
      const e = this.cameEdge[at] as number;
      edges.push(e);
      at = (this.edges[e] as RoadEdge).from;
      nodes.push(at);
    }
    edges.reverse();
    nodes.reverse();
    let length = 0;
    let time = 0;
    for (const e of edges) {
      const edge = this.edges[e] as RoadEdge;
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
    nodes.push({ id, x: p.x, y: p.y, edges: [] });
    return id;
  };

  for (const road of roads) {
    const points = road.points;
    const last = points.length - 1;
    const deck = new Uint8Array(Math.max(0, last));
    for (const at of road.bridges) if (at >= 0 && at < deck.length) deck[at] = 1;
    const bore = new Uint8Array(Math.max(0, last));
    for (const at of road.tunnels) if (at >= 0 && at < bore.length) bore[at] = 1;

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
}

/** The two edges of one run: one each way, pointing at each other. */
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
  const backward = forward + 1;
  const shared = { curve: road.id, tier: road.tier, lanes: spec.lanes, speedLimit: spec.speedLimit, length, bridge, tunnel };
  edges.push({ id: forward, from: fromNode, to: toNode, twin: backward, start: startIndex, end: endIndex, crossings: [], ...shared });
  edges.push({ id: backward, from: toNode, to: fromNode, twin: forward, start: endIndex, end: startIndex, crossings: [], ...shared });
  (nodes[fromNode] as RoadNode).edges.push(forward);
  (nodes[toNode] as RoadNode).edges.push(backward);
}

/** The point of a segment nearest a place, and how far away it is. */
function closestOnSegment(px: number, py: number, a: Point, b: Point): { x: number; y: number; d: number } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((px - a.x) * vx + (py - a.y) * vy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = a.x + vx * t;
  const y = a.y + vy * t;
  return { x, y, d: hypot(px - x, py - y) };
}

/**
 * A binary heap of nodes by cost. Equal costs come out in node order, which is
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
