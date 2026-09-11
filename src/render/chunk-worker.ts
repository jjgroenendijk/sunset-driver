/**
 * A worker that builds chunks (spec section 9.1).
 *
 * The main thread generates the whole-map skeleton once and sends it here.
 * The worker then builds the layers a chunk is cut from — the road graph, the
 * footprint, the parcels, the buildings and the carve — and answers one chunk
 * at a time with everything that chunk draws, as plain arrays.
 *
 * The layers are the dearest thing in the project and each worker builds its
 * own copy of them, because they carry methods and cannot be shared. That is
 * paid once at the start of a session, off the frame, and every chunk after
 * that is a clip and a loft. The frame is charged only for the upload.
 *
 * `chunk-pool.ts` is the other side of this conversation.
 */
import { buildLayers, ChunkSource } from '../world/chunks.ts';
import type { WorldDescription } from '../world/types.ts';
import { buildChunkPayload, chunkLookups, payloadTransfers, type ChunkLookups, type ChunkPayload } from './chunk-payload.ts';
import type { ChunkDetail } from './streaming.ts';

/** Build the layers of this world and stand by. Sent once, before anything else. */
export interface StartCommand {
  type: 'start';
  world: WorldDescription;
}

/** Build one chunk at one detail. */
export interface ChunkCommand {
  type: 'chunk';
  cx: number;
  cy: number;
  detail: ChunkDetail;
}

export type WorkerCommand = StartCommand | ChunkCommand;

/** The layers are built and the worker is free. Sent once, then after each chunk. */
export interface ReadyReply {
  type: 'ready';
}

/** One chunk, built. */
export interface ChunkReply {
  type: 'chunk';
  payload: ChunkPayload;
}

export type WorkerReply = ReadyReply | ChunkReply;

/**
 * What a dedicated worker's global scope offers. `self` is typed as a window
 * here, because the project is built with the DOM library and a worker library
 * cannot be added beside it.
 */
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

const scope = self as unknown as WorkerScope;

let source: ChunkSource | undefined;
let lookups: ChunkLookups | undefined;

scope.addEventListener('message', (event: MessageEvent) => {
  const command = event.data as WorkerCommand;
  if (command.type === 'start') {
    const world = command.world;
    const layers = buildLayers(world);
    source = new ChunkSource(world, layers);
    lookups = chunkLookups(world, layers);
    scope.postMessage({ type: 'ready' } satisfies ReadyReply);
    return;
  }
  if (source === undefined || lookups === undefined) throw new Error('a chunk was asked for before the world arrived');
  const payload = buildChunkPayload(source.chunk(command.cx, command.cy), lookups, command.detail);
  // The arrays are handed over rather than copied: the worker keeps no
  // reference to them, and a chunk of the core is megabytes of geometry.
  scope.postMessage({ type: 'chunk', payload } satisfies ChunkReply, payloadTransfers(payload));
  scope.postMessage({ type: 'ready' } satisfies ReadyReply);
});
