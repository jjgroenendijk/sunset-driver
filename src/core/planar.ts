/**
 * The planar graph the boolean engine of `geom.ts` runs on: the faces the cut
 * edges leave, how many rings of each input wind round each of them, and the
 * regions the kept faces assemble into.
 *
 * One graph answers every operation, so a caller that asks two questions of the
 * same pair of inputs pays for the cutting once. Coordinates are whole grid
 * units throughout, as in `edges.ts`.
 */
import { atan2 } from './libm.ts';
import {
  Buckets,
  type Box,
  type Edges,
  GRID,
  KEY_SPAN,
  nodeKey,
  orient,
  noEdges,
  pushEdge,
  settle,
  toGrid,
} from './edges.ts';
import { gatherRings, type Point, type Region, ringArea } from './ring.ts';

/** Square metres below which a ring of the result is dropped as a sliver of rounding. */
const MIN_RING_AREA = 0.01;
export type Operation = 'union' | 'difference' | 'intersection';

/** Run one boolean operation. */
export function combine(subject: readonly Region[], clip: readonly Region[], operation: Operation): Region[] {
  const graph = planarise(subject, clip);
  return graph === undefined ? [] : assemble(graph, classify(graph, operation));
}

/**
 * The planar graph two sets of regions make together, or nothing at all when
 * neither of them has an edge. Every operation reads the same graph, so one
 * that asks two questions of it pays for it once.
 */
export function planarise(subject: readonly Region[], clip: readonly Region[]): Graph | undefined {
  const edges = noEdges();
  collect(subject, 0, edges);
  collect(clip, 1, edges);
  return edges.ax.length === 0 ? undefined : arrange(settle(edges));
}

/** Every edge of every ring, wound so that the ground each region owns lies to its left. */
export function collect(regions: readonly Region[], set: number, into: Edges): void {
  for (const region of regions) {
    ringEdges(region.outer, false, set, into);
    for (const hole of region.holes) ringEdges(hole, true, set, into);
  }
}

function ringEdges(ring: readonly Point[], hole: boolean, set: number, into: Edges): void {
  if (ring.length < 3) return;
  // A hole winds the other way, so the ground its region owns is on its left too.
  const reverse = ringArea(ring) < 0 !== hole;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const from = reverse ? b : a;
    const to = reverse ? a : b;
    pushEdge(into, toGrid(from.x), toGrid(from.y), toGrid(to.x), toGrid(to.y), set);
  }
}

export interface Graph {
  /** Node positions in grid units. */
  x: number[];
  y: number[];
  /** One entry per edge: the nodes it joins, the lower id first. */
  from: number[];
  to: number[];
  /** Rings of each input running `from` to `to`, less those running the other way. */
  windSubject: number[];
  windClip: number[];
  /** Half-edge `2e` runs `from` to `to`, half-edge `2e + 1` the other way. */
  halves: number;
  /** The half-edges leaving each node, anticlockwise by angle. */
  leaving: number[][];
  /** Where each half-edge sits in the list of the node it leaves. */
  slot: number[];
  /** The face cycle each half-edge belongs to. */
  cycle: number[];
  /** The face each cycle was merged into, as a cycle id. */
  face: number[];
  /** Cycles, in the order they were traced. */
  cycles: number;
  /** The half-edges of each face, by the cycle id the face is known as. */
  halvesByFace: Map<number, number[]>;
  /** The face that holds the ground outside everything, or -1 in an empty graph. */
  outside: number;
}

