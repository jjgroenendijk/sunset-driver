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
import type { BuildingMap } from '../../src/world/city/buildings.ts';
import type { RoadFootprint } from '../../src/world/city/footprint.ts';
import type { ParcelMap } from '../../src/world/city/parcels.ts';
import type { WorldDescription } from '../../src/world/types.ts';

const WORKER_URL = new URL('./world-worker.ts', import.meta.url);

/** What a job asks the pool for. */
export interface WorldJob {
  seed: number;
  /**
   * Build the layers of the world in the worker as well. They are the dearest
   * things built on a world, so a test that reads them asks for them here
   * rather than building them on the test thread.
   */
  parts?: boolean;
}

/**
 * The layers of a world that cross a thread boundary. The road graph is not
 * here: it carries methods, and it is cheap to rebuild next to these.
 */
export interface WorldParts {
  footprint: RoadFootprint;
  parcels: ParcelMap;
  buildings: BuildingMap;
}

/** A world the pool built, with whatever its job asked for on top of it. */
export interface PooledWorld {
  world: WorldDescription;
  /** Present when the job set `parts`. */
  parts?: WorldParts;
}

/**
 * Generate one world per seed, several at a time. The result lines up with
 * `seeds`, so a seed given twice is generated twice.
 */
export async function worldsFor(seeds: readonly number[]): Promise<WorldDescription[]> {
  const built = await buildWorlds(seeds.map((seed) => ({ seed })));
  return built.map((entry) => entry.world);
}

/**
 * The world of one seed, generated once however many suites ask for it. The
 * unit project does not isolate its files, so the files one worker runs share
 * this cache: the map suites read seed 1 three times, and it is generated once.
 */
const shared = new Map<number, Promise<WorldDescription>>();
export function sharedWorld(seed: number): Promise<WorldDescription> {
  let world = shared.get(seed);
  if (world === undefined) {
    world = worldsFor([seed]).then((built) => built[0] as WorldDescription);
    shared.set(seed, world);
  }
  return world;
}

/**
 * Run one job per element, several at a time. The result lines up with `jobs`,
 * whatever order the pool ran them in.
 *
 * A job that asks for parts costs about three times one that does not, so the
 * pool hands those out first. A long job started last is what leaves every
 * other worker idle while one of them finishes, and that tail is the whole
 * wait: the jobs are the same work either way round.
 */
export async function buildWorlds(jobs: readonly WorldJob[]): Promise<PooledWorld[]> {
  const out: PooledWorld[] = new Array(jobs.length) as PooledWorld[];
  if (jobs.length === 0) return out;

  // Longest first, and stable within each length so a run stays repeatable.
  const order = jobs.map((_, index) => index);
  order.sort((a, b) => {
    const heavy = Number((jobs[b] as WorldJob).parts === true) - Number((jobs[a] as WorldJob).parts === true);
    return heavy !== 0 ? heavy : a - b;
  });

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
        if (next < order.length) {
          const index = order[next] as number;
          const job = jobs[index] as WorldJob;
          worker.postMessage({ index, seed: job.seed, parts: job.parts === true });
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
