import { buildCorridors } from './corridors.ts';
import { generateDistricts, layoutZones } from './districts.ts';
import { buildRoadGraph } from './graph.ts';
import { traceRoads } from './roads.ts';
import { buildTensorField } from './tensor.ts';
import { describeWater, generateTerrain, layoutTerrain, TERRAIN_CELL } from './terrain.ts';
import { worldSizeFor } from './size.ts';
import type { WorldDescription, WorldSkeleton } from './types.ts';

/**
 * Generate the whole-world skeleton for a seed: size, terrain, water, districts,
 * roads and the corridors that run along them. Pure and headless; safe to run
 * in a worker or in Node.
 */
export function generateWorld(seed: number): WorldDescription {
  const size = worldSizeFor(seed, TERRAIN_CELL);
  const layout = layoutTerrain(seed, size);
  const terrain = generateTerrain(seed, layout);
  const water = describeWater(seed, terrain, layout);
  const zones = layoutZones(size, layout.core, water);
  const districts = generateDistricts(seed, zones, terrain, water);
  const skeleton: WorldSkeleton = {
    seed,
    size,
    core: layout.core,
    terrain: terrain.toData(),
    water,
    districts,
  };
  const roads = traceRoads(skeleton, buildTensorField(skeleton));
  // The graph is built here rather than stored: the corridors are the last
  // thing generation asks of it, and everything else builds it on demand.
  const { corridors, tram } = buildCorridors(skeleton, roads, buildRoadGraph(roads));
  return { ...skeleton, roads, corridors, tram };
}
