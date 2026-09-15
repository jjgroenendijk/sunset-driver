/**
 * What one chunk costs the frame (spec section 9.2).
 *
 * Every layer a chunk draws is batched by kind and by cell (`cells.ts`), so its
 * cost is a count of kinds and cells rather than a count of things: the ground,
 * the tiers of road that run through it, and the batches its buildings need.
 * The count is answered off the chunk alone, without building any geometry, so
 * the gate can ask it of every chunk of a map. It is the most the chunk costs:
 * it takes every kind to fill every cell. `payloadDrawCalls` counts the cells a
 * built chunk fills, and the HUD shows that.
 */
import type { WorldChunk } from '../world/chunks.ts';
import { buildingDrawCalls } from './building-mesh.ts';
import { CHUNK_CELLS } from './cells.ts';
import { lampDrawCalls } from './lamp-mesh.ts';
import { vegetationDrawCalls } from './plant-mesh.ts';
import { roadDrawCalls } from './road-mesh.ts';
import type { ChunkDetail } from './streaming.ts';

/**
 * Batches one cell of a chunk may draw: at most five for the roads, one per
 * tier, at most three for the buildings — the generated facades, the blocks
 * and the outlines that rim both — one for the plants, whatever species stand
 * there, and one for the street lamps, whatever tiers carry them.
 */
export const CELL_BATCH_CAP = 10;

/**
 * Draw calls a chunk may cost: {@link CELL_BATCH_CAP} in each of its
 * {@link CHUNK_CELLS} cells, one ground mesh, and one line of markings for each
 * of the three marked tiers, which are not cut into cells. That is 44. A count
 * over this is a batching regression, not a cap to raise; a system that lands
 * in a chunk later raises it together with the batches it brings.
 */
export const CHUNK_DRAW_CALL_CAP = 1 + 3 + CELL_BATCH_CAP * CHUNK_CELLS;

/**
 * The most draw calls one chunk costs at near detail: the ground, and the
 * roads, the buildings, the plants and the lamps with every kind in every cell.
 */
export function chunkDrawCalls(chunk: WorldChunk): number {
  const batches = buildingDrawCalls(chunk) + vegetationDrawCalls(chunk) + lampDrawCalls(chunk);
  return 1 + roadDrawCalls(chunk, CHUNK_CELLS) + batches * CHUNK_CELLS;
}

/**
 * Vertices a chunk's buildings may cost at each detail, shells and outlines
 * together (spec section 9.2). `buildingVertices` is the count.
 *
 * Measured on the dearest chunk of each of 24 sweep seeds, the dearest of them
 * costs 1 240 000 at near detail, 87 000 at mid and 7 300 at far. Each cap
 * stands about a fifth over that. A count over a cap is a regression in the
 * geometry, not a cap to raise.
 */
export const CHUNK_VERTEX_CAP: Readonly<Record<ChunkDetail, number>> = {
  near: 1_500_000,
  mid: 105_000,
  far: 9_000,
};