function arrange(edges: Edges): Graph {
  const x: number[] = [];
  const y: number[] = [];
  const ids = new Map<number, number>();
  const nodeOf = (px: number, py: number): number => {
    const key = nodeKey(px, py);
    const found = ids.get(key);
    if (found !== undefined) return found;
    const id = x.length;
    ids.set(key, id);
    x.push(px);
    y.push(py);
    return id;
  };

  const from: number[] = [];
  const to: number[] = [];
  const windSubject: number[] = [];
  const windClip: number[] = [];
  const edgeIds = new Map<number, number>();
  const count = edges.ax.length;
  for (let i = 0; i < count; i++) {
    const u = nodeOf(edges.ax[i] as number, edges.ay[i] as number);
    const v = nodeOf(edges.bx[i] as number, edges.by[i] as number);
    if (u === v) continue;
    const lo = Math.min(u, v);
    const hi = Math.max(u, v);
    // Two node ids as one key. There are far fewer nodes than the key span, so
    // no two pairs share a key and the key stays an exact integer.
    const key = lo * KEY_SPAN + hi;
    let id = edgeIds.get(key);
    if (id === undefined) {
      id = from.length;
      edgeIds.set(key, id);
      from.push(lo);
      to.push(hi);
      windSubject.push(0);
      windClip.push(0);
    }
    const way = u === lo ? 1 : -1;
    if (edges.set[i] === 0) windSubject[id] = (windSubject[id] as number) + way;
    else windClip[id] = (windClip[id] as number) + way;
  }

  const kept = woundEdges({ from, to, windSubject, windClip });
  const graph: Graph = {
    x,
    y,
    ...kept,
    halves: kept.from.length * 2,
    leaving: [],
    slot: [],
    cycle: [],
    face: [],
    cycles: 0,
    halvesByFace: new Map<number, number[]>(),
    outside: -1,
  };
  sortLeaving(graph);
  traceCycles(graph);
  gatherFaces(graph);
  indexHalvesByFace(graph);
  return graph;
}

/** The edges of a graph, each with how many rings of each input wind along it. */
interface WoundEdges {
  from: number[];
  to: number[];
  windSubject: number[];
  windClip: number[];
}

/**
 * The edges some ring still winds along. An edge the rings cancel on has the
 * same ground each side, so it bounds nothing and is dropped before the faces
 * are walked.
 */
function woundEdges(all: WoundEdges): WoundEdges {
  const kept: WoundEdges = { from: [], to: [], windSubject: [], windClip: [] };
  for (let e = 0; e < all.from.length; e++) {
    if (all.windSubject[e] === 0 && all.windClip[e] === 0) continue;
    kept.from.push(all.from[e] as number);
    kept.to.push(all.to[e] as number);
    kept.windSubject.push(all.windSubject[e] as number);
    kept.windClip.push(all.windClip[e] as number);
  }
  return kept;
}

/** File every half-edge under the face on its left. */
function indexHalvesByFace(graph: Graph): void {
  for (let half = 0; half < graph.halves; half++) {
    const face = graph.face[graph.cycle[half] as number] as number;
    const list = graph.halvesByFace.get(face);
    if (list === undefined) graph.halvesByFace.set(face, [half]);
    else list.push(half);
  }
}

function halfFrom(graph: Graph, half: number): number {
  return (half & 1) === 0 ? (graph.from[half >> 1] as number) : (graph.to[half >> 1] as number);
}

function halfTo(graph: Graph, half: number): number {
  return (half & 1) === 0 ? (graph.to[half >> 1] as number) : (graph.from[half >> 1] as number);
}

/** Order the half-edges leaving each node by the direction they set off in. */
function sortLeaving(graph: Graph): void {
  const leaving: number[][] = [];
  for (let n = 0; n < graph.x.length; n++) leaving.push([]);
  for (let half = 0; half < graph.halves; half++) {
    (leaving[halfFrom(graph, half)] as number[]).push(half);
  }
  const angle = new Float64Array(graph.halves);
  for (let half = 0; half < graph.halves; half++) angle[half] = angleOf(graph, half);
  const slot = new Array<number>(graph.halves).fill(0);
  for (const list of leaving) {
    // Two half-edges that leave at the same angle are ordered by id, so the walk
    // round a node never depends on the order the edges happened to be built in.
    list.sort((p, q) => (angle[p] as number) - (angle[q] as number) || p - q);
    for (let i = 0; i < list.length; i++) slot[list[i] as number] = i;
  }
  graph.leaving = leaving;
  graph.slot = slot;
}

