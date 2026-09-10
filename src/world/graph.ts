/**
 * The road graph (spec section 6.5): the traced curves as nodes and edges that
 * traffic, police, navigation, the minimap and pathfinding can ask questions
 * of. It is not render geometry.
 *
 * A node stands where roads meet: both ends of every curve, and every point two
 * curves share. The tracer joins a road to another one by copying the point it
 * met, so a junction is exactly a shared point. Two roads that only cross on
 * the map without sharing a point do not meet on the ground either — one is
 * carried over the other — so grade separation holds by construction and an
 * overpass is never turned into a junction (spec section 6.2). Those crossings
 * are found and listed in {@link RoadGraph.crossings}, and both of the runs
 * that meet at one carry its index, so traffic and navigation can tell an
 * overpass from a turn.
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
import { compareNumbers } from '../core/sort.ts';
import { TIERS } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/** Side of one bucket of the spatial index, in metres. */
const INDEX_CELL = 60;
/** Millimetres: two road points this close are the same junction. */
const KEY_SCALE = 1000;
/** Half the span of the key grid in millimetres; keys stay safe integers well past a 6 km map. */
const KEY_OFFSET = 8_000_000;
const KEY_SPAN = 2 * KEY_OFFSET + 1;
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
const CARRY_RANK: Record<RoadTier, number> = { highway: 4, arterial: 3, street: 2, alley: 1, dirt: 0 };
const DECK_RANK = 5;
const BORE_RANK = -1;

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
      return Math.hypot(node.x - x, node.y - y);
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
   */
  shortestPath(from: number, to: number): RoadRoute | undefined {
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
 * each run. A point is a node when it is an end of its curve or when more than
 * one curve point stands there.
 */
function build(roads: readonly RoadCurve[], nodes: RoadNode[], edges: RoadEdge[]): void {
  const visits = new Map<number, number>();
  for (const road of roads) {
    for (const p of road.points) {
      const key = pointKey(p);
      visits.set(key, (visits.get(key) ?? 0) + 1);
    }
  }

  const nodeOf = new Map<number, number>();
  const nodeAt = (p: Point): number => {
    const key = pointKey(p);
    const known = nodeOf.get(key);
    if (known !== undefined) return known;
    const id = nodes.length;
    nodeOf.set(key, id);
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
    let startNode = nodeAt(points[0] as Point);
    let length = 0;
    let bridge = false;
    let tunnel = false;
    for (let i = 1; i <= last; i++) {
      const a = points[i - 1] as Point;
      const b = points[i] as Point;
      length += Math.hypot(b.x - a.x, b.y - a.y);
      if (deck[i - 1] === 1) bridge = true;
      if (bore[i - 1] === 1) tunnel = true;
      const junction = (visits.get(pointKey(b)) ?? 0) > 1;
      if (i !== last && !junction) continue;
      const endNode = nodeAt(b);
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
function findCrossings(roads: readonly RoadCurve[], edges: readonly RoadEdge[]): GradeCrossing[] {
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
  return Math.hypot(x - p.x, y - p.y) < END_CLEARANCE;
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

/** A road point as one safe integer, so points that coincide share a key. */
function pointKey(p: Point): number {
  const x = Math.round(p.x * KEY_SCALE) + KEY_OFFSET;
  const y = Math.round(p.y * KEY_SCALE) + KEY_OFFSET;
  return x * KEY_SPAN + y;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOf(nodes: readonly RoadNode[]): Bounds {
  const bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as RoadNode;
    if (i === 0) {
      bounds.minX = bounds.maxX = node.x;
      bounds.minY = bounds.maxY = node.y;
      continue;
    }
    if (node.x < bounds.minX) bounds.minX = node.x;
    if (node.y < bounds.minY) bounds.minY = node.y;
    if (node.x > bounds.maxX) bounds.maxX = node.x;
    if (node.y > bounds.maxY) bounds.maxY = node.y;
  }
  return bounds;
}

/**
 * A uniform grid of buckets holding ids by the ground they cover, so "what is
 * near here?" costs a handful of comparisons rather than a walk over the whole
 * network. An id sits in every bucket its bounding box touches, so a search
 * that has covered `r` rings has seen everything within `r` cells.
 */
class Buckets {
  private readonly cell: number;
  private readonly originX: number;
  private readonly originY: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly buckets: number[][] = [];

  constructor(bounds: Bounds, cell: number) {
    this.cell = cell;
    this.originX = bounds.minX - cell;
    this.originY = bounds.minY - cell;
    this.nx = Math.max(1, Math.ceil((bounds.maxX - this.originX) / cell) + 2);
    this.ny = Math.max(1, Math.ceil((bounds.maxY - this.originY) / cell) + 2);
    for (let i = 0; i < this.nx * this.ny; i++) this.buckets.push([]);
  }

  private column(v: number, origin: number, count: number): number {
    const i = Math.floor((v - origin) / this.cell);
    return i < 0 ? 0 : i >= count ? count - 1 : i;
  }

  add(id: number, minX: number, minY: number, maxX: number, maxY: number): void {
    const x0 = this.column(minX, this.originX, this.nx);
    const x1 = this.column(maxX, this.originX, this.nx);
    const y0 = this.column(minY, this.originY, this.ny);
    const y1 = this.column(maxY, this.originY, this.ny);
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const bucket = this.buckets[iy * this.nx + ix] as number[];
        // A long segment lands in the same bucket for each of its own cells.
        if (bucket[bucket.length - 1] !== id) bucket.push(id);
      }
    }
  }

  /**
   * Every id in a bucket the box touches. An id whose own box covers several of
   * those buckets is visited once for each of them, so the caller has to be
   * ready to see it more than once.
   */
  each(minX: number, minY: number, maxX: number, maxY: number, visit: (id: number) => void): void {
    const x0 = this.column(minX, this.originX, this.nx);
    const x1 = this.column(maxX, this.originX, this.nx);
    const y0 = this.column(minY, this.originY, this.ny);
    const y1 = this.column(maxY, this.originY, this.ny);
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        for (const id of this.buckets[iy * this.nx + ix] as number[]) visit(id);
      }
    }
  }

  /** The id nearest a place by `distanceOf`, searched ring by ring outward. */
  nearest(x: number, y: number, distanceOf: (id: number) => number): { id: number; distance: number } | undefined {
    const cx = this.column(x, this.originX, this.nx);
    const cy = this.column(y, this.originY, this.ny);
    const rings = Math.max(this.nx, this.ny);
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r <= rings; r++) {
      for (let iy = Math.max(0, cy - r); iy <= Math.min(this.ny - 1, cy + r); iy++) {
        const edgeRow = iy === cy - r || iy === cy + r;
        for (let ix = Math.max(0, cx - r); ix <= Math.min(this.nx - 1, cx + r); ix++) {
          // Only the ring itself; the cells inside it were searched already.
          if (!edgeRow && ix !== cx - r && ix !== cx + r) continue;
          for (const id of this.buckets[iy * this.nx + ix] as number[]) {
            const d = distanceOf(id);
            if (d >= bestD) continue;
            bestD = d;
            best = id;
          }
        }
      }
      // Everything within `r` cells has been seen, so a nearer id cannot exist.
      if (best >= 0 && bestD <= r * this.cell) break;
    }
    return best < 0 ? undefined : { id: best, distance: bestD };
  }
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
  return { x, y, d: Math.hypot(px - x, py - y) };
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
