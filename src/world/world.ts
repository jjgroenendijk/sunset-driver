import { nameBoardwalk, planBeaches, withBeachCulture, withBoardwalkRoad } from './beaches.ts';
import { buildCorridors } from './corridors.ts';
import { generateDistricts, layoutZones } from './districts.ts';
import { buildRoadGraph } from './graph.ts';
import { traceRoads } from './roads.ts';
import { buildTensorField } from './tensor.ts';
import { describeWater } from './crossings.ts';
import { generateTerrain, layoutTerrain, TERRAIN_CELL } from './terrain.ts';
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
  // The beaches are planned on the terrain alone. They read the district sites
  // only, so nothing feeds back into where they are.
  const beaches = planBeaches(size, terrain, water, zones, sites);
  const skeleton: WorldSkeleton = {
    seed,
    size,
    archetype: layout.archetype.name,
    core: layout.core,
    terrain: terrain.toData(),
    water,
    districts: sites,
    beaches,
  };
  const { roads, boardwalks } = traceRoads(skeleton, buildTensorField(skeleton));
  // Which road a boardwalk turned out to be is only known once it is laid, and
  // a resort that got none is no resort.
  const developed = beaches.map((beach, i) => withBoardwalkRoad(beach, boardwalks[i] ?? -1));
  // The name and the beach culture of spec section 8.3 are handed out here,
  // over the beaches as they ended up, so The Boardwalk is never the
  // neighbourhood of a beach that was left as plain sand. Nothing in the trace
  // or the corridors reads a district's name or its culture; the simulation
  // does, and it reads the finished world.
  const districts = withBeachCulture(nameBoardwalk(sites, developed, zones), developed);
  // The graph is built here rather than stored: the corridors are the last
  // thing generation asks of it, and everything else builds it on demand.
  const { corridors, tram } = buildCorridors(skeleton, roads, buildRoadGraph(roads));
  return { ...skeleton, districts, beaches: developed, roads, corridors, tram };
}
