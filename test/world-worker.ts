/**
 * Worker side of `world-pool.ts`: generates one world per message and posts it
 * back. Run by plain Node with type stripping, not through Vite, so it may
 * import only what `src/world` imports.
 */
import { parentPort } from 'node:worker_threads';
import { generateWorld } from '../src/world/world.ts';

const port = parentPort;
if (port === null) throw new Error('world-worker.ts must be run as a worker');

port.on('message', (job: { index: number; seed: number }) => {
  const world = generateWorld(job.seed);
  // The heights are the bulk of a world, and the worker keeps no reference to
  // them, so hand the buffer over rather than copying a megabyte per seed.
  port.postMessage({ index: job.index, world }, [world.terrain.heights.buffer as ArrayBuffer]);
});
