/**
 * The dry land as polygons: the coastline of spec section 7.2 read off the
 * heightfield.
 *
 * Everything else about the land is a grid — the heightfield itself, the pieces
 * `landmass.ts` labels — but the parcel model of spec section 6.4 subtracts the
 * road footprint from the land, and subtraction is polygon arithmetic. So the
 * waterline is traced here once and handed to `src/core/geom.ts`.
 *
 * The trace is marching squares over the height grid. A cell's four corners are
 * each dry or wet, and the contour crosses the cell edge between a dry corner
 * and a wet one. The crossing is where the two corner heights cross the sea
 * level, so the two cells that share a grid edge put it in exactly the same
 * place and the pieces chain into closed rings with no gaps. Where two dry
 * corners stand diagonally opposite two wet ones the cell is a saddle, and the
 * height at its middle says whether the land runs through it or the water does.
 *
 * Every ring comes back wound with the land on its left: an island
 * anticlockwise, a lake inside it clockwise. That is the winding the boolean
 * engine reads, so the rings go straight into a region.
 *
 * Pure and headless: the same heightfield gives the same rings, in the same
 * order, on every machine.
 */
import { regionsFromRings, ringArea, type Point, type Region } from '../../core/geom.ts';
import type { Heightfield } from './heightfield.ts';

/**
 * Square metres below which a piece of land is dropped as a rock in the sea,
 * and a pond as a puddle. One height cell is 100 m², so this is a patch four
 * cells across: too small to stand anything on and too small to sail into.
 */
const MIN_RING_AREA = 400;

/**
 * Metres the water outside the grid stands below the sea level. The trace puts
 * a crossing where the heights either side of a cell edge meet that level, so
 * a depth this far down puts it on the last node of the grid rather than a
 * fraction of a cell beyond it, and land that reaches the edge of the map
 * closes on the edge itself.
 */
const OFF_GRID_DEPTH = 1e6;

/** Which side of a cell a contour piece runs from or to. */
type Side = 0 | 1 | 2 | 3;
const BOTTOM: Side = 0;
const RIGHT: Side = 1;
const TOP: Side = 2;
const LEFT: Side = 3;

/**
 * The contour pieces of each of the sixteen corner patterns, as pairs of sides
 * with the land on the left. The pattern is a bit per corner, anticlockwise
 * from the bottom left: 1 the bottom left, 2 the bottom right, 4 the top right,
 * 8 the top left. The two saddles, 5 and 10, are decided by the middle of the
 * cell and are not in the table.
 */
const PIECES: readonly (readonly Side[])[] = [
  [], // 0: all wet
  [BOTTOM, LEFT],
  [RIGHT, BOTTOM],
  [RIGHT, LEFT],
  [TOP, RIGHT],
  [], // 5: saddle
  [TOP, BOTTOM],
  [TOP, LEFT],
  [LEFT, TOP],
  [BOTTOM, TOP],
  [], // 10: saddle
  [RIGHT, TOP],
  [LEFT, RIGHT],
  [BOTTOM, RIGHT],
  [LEFT, BOTTOM],
  [], // 15: all dry
];

/** The saddle where the land runs through the middle, and where the water does. */
const SADDLE_5_JOINED: readonly Side[] = [BOTTOM, RIGHT, TOP, LEFT];
const SADDLE_5_SPLIT: readonly Side[] = [BOTTOM, LEFT, TOP, RIGHT];
const SADDLE_10_JOINED: readonly Side[] = [LEFT, BOTTOM, RIGHT, TOP];
const SADDLE_10_SPLIT: readonly Side[] = [RIGHT, BOTTOM, LEFT, TOP];

/**
 * The pieces of a saddle cell, pattern 5 or 10. The middle of the cell
 * decides whether the land runs through it or the water does, so the two
 * pieces never cross each other.
 */
function saddleSides(pattern: number, middleDry: boolean): readonly Side[] {
  if (pattern === 5) return middleDry ? SADDLE_5_JOINED : SADDLE_5_SPLIT;
  return middleDry ? SADDLE_10_JOINED : SADDLE_10_SPLIT;
}

/**
 * The dry land of a heightfield as regions, with the ponds in it as holes.
 * `level` is the height the water stands at.
 */
export function landRegions(hf: Heightfield, level: number): Region[] {
  return regionsFromRings(landRings(hf, level));
}

/** The coastline as closed rings, land on the left. */
export function landRings(hf: Heightfield, level: number): Point[][] {
  const trace = new Trace(hf, level);
  trace.walkCells();
  return trace.rings();
}

/**
 * One run of marching squares: the contour pieces of every cell, then the
 * pieces chained into rings.
 *
 * A piece runs from one grid edge to another, and a grid edge carries at most
 * one crossing, so an edge is named by its own place in the grid rather than by
 * the coordinates of that crossing. Each edge is then the end of exactly one
 * piece and the start of exactly one other, and chaining is a walk.
 */
