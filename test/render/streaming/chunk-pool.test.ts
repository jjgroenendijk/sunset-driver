/**
 * The slowed worker of the profiler (`src/render/streaming/chunk-pool.ts`).
 *
 * It stands in for a phone whose chunk workers run on its slow cores. What is
 * pinned here is that a reply lands `factor` times after the build began, and
 * that the replies keep their order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { slowedWorker, type ChunkWorker } from '../../../src/render/streaming/chunk-pool.ts';
import type { WorkerReply } from '../../../src/render/streaming/chunk-worker.ts';

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