function angleOf(graph: Graph, half: number): number {
  const u = halfFrom(graph, half);
  const v = halfTo(graph, half);
  return atan2((graph.y[v] as number) - (graph.y[u] as number), (graph.x[v] as number) - (graph.x[u] as number));
}

/**
 * Walk every face of the graph. A face lies to the left of each half-edge that
 * bounds it, so on arriving at a node the walk takes the half-edge just
 * clockwise of the way it came.
 */
function traceCycles(graph: Graph): void {
  const cycle = new Array<number>(graph.halves).fill(-1);
  let next = 0;
  for (let start = 0; start < graph.halves; start++) {
    if (cycle[start] !== -1) continue;
    let half = start;
    do {
      cycle[half] = next;
      const back = half ^ 1;
      const at = halfTo(graph, half);
      const list = graph.leaving[at] as number[];
      const here = graph.slot[back] as number;
      half = list[(here + list.length - 1) % list.length] as number;
    } while (half !== start);
    next++;
  }
  graph.cycle = cycle;
  graph.cycles = next;
}

/**
 * Put the cycles that bound the same face together. A cycle that winds
 * clockwise is a hole in a face, so a ray cast left from its leftmost corner
 * finds an edge of the face it is a hole of; one that finds nothing is a hole
 * in the ground outside everything.
 */
function gatherFaces(graph: Graph): void {
  const parent = new Array<number>(graph.cycles).fill(0).map((_, i) => i);
  const find = (a: number): number => {
    let root = a;
    while ((parent[root] as number) !== root) root = parent[root] as number;
    let walk = a;
    while ((parent[walk] as number) !== root) {
      const up = parent[walk] as number;
      parent[walk] = root;
      walk = up;
    }
    return root;
  };
  const join = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let n = 0; n < graph.x.length; n++) {
    box.minX = Math.min(box.minX, graph.x[n] as number);
    box.minY = Math.min(box.minY, graph.y[n] as number);
    box.maxX = Math.max(box.maxX, graph.x[n] as number);
    box.maxY = Math.max(box.maxY, graph.y[n] as number);
  }
  const index = new Buckets(box);
  for (let e = 0; e < graph.from.length; e++) {
    const u = graph.from[e] as number;
    const v = graph.to[e] as number;
    index.add(e, graph.x[u] as number, graph.y[u] as number, graph.x[v] as number, graph.y[v] as number);
  }

  const corner = leftmostCorners(graph);
  let outside = -1;
  for (let c = 0; c < graph.cycles; c++) {
    // A cycle that winds anticlockwise is the outline of a face of its own. Every
    // other one is a hole in the face the ray to its left finds.
    if ((corner.area[c] as number) > 0) continue;
    const at = corner.node[c] as number;
    const holder = edgeLeftOf(graph, index, graph.x[at] as number, graph.y[at] as number);
    if (holder === -1) {
      if (outside === -1) outside = c;
      else join(c, outside);
      continue;
    }
    join(c, graph.cycle[holder] as number);
  }

  const face = new Array<number>(graph.cycles).fill(0);
  for (let c = 0; c < graph.cycles; c++) face[c] = find(c);
  graph.face = face;
  graph.outside = outside === -1 ? -1 : (face[outside] as number);
}

/** The leftmost corner of each cycle, and how the cycle winds. */
function leftmostCorners(graph: Graph): { node: number[]; area: number[] } {
  const node = new Array<number>(graph.cycles).fill(-1);
  const area = new Array<number>(graph.cycles).fill(0);
  const originX = new Array<number>(graph.cycles).fill(0);
  const originY = new Array<number>(graph.cycles).fill(0);
  for (let half = 0; half < graph.halves; half++) {
    const c = graph.cycle[half] as number;
    const u = halfFrom(graph, half);
    if (node[c] === -1) {
      node[c] = u;
      originX[c] = graph.x[u] as number;
      originY[c] = graph.y[u] as number;
      continue;
    }
    const best = node[c] as number;
    const bx = graph.x[best] as number;
    const by = graph.y[best] as number;
    const ux = graph.x[u] as number;
    const uy = graph.y[u] as number;
    if (ux < bx || (ux === bx && uy < by)) node[c] = u;
  }
  for (let half = 0; half < graph.halves; half++) {
    const c = graph.cycle[half] as number;
    const u = halfFrom(graph, half);
    const v = halfTo(graph, half);
    const ox = originX[c] as number;
    const oy = originY[c] as number;
    area[c] =
      (area[c] as number) +
      ((graph.x[u] as number) - ox) * ((graph.y[v] as number) - oy) -
      ((graph.x[v] as number) - ox) * ((graph.y[u] as number) - oy);
  }
  return { node, area };
}