class Trace {
  private readonly hf: Heightfield;
  private readonly level: number;
  /** Nodes per side, and the stride of the edge keys, which allows one node past each end. */
  private readonly n: number;
  private readonly stride: number;
  /** The grid edge each piece runs from and to. */
  private readonly from: number[] = [];
  private readonly to: number[] = [];
  /** The piece leaving each grid edge, by edge key. */
  private readonly leaving = new Map<number, number>();
  /** Where the contour crosses each grid edge, by edge key. */
  private readonly crossing = new Map<number, Point>();

  constructor(hf: Heightfield, level: number) {
    this.hf = hf;
    this.level = level;
    this.n = hf.gridSize;
    this.stride = this.n + 2;
  }

  /**
   * Every cell of the grid, and one ring of cells outside it. Ground beyond the
   * grid is water, so a coastline that runs to the edge of the map still closes.
   */
  walkCells(): void {
    for (let iy = -1; iy < this.n; iy++) {
      for (let ix = -1; ix < this.n; ix++) this.cell(ix, iy);
    }
  }

  /** The rings the pieces chain into, each wound with the land on its left. */
  rings(): Point[][] {
    const out: Point[][] = [];
    const done = new Uint8Array(this.from.length);
    for (let start = 0; start < this.from.length; start++) {
      if (done[start] === 1) continue;
      const ring: Point[] = [];
      let piece = start;
      do {
        done[piece] = 1;
        ring.push(this.crossing.get(this.from[piece] as number) as Point);
        const next = this.leaving.get(this.to[piece] as number);
        // Every edge is left by a piece, so this only ends at the ring's start.
        if (next === undefined) break;
        piece = next;
      } while (done[piece] === 0);
      if (ring.length < 3) continue;
      if (Math.abs(ringArea(ring)) < MIN_RING_AREA) continue;
      out.push(ring);
    }
    return out;
  }

  /** The height at a grid node. Anything off the grid is water. */
  private heightAt(ix: number, iy: number): number {
    if (ix < 0 || iy < 0 || ix >= this.n || iy >= this.n) return this.level - OFF_GRID_DEPTH;
    return this.hf.at(ix, iy);
  }

  /** The contour pieces of one cell, whose bottom left corner is the node `(ix, iy)`. */
  private cell(ix: number, iy: number): void {
    const h00 = this.heightAt(ix, iy);
    const h10 = this.heightAt(ix + 1, iy);
    const h11 = this.heightAt(ix + 1, iy + 1);
    const h01 = this.heightAt(ix, iy + 1);
    const level = this.level;
    const pattern =
      (h00 >= level ? 1 : 0) | (h10 >= level ? 2 : 0) | (h11 >= level ? 4 : 0) | (h01 >= level ? 8 : 0);
    if (pattern === 0 || pattern === 15) return;
    const sides = pattern === 5 || pattern === 10 ? saddleSides(pattern, (h00 + h10 + h11 + h01) / 4 >= level) : (PIECES[pattern] as readonly Side[]);
    for (let i = 0; i + 1 < sides.length; i += 2) {
      this.piece(ix, iy, sides[i] as Side, sides[i + 1] as Side);
    }
  }

  /** Record one piece, and where the contour crosses each of the two sides it joins. */
  private piece(ix: number, iy: number, from: Side, to: Side): void {
    const a = this.sideKey(ix, iy, from);
    const b = this.sideKey(ix, iy, to);
    if (!this.crossing.has(a)) this.crossing.set(a, this.crossingOn(ix, iy, from));
    if (!this.crossing.has(b)) this.crossing.set(b, this.crossingOn(ix, iy, to));
    this.leaving.set(a, this.from.length);
    this.from.push(a);
    this.to.push(b);
  }

  /**
   * A side of a cell as the grid edge it is. The bottom of one cell is the top
   * of the cell below it, so both name the same key and both put the crossing
   * in the same place.
   */
  private sideKey(ix: number, iy: number, side: Side): number {
    const horizontal = side === BOTTOM || side === TOP;
    const x = side === RIGHT ? ix + 1 : ix;
    const y = side === TOP ? iy + 1 : iy;
    return (((y + 1) * this.stride + (x + 1)) << 1) | (horizontal ? 0 : 1);
  }

  /** Where the sea level crosses one side of a cell, in world metres. */
  private crossingOn(ix: number, iy: number, side: Side): Point {
    const horizontal = side === BOTTOM || side === TOP;
    const x = side === RIGHT ? ix + 1 : ix;
    const y = side === TOP ? iy + 1 : iy;
    const here = this.heightAt(x, y);
    const next = horizontal ? this.heightAt(x + 1, y) : this.heightAt(x, y + 1);
    const span = next - here;
    const t = span === 0 ? 0.5 : (this.level - here) / span;
    const cell = this.hf.cellSize;
    return {
      x: this.hf.originX + (x + (horizontal ? t : 0)) * cell,
      y: this.hf.originY + (y + (horizontal ? 0 : t)) * cell,
    };
  }
}
