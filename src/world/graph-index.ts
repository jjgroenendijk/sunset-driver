/**
 * The spatial index of the road graph: a grid of buckets that answers "what is
 * near here?" for nodes, edges and the segments the crossing search compares.
 */
import type { RoadNode } from './graph.ts';

/** Side of one bucket of the spatial index, in metres. */
export const INDEX_CELL = 60;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(nodes: readonly RoadNode[]): Bounds {
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
export class Buckets {
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
