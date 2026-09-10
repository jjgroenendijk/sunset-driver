/**
 * Worker side of `world-pool.ts`: generates one world per message and posts it
 * back. A job may also ask for the footprint and the parcels of that world,
 * which are the two dearest things built on top of a world; building them here
 * keeps them off the test thread. Run by plain Node with type stripping, not
 * through Vite, so it may import only what `src/world` imports.
 */
import { parentPort } from 'node:worker_threads';
import { buildFootprint, type RoadFootprint } from '../src/world/footprint.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { buildParcels, type ParcelMap } from '../src/world/parcels.ts';
import { buildTensorField } from '../src/world/tensor.ts';
import { generateWorld } from '../src/world/world.ts';

const port = parentPort;
if (port === null) throw new Error('world-worker.ts must be run as a worker');

port.on('message', (job: { index: number; seed: number; parts: boolean }) => {
  const world = generateWorld(job.seed);
  let parts: { footprint: RoadFootprint; parcels: ParcelMap } | undefined;
  if (job.parts) {
    // The road graph carries methods, so it cannot cross a thread boundary. The
    // caller builds its own, which is cheap next to the footprint and the parcels.
    const graph = buildRoadGraph(world.roads);
    const footprint = buildFootprint(world.roads, world.corridors, graph);
    parts = { footprint, parcels: buildParcels(world, footprint, graph, buildTensorField(world)) };
  }
  // The heights are the bulk of a world, and the worker keeps no reference to
  // them, so hand the buffer over rather than copying a megabyte per seed.
  port.postMessage({ index: job.index, world, parts }, [world.terrain.heights.buffer as ArrayBuffer]);
});
