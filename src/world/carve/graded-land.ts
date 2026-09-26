/**
 * The land a road of one tier can climb to, over the ground and the crossings
 * of the water description.
 *
 * `LandMasses` (`landmass.ts`) says whether a piece of dry land is joined to
 * the main island at all. It says nothing about the climb: a shelf, a knoll or
 * a ledge behind a cliff is part of the piece the core stands on, and no road
 * of any tier can drive up to it. Anything placed there is built where nobody
 * can arrive.
 *
 * So this floods the grid from the core over dry nodes, stepping only where
 * the rise over one cell stays inside the tier's grade, and hops a crossing of
 * the water description once its near head is climbed to: a bridge lands on a
 * shore, and the road goes on from there. The flood and the hops run in turn
 * until nothing new is reached.
 *
 * Two nodes are joined by the four straight steps only, the way `landmass.ts`
 * joins them: a diagonal step of the road tracer needs both of its neighbours,
 * which is the same reachability.
 */
import type { Heightfield } from '../terrain/heightfield.ts';
import { DRY_MARGIN } from '../roads/road-ground.ts';
import { SEA_LEVEL } from '../terrain/terrain.ts';
import type { Crossing, Point } from '../types.ts';

/** Grid steps around a bridge head searched for the graded ground it stands on. */
const HEAD_REACH = 3;

/** The four straight steps: a diagonal one is not a way across for a road. */
const NEIGHBOUR_X = [1, -1, 0, 0];
const NEIGHBOUR_Y = [0, 0, 1, -1];

export class GradedLand {
  private readonly hf: Heightfield;
  /** 1 where a road of the tier can climb to the node from the core. */
  private readonly reached: Uint8Array;
  private readonly queue: Int32Array;
  private readonly rise: number;
  private readonly dry: number;
  private readonly avoid: ((x: number, y: number) => boolean) | undefined;
  private tail = 0;
  private head = 0;

  /**
   * @param maxGrade Steepest rise over run the tier accepts (`TIERS[tier].maxGrade`).
   * @param crossings Crossings the flood may hop. Left out, it stays on the
   * land the core stands on, which is what a search for the crossings
   * themselves has to ask.
   * @param avoid Ground the flood may not step on: ground a site is about to
   * take, which the roads will keep off.
   */
  constructor(hf: Heightfield, core: Point, maxGrade: number, crossings: readonly Crossing[] = [], avoid?: (x: number, y: number) => boolean) {
    this.hf = hf;
    this.avoid = avoid;
    const n = hf.gridSize;
    this.rise = maxGrade * hf.cellSize;
    this.dry = SEA_LEVEL + DRY_MARGIN;
    this.reached = new Uint8Array(n * n);
    this.queue = new Int32Array(n * n);
    this.seed(core);
    this.flood();
    // A crossing is hopped from whichever head the flood has climbed to, and
    // hopping one can climb to the head of the next, so the two run in turn.
    for (let more = true; more; ) {
      more = false;
      for (const crossing of crossings) {
        if (this.near(crossing.from) && this.seedNear(crossing.to)) more = true;
        if (this.near(crossing.to) && this.seedNear(crossing.from)) more = true;
      }
      if (more) this.flood();
    }
  }

  /** True when the tier can climb to the node under a point. */
  at(x: number, y: number): boolean {
    const node = this.nodeAt(x, y);
    return node >= 0 && this.reached[node] === 1;
  }

  /** True when a node it can climb to stands within a few grid steps of a point. */
  near(p: Point): boolean {
    const hf = this.hf;
    const n = hf.gridSize;
    const cx = Math.round((p.x - hf.originX) / hf.cellSize);
    const cy = Math.round((p.y - hf.originY) / hf.cellSize);
    for (let iy = Math.max(0, cy - HEAD_REACH); iy <= Math.min(n - 1, cy + HEAD_REACH); iy++) {
      for (let ix = Math.max(0, cx - HEAD_REACH); ix <= Math.min(n - 1, cx + HEAD_REACH); ix++) {
        if (this.reached[iy * n + ix] === 1) return true;
      }
    }
    return false;
  }

  /** The grid node under a world point, or -1 outside the grid. */
  private nodeAt(x: number, y: number): number {
    const hf = this.hf;
    const n = hf.gridSize;
    const ix = Math.round((x - hf.originX) / hf.cellSize);
    const iy = Math.round((y - hf.originY) / hf.cellSize);
    if (ix < 0 || iy < 0 || ix >= n || iy >= n) return -1;
    return iy * n + ix;
  }

  /** Take a dry node as reached, and queue it. True when it was not reached already. */
  private seed(p: Point): boolean {
    const node = this.nodeAt(p.x, p.y);
    if (node < 0 || this.reached[node] === 1 || (this.hf.heights[node] as number) < this.dry) return false;
    this.reached[node] = 1;
    this.queue[this.tail++] = node;
    return true;
  }

  /**
   * Seed the flood at a bridge head: the nearest dry node to it, searched in
   * rings so the nearest is taken whichever way it lies. The chord's own end
   * stands on the waterline, which a road may not drive on, so the head itself
   * is often too wet to seed.
   */
  private seedNear(p: Point): boolean {
    const hf = this.hf;
    const cx = Math.round((p.x - hf.originX) / hf.cellSize);
    const cy = Math.round((p.y - hf.originY) / hf.cellSize);
    for (let r = 0; r <= HEAD_REACH; r++) {
      const node = this.dryOnRing(cx, cy, r);
      if (node < 0) continue;
      if (this.reached[node] === 1) return false;
      this.reached[node] = 1;
      this.queue[this.tail++] = node;
      return true;
    }
    return false;
  }

  /** The first dry node on the square ring `r` nodes out from a node, row by row; -1 where none is. */
  private dryOnRing(cx: number, cy: number, r: number): number {
    const hf = this.hf;
    const n = hf.gridSize;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const ix = cx + dx;
        const iy = cy + dy;
        if (ix < 0 || iy < 0 || ix >= n || iy >= n) continue;
        const node = iy * n + ix;
        if ((hf.heights[node] as number) < this.dry) continue;
        return node;
      }
    }
    return -1;
  }

  /** Walk the queue out over every dry step the tier can climb. */
  private flood(): void {
    const hf = this.hf;
    const n = hf.gridSize;
    const reached = this.reached;
    const queue = this.queue;
    while (this.head < this.tail) {
      const at = queue[this.head++] as number;
      const ix = at % n;
      const iy = (at - ix) / n;
      const h = hf.heights[at] as number;
      for (let k = 0; k < NEIGHBOUR_X.length; k++) {
        const jx = ix + (NEIGHBOUR_X[k] as number);
        const jy = iy + (NEIGHBOUR_Y[k] as number);
        if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
        const to = jy * n + jx;
        const g = hf.heights[to] as number;
        if (reached[to] === 1 || g < this.dry || Math.abs(g - h) > this.rise) continue;
        if (this.avoid?.(hf.worldX(jx), hf.worldY(jy)) === true) continue;
        reached[to] = 1;
        queue[this.tail++] = to;
      }
    }
  }
}
