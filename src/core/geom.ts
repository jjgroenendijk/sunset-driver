/**
 * Polygon arithmetic for the parcel model (spec section 6.4).
 *
 * A ring is a closed loop of points; the first point is not repeated at the
 * end. A region is one piece of ground: an outer ring wound anticlockwise and
 * the rings of its holes wound clockwise. {@link union}, {@link difference} and
 * {@link split} take regions and give regions, so a hole stays a hole through
 * every step.
 *
 * All three share one engine. It cuts every edge where another edge meets it,
 * walks the faces of the planar graph that leaves, counts how many input rings
 * wind round each face, and keeps the faces the operation asks for. A split
 * keeps both answers off the one graph, so the two sides of a cut are bounded
 * by the same edges and cannot overlap.
 *
 * Coordinates are rounded to the millimetre first. Every cross product that
 * decides which side of an edge a point falls on is then an exact integer, so
 * two such answers can never contradict each other, and the same input gives
 * the same output on every machine.
 */
import { clamp, direction } from './math.ts';

export interface Point {
  x: number;
  y: number;
}

/**
 * One piece of ground: an outer ring wound anticlockwise, and the rings of the
 * holes in it wound clockwise. Nothing else stands inside the outer ring.
 */
export interface Region {
  outer: Point[];
  holes: Point[][];
}

/** How far past the half-width a mitred corner may reach, so a sharp bend does not spike. */
const MITER_LIMIT = 1.5;
/** Metres below which two points on a line are the same place. */
const EPSILON = 1e-6;

/** Metres one unit of the boolean engine's grid stands for. */
const GRID = 1e-3;
/** Grid units a node may stand from an edge before the edge is routed through it. */
const SNAP = 0.7072;
/** How often the edges are cut and looked at again before the graph is taken as settled. */
const MAX_PASSES = 4;
/** Grid units one bucket of the spatial index covers: sixteen metres. */
const BUCKET = 16000;
/** Square metres below which a ring of the result is dropped as a sliver of rounding. */
const MIN_RING_AREA = 0.01;
/** Half the span of the node keys in grid units; keys stay exact integers well past a 6 km map. */
const KEY_OFFSET = 1 << 23;
const KEY_SPAN = 2 * KEY_OFFSET;

/** The signed area of a ring in square metres. Positive when it winds anticlockwise. */
export function ringArea(ring: readonly Point[]): number {
  const origin = ring[0];
  if (origin === undefined) return 0;
  // Fanned out from the first point, so a small ring far from the origin keeps
  // its precision instead of being lost between two huge cross products.
  let sum = 0;
  for (let i = 1; i + 1 < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[i + 1] as Point;
    sum += (a.x - origin.x) * (b.y - origin.y) - (b.x - origin.x) * (a.y - origin.y);
  }
  return sum / 2;
}

/** The ground a region covers in square metres: its outer ring less its holes. */
export function regionArea(region: Region): number {
  let total = ringArea(region.outer);
  for (const hole of region.holes) total += ringArea(hole);
  return total;
}

/** The ground a set of regions covers in square metres. They must not overlap. */
export function areaOf(regions: readonly Region[]): number {
  let total = 0;
  for (const region of regions) total += regionArea(region);
  return total;
}

/** True when a point stands inside a closed ring, by counting the crossings of a ray. */
export function pointInRing(p: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a.y > p.y === b.y > p.y) continue;
    if (p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** True when a point stands on the ground a region owns: inside its outer ring and in none of its holes. */
export function pointInRegion(p: Point, region: Region): boolean {
  if (!pointInRing(p, region.outer)) return false;
  for (const hole of region.holes) if (pointInRing(p, hole)) return false;
  return true;
}

/** True when a point stands on the ground any of the regions owns. */
export function pointInRegions(p: Point, regions: readonly Region[]): boolean {
  for (const region of regions) if (pointInRegion(p, region)) return true;
  return false;
}

/** A ring on its own as a region, wound the way the engine expects. */
export function regionOf(ring: readonly Point[]): Region {
  const outer = ring.map((p) => ({ x: p.x, y: p.y }));
  if (ringArea(outer) < 0) outer.reverse();
  return { outer, holes: [] };
}

/**
 * Rings that already wind with the ground on their left — an outline
 * anticlockwise, a hole clockwise — gathered into regions. Each hole is put
 * inside the smallest outline around it. Rings that come from tracing one
 * boundary, such as a coastline, arrive this way.
 */
export function regionsFromRings(rings: readonly Point[][]): Region[] {
  const outers: Region[] = [];
  const holes: Point[][] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    if (ringArea(ring) > 0) outers.push({ outer: ring.map((p) => ({ x: p.x, y: p.y })), holes: [] });
    else holes.push(ring.map((p) => ({ x: p.x, y: p.y })));
  }
  for (const hole of holes) {
    const home = smallestAround(outers, hole[0] as Point);
    if (home !== undefined) home.holes.push(hole);
  }
  return outers;
}

