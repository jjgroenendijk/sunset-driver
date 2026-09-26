/**
 * The buckets giving way files the cars and the people of the box in, and
 * the cache of whose loop passes near the box (`give-way.ts`).
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
