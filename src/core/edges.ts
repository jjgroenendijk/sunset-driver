/**
 * The edge soup the boolean engine of `geom.ts` works on, and the spatial index
 * it asks through.
 *
 * Everything here works in whole grid units, not metres: a coordinate is
 * rounded to the millimetre first, so every cross product that decides which
 * side of an edge a point falls on is an exact integer. Two such answers can
 * never contradict each other, and the same input gives the same output on
 * every machine.
 */
import { clamp } from './math.ts';

/** Metres one unit of the boolean engine's grid stands for. */
export const GRID = 1e-3;
/** Grid units a node may stand from an edge before the edge is routed through it. */
const SNAP = 0.7072;
/** How often the edges are cut and looked at again before the graph is taken as settled. */
const MAX_PASSES = 4;
/** Grid units one bucket of the spatial index covers: sixteen metres. */
const BUCKET = 16000;
/** Half the span of the node keys in grid units; keys stay exact integers well past a 6 km map. */
const KEY_OFFSET = 1 << 23;
export const KEY_SPAN = 2 * KEY_OFFSET;

/** Edges under construction: `a` to `b`, and which input the edge came from. */
export interface Edges {
  ax: number[];
  ay: number[];
  bx: number[];
  by: number[];
  /** 0 for the subject, 1 for the clip. */
  set: number[];
}

export function noEdges(): Edges {
  return { ax: [], ay: [], bx: [], by: [], set: [] };
}

export function pushEdge(edges: Edges, ax: number, ay: number, bx: number, by: number, set: number): void {
  if (ax === bx && ay === by) return;
  edges.ax.push(ax);
  edges.ay.push(ay);
  edges.bx.push(bx);
  edges.by.push(by);
  edges.set.push(set);
}

export function toGrid(v: number): number {
  return Math.round(v / GRID);
}

export function nodeKey(x: number, y: number): number {
  return (x + KEY_OFFSET) * KEY_SPAN + (y + KEY_OFFSET);
}

/** What a boolean operation keeps of the ground its two inputs cover. */

/**
 * Cut the edges until no two of them meet anywhere but at a shared end. Every
 * node found is a place an edge has to pass exactly through, so an edge that
 * runs within half a cell of one is bent onto it. Bending an edge can put it
 * across another one, so the whole pass runs again until nothing moves, or
 * until {@link MAX_PASSES} passes have run.
 */
export function settle(edges: Edges): Edges {
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
export function crossings(edges: Edges, box: Box, add: (x: number, y: number) => void): void {
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

/**
 * Twice the signed area of the triangle: which side of the line from `from` to
 * `to` the point `p` falls.
 */
export function orient(fromX: number, fromY: number, toX: number, toY: number, px: number, py: number): number {
  return (toX - fromX) * (py - fromY) - (toY - fromY) * (px - fromX);
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
    const order = found.map((_, k) => k).sort((p, q) => (along[p] as number) - (along[q] as number) || (found[p] as number) - (found[q] as number));
    let fromX = ax;
    let fromY = ay;
    let lastT = -1;
    for (const k of order) {
      const n = found[k] as number;
      const px = nodes.x[n] as number;
      const py = nodes.y[n] as number;
      if (px === fromX && py === fromY) continue;
      // Two nodes the same way along the edge stand either side of it: the
      // other corners of the cell a one-unit diagonal crosses. The hop between
      // them is the opposite diagonal, so routing through both would only swap
      // one crossing for another, pass after pass. The first of them is enough.
      if (along[k] === lastT) continue;
      lastT = along[k] as number;
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
export class Buckets {
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
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function edgeBox(edges: Edges): Box {
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
