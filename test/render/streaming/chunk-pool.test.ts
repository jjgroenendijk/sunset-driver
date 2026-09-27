/**
 * The slowed worker of the profiler, and the pool made ahead of a session
 * (`src/render/streaming/chunk-pool.ts`).
 *
 * The slowed worker stands in for a phone whose chunk workers run on its slow
 * cores. What is pinned here is that a reply lands `factor` times after the
 * build began, and that the replies keep their order. The pool made ahead is
 * handed to the session of its seed and stopped for any other.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareChunkPool,
  slowedWorker,
  takeChunkPool,
  type ChunkWorker,
} from '../../../src/render/streaming/chunk-pool.ts';
import type { WorkerCommand, WorkerReply } from '../../../src/render/streaming/chunk-worker.ts';
import type { WorldDescription } from '../../../src/world/types.ts';

/** A worker whose replies the test sends by hand. */
function handWorker(): { worker: ChunkWorker; reply: (reply: WorkerReply) => void } {
  let listener: (reply: WorkerReply) => void = () => {};
  return {
    worker: { post: () => {}, onReply: (l) => (listener = l), terminate: () => {} },
    reply: (reply) => listener(reply),
  };
}

describe('slowedWorker', () => {
  afterEach(() => vi.useRealTimers());

  it('answers factor times after the build began, in order', () => {
    vi.useFakeTimers();
    const hand = handWorker();
    const slow = slowedWorker(hand.worker, 4);
    const heard: number[] = [];
    slow.onReply(() => heard.push(performance.now()));
    const start = performance.now();
    slow.post({ type: 'chunk', cx: 0, cy: 0, detail: 'near' });
    vi.advanceTimersByTime(100);
    hand.reply({ type: 'ready' });
    hand.reply({ type: 'ready' });
    vi.advanceTimersByTime(299);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(heard.map((at) => at - start)).toEqual([400, 400]);
  });
});

/** A worker that records what it was sent and whether it was stopped. */
function recordingWorker(): { worker: ChunkWorker; sent: WorkerCommand[]; stopped: () => boolean } {
  const sent: WorkerCommand[] = [];
  let stopped = false;
  return {
    worker: { post: (command) => sent.push(command), onReply: () => {}, terminate: () => (stopped = true) },
    sent,
    stopped: () => stopped,
  };
}

describe('a pool made ahead of its session', () => {
  const world = (seed: number): WorldDescription => ({ seed }) as WorldDescription;

  it('is the pool the session of its seed takes, already building the start', () => {
    const workers = [recordingWorker(), recordingWorker()];
    const spare = workers.map((w) => w.worker);
    prepareChunkPool(world(7), { x: 0, y: 0 }, () => spare.shift() as ChunkWorker);
    const chunks = workers.flatMap((w) => w.sent.filter((command) => command.type === 'chunk'));
    expect(chunks).toHaveLength(9);
    const pool = takeChunkPool(world(7), () => {
      throw new Error('no new worker is wanted');
    });
    expect(pool.pending).toBe(9);
    pool.dispose();
  });

  it('is stopped when the session plays another seed', () => {
    const early = recordingWorker();
    prepareChunkPool(world(7), undefined, () => early.worker);
    const fresh = recordingWorker();
    const pool = takeChunkPool(world(8), () => fresh.worker);
    expect(early.stopped()).toBe(true);
    expect(fresh.sent[0]).toMatchObject({ type: 'start', world: { seed: 8 } });
    pool.dispose();
  });
});
