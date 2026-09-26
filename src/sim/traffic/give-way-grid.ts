/**
 * The box giving way decides (`give-way.ts`), the buckets it files the cars
 * and the people of the box in, and the cache of whose loop passes near it.
 */

/** Metres the box of candidates is grown by, and snapped to, so it is looked up again only now and then. */
const NEAR_SNAP = 40;

type Near = (minX: number, minY: number, maxX: number, maxY: number, out: number[]) => number[];

/**
 * Whose loop passes near a box, asked of an index only when the box has moved
 * to another snap of the map. The answer is a function of the snap alone, so
 * it is the same in a replay.
 */
export class NearCache {
  private key = '';
  private readonly ids: number[] = [];

  of(x: number, y: number, reach: number, near: Near): readonly number[] {
    const sx = Math.floor(x / NEAR_SNAP);
    const sy = Math.floor(y / NEAR_SNAP);
    const key = `${sx},${sy},${reach}`;
    if (key !== this.key) {
      this.key = key;
      const r = reach + NEAR_SNAP;
      near(sx * NEAR_SNAP - r, sy * NEAR_SNAP - r, (sx + 1) * NEAR_SNAP + r, (sy + 1) * NEAR_SNAP + r, this.ids);
    }
    return this.ids;
  }
}

/**
 * Buckets of the box, each a list of indices. Only the buckets filled on the
 * last tick are emptied for the next: a few hundred of more than a thousand.
 */
export class Grid {
  readonly cells: number[][] = [];
  private readonly used: number[] = [];

  reset(count: number): void {
    for (const i of this.used) (this.cells[i] as number[]).length = 0;
    this.used.length = 0;
    while (this.cells.length < count) this.cells.push([]);
  }

  add(cell: number, entry: number): void {
    const list = this.cells[cell] as number[];
    if (list.length === 0) this.used.push(cell);
    list.push(entry);
  }
}

/** Metres of one bucket of the grids the box is filed in. */
const CELL = 12;

/**
 * The box round the player that giving way decides, cut into the buckets its
 * grids file the cars and the people in.
 */
export class BoxFrame {
  minX = 0;
  minY = 0;
  cols = 0;
  /** Metres each way of the middle the box reaches. */
  reach = 0;

  /** Stand the box round `(x, y)`, `reach` metres each way, and answer how many buckets a grid of it needs. */
  set(x: number, y: number, reach: number): number {
    this.minX = x - reach;
    this.minY = y - reach;
    this.reach = reach;
    this.cols = Math.ceil((2 * reach) / CELL) + 1;
    return this.cols * this.cols;
  }

  get midX(): number {
    return this.minX + this.reach;
  }

  get midY(): number {
    return this.minY + this.reach;
  }

  inBox(x: number, y: number): boolean {
    const max = 2 * this.reach;
    return x >= this.minX && x < this.minX + max && y >= this.minY && y < this.minY + max;
  }

  cellOf(x: number, y: number): number {
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.minX) / CELL)));
    const cy = Math.max(0, Math.min(this.cols - 1, Math.floor((y - this.minY) / CELL)));
    return cy * this.cols + cx;
  }

  /** Every entry of a grid filed within `r` of a point, into `out`. */
  around(grid: Grid, x: number, y: number, r: number, out: number[]): number[] {
    out.length = 0;
    const cx0 = Math.max(0, Math.floor((x - r - this.minX) / CELL));
    const cx1 = Math.min(this.cols - 1, Math.floor((x + r - this.minX) / CELL));
    const cy0 = Math.max(0, Math.floor((y - r - this.minY) / CELL));
    const cy1 = Math.min(this.cols - 1, Math.floor((y + r - this.minY) / CELL));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (const entry of grid.cells[cy * this.cols + cx] as number[]) out.push(entry);
      }
    }
    return out;
  }
}
