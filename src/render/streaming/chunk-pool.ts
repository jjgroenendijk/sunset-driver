/**
 * The pool of workers that build the chunks (spec sections 9.1, 2.4).
 *
 * The scene says which chunks it wants and at what detail, nearest first, and
 * takes whatever has arrived. Nothing here blocks: a frame that asks for
 * twenty chunks and gets none back is a frame that cost nothing, and the
 * chunks turn up over the frames after it. That is the trade spec section 9.1
 * asks for — chunks arrive later, the frame rate is never spent.
 *
 * A request the scene stops asking for is dropped from the queue on the next
 * call, so driving away from a chunk cancels it before a worker starts on it.
 * One already in a worker is left to finish, because a worker cannot be
 * interrupted, and its payload is thrown away if nobody wants it by then.
 */
import type { MetroStation } from '../../world/transit/metro.ts';
import type { ParkingBays } from '../../world/city/parking.ts';
import type { Shop } from '../../world/city/shops.ts';
import type { Point, WorldDescription } from '../../world/types.ts';
import type { ChunkPayload } from './chunk-payload.ts';
import type { WorkerCommand, WorkerReply } from './chunk-worker.ts';
import type { ChunkDetail, ChunkWant } from './streaming.ts';

/**
 * Workers building chunks, at most. Each one holds its own copy of the
 * whole-map layers, which is the largest thing in memory, so a third copy
 * costs more than the parallelism buys on the machines spec section 2.4 aims
 * at.
 */
const MAX_WORKERS = 2;

/** Where the scene gets its chunks from. */
export interface ChunkStream {
  /** Ask for these chunks, nearest first, and forget every request not in the list. */
  want(wants: readonly ChunkWant[]): void;
  /** A chunk that has arrived and is still wanted, or nothing. */
  take(): ChunkPayload | undefined;
  /** Chunks asked for and not yet taken. */
  readonly pending: number;
  /** The police stations of the world (spec section 11.7), once a worker has built the parcels. */
  readonly stations?: readonly Point[];
  /** The metro stations of the world (spec section 13.3), from the same answer. */
  readonly metro?: readonly MetroStation[];
  /** The shops of the world (spec section 16.1), from the same answer. */
  readonly shops?: readonly Shop[];
  /** The parking bays of the world (spec section 13.1), from the same worker's answer. */
  readonly bays?: ParkingBays;
  dispose(): void;
}

/** One worker, as the pool talks to it. A test hands the pool its own. */
export interface ChunkWorker {
  post(command: WorkerCommand): void;
  onReply(listener: (reply: WorkerReply) => void): void;
  terminate(): void;
}

/** One worker of the pool, and what it is doing. */
interface Slot {
  worker: ChunkWorker;
  /** False until the worker has built its layers. */
  ready: boolean;
  /** The chunk it is building, if any. */
  busy?: string;
}

/** A pool of workers, each with a copy of the world. */
export class ChunkPool implements ChunkStream {
  private readonly slots: Slot[] = [];
  private queue: ChunkWant[] = [];
  private readonly wanted = new Map<string, ChunkDetail>();
  private readonly inFlight = new Map<string, ChunkDetail>();
  private readonly arrived: ChunkPayload[] = [];
  /** Every worker builds the same parcels, so the first to answer says where the stations are. */
  stations: readonly Point[] | undefined;
  metro: readonly MetroStation[] | undefined;
  shops: readonly Shop[] | undefined;
  /** The bays the one worker that was asked for them laid out. */
  bays: ParkingBays | undefined;

  constructor(world: WorldDescription, spawn: () => ChunkWorker = spawnChunkWorker, size = poolSize()) {
    for (let i = 0; i < size; i++) {
      const slot: Slot = { worker: spawn(), ready: false };
      this.slots.push(slot);
      slot.worker.onReply((reply) => this.receive(slot, reply));
      // Only the first worker lays out the parking bays: the answer is the
      // same from every one of them, and building it delays a worker's first chunk.
      slot.worker.post({ type: 'start', world, bays: i === 0 });
    }
  }

  want(wants: readonly ChunkWant[]): void {
    this.wanted.clear();
    for (const want of wants) this.wanted.set(keyOf(want.cx, want.cy), want.detail);
    // A chunk already in a worker is not asked for again. Should the detail
    // wanted have changed while it was building, the scene asks for the new
    // one on the frame after the old one lands.
    this.queue = wants.filter((want) => !this.inFlight.has(keyOf(want.cx, want.cy)));
    this.pump();
  }

  take(): ChunkPayload | undefined {
    return this.arrived.shift();
  }

  get pending(): number {
    return this.queue.length + this.inFlight.size + this.arrived.length;
  }

  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate();
    this.slots.length = 0;
    this.queue = [];
    this.inFlight.clear();
    this.arrived.length = 0;
  }

  private receive(slot: Slot, reply: WorkerReply): void {
    if (reply.type === 'ready') {
      if (reply.stations !== undefined) this.stations ??= reply.stations;
      if (reply.metro !== undefined) this.metro ??= reply.metro;
      if (reply.shops !== undefined) this.shops ??= reply.shops;
      if (reply.bays !== undefined) this.bays ??= reply.bays;
      slot.ready = true;
      slot.busy = undefined;
      this.pump();
      return;
    }
    const payload = reply.payload;
    const key = keyOf(payload.cx, payload.cy);
    this.inFlight.delete(key);
    // A chunk nobody wants any more is dropped rather than drawn: the player
    // drove out of reach of it while it was being built.
    if (this.wanted.has(key)) this.arrived.push(payload);
  }

  /** Hand the next chunks to whichever workers are free. */
  private pump(): void {
    for (const slot of this.slots) {
      if (!slot.ready || slot.busy !== undefined) continue;
      const want = this.nextWant();
      if (want === undefined) return;
      const key = keyOf(want.cx, want.cy);
      slot.busy = key;
      this.inFlight.set(key, want.detail);
      slot.worker.post({ type: 'chunk', cx: want.cx, cy: want.cy, detail: want.detail });
    }
  }

  /** The next chunk of the queue that is not already in a worker or waiting to be taken. */
  private nextWant(): ChunkWant | undefined {
    while (this.queue.length > 0) {
      const want = this.queue.shift() as ChunkWant;
      const key = keyOf(want.cx, want.cy);
      if (this.inFlight.has(key)) continue;
      if (this.arrived.some((payload) => keyOf(payload.cx, payload.cy) === key)) continue;
      return want;
    }
    return undefined;
  }
}

/** Workers to run. One core is left to the frame, whatever the machine. */
function poolSize(): number {
  const cores = typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency ?? 4);
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

/** A real worker, running `chunk-worker.ts` as a module. */
function spawnChunkWorker(): ChunkWorker {
  const worker = new Worker(new URL('./chunk-worker.ts', import.meta.url), { type: 'module' });
  return {
    post: (command) => worker.postMessage(command),
    onReply: (listener) => worker.addEventListener('message', (event) => listener(event.data as WorkerReply)),
    terminate: () => worker.terminate(),
  };
}

function keyOf(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
