import { nameBoardwalk, planBeaches, withBeachCulture } from './beaches.ts';
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
  const sites = generateDistricts(seed, zones, terrain, water);
  // The beaches are planned on the terrain alone, then give the districts they
  // run through the name and the beach culture of spec section 8.3. They read
  // the district sites only, so nothing feeds back into where they are.
  const beaches = planBeaches(size, terrain, water, zones, sites);
  const named = nameBoardwalk(sites, beaches, zones);
  const skeleton: WorldSkeleton = {
    seed,
    size,
    core: layout.core,
    terrain: terrain.toData(),
    water,
    districts: withBeachCulture(named, beaches, zones),
    beaches,
  };
  const { roads, boardwalks } = traceRoads(skeleton, buildTensorField(skeleton));
  // The graph is built here rather than stored: the corridors are the last
  // thing generation asks of it, and everything else builds it on demand.
  const { corridors, tram } = buildCorridors(skeleton, roads, buildRoadGraph(roads));
  return {
    ...skeleton,
    // Which road a boardwalk turned out to be is only known once it is laid.
    beaches: beaches.map((beach, i) => ({ ...beach, boardwalkRoad: boardwalks[i] ?? -1 })),
    roads,
    corridors,
    tram,
  };
}
