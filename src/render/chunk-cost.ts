/**
 * What one chunk costs the frame (spec section 9.2).
 *
 * Every layer a chunk draws is batched by kind, so its cost is a count of kinds
 * rather than a count of things: the ground, the tiers of road that run through
 * it, and the batches its buildings need. The count is answered off the chunk
 * alone, without building any geometry, so the gate can ask it of every chunk of
 * a map and the HUD can show it while playing.
 */
import type { WorldChunk } from '../world/chunks.ts';
import { buildingDrawCalls } from './building-mesh.ts';
import { vegetationDrawCalls } from './plant-mesh.ts';
import { roadDrawCalls } from './road-mesh.ts';

/**
 * Draw calls a chunk may cost. One ground mesh, at most eight for the roads —
 * five tiers, three of them marked — at most three for the buildings — the
 * generated facades, the blocks and the outlines that rim both — and one for the
 * plants, whatever species stand there. A count over this is a batching
 * regression, not a cap to raise; a system that lands in a chunk later raises it
 * together with the batches it brings.
 */
export const CHUNK_DRAW_CALL_CAP = 13;

/** Draw calls one chunk costs: the ground, the roads, the buildings and the plants. */
export function chunkDrawCalls(chunk: WorldChunk): number {
  return 1 + roadDrawCalls(chunk) + buildingDrawCalls(chunk) + vegetationDrawCalls(chunk);
}