/**
 * The half-edge whose face holds the ground just left of a point: cast a ray
 * left along the row and take the nearest edge it meets, in the direction that
 * keeps the point on its left. Returns -1 where the ray leaves the map.
 */
function edgeLeftOf(graph: Graph, index: Buckets, px: number, py: number): number {
  let bestX = -Infinity;
  let best = -1;
  // Column by column to the left. An edge that crosses the ray further right
  // than the best one found so far reaches into the column that crossing falls
  // in, and that column has already been read, so the walk can stop there.
  for (let column = index.column(px); column >= 0; column--) {
    if (best !== -1 && bestX > index.rightOf(column)) break;
    const bucket = index.columnAt(column, py);
    if (bucket === undefined) continue;
    for (const e of bucket) {
      const u = graph.from[e] as number;
      const v = graph.to[e] as number;
      const uy = graph.y[u] as number;
      const vy = graph.y[v] as number;
      if (uy > py === vy > py) continue;
      const ux = graph.x[u] as number;
      const vx = graph.x[v] as number;
      const at = ux + ((vx - ux) * (py - uy)) / (vy - uy);
      if (at >= px || at <= bestX) continue;
      bestX = at;
      best = e;
    }
  }
  return best === -1 ? -1 : downHalf(graph, best);
}

/**
 * Of the two ways along edge `e`, the one running down the map. A point just
 * right of the edge is on its left.
 */
function downHalf(graph: Graph, e: number): number {
  const u = graph.from[e] as number;
  const v = graph.to[e] as number;
  return (graph.y[v] as number) < (graph.y[u] as number) ? 2 * e : 2 * e + 1;
}

/** Which faces the operation keeps: how many rings of each input wind round each one. */
export function classify(graph: Graph, operation: Operation): boolean[] {
  const inside = new Array<boolean>(graph.cycles).fill(false);
  // The face outside everything has no ring winding round it. Every other face
  // is reached by stepping over an edge from a face already counted.
  if (graph.outside === -1) return inside;
  const { subject, clip, known } = faceWindings(graph);
  for (let face = 0; face < graph.cycles; face++) {
    if (!known[face]) continue;
    inside[face] = keeps(operation, (subject[face] as number) !== 0, (clip[face] as number) !== 0);
  }
  return inside;
}

/** Whether `operation` keeps ground that is in the subject or not, and in the clip or not. */
function keeps(operation: Operation, inSubject: boolean, inClip: boolean): boolean {
  if (operation === 'union') return inSubject || inClip;
  if (operation === 'difference') return inSubject && !inClip;
  return inSubject && inClip;
}

/**
 * How many rings of each input wind round each face, walked out from the face
 * outside everything, and which faces the walk reached.
 */
function faceWindings(graph: Graph): { subject: number[]; clip: number[]; known: boolean[] } {
  const subject = new Array<number>(graph.cycles).fill(0);
  const clip = new Array<number>(graph.cycles).fill(0);
  const known = new Array<boolean>(graph.cycles).fill(false);
  known[graph.outside] = true;
  const queue = [graph.outside];
  for (let head = 0; head < queue.length; head++) {
    const face = queue[head] as number;
    for (const half of graph.halvesByFace.get(face) ?? []) {
      const other = graph.face[graph.cycle[half ^ 1] as number] as number;
      if (known[other]) continue;
      // The face left of a half-edge has one more turn of every ring that runs
      // that way than the face on its right.
      const way = (half & 1) === 0 ? 1 : -1;
      const e = half >> 1;
      known[other] = true;
      subject[other] = (subject[face] as number) - way * (graph.windSubject[e] as number);
      clip[other] = (clip[face] as number) - way * (graph.windClip[e] as number);
      queue.push(other);
    }
  }
  return { subject, clip, known };
}