/**
 * The two sides of a strip of the given half-width along a line. A corner is
 * mitred, so the two segments that meet there hand the ground over without a
 * gap, and the mitre is clamped at {@link MITER_LIMIT} so a sharp bend does not
 * throw a spike of land far out to the side.
 */
export function offsetSides(points: readonly Point[], halfWidth: number): { left: Point[]; right: Point[] } {
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const here = points[i] as Point;
    const back = i > 0 ? direction(points[i - 1] as Point, here) : undefined;
    const ahead = i + 1 < points.length ? direction(here, points[i + 1] as Point) : undefined;
    const d0 = back ?? (ahead as Point);
    const d1 = ahead ?? (back as Point);
    // The mitre bisects the two segments; where they double back it is the
    // normal of the one ahead, because there is no corner to bisect.
    let mx = -(d0.y + d1.y);
    let my = d0.x + d1.x;
    const len = Math.hypot(mx, my);
    if (len < EPSILON) {
      mx = -d1.y;
      my = d1.x;
    } else {
      mx /= len;
      my /= len;
    }
    const reach = halfWidth / clamp(mx * -d1.y + my * d1.x, 1 / MITER_LIMIT, 1);
    left.push({ x: here.x + mx * reach, y: here.y + my * reach });
    right.push({ x: here.x - mx * reach, y: here.y - my * reach });
  }
  return { left, right };
}

/**
 * A line offset by a half-width each side and closed into one ring, wound
 * anticlockwise. This is the ground a road of that width covers.
 */
export function strip(points: readonly Point[], halfWidth: number): Point[] {
  const sides = offsetSides(points, halfWidth);
  const ring = sides.left.concat(sides.right.reverse());
  if (ringArea(ring) < 0) ring.reverse();
  return ring;
}

/**
 * A ring of `sides` corners round a point, wound anticlockwise and covering the
 * whole circle of that radius: the corners stand far enough out that the flats
 * between them still clear it.
 */
export function disc(x: number, y: number, radius: number, sides: number): Point[] {
  const reach = radius / Math.cos(Math.PI / sides);
  const ring: Point[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (2 * Math.PI * i) / sides;
    ring.push({ x: x + reach * Math.cos(angle), y: y + reach * Math.sin(angle) });
  }
  return ring;
}

/** The ground all the regions cover together, as regions that do not overlap. */
export function union(regions: readonly Region[]): Region[] {
  return combine(regions, [], 'union');
}

/** The ground the subject covers and the clip does not. */
export function difference(subject: readonly Region[], clip: readonly Region[]): Region[] {
  return combine(subject, clip, 'difference');
}

/**
 * The subject cut by the clip: the ground it shares with the clip, and the
 * ground it keeps to itself. Both sides come out of one pass, so they are cut
 * on exactly the same edges and neither can overlap the other.
 */
export function split(subject: readonly Region[], clip: readonly Region[]): { inside: Region[]; outside: Region[] } {
  const graph = planarise(subject, clip);
  if (graph === undefined) return { inside: [], outside: [] };
  return {
    inside: assemble(graph, classify(graph, 'intersection')),
    outside: assemble(graph, classify(graph, 'difference')),
  };
}

// --- The boolean engine -----------------------------------------------------
//
// Everything below works in whole grid units, not metres.

/** Edges under construction: `a` to `b`, and which input the edge came from. */
interface Edges {
  ax: number[];
  ay: number[];
  bx: number[];
  by: number[];
  /** 0 for the subject, 1 for the clip. */
  set: number[];
}

function noEdges(): Edges {
  return { ax: [], ay: [], bx: [], by: [], set: [] };
}

function pushEdge(edges: Edges, ax: number, ay: number, bx: number, by: number, set: number): void {
  if (ax === bx && ay === by) return;
  edges.ax.push(ax);
  edges.ay.push(ay);
  edges.bx.push(bx);
  edges.by.push(by);
  edges.set.push(set);
}

function toGrid(v: number): number {
  return Math.round(v / GRID);
}

