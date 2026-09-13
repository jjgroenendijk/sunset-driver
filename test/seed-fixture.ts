import { ChunkSource, type WorldChunk } from '../src/world/chunks.ts';
import { buildCarve, type RoadCarve } from '../src/world/carve.ts';
import { type BuildingMap } from '../src/world/buildings.ts';
import { type RoadFootprint } from '../src/world/footprint.ts';
import { buildRoadGraph, type RoadGraph } from '../src/world/graph.ts';
import { buildJunctions, type JunctionMap } from '../src/world/junctions.ts';
import { RoadBeds } from '../src/world/bed.ts';
import { type ParcelMap } from '../src/world/parcels.ts';
import { type WorldDescription } from '../src/world/types.ts';
import { Vegetation } from '../src/world/vegetation.ts';
import { sweepSeeds } from './helpers.ts';
import { buildWorlds, type PooledWorld, type WorldParts } from './world-pool.ts';
import { SEED_COUNT, REPEAT_COUNT, FOOTPRINT_COUNT, ISOLATED_COUNT } from './seed-limits.ts';

/**
 * The worlds the seed sweep reads, and the layers built on them. Generating a
 * world is the dearest thing this project does, so every check file shares one
 * set: `ready()` generates them once for the whole run, however many files ask.
 */
export const seeds = sweepSeeds(SEED_COUNT);
export const worlds = new Map<number, WorldDescription>();
/** The second generation of the repeated seeds, for the byte-identical check. */
export const repeats = new Map<number, WorldDescription>();
/** The footprint of a seed, laid by the pool for the first FOOTPRINT_COUNT seeds. */
export const footprints = new Map<number, RoadFootprint>();
export const footprintOf = (seed: number): RoadFootprint => {
  const known = footprints.get(seed);
  if (known === undefined) throw new Error(`no footprint for seed ${seed}: the pool lays the first ${FOOTPRINT_COUNT}`);
  return known;
};
/** The parcels of a seed, cut by the pool for the same seeds. */
export const parcelMaps = new Map<number, ParcelMap>();
export const parcelsOf = (seed: number): ParcelMap => {
  const known = parcelMaps.get(seed);
  if (known === undefined) throw new Error(`no parcels for seed ${seed}: the pool cuts the first ${FOOTPRINT_COUNT}`);
  return known;
};
/** The second generation of the isolated seeds, with the layers of that generation. */
export const repeatParts = new Map<number, WorldParts>();
/**
 * The chunk source of a seed, over the layers the pool has already built. A
 * source built from the world alone would lay the footprint and cut the
 * parcels a second time.
 */
export const sources = new Map<number, ChunkSource>();
export const sourceOf = (seed: number): ChunkSource => {
  const known = sources.get(seed);
  if (known !== undefined) return known;
  const world = worlds.get(seed) as WorldDescription;
  const built = new ChunkSource(world, {
    graph: graphOf(seed),
    junctions: junctionsOf(seed),
    footprint: footprintOf(seed),
    parcels: parcelsOf(seed),
    buildings: buildingsOf(seed),
    carve: carveOf(seed),
    vegetation: vegetationOf(seed),
  });
  sources.set(seed, built);
  return built;
};
/**
 * A chunk of a seed, cut once however many tests read it. Cutting the block
 * again for every test was most of what the chunk checks cost. The check that
 * a chunk cuts the same in isolation cuts its own, since that cut is what it
 * checks.
 */
