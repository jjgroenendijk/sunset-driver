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
 * Metres a box is grown by for {@link FarCache}, at most, and the least it is
 * tried at. The most differs by id, so the entries a tick notes do not all run
 * out on one tick. Somebody whose edge the grown box meets is tried again at
 * half the margin, down to the least.
 */
const FAR_MARGIN = 40;
const FAR_SPREAD = 5;
const FAR_LEAST = 5;

/**
 * Who was found far from the box, and for how long that holds, so their loop
 * is not read again every tick (issue #778).
 *
 * A car or a person whose edge does not meet the box, grown by a margin, stays
 * out of the box while two things hold: they stay on that edge, and the box
 * moves less than the margin. The first is read off their loop once, as ticks
 * left on the edge. Their hold may change the time they stand at, so the
 * entry also keeps the time's offset from the tick. The answer is exactly the
 * one the full test gives, so a replay without the cache matches one with it.
 */
export class FarCache {
  private until: number[] = [];
  private offset: number[] = [];
  private margin: number[] = [];
  private atX: number[] = [];
  private atY: number[] = [];

  /** True while `id`, standing at `offset` ticks from the tick, is known to be out of the box round `(x, y)`. */
  skips(id: number, tick: number, offset: number, x: number, y: number): boolean {
    const until = this.until[id];
    if (until === undefined || tick >= until || this.offset[id] !== offset) return false;
    const margin = this.margin[id] as number;
    return Math.abs(x - (this.atX[id] as number)) <= margin && Math.abs(y - (this.atY[id] as number)) <= margin;
  }

  /**
   * Note `id` as out of the box of `reach` round `(x, y)` for `left` ticks,
   * at the widest margin that `meets` says their edge misses.
   */
  note(
    id: number,
    tick: number,
    offset: number,
    x: number,
    y: number,
    reach: number,
    meets: (minX: number, minY: number, maxX: number, maxY: number) => boolean,
    left: () => number,
  ): void {
    let margin = FAR_MARGIN + (id % 8) * FAR_SPREAD;
    while (margin >= FAR_LEAST) {
      const r = reach + margin;
      if (!meets(x - r, y - r, x + r, y + r)) break;
      margin /= 2;
    }
    if (margin < FAR_LEAST) return;
    const ticks = left();
    if (ticks <= 0) return;
    while (this.until.length <= id) {
      this.until.push(-1);
      this.offset.push(0);
      this.margin.push(0);
      this.atX.push(0);
      this.atY.push(0);
    }
    this.until[id] = tick + ticks;
    this.offset[id] = offset;
    this.margin[id] = margin;
    this.atX[id] = x;
    this.atY[id] = y;
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
