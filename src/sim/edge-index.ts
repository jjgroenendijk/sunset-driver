/**
 * Which ambient actors can be near a place (spec section 5.3).
 *
 * An actor of the traffic or the crowd goes round a loop of road edges for
 * ever. It can only ever stand near the edges of its loop, so it is filed once
 * in every bucket those edges cover, and a box asks the buckets it meets. The
 * answer is every actor that can be in the box at any tick; the caller reads
 * each one's pose to see whether it is there now.
 */
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import type { Point, RoadCurve } from '../world/types.ts';

export class EdgeIndex {
  /** The box round each edge, grown by the reach: minX, minY, maxX, maxY. */
  private readonly boxes: Float64Array;
  private readonly cells: number[][] = [];
  private readonly cell: number;
  private readonly originX: number;
  private readonly originY: number;
  private readonly nx: number;
  private readonly ny: number;

  /** `reach` is the metres an actor may stand off the centreline of its edge; `cell` the side of a bucket. */
  constructor(roads: readonly RoadCurve[], graph: RoadGraph, reach: number, cell: number) {
    this.cell = cell;
    this.boxes = new Float64Array(graph.edges.length * 4);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const edge of graph.edges) {
      const box = boxOf(roads, edge, reach);
      this.boxes.set(box, edge.id * 4);
      minX = Math.min(minX, box[0]);
      minY = Math.min(minY, box[1]);
      maxX = Math.max(maxX, box[2]);
      maxY = Math.max(maxY, box[3]);
    }
    if (graph.edges.length === 0) minX = minY = maxX = maxY = 0;
    this.originX = minX;
    this.originY = minY;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
    this.ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
    for (let i = 0; i < this.nx * this.ny; i++) this.cells.push([]);
  }

  /** True when an edge, grown by the reach, overlaps a box. */
  meets(edge: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
    const b = this.boxes;
    return (b[edge * 4] as number) <= maxX && (b[edge * 4 + 2] as number) >= minX && (b[edge * 4 + 1] as number) <= maxY && (b[edge * 4 + 3] as number) >= minY;
  }

  /**
   * File an actor in every bucket one edge of its loop covers. The actors are
   * filed in ascending id, and each files all its edges before the next files
   * any, so a bucket holds an id once.
   */
  file(id: number, edge: number): void {
    const b = this.boxes;
    const x0 = this.column(b[edge * 4] as number, this.originX, this.nx);
    const x1 = this.column(b[edge * 4 + 2] as number, this.originX, this.nx);
    const y0 = this.column(b[edge * 4 + 1] as number, this.originY, this.ny);
    const y1 = this.column(b[edge * 4 + 3] as number, this.originY, this.ny);
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        const bucket = this.cells[iy * this.nx + ix] as number[];
        if (bucket[bucket.length - 1] !== id) bucket.push(id);
      }
    }
  }

  /** The ids of every actor whose loop passes through a box, ascending and without repeats. */
  near(minX: number, minY: number, maxX: number, maxY: number, out: number[]): number[] {
    out.length = 0;
    const x0 = this.column(minX, this.originX, this.nx);
    const x1 = this.column(maxX, this.originX, this.nx);
    const y0 = this.column(minY, this.originY, this.ny);
    const y1 = this.column(maxY, this.originY, this.ny);
    for (let iy = y0; iy <= y1; iy++) {
      for (let ix = x0; ix <= x1; ix++) {
        for (const id of this.cells[iy * this.nx + ix] as number[]) out.push(id);
      }
    }
    out.sort((a, b) => a - b);
    let kept = 0;
    for (let i = 0; i < out.length; i++) {
      if (i > 0 && out[i] === out[i - 1]) continue;
      out[kept++] = out[i] as number;
    }
    out.length = kept;
    return out;
  }

  private column(v: number, origin: number, count: number): number {
    const i = Math.floor((v - origin) / this.cell);
    return i < 0 ? 0 : i >= count ? count - 1 : i;
  }
}

function boxOf(roads: readonly RoadCurve[], edge: RoadEdge, reach: number): [number, number, number, number] {
  const points = (roads[edge.curve] as RoadCurve).points;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = Math.min(edge.start, edge.end); i <= Math.max(edge.start, edge.end); i++) {
    const p = points[i] as Point;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return [minX - reach, minY - reach, maxX + reach, maxY + reach];
}
