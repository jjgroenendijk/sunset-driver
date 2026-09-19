/**
 * Worker side of `world-pool.ts`: generates one world per message and posts it
 * back. A job may also ask for the layers built on top of that world — the
 * footprint, the parcels and the buildings — which are the dearest things this
 * project builds; building them here keeps them off the test thread. Run by
 * plain Node with type stripping, not through Vite, so it may import only what
 * `src/world` imports.
 */
import { parentPort } from 'node:worker_threads';
import { buildBuildings } from '../src/world/buildings.ts';
import { buildFootprint } from '../src/world/footprint.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { buildParcels } from '../src/world/parcels.ts';
import { buildTensorField } from '../src/world/tensor.ts';
import { generateWorld } from '../src/world/world.ts';
import type { WorldParts } from './world-pool.ts';

const port = parentPort;
if (port === null) throw new Error('world-worker.ts must be run as a worker');

port.on('message', (job: { index: number; seed: number; parts: boolean }) => {
  const world = generateWorld(job.seed);
  let parts: WorldParts | undefined;
  if (job.parts) {
    // The road graph carries methods, so it cannot cross a thread boundary. The
    // caller builds its own, which is cheap next to the layers built here.
    const graph = buildRoadGraph(world.roads);
    const footprint = buildFootprint(world, graph);
    const parcels = buildParcels(world, footprint, graph, buildTensorField(world));
    parts = { footprint, parcels, buildings: buildBuildings(world, parcels, graph) };
  }
  // The heights are the bulk of a world, and the worker keeps no reference to
  // them, so hand the buffer over rather than copying a megabyte per seed.
  port.postMessage({ index: job.index, world, parts }, [world.terrain.heights.buffer as ArrayBuffer]);
});
