import { generateDistricts, layoutZones } from './districts.ts';
import { traceMajorRoads } from './roads.ts';
import { buildTensorField } from './tensor.ts';
import { describeWater, generateTerrain, layoutTerrain, TERRAIN_CELL } from './terrain.ts';
import { worldSizeFor } from './size.ts';
import type { WorldDescription, WorldSkeleton } from './types.ts';

/**
 * Generate the whole-world skeleton for a seed: size, terrain, water, districts
 * and major roads. Pure and headless; safe to run in a worker or in Node.
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
  return { ...skeleton, roads: traceMajorRoads(skeleton, buildTensorField(skeleton)) };
}