function nodeKey(x: number, y: number): number {
  return (x + KEY_OFFSET) * KEY_SPAN + (y + KEY_OFFSET);
}

/** What a boolean operation keeps of the ground its two inputs cover. */
type Operation = 'union' | 'difference' | 'intersection';

/** Run one boolean operation. */
function combine(subject: readonly Region[], clip: readonly Region[], operation: Operation): Region[] {
  const graph = planarise(subject, clip);
  return graph === undefined ? [] : assemble(graph, classify(graph, operation));
}

/**
 * The planar graph two sets of regions make together, or nothing at all when
 * neither of them has an edge. Every operation reads the same graph, so one
 * that asks two questions of it pays for it once.
 */
function planarise(subject: readonly Region[], clip: readonly Region[]): Graph | undefined {
  const edges = noEdges();
  collect(subject, 0, edges);
  collect(clip, 1, edges);
  return edges.ax.length === 0 ? undefined : arrange(settle(edges));
}

/** Every edge of every ring, wound so that the ground each region owns lies to its left. */
function collect(regions: readonly Region[], set: number, into: Edges): void {
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
    const ax = toGrid(a.x);
    const ay = toGrid(a.y);
    const bx = toGrid(b.x);
    const by = toGrid(b.y);
    if (reverse) pushEdge(into, bx, by, ax, ay, set);
    else pushEdge(into, ax, ay, bx, by, set);
  }
}

/**
 * Cut the edges until no two of them meet anywhere but at a shared end. Every
 * node found is a place an edge has to pass exactly through, so an edge that
 * runs within half a cell of one is bent onto it. Bending an edge can put it
 * across another one, so the whole pass runs again until nothing moves, or
 * until {@link MAX_PASSES} passes have run.
 */
function settle(edges: Edges): Edges {
  const box = edgeBox(edges);
  let current = edges;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const nodes = nodesOf(current, box);
    const next = cutAt(current, nodes);
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

/** Where the edges end and where they cross, each place once. */
function nodesOf(edges: Edges, box: Box): { x: number[]; y: number[]; index: Buckets } {
  const x: number[] = [];
  const y: number[] = [];
  const seen = new Set<number>();
  const add = (px: number, py: number): void => {
    const key = nodeKey(px, py);
    if (seen.has(key)) return;
    seen.add(key);
    x.push(px);
    y.push(py);
  };
  const count = edges.ax.length;
  for (let i = 0; i < count; i++) {
    add(edges.ax[i] as number, edges.ay[i] as number);
    add(edges.bx[i] as number, edges.by[i] as number);
  }
  crossings(edges, box, add);
  const index = new Buckets(box);
  for (let i = 0; i < x.length; i++) index.add(i, x[i] as number, y[i] as number, x[i] as number, y[i] as number);
  return { x, y, index };
}

/** Report every place two edges cross away from their ends. */
function crossings(edges: Edges, box: Box, add: (x: number, y: number) => void): void {
  const count = edges.ax.length;
  const index = new Buckets(box);
  for (let i = 0; i < count; i++) {
    index.add(i, edges.ax[i] as number, edges.ay[i] as number, edges.bx[i] as number, edges.by[i] as number);
  }
  const stamp = new Int32Array(count).fill(-1);
  const candidates: number[] = [];
  for (let i = 0; i < count; i++) {
    candidates.length = 0;
    index.near(edges.ax[i] as number, edges.ay[i] as number, edges.bx[i] as number, edges.by[i] as number, 0, (j) => {
      if (j <= i || stamp[j] === i) return;
      stamp[j] = i;
      candidates.push(j);
    });
    for (const j of candidates) {
      const ax = edges.ax[i] as number;
      const ay = edges.ay[i] as number;
      const bx = edges.bx[i] as number;
      const by = edges.by[i] as number;
      const cx = edges.ax[j] as number;
      const cy = edges.ay[j] as number;
      const dx = edges.bx[j] as number;
      const dy = edges.by[j] as number;
      // Exact on whole grid units, so the four sides never contradict each other.
      const d1 = orient(ax, ay, bx, by, cx, cy);
      const d2 = orient(ax, ay, bx, by, dx, dy);
      const d3 = orient(cx, cy, dx, dy, ax, ay);
      const d4 = orient(cx, cy, dx, dy, bx, by);
      if (d1 > 0 === d2 > 0 || d3 > 0 === d4 > 0) continue;
      if (d1 === 0 || d2 === 0 || d3 === 0 || d4 === 0) continue;
      const t = d3 / (d3 - d4);
      add(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t));
    }
  }
}