export const chunkMaps = new Map<number, Map<string, WorldChunk>>();
export const chunkOf = (seed: number, cx: number, cy: number): WorldChunk => {
  let cut = chunkMaps.get(seed);
  if (cut === undefined) {
    cut = new Map();
    chunkMaps.set(seed, cut);
  }
  const key = `${cx}:${cy}`;
  const known = cut.get(key);
  if (known !== undefined) return known;
  const built = sourceOf(seed).chunk(cx, cy);
  cut.set(key, built);
  return built;
};
/** The junctions of a seed, built once however many tests ask about them. */
export const junctionMaps = new Map<number, JunctionMap>();
export const junctionsOf = (seed: number): JunctionMap => {
  const known = junctionMaps.get(seed);
  if (known !== undefined) return known;
  const world = worlds.get(seed) as WorldDescription;
  const built = buildJunctions(world.roads, graphOf(seed));
  junctionMaps.set(seed, built);
  return built;
};
/** The carve of a seed, built once however many tests ask about it. */
export const carves = new Map<number, RoadCarve>();
export const carveOf = (seed: number): RoadCarve => {
  const known = carves.get(seed);
  if (known !== undefined) return known;
  const world = worlds.get(seed) as WorldDescription;
  const built = buildCarve(world.terrain, world.roads, junctionsOf(seed));
  carves.set(seed, built);
  return built;
};
/** The beds of a seed's roads: the line each is lofted onto and carved to. */
export const bedMaps = new Map<number, RoadBeds>();
export const bedsOf = (seed: number): RoadBeds => {
  const known = bedMaps.get(seed);
  if (known !== undefined) return known;
  const world = worlds.get(seed) as WorldDescription;
  const built = new RoadBeds(world.terrain, world.roads, junctionsOf(seed));
  bedMaps.set(seed, built);
  return built;
};
/** The buildings of a seed, laid by the pool for the same seeds. */
export const buildingMaps = new Map<number, BuildingMap>();
export const buildingsOf = (seed: number): BuildingMap => {
  const known = buildingMaps.get(seed);
  if (known === undefined) throw new Error(`no buildings for seed ${seed}: the pool lays the first ${FOOTPRINT_COUNT}`);
  return known;
};
/** The vegetation of a seed, which stands on its parcels and off its lots. */
export const vegetations = new Map<number, Vegetation>();
export const vegetationOf = (seed: number): Vegetation => {
  const known = vegetations.get(seed);
  if (known !== undefined) return known;
  const built = new Vegetation(seed, parcelsOf(seed), buildingsOf(seed));
  vegetations.set(seed, built);
  return built;
};
/** The graph of a seed, built once however many tests ask about it. */
export const graphs = new Map<number, RoadGraph>();
export const graphOf = (seed: number): RoadGraph => {
  const known = graphs.get(seed);
  if (known !== undefined) return known;
  const built = buildRoadGraph((worlds.get(seed) as WorldDescription).roads);
  graphs.set(seed, built);
  return built;
};

let generating: Promise<void> | undefined;

/**
 * Generate every world the sweep reads, once. Each check file awaits this in
 * its own `beforeAll`; the second and later callers wait on the first call.
 */
export function ready(): Promise<void> {
  generating ??= generate();
  return generating;
}

async function generate(): Promise<void> {
  // Every seed once, then the repeated seeds a second time: the pool runs the
  // two rounds back to back so the byte-identical check costs no extra wait.
  // The pool itself starts the jobs that ask for layers first, so they are
  // listed here in the order the tests read them.
  const repeated = seeds.slice(0, REPEAT_COUNT);
  const jobs = [
    ...seeds.map((seed, i) => ({ seed, parts: i < FOOTPRINT_COUNT })),
    // The repeated seeds the chunk gate cuts in isolation carry their layers
    // too, so that side of the check is built from end to end in a worker,
    // away from the layers the tests on this thread read.
    ...repeated.map((seed, i) => ({ seed, parts: i < ISOLATED_COUNT })),
  ];
  const generated = await buildWorlds(jobs);
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i] as number;
    const built = generated[i] as PooledWorld;
    worlds.set(seed, built.world);
    if (built.parts !== undefined) {
      footprints.set(seed, built.parts.footprint);
      parcelMaps.set(seed, built.parts.parcels);
      buildingMaps.set(seed, built.parts.buildings);
    }
  }
  for (let i = 0; i < repeated.length; i++) {
    const seed = repeated[i] as number;
    const built = generated[seeds.length + i] as PooledWorld;
    repeats.set(seed, built.world);
    if (built.parts !== undefined) repeatParts.set(seed, built.parts);
  }
}
