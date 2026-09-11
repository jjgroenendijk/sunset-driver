import { describeBeaches, linkBoardwalks } from './beaches.ts';
import { buildCorridors } from './corridors.ts';
import { generateDistricts, layoutZones, nameBeachNeighbourhood } from './districts.ts';
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
  // The beaches come before the roads, because the boardwalk of spec section
  // 7.3 is a road along the back of one. They come after the districts because
  // the main beach has to stand on an island the roads will reach, and the
  // districts are what says which those are.
  const beaches = describeBeaches(seed, terrain, water, zones, districts);
  nameBeachNeighbourhood(districts, beaches);
  const skeleton: WorldSkeleton = {
    seed,
    size,
    core: layout.core,
    terrain: terrain.toData(),
    water,
    beaches,
    districts,
  };
  const roads = traceRoads(skeleton, buildTensorField(skeleton));
  // The graph is built here rather than stored: the corridors are the last
  // thing generation asks of it, and everything else builds it on demand.
  const { corridors, tram } = buildCorridors(skeleton, roads, buildRoadGraph(roads));
  // The boardwalk is a road, so a beach only learns which roads run along it
  // once they are traced (spec section 7.3).
  return { ...skeleton, beaches: linkBoardwalks(beaches, roads), roads, corridors, tram };
}
