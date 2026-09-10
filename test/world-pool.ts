/**
 * Generating a world is the most expensive thing this project does, and the
 * sweeps need one per seed. This pool spreads that over the machine's cores so
 * the test tiers stay inside the times CLAUDE.md sets.
 *
 * Generation is a pure function of the seed, so a world a worker builds is the
 * world the caller's own thread would have built.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { WorldDescription } from '../src/world/types.ts';

const WORKER_URL = new URL('./world-worker.ts', import.meta.url);

/**
 * Generate one world per seed, several at a time. The result lines up with
 * `seeds`, so a seed given twice is generated twice. Timing a world generated
 * here would be timing a busy machine: `test/budget.test.ts` owns that.
 */
export async function worldsFor(seeds: readonly number[]): Promise<WorldDescription[]> {
  const out: WorldDescription[] = new Array(seeds.length) as WorldDescription[];
  if (seeds.length === 0) return out;

  // One worker per core, and never more workers than there is work for them.
  const size = Math.max(1, Math.min(availableParallelism(), seeds.length));
  const workers: Worker[] = [];
  let next = 0;
  let done = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown): void => {
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const feed = (worker: Worker): void => {
        if (next < seeds.length) {
          worker.postMessage({ index: next, seed: seeds[next] as number });
          next++;
        }
      };

      for (let i = 0; i < size; i++) {
        const worker = new Worker(WORKER_URL);
        workers.push(worker);
        worker.on('error', fail);
        worker.on('message', (result: { index: number; world: WorldDescription }) => {
          out[result.index] = result.world;
          done++;
          if (done === seeds.length) resolve();
          else feed(worker);
        });
        feed(worker);
      }
    });
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }

  return out;
}