/** Twice the signed area of the triangle: which side of the line through a and b the point c falls. */
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * Bend every edge onto the nodes it passes within half a cell of. Returns the
 * cut edges, or nothing at all when no edge had a node to pass through.
 */
function cutAt(edges: Edges, nodes: { x: number[]; y: number[]; index: Buckets }): Edges | undefined {
  const out = noEdges();
  let changed = false;
  const count = edges.ax.length;
  const found: number[] = [];
  const along: number[] = [];
  for (let i = 0; i < count; i++) {
    const ax = edges.ax[i] as number;
    const ay = edges.ay[i] as number;
    const bx = edges.bx[i] as number;
    const by = edges.by[i] as number;
    const set = edges.set[i] as number;
    const ex = bx - ax;
    const ey = by - ay;
    const lengthSquared = ex * ex + ey * ey;
    found.length = 0;
    along.length = 0;
    // One grid unit past the edge, which covers the whole of the {@link SNAP} radius.
    nodes.index.near(ax, ay, bx, by, 1, (n) => {
      const px = nodes.x[n] as number;
      const py = nodes.y[n] as number;
      if ((px === ax && py === ay) || (px === bx && py === by)) return;
      const t = ((px - ax) * ex + (py - ay) * ey) / lengthSquared;
      if (t <= 0 || t >= 1) return;
      const offX = px - (ax + ex * t);
      const offY = py - (ay + ey * t);
      if (offX * offX + offY * offY > SNAP * SNAP) return;
      found.push(n);
      along.push(t);
    });
    if (found.length === 0) {
      pushEdge(out, ax, ay, bx, by, set);
      continue;
    }
    changed = true;
    const order = found.map((_, k) => k).sort((p, q) => (along[p] as number) - (along[q] as number));
    let fromX = ax;
    let fromY = ay;
    for (const k of order) {
      const n = found[k] as number;
      const px = nodes.x[n] as number;
      const py = nodes.y[n] as number;
      if (px === fromX && py === fromY) continue;
      pushEdge(out, fromX, fromY, px, py, set);
      fromX = px;
      fromY = py;
    }
    pushEdge(out, fromX, fromY, bx, by, set);
  }
  return changed ? out : undefined;
}

/**
 * A uniform grid of buckets over the ground the work covers, holding whatever
 * reaches into each bucket. Everything it is asked about stands inside the
 * bounds it was built with, so the buckets are one plain array and a bucket is
 * found by arithmetic alone.
 */
class Buckets {
  private readonly minColumn: number;
  private readonly minRow: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly buckets: (number[] | undefined)[];
  /** The buckets the walk under way crosses. Kept between calls so a walk allocates nothing. */
  private walked: Int32Array = new Int32Array(64);

  constructor(box: Box) {
    this.minColumn = columnOf(box.minX);
    this.minRow = columnOf(box.minY);
    this.columns = columnOf(box.maxX) - this.minColumn + 1;
    this.rows = columnOf(box.maxY) - this.minRow + 1;
    this.buckets = new Array<number[] | undefined>(this.columns * this.rows).fill(undefined);
  }

  /** File a segment in every bucket it crosses. */
  add(id: number, ax: number, ay: number, bx: number, by: number): void {
    const count = this.walk(ax, ay, bx, by, 0);
    const walked = this.walked;
    for (let k = 0; k < count; k++) {
      const at = walked[k] as number;
      const bucket = this.buckets[at];
      if (bucket === undefined) this.buckets[at] = [id];
      else bucket.push(id);
    }
  }

  /**
   * Report what reaches into the buckets the segment crosses, each bucket once.
   * `pad` is how far past the segment the walk reaches, in grid units, so a
   * caller that asks about the ground near a segment rather than under it still
   * finds it. An id filed in two of the buckets walked is reported twice, and
   * `visit` may not ask the index anything itself: one walk is under way at a
   * time.
   */
  near(ax: number, ay: number, bx: number, by: number, pad: number, visit: (id: number) => void): void {
    const count = this.walk(ax, ay, bx, by, pad);
    const walked = this.walked;
    for (let k = 0; k < count; k++) {
      const bucket = this.buckets[walked[k] as number];
      if (bucket === undefined) continue;
      for (const id of bucket) visit(id);
    }
  }