/** Trace the edges the result keeps into rings, and gather the rings into regions. */
export function assemble(graph: Graph, inside: readonly boolean[]): Region[] {
  const faceOf = (half: number): number => graph.face[graph.cycle[half] as number] as number;
  const kept = new Array<boolean>(graph.halves).fill(false);
  for (let e = 0; e < graph.from.length; e++) {
    const left = inside[faceOf(2 * e)] === true;
    const right = inside[faceOf(2 * e + 1)] === true;
    if (left === right) continue;
    kept[left ? 2 * e : 2 * e + 1] = true;
  }
  const find = groundOf(graph, inside, faceOf);

  const rings: Point[][] = [];
  const owner: number[] = [];
  const done = new Array<boolean>(graph.halves).fill(false);
  for (let start = 0; start < graph.halves; start++) {
    if (!kept[start] || done[start]) continue;
    const walk = traceKept(graph, kept, done, start);
    // Straightened on the whole grid units the walk is made of, where three
    // points either stand on one line exactly or do not stand on one at all.
    const simple = straighten(walk);
    if (simple.length < 3) continue;
    const ring = simple.map((p) => ({ x: p.x * GRID, y: p.y * GRID }));
    if (Math.abs(ringArea(ring)) < MIN_RING_AREA) continue;
    rings.push(ring);
    owner.push(find(faceOf(start)));
  }
  return gatherRings(rings, owner);
}

/**
 * The piece of ground each face of the result belongs to, as a face that
 * stands for it. Faces of the result that touch along a dropped edge are one
 * piece of ground.
 */
function groundOf(graph: Graph, inside: readonly boolean[], faceOf: (half: number) => number): (face: number) => number {
  const parent = new Array<number>(graph.cycles).fill(0).map((_, i) => i);
  const find = (a: number): number => {
    let root = a;
    while ((parent[root] as number) !== root) root = parent[root] as number;
    return root;
  };
  for (let e = 0; e < graph.from.length; e++) {
    const left = faceOf(2 * e);
    const right = faceOf(2 * e + 1);
    if (!inside[left] || !inside[right]) continue;
    const ra = find(left);
    const rb = find(right);
    if (ra !== rb) parent[ra] = rb;
  }
  return find;
}

/** The corners of the ring of kept edges that `start` opens, marking each edge done. */
function traceKept(graph: Graph, kept: readonly boolean[], done: boolean[], start: number): Point[] {
  const walk: Point[] = [];
  let half = start;
  do {
    done[half] = true;
    const u = halfFrom(graph, half);
    walk.push({ x: graph.x[u] as number, y: graph.y[u] as number });
    half = nextKept(graph, kept, half);
    if (half === -1) break;
  } while (half !== start);
  return walk;
}

/**
 * The next edge of the ring being traced: at the node the edge arrives at, the
 * first kept edge clockwise of the way it came.
 */
function nextKept(graph: Graph, kept: readonly boolean[], half: number): number {
  const back = half ^ 1;
  const at = halfTo(graph, half);
  const list = graph.leaving[at] as number[];
  const here = graph.slot[back] as number;
  for (let step = 1; step <= list.length; step++) {
    const candidate = list[(here + list.length - step) % list.length] as number;
    if (kept[candidate] === true) return candidate;
  }
  return -1;
}

/** Drop the corners a ring only bends imperceptibly at, which the cutting left behind. */
function straighten(ring: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < ring.length; i++) {
    const back = ring[(i + ring.length - 1) % ring.length] as Point;
    const here = ring[i] as Point;
    const ahead = ring[(i + 1) % ring.length] as Point;
    if (orient(back.x, back.y, ahead.x, ahead.y, here.x, here.y) === 0) continue;
    out.push(here);
  }
  return out;
}

/** Put each ring with the piece of ground it bounds: one outline, and the holes in it. */
