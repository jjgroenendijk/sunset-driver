import { pointInRegions } from '../src/core/geom.ts';
import { type Parcel } from '../src/world/parcels.ts';
import { type Point, type RoadCurve } from '../src/world/types.ts';

/**
 * The two indexes the sweep asks its questions through. Both answer a question a
 * check would otherwise put to every parcel or every road point of a world,
 * which over 200 seeds is the whole cost of the check.
 */
/**
 * The parcels of a world by the ground they cover, so asking which of them
 * claims a place costs a few tests rather than one per parcel.
 */
export class ParcelIndex {
  private readonly parcels: readonly Parcel[];
  private readonly minX: number[] = [];
  private readonly minY: number[] = [];
  private readonly maxX: number[] = [];
  private readonly maxY: number[] = [];

  constructor(parcels: readonly Parcel[]) {
    this.parcels = parcels;
    for (const parcel of parcels) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of parcel.region.outer) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      this.minX.push(minX);
      this.minY.push(minY);
      this.maxX.push(maxX);
      this.maxY.push(maxY);
    }
  }

  /** The parcels that claim a place, by id. More than one of them is a fault. */
  at(p: Point): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.parcels.length; i++) {
      if (p.x < (this.minX[i] as number) || p.x > (this.maxX[i] as number)) continue;
      if (p.y < (this.minY[i] as number) || p.y > (this.maxY[i] as number)) continue;
      const parcel = this.parcels[i] as Parcel;
      if (pointInRegions(p, [parcel.region])) out.push(parcel.id);
    }
    return out;
  }
}

/**
 * Every road point in buckets, so "how far is this ground from a road?" costs a
 * few comparisons. `cell` is the bucket side in metres.
 */
export class PointGrid {
  private readonly cell: number;
  private readonly n: number;
  private readonly half: number;
  private readonly buckets = new Map<number, { p: Point; curve: number }[]>();

  constructor(size: number, cell: number, roads: readonly RoadCurve[]) {
    this.cell = cell;
    this.half = size / 2;
    this.n = Math.ceil(size / cell) + 4;
    for (const road of roads) {
      for (const p of road.points) {
        const key = this.column(p.y) * this.n + this.column(p.x);
        const bucket = this.buckets.get(key);
        if (bucket === undefined) this.buckets.set(key, [{ p, curve: road.id }]);
        else bucket.push({ p, curve: road.id });
      }
    }
  }

  private column(v: number): number {
    return Math.max(0, Math.min(this.n - 1, Math.floor((v + this.half) / this.cell) + 1));
  }

  /**
   * Metres to the nearest road point, ignoring one curve. Infinity when there
   * is none.
   *
   * Each ring adds only its own square of cells, and the best so far is carried
   * from one ring to the next. Scanning the whole square again at every ring
   * costs the cube of the rings searched, and the wilderness, where the nearest
   * road can be twenty cells away, is most of what this grid is asked.
   */
  nearest(x: number, y: number, except = -1): number {
    const cx = this.column(x);
    const cy = this.column(y);
    const last = this.n - 1;
    let best = Infinity; // Squared, so the search does one square root and no more.
    for (let ring = 0; ring <= this.n; ring++) {
      const loY = cy - ring;
      const hiY = cy + ring;
      const loX = cx - ring;
      const hiX = cx + ring;
      for (let iy = Math.max(0, loY); iy <= Math.min(last, hiY); iy++) {
        if (iy === loY || iy === hiY) {
          // A full row of the ring: its top and its bottom.
          for (let ix = Math.max(0, loX); ix <= Math.min(last, hiX); ix++) {
            best = this.closest(iy * this.n + ix, x, y, except, best);
          }
        } else {
          // A row between them: only the two cells on the sides.
          if (loX >= 0) best = this.closest(iy * this.n + loX, x, y, except, best);
          if (hiX <= last) best = this.closest(iy * this.n + hiX, x, y, except, best);
        }
      }
      // Only trust the answer once the rings searched cover it.
      const covered = (ring - 1) * this.cell;
      if (ring >= 1 && best < covered * covered) return Math.sqrt(best);
    }
    return Math.sqrt(best);
  }

  /** The squared distance to the nearest point in one cell, or `best` if it is nearer. */
  private closest(key: number, x: number, y: number, except: number, best: number): number {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return best;
    let near = best;
    for (const e of bucket) {
      if (e.curve === except) continue;
      const dx = e.p.x - x;
      const dy = e.p.y - y;
      const d = dx * dx + dy * dy;
      if (d < near) near = d;
    }
    return near;
  }
}