  /**
   * Fill {@link walked} with the buckets a segment crosses, dilated by `pad`
   * grid units, and answer how many there are. Filling the box around the
   * segment instead would put a 2 km diagonal in the fifteen thousand buckets
   * of its box rather than the hundred and twenty five it really crosses.
   *
   * Each column is clipped to the segment, and the ends of the clipped piece
   * give the rows the segment covers there. The row range is widened by one
   * grid unit on top of the padding, because the y of a clipped end comes of a
   * division and can land a rounding error the wrong side of a boundary.
   */
  private walk(ax: number, ay: number, bx: number, by: number, pad: number): number {
    const lowX = Math.min(ax, bx);
    const highX = Math.max(ax, bx);
    const loColumn = this.clampColumn(lowX - pad);
    const hiColumn = this.clampColumn(highX + pad);
    // An upright segment has no slope to take, and one that stays inside a
    // single column covers the whole of its own y range there. Both cover every
    // column of the walk with that range, and neither needs any clipping.
    const spread = lowX !== highX && loColumn !== hiColumn;
    const slope = spread ? (by - ay) / (bx - ax) : 0;
    let count = 0;
    for (let cx = loColumn; cx <= hiColumn; cx++) {
      let loY: number;
      let hiY: number;
      if (spread) {
        // The stretch of the segment standing in this column, held to its ends
        // so a padded column outside it takes the row of the end nearest it.
        const x0 = clamp((cx + this.minColumn) * BUCKET, lowX, highX);
        const x1 = clamp((cx + this.minColumn + 1) * BUCKET, lowX, highX);
        const y0 = ay + (x0 - ax) * slope;
        const y1 = ay + (x1 - ax) * slope;
        loY = Math.min(y0, y1);
        hiY = Math.max(y0, y1);
      } else {
        loY = Math.min(ay, by);
        hiY = Math.max(ay, by);
      }
      const loRow = this.clampRow(loY - pad - 1);
      const hiRow = this.clampRow(hiY + pad + 1);
      const base = cx * this.rows;
      if (count + hiRow - loRow + 1 > this.walked.length) this.walked = grown(this.walked, count + hiRow - loRow + 1);
      for (let cy = loRow; cy <= hiRow; cy++) this.walked[count++] = base + cy;
    }
    return count;
  }

  /** The column a coordinate falls in, clamped to the grid. */
  column(v: number): number {
    return this.clampColumn(v);
  }

  /** The coordinate the right side of a column stands at. */
  rightOf(column: number): number {
    return (column + this.minColumn + 1) * BUCKET;
  }

  /** What reaches into one bucket, by column and by the row a coordinate falls in. */
  columnAt(column: number, v: number): readonly number[] | undefined {
    return this.buckets[column * this.rows + this.clampRow(v)];
  }

  private clampColumn(v: number): number {
    return clamp(columnOf(v) - this.minColumn, 0, this.columns - 1);
  }

  private clampRow(v: number): number {
    return clamp(columnOf(v) - this.minRow, 0, this.rows - 1);
  }
}

/** The array again, at least `least` long. */
function grown(array: Int32Array, least: number): Int32Array {
  let size = array.length;
  while (size < least) size *= 2;
  const out = new Int32Array(size);
  out.set(array);
  return out;
}

function columnOf(v: number): number {
  return Math.floor(v / BUCKET);
}

/** The ground something covers. */
interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function edgeBox(edges: Edges): Box {
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < edges.ax.length; i++) {
    box.minX = Math.min(box.minX, edges.ax[i] as number, edges.bx[i] as number);
    box.minY = Math.min(box.minY, edges.ay[i] as number, edges.by[i] as number);
    box.maxX = Math.max(box.maxX, edges.ax[i] as number, edges.bx[i] as number);
    box.maxY = Math.max(box.maxY, edges.ay[i] as number, edges.by[i] as number);
  }
  return box;
}

/**
 * The planar graph the settled edges make: nodes, the edges between them with
 * how many rings of each input run each way along them, and the half-edges of
 * the faces.
 */
interface Graph {
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

  // An edge the rings cancel on has the same ground each side, so it bounds
  // nothing and is dropped before the faces are walked.
  const keptFrom: number[] = [];
  const keptTo: number[] = [];
  const keptSubject: number[] = [];
  const keptClip: number[] = [];
  for (let e = 0; e < from.length; e++) {
    if (windSubject[e] === 0 && windClip[e] === 0) continue;
    keptFrom.push(from[e] as number);
    keptTo.push(to[e] as number);
    keptSubject.push(windSubject[e] as number);
    keptClip.push(windClip[e] as number);
  }

