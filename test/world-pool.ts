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
import type { RoadFootprint } from '../src/world/footprint.ts';
import type { ParcelMap } from '../src/world/parcels.ts';
import type { WorldDescription } from '../src/world/types.ts';

const WORKER_URL = new URL('./world-worker.ts', import.meta.url);

/** What a job asks the pool for. */
export interface WorldJob {
  seed: number;
  /**
   * Lay the footprint and cut the parcels of the world in the worker as well.
   * They are the dearest things built on a world, so a test that reads them
   * asks for them here rather than building them on the test thread.
   */
  parts?: boolean;
}

/** A world the pool built, with whatever its job asked for on top of it. */
export interface PooledWorld {
  world: WorldDescription;
  /** Present when the job set `parts`. The road graph is not here: it carries
   * methods, so it cannot cross a thread boundary, and it is cheap to rebuild. */
  parts?: { footprint: RoadFootprint; parcels: ParcelMap };
}

/**
 * Generate one world per seed, several at a time. The result lines up with
 * `seeds`, so a seed given twice is generated twice. Timing a world generated
 * here would be timing a busy machine: `test/budget.test.ts` owns that.
 */
export async function worldsFor(seeds: readonly number[]): Promise<WorldDescription[]> {
  const built = await buildWorlds(seeds.map((seed) => ({ seed })));
  return built.map((entry) => entry.world);
}

/**
 * Run one job per element, several at a time. The result lines up with `jobs`.
 * Jobs are handed out in order, so put the ones that ask for parts first: the
 * pool then starts its longest work first and no worker tails the rest.
 */
export async function buildWorlds(jobs: readonly WorldJob[]): Promise<PooledWorld[]> {
  const out: PooledWorld[] = new Array(jobs.length) as PooledWorld[];
  if (jobs.length === 0) return out;

  // One worker per core, and never more workers than there is work for them.
  const size = Math.max(1, Math.min(availableParallelism(), jobs.length));
  const workers: Worker[] = [];
  let next = 0;
  let done = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown): void => {
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const feed = (worker: Worker): void => {
        if (next < jobs.length) {
          const job = jobs[next] as WorldJob;
          worker.postMessage({ index: next, seed: job.seed, parts: job.parts === true });
          next++;
        }
      };

      for (let i = 0; i < size; i++) {
        const worker = new Worker(WORKER_URL);
        workers.push(worker);
        worker.on('error', fail);
        worker.on('message', (result: PooledWorld & { index: number }) => {
          out[result.index] = { world: result.world, parts: result.parts };
          done++;
          if (done === jobs.length) resolve();
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
