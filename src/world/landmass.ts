/**
 * The connected pieces of dry land, and which of them carry an island of the
 * water description.
 *
 * An island is a power cell of the map, not the land itself. The coastline is
 * cut across those cells after a domain warp, so a cell can hold a rock in the
 * sea a few thousand square metres wide with no island site on it. Nothing
 * reaches such a rock: the roads route over land, so they find no way there and
 * lay none. Anything that places ground content asks here first, and builds
 * only where the network can arrive.
 *
 * Two nodes are one piece of land when a road could walk between them, so only
 * the four straight steps join them. A diagonal step of the road tracer needs
 * both of its neighbours dry, which is the same reachability.
 */
import type { Heightfield } from './heightfield.ts';
import type { Island } from './types.ts';

/** Nodes searched around an island site for the land it stands on, in grid steps. */
const SITE_REACH = 8;

/** The four straight steps: a diagonal one is not a way across for a road. */
const NEIGHBOUR_X = [1, -1, 0, 0];
const NEIGHBOUR_Y = [0, 0, 1, -1];

export class LandMasses {
  private readonly hf: Heightfield;
  /** Piece of land each grid node belongs to, or -1 where it is water. */
  private readonly label: Int32Array;
  /** 1 where the piece of land with that label carries an island site. */
  private readonly inhabited: Uint8Array;

  constructor(hf: Heightfield, islands: readonly Island[], minHeight: number) {
    this.hf = hf;
    const n = hf.gridSize;
    const label = new Int32Array(n * n).fill(-1);
    const queue = new Int32Array(n * n);
    let count = 0;
    for (let start = 0; start < label.length; start++) {
      if (label[start] !== -1 || (hf.heights[start] as number) < minHeight) continue;
      const mass = count++;
      label[start] = mass;
      queue[0] = start;
      let head = 0;
      let tail = 1;
      while (head < tail) {
        const at = queue[head++] as number;
        const ix = at % n;
        const iy = (at - ix) / n;
        for (let k = 0; k < NEIGHBOUR_X.length; k++) {
          const jx = ix + (NEIGHBOUR_X[k] as number);
          const jy = iy + (NEIGHBOUR_Y[k] as number);
          if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
          const to = jy * n + jx;
          if (label[to] !== -1 || (hf.heights[to] as number) < minHeight) continue;
          label[to] = mass;
          queue[tail++] = to;
        }
      }
    }
    this.label = label;
    this.inhabited = new Uint8Array(count);
    for (const island of islands) {
      const mass = this.massNear(island.x, island.y);
      if (mass >= 0) this.inhabited[mass] = 1;
    }
  }

  /** The piece of land under a world point, or -1 over water. */
  massAt(x: number, y: number): number {
    const n = this.hf.gridSize;
    const ix = Math.round((x - this.hf.originX) / this.hf.cellSize);
    const iy = Math.round((y - this.hf.originY) / this.hf.cellSize);
    if (ix < 0 || iy < 0 || ix >= n || iy >= n) return -1;
    return this.label[iy * n + ix] as number;
  }

  /**
   * True when the land under a point carries an island of the water
   * description, so a road can reach it over the ground and the crossings.
   */
  carriesIsland(x: number, y: number): boolean {
    const mass = this.massAt(x, y);
    return mass >= 0 && this.inhabited[mass] === 1;
  }

  /** The piece of land at a site, or the nearest one within {@link SITE_REACH}. */
  private massNear(x: number, y: number): number {
    const n = this.hf.gridSize;
    const cx = Math.round((x - this.hf.originX) / this.hf.cellSize);
    const cy = Math.round((y - this.hf.originY) / this.hf.cellSize);
    for (let r = 0; r <= SITE_REACH; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const ix = cx + dx;
          const iy = cy + dy;
          if (ix < 0 || iy < 0 || ix >= n || iy >= n) continue;
          const mass = this.label[iy * n + ix] as number;
          if (mass >= 0) return mass;
        }
      }
    }
    return -1;
  }
}