  const graph: Graph = {
    x,
    y,
    from: keptFrom,
    to: keptTo,
    windSubject: keptSubject,
    windClip: keptClip,
    halves: keptFrom.length * 2,
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
  for (let half = 0; half < graph.halves; half++) {
    const face = graph.face[graph.cycle[half] as number] as number;
    const list = graph.halvesByFace.get(face);
    if (list === undefined) graph.halvesByFace.set(face, [half]);
    else list.push(half);
  }
  return graph;
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
  return Math.atan2((graph.y[v] as number) - (graph.y[u] as number), (graph.x[v] as number) - (graph.x[u] as number));
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
  if (best === -1) return -1;
  // Of the two ways along that edge, the one running down the map has the
  // point on its left.
  const u = graph.from[best] as number;
  const v = graph.to[best] as number;
  return (graph.y[v] as number) < (graph.y[u] as number) ? 2 * best : 2 * best + 1;
}

/** Which faces the operation keeps: how many rings of each input wind round each one. */
function classify(graph: Graph, operation: Operation): boolean[] {
  const subject = new Array<number>(graph.cycles).fill(0);
  const clip = new Array<number>(graph.cycles).fill(0);
  const known = new Array<boolean>(graph.cycles).fill(false);
  const inside = new Array<boolean>(graph.cycles).fill(false);
  // The face outside everything has no ring winding round it. Every other face
  // is reached by stepping over an edge from a face already counted.
  if (graph.outside === -1) return inside;
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

  for (let face = 0; face < graph.cycles; face++) {
    if (!known[face]) continue;
    const inSubject = (subject[face] as number) !== 0;
    const inClip = (clip[face] as number) !== 0;
    inside[face] =
      operation === 'union' ? inSubject || inClip : operation === 'difference' ? inSubject && !inClip : inSubject && inClip;
  }
  return inside;
}

/** Trace the edges the result keeps into rings, and gather the rings into regions. */
function assemble(graph: Graph, inside: readonly boolean[]): Region[] {
  const faceOf = (half: number): number => graph.face[graph.cycle[half] as number] as number;
  const kept = new Array<boolean>(graph.halves).fill(false);
  for (let e = 0; e < graph.from.length; e++) {
    const left = inside[faceOf(2 * e)] === true;
    const right = inside[faceOf(2 * e + 1)] === true;
    if (left === right) continue;
    kept[left ? 2 * e : 2 * e + 1] = true;
  }

  // Faces of the result that touch along a dropped edge are one piece of ground.
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

  const rings: Point[][] = [];
  const owner: number[] = [];
  const done = new Array<boolean>(graph.halves).fill(false);
  for (let start = 0; start < graph.halves; start++) {
    if (!kept[start] || done[start]) continue;
    const walk: Point[] = [];
    let half = start;
    do {
      done[half] = true;
      const u = halfFrom(graph, half);
      walk.push({ x: graph.x[u] as number, y: graph.y[u] as number });
      half = nextKept(graph, kept, half);
      if (half === -1) break;
    } while (half !== start);
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
function gatherRings(rings: readonly Point[][], owner: readonly number[]): Region[] {
  const groups = new Map<number, number[]>();
  const keys: number[] = [];
  for (let i = 0; i < rings.length; i++) {
    const key = owner[i] as number;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [i]);
      keys.push(key);
    } else {
      group.push(i);
    }
  }
  keys.sort((a, b) => a - b);
  const regions: Region[] = [];
  for (const key of keys) {
    const group = groups.get(key) as number[];
    const outers: Region[] = [];
    const holes: Point[][] = [];
    for (const i of group) {
      const ring = rings[i] as Point[];
      if (ringArea(ring) > 0) outers.push({ outer: ring, holes: [] });
      else holes.push(ring);
    }
    if (outers.length === 0) continue;
    for (const hole of holes) {
      const home = smallestAround(outers, hole[0] as Point);
      if (home !== undefined) home.holes.push(hole);
    }
    for (const region of outers) regions.push(region);
  }
  return regions;
}

/** The smallest of the outlines a point stands inside, or none of them. */
function smallestAround(outers: readonly Region[], p: Point): Region | undefined {
  let best: Region | undefined;
  let bestArea = Infinity;
  for (const region of outers) {
    if (!pointInRing(p, region.outer)) continue;
    const area = ringArea(region.outer);
    if (area < bestArea) {
      bestArea = area;
      best = region;
    }
  }
  return best;
}
