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
import { posterDrawCalls } from './poster-mesh.ts';
import { roadDrawCalls } from './road-mesh.ts';
import { signDrawCalls } from './sign-mesh.ts';
import type { ChunkDetail } from './streaming.ts';

/**
 * Batches one cell of a chunk may draw: at most five for the roads, one per
 * tier, at most two for the buildings — the generated facades and the blocks —
 * one for the plants, whatever species stand there, one for the street lamps,
 * whatever tiers carry them, one for the harm-reduction posters, whatever
 * designs they carry, and one for the shop signs.
 */
export const CELL_BATCH_CAP = 11;

/**
 * Batches a chunk spends on the metro entrances of spec section 13.3: one for
 * the whole chunk, since there is no point cutting a dozen objects in a city
 * into cells (`metro.ts`).
 */
const METRO_BATCHES = 1;

/**
 * Draw calls a chunk may cost: {@link CELL_BATCH_CAP} in each of its
 * {@link CHUNK_CELLS} cells, one ground mesh, one line of markings for each of
 * the three marked tiers and one batch of metro entrances, none of which are
 * cut into cells. That is 49. A count over this is a batching regression, not a
 * cap to raise; a system that lands in a chunk later raises it together with
 * the batches it brings.
 */
export const CHUNK_DRAW_CALL_CAP = 1 + 3 + METRO_BATCHES + CELL_BATCH_CAP * CHUNK_CELLS;

/**
 * The most draw calls one chunk costs at near detail: the ground, and the
 * roads, the buildings, the plants, the lamps, the posters and the signs with
 * every kind in every cell.
 *
 * The metro entrances of spec section 13.3 are one batch for the whole chunk
 * and are counted in every chunk, because a chunk does not know the parcels and
 * cannot say whether a station stands in it. A city has a dozen or so.
 */
export function chunkDrawCalls(chunk: WorldChunk): number {
  const batches =
    buildingDrawCalls(chunk) +
    vegetationDrawCalls(chunk) +
    lampDrawCalls(chunk) +
    posterDrawCalls(chunk.buildings.length) +
    signDrawCalls(chunk.buildings.length);
  return 1 + METRO_BATCHES + roadDrawCalls(chunk, CHUNK_CELLS) + batches * CHUNK_CELLS;
}

/**
 * Vertices a chunk's buildings may cost at each detail, shells, roofs and
 * footings together (spec section 9.2). `buildingVertices` is the count.
 *
 * Measured on the dearest chunk of each of 24 sweep seeds, the dearest of them
 * costs 1 240 000 at near detail, 87 000 at mid and 9 600 at far. Each cap
 * stands about a fifth over that. The far count follows the towers: the
 * diamond interchanges moved the core of seed 4007327102 so that 58 towers
 * stand in its chunk 0,0, where 43 stood before. A count over a cap with the
 * same buildings is a regression in the geometry, not a cap to raise.
 */
export const CHUNK_VERTEX_CAP: Readonly<Record<ChunkDetail, number>> = {
  near: 1_500_000,
  mid: 105_000,
  far: 11_500,
};
