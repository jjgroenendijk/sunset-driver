/**
 * The cells a chunk's batches are cut into (spec section 9.2).
 *
 * A batch is one merged mesh, and the renderer culls a mesh as a whole: in the
 * view, in each shadow cascade and in the water's mirror. A batch that spans
 * its whole chunk is drawn whole wherever any corner of the chunk is seen, and
 * a chunk is 250 m across. So each batch is cut into cells, and a part goes
 * into the cell its middle stands in. Every cell of a kind is drawn in that
 * kind's one material, so the shaders stay shared between every chunk.
 *
 * A cell costs a draw in every pass it is seen in, so the size of a cell is a
 * trade. A quarter of a chunk is where the frame came out best (see
 * `docs/streaming.md`). The far ring is not cut: its batches are a few thousand
 * vertices, and a draw costs more than culling them saves.
 *
 * Nothing here touches three.js, so a worker and a test read it alike.
 */
import type { ChunkBounds } from '../world/chunks.ts';
import type { ChunkDetail } from './streaming.ts';

/** Cells along each side of a chunk, at each detail. */
const CELLS_PER_SIDE: Readonly<Record<ChunkDetail, number>> = { near: 2, mid: 2, far: 1 };

/** Cells a chunk is cut into at most, which is at near detail. */
export const CHUNK_CELLS = CELLS_PER_SIDE.near ** 2;

/** The cells of one chunk: the ground it covers, and how many cells each way. */
export interface CellGrid {
  bounds: ChunkBounds;
  perSide: number;
}

/** The cells of a chunk built at a detail. */
export function cellGrid(bounds: ChunkBounds, detail: ChunkDetail): CellGrid {
  return { bounds, perSide: CELLS_PER_SIDE[detail] };
}

/**
 * The cell a place stands in, numbered row by row. A place outside the chunk
 * — a bevel over the edge — is given the nearest cell.
 */
export function cellAt(grid: CellGrid, x: number, y: number): number {
  const { bounds, perSide } = grid;
  const column = Math.floor(((x - bounds.minX) / (bounds.maxX - bounds.minX)) * perSide);
  const row = Math.floor(((y - bounds.minY) / (bounds.maxY - bounds.minY)) * perSide);
  return clamp(row, perSide) * perSide + clamp(column, perSide);
}

/**
 * The cell a part stands in. A part with a frame stands at the origin of that
 * frame, which is the middle of a building's lot and the foot of a plant or a
 * mast. A part without one is already in world places, and stands at the
 * middle of the box its positions span. `x` and `z` of a position are the
 * map's `x` and `y`.
 */
export function cellOfPart(grid: CellGrid, positions: ArrayLike<number>, matrix: ArrayLike<number> | undefined): number {
  if (matrix !== undefined) return cellAt(grid, matrix[12] as number, matrix[14] as number);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i] as number;
    const z = positions[i + 2] as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (minX > maxX) return 0;
  return cellAt(grid, (minX + maxX) / 2, (minZ + maxZ) / 2);
}

/**
 * Items sorted into their cells: one list per cell that holds any, in cell
 * order, each keeping the order the items came in.
 */
export function byCell<T>(grid: CellGrid, items: readonly T[], cellOf: (item: T) => number): T[][] {
  const cells: T[][] = Array.from({ length: grid.perSide * grid.perSide }, () => []);
  for (const item of items) (cells[cellOf(item)] as T[]).push(item);
  return cells.filter((cell) => cell.length > 0);
}

/** Cells that hold at least one of a list of places. */
export function cellsHolding(grid: CellGrid, count: number, placeOf: (i: number) => { x: number; y: number }): number {
  const held = new Uint8Array(grid.perSide * grid.perSide);
  for (let i = 0; i < count; i++) {
    const place = placeOf(i);
    held[cellAt(grid, place.x, place.y)] = 1;
  }
  return held.reduce((sum, one) => sum + one, 0);
}

function clamp(index: number, perSide: number): number {
  return index < 0 ? 0 : index >= perSide ? perSide - 1 : index;
}
