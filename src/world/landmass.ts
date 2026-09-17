/**
 * The connected pieces of dry land, and which of them the road network can
 * arrive at.
 *
 * An island is a power cell of the map, not the land itself. The coastline is
 * cut across those cells after a domain warp, so a cell can hold a rock in the
 * sea a few thousand square metres wide, and a cell can hold several pieces of
 * land that no crossing joins. Nothing reaches such a piece: the roads route
 * over the ground and bridge only the crossings of the water description, so
 * they find no way there and lay none. Anything that places ground content asks
 * here first, and builds only where the network can arrive.
 *
 * A piece of land is reached when it is the one the main island stands on, or a
 * chain of crossings leads to it from there. Asking only whether a piece
 * carries an island site is not enough: a crossing lands where the ground is
 * dry, and both ends of one can be pieces the mainland never reaches.
 *
 * Two nodes are one piece of land when a road could walk between them, so only
 * the four straight steps join them. A diagonal step of the road tracer needs
 * both of its neighbours dry, which is the same reachability.
 */
import type { Heightfield } from './heightfield.ts';
import type { District, Island, WaterDescription } from './types.ts';

/** Nodes searched around an island site for the land it stands on, in grid steps. */
const SITE_REACH = 8;

/** The four straight steps: a diagonal one is not a way across for a road. */
const NEIGHBOUR_X = [1, -1, 0, 0];
const NEIGHBOUR_Y = [0, 0, 1, -1];

export class LandMasses {
  private readonly hf: Heightfield;
  /** Piece of land each grid node belongs to, or -1 where it is water. */
  private readonly label: Int32Array;
  /** 1 where the road network can arrive at the piece of land with that label. */
  private readonly reached: Uint8Array;
  /** The pieces each crossing of the water description joins, by label. */
  private readonly linked: number[][] = [];
  /** The piece the main island stands on, or -1 where it stands on none. */
  private mainMass = -1;

  constructor(hf: Heightfield, water: WaterDescription, minHeight: number) {
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
    this.reached = this.floodFromMain(water, count);
  }

  /**
   * The pieces of land the network can arrive at: the one the main island
   * stands on, and every piece a chain of crossings leads to from it.
   */
  private floodFromMain(water: WaterDescription, count: number): Uint8Array {
    const linked = this.linked;
    for (let i = 0; i < count; i++) linked.push([]);
    for (const crossing of water.crossings) {
      const a = this.massNear(crossing.from.x, crossing.from.y);
      const b = this.massNear(crossing.to.x, crossing.to.y);
      if (a < 0 || b < 0 || a === b) continue;
      (linked[a] as number[]).push(b);
      (linked[b] as number[]).push(a);
    }
    const reached = new Uint8Array(count);
    let main: Island | undefined;
    for (const island of water.islands) if (island.main) main = island;
    const start = main === undefined ? -1 : this.massNear(main.x, main.y);
    this.mainMass = start;
    if (start < 0) return reached;
    reached[start] = 1;
    const queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      for (const to of linked[queue[qi] as number] as number[]) {
        if (reached[to] === 1) continue;
        reached[to] = 1;
        queue.push(to);
      }
    }
    return reached;
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
   * The pieces of land a road is really laid on, one flag each: the piece the
   * main island stands on, every piece a district stands on, and every piece a
   * chain of crossings runs through on the way from the one to the other.
   *
   * {@link reaches} says a road *could* arrive; this says it *will*.
   * `linkIslands` (`roads.ts`) bridges to an island that carries a district and
   * to the islands on the way there, and to nothing else, so a piece a chain of
   * crossings leads to still gets no road when no district stands at the end of
   * that chain. Content that needs a road to be worth placing has to ask this.
   * The two walk the same chain, from the two ends.
   */
  servedMasses(districts: readonly District[]): Uint8Array {
    const count = this.linked.length;
    const served = new Uint8Array(count);
    if (this.mainMass < 0) return served;
    // Breadth-first from the main piece, keeping the crossing each piece was
    // first reached over, so following parents leads back to the main piece.
    const parent = new Int32Array(count).fill(-1);
    const queue = [this.mainMass];
    parent[this.mainMass] = this.mainMass;
    for (let qi = 0; qi < queue.length; qi++) {
      for (const to of this.linked[queue[qi] as number] as number[]) {
        if (parent[to] !== -1) continue;
        parent[to] = queue[qi] as number;
        queue.push(to);
      }
    }
    served[this.mainMass] = 1;
    for (const d of districts) {
      let mass = this.massNear(d.x, d.y);
      while (mass >= 0 && served[mass] === 0) {
        served[mass] = 1;
        const up = parent[mass] as number;
        if (up === -1 || up === mass) break;
        mass = up;
      }
    }
    return served;
  }

  /**
   * True when a road can arrive at the land under a point, over the ground and
   * the crossings of the water description.
   */
  reaches(x: number, y: number): boolean {
    const mass = this.massAt(x, y);
    return mass >= 0 && this.reached[mass] === 1;
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
