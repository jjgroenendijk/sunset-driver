import { describe, expect, it } from 'vitest';
import type { InputFrame } from '../src/sim/input.ts';
import { initPhysics, SimPhysics, type Ground } from '../src/sim/physics.ts';
import { createSimState, stepSim } from '../src/sim/simulation.ts';
import { MeshBasicMaterial, type Material } from 'three';
import { fillOfPacked, type Batch } from '../src/render/batch.ts';
import { buildChunkBuildings, buildingLookup } from '../src/render/building-mesh.ts';
import { buildChunkPayload, chunkLookups, type ChunkPayload, type PackedBatch } from '../src/render/chunk-payload.ts';
import { groundGeometry } from '../src/render/ground.ts';
import { FRAME_BUDGET_MS } from '../src/render/quality.ts';
import { buildCarve } from '../src/world/carve.ts';
import { chunkAt, chunkBounds, ChunkSource } from '../src/world/chunks.ts';
import { buildFootprint, type RoadFootprint } from '../src/world/footprint.ts';
import { buildBuildings } from '../src/world/buildings.ts';
import { buildParcels, type ParcelMap } from '../src/world/parcels.ts';
import { buildRoadGraph, type RoadGraph } from '../src/world/graph.ts';
import { buildJunctions } from '../src/world/junctions.ts';
import { buildTensorField } from '../src/world/tensor.ts';
import type { WorldDescription } from '../src/world/types.ts';
import { Vegetation } from '../src/world/vegetation.ts';
import { generateWorld } from '../src/world/world.ts';
import { BUDGET_MS, BUDGET_US, FRAME_MS, FRAME_SLICE_MS, SIM_SLICE_MS } from './budgets.ts';
import { bestOf, bestUnder, DRY, inputStream, landPoints, sweepSeeds } from './helpers.ts';

/**
 * A handful of seeds. This file measures wall-clock cost, so it may not share
 * the machine with the sweeps and its seeds are generated one after another:
 * every world here is a second of the quick tier's wall clock. The quick tier
 * takes two, whose median is the slower of them, so it is held to the stricter
 * number; the full tier, which has the time, takes a spread.
 */
const GEN_SEEDS = sweepSeeds(process.env.SWEEP_SEEDS ? 12 : 2);

/** Repetitions of each measurement; the fastest one is scored. */
const RUNS = 3;

/**
 * Ticks the per-tick cost is averaged over. Twenty seconds of driving: long
 * enough for the average to settle, short enough that the quick tier can pay
 * for it three times if the first run is unlucky.
 */
const SIM_TICKS = 1200;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

/** The measured worlds, kept so the road graph is not charged for generating them again. */
const worlds: WorldDescription[] = [];

function measuredWorlds(): WorldDescription[] {
  if (worlds.length === 0) for (const seed of GEN_SEEDS) worlds.push(generateWorld(seed));
  return worlds;
}

/**
 * The road graph of a measured world, built once. It is measured in its own
 * right below, and the tests that only need it as input read it from here
 * rather than paying for it again.
 */
const graphs = new Map<number, RoadGraph>();

function graphOf(world: WorldDescription): RoadGraph {
  const known = graphs.get(world.seed);
  if (known !== undefined) return known;
  const built = buildRoadGraph(world.roads);
  graphs.set(world.seed, built);
  return built;
}

/**
 * The footprint of a measured world. The test that measures laying it keeps the
 * build it timed here, so the parcels are cut from a footprint nobody paid for
 * twice.
 */
const footprints = new Map<number, RoadFootprint>();

function footprintOf(world: WorldDescription): RoadFootprint {
  const known = footprints.get(world.seed);
  if (known !== undefined) return known;
  const built = buildFootprint(world.roads, world.corridors, graphOf(world));
  footprints.set(world.seed, built);
  return built;
}

/**
 * The parcels of a measured world, kept the same way: the test that measures
 * cutting them leaves its last cut here, so the buildings stand on parcels
 * nobody paid for twice.
 */
const parcelMaps = new Map<number, ParcelMap>();

function parcelsOf(world: WorldDescription): ParcelMap {
  const known = parcelMaps.get(world.seed);
  if (known !== undefined) return known;
  const built = buildParcels(world, footprintOf(world), graphOf(world), buildTensorField(world));
  parcelMaps.set(world.seed, built);
  return built;
}

/**
 * Worlds the footprint and the parcels are measured on. Laying a footprint and
 * cutting the parcels of a world are the two dearest things this file does, so
 * the quick tier measures one world and leaves the spread of seeds to the full
 * tier.
 */
const HEAVY_WORLDS = process.env.SWEEP_SEEDS ? 4 : 1;

describe('performance budgets', () => {
  it('keeps every enforced budget inside its spec section 2.4 slice', () => {
    const slices = FRAME_SLICE_MS;
    const total =
      slices.render + slices.physics + slices.gameplayAndAi + slices.streaming + slices.headroom;
    expect(total).toBe(FRAME_MS);
    // The quality tiers of spec section 9.2 watch the whole frame, so the
    // frame they hold it to is the sum of the slices and not one of them.
    expect(FRAME_BUDGET_MS).toBe(FRAME_MS);
    expect(BUDGET_MS.simTick).toBeLessThanOrEqual(SIM_SLICE_MS);
    // The streaming queue holds a frame to its slice apart from the piece it
    // is already running (spec section 9.1). Even that worst frame leaves the
    // renderer the whole of its own slice.
    expect(slices.streaming + BUDGET_MS.chunkUpload + slices.render).toBeLessThanOrEqual(FRAME_MS);
  });

  it('steps the simulation within the per-tick budget', async () => {
    // The tick steps Rapier (spec section 11.3), so this is the physics slice
    // and the gameplay slice together, driving over hills on a real surface.
    await initPhysics();
    const ground: Ground = {
      heightAt: (x, y) => 2.5 * Math.sin(x / 37) + 1.5 * Math.cos(y / 51),
      surfaceAt: () => 'asphalt',
      seaLevel: DRY,
    };
    const inputs = inputStream(0x5717, SIM_TICKS);
    const run = (ticks: number): void => {
      const state = createSimState(0x5717);
      const physics = new SimPhysics(ground, state);
      physics.spawn(state, 0, 0, 0);
      for (let i = 0; i < ticks; i++) stepSim(state, inputs[i] as InputFrame, physics);
      physics.dispose();
    };

    run(300); // Warm up, so the measurement is of steady-state code and not of the JIT.
    const perTick = bestUnder(RUNS, BUDGET_MS.simTick * SIM_TICKS, () => run(SIM_TICKS)) / SIM_TICKS;

    expect(perTick, `${perTick.toFixed(4)} ms/tick`).toBeLessThan(BUDGET_MS.simTick);
  });

  it('generates a world within the per-seed budget', () => {
    // The first world of a process pays for the generator's JIT: the same call
    // made again comes out about a quarter faster. That is warm-up and not what
    // generating a world costs, and this is the first thing the budgets project
    // runs, so the quick tier was measuring the cold path and nothing else — a
    // median over two seeds is the slower of them, which was always the cold
    // one. Every other budget here warms up before it measures; so does this.
    generateWorld(GEN_SEEDS[0] as number);
    const times = GEN_SEEDS.map((seed) => {
      const t0 = performance.now();
      worlds.push(generateWorld(seed));
      return performance.now() - t0;
    });
    const worst = Math.max(...times);
    const typical = median(times);

    expect(typical, `${typical.toFixed(0)} ms median`).toBeLessThan(BUDGET_MS.worldGen);
    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.worldGenWorst);
  });

  it('builds the road graph of a world within its budget', () => {
    const times = measuredWorlds().map((world) => bestUnder(RUNS, BUDGET_MS.roadGraph, () => void buildRoadGraph(world.roads)));
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(1)} ms worst`).toBeLessThan(BUDGET_MS.roadGraph);
  });

  it('builds the tensor field of a world within its budget', () => {
    const times = measuredWorlds().map((world) => bestUnder(RUNS, BUDGET_MS.tensorField, () => void buildTensorField(world)));
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.tensorField);
  });

  it('builds the carve of a world within its budget', () => {
    const times = measuredWorlds().map((world) => {
      const junctions = buildJunctions(world.roads, graphOf(world));
      return bestUnder(RUNS, BUDGET_MS.carve, () => void buildCarve(world.terrain, world.roads, junctions));
    });
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.carve);
  });

  it('samples the tensor field fast enough to trace streamlines with', () => {
    const perSample = measuredWorlds().map((world) => {
      const field = buildTensorField(world);
      const points = landPoints(world, 500, 0x51e);
      // The budget is per sample, so the limit the runs are measured against is
      // what the whole sweep of points may cost.
      const ms = bestUnder(RUNS, (BUDGET_US.tensorSample * points.length) / 1000, () => {
        for (const p of points) field.majorAt(p.x, p.y);
      });
      return (ms / points.length) * 1000;
    });
    const worst = Math.max(...perSample);

    expect(worst, `${worst.toFixed(1)} µs per sample`).toBeLessThan(BUDGET_US.tensorSample);
  });

  it('lays the road footprint of a world within its budget', () => {
    const times = measuredWorlds().slice(0, HEAVY_WORLDS).map((world) => {
      const graph = graphOf(world);
      // Keep the last build: the parcels below are cut from it.
      return bestUnder(2, BUDGET_MS.footprint, () => footprints.set(world.seed, buildFootprint(world.roads, world.corridors, graph)));
    });
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.footprint);
  });

  it('cuts the parcels of a world within its budget', () => {
    const times = measuredWorlds().slice(0, HEAVY_WORLDS).map((world) => {
      const graph = graphOf(world);
      const footprint = footprintOf(world);
      const field = buildTensorField(world);
      // Keep the last cut: the buildings below stand on it.
      return bestUnder(2, BUDGET_MS.parcels, () => parcelMaps.set(world.seed, buildParcels(world, footprint, graph, field)));
    });
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.parcels);
  });

  it('lays the buildings of a world within its budget', () => {
    const times = measuredWorlds().slice(0, HEAVY_WORLDS).map((world) => {
      const graph = graphOf(world);
      const parcels = parcelsOf(world);
      return bestUnder(RUNS, BUDGET_MS.buildings, () => void buildBuildings(world, parcels, graph));
    });
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.buildings);
  });

/**
 * The chunk source of a measured world, over the layers already built for it.
 * The layers are the dearest thing in the project and each of them is measured
 * in its own right above; a chunk test is charged for cutting a chunk, not for
 * what it is cut from. So the source is built once, however many tests read it.
 */
const chunkSources = new Map<number, ChunkSource>();

function chunkSourceOf(world: WorldDescription): ChunkSource {
  const known = chunkSources.get(world.seed);
  if (known !== undefined) return known;
  const graph = graphOf(world);
  const parcels = parcelsOf(world);
  const buildings = buildBuildings(world, parcels, graph);
  const junctions = buildJunctions(world.roads, graph);
  const built = new ChunkSource(world, {
    graph,
    junctions,
    footprint: footprintOf(world),
    parcels,
    buildings,
    carve: buildCarve(world.terrain, world.roads, junctions),
    vegetation: new Vegetation(world.seed, parcels, buildings),
  });
  chunkSources.set(world.seed, built);
  return built;
}

/**
 * How long each step of putting a chunk into the scene takes: the ground, then
 * each part of each batch as the streaming queue runs it. The materials are
 * plain ones, because what is measured is the copy into the batch and not what
 * the batch is drawn with. The plants and the lamps are left out: each is a
 * copy of one of a handful of small models, and the dearest step is a
 * generated tower. Each step says which piece it is, so a failure names it.
 */
function uploadSteps(payload: ChunkPayload, material: Material): { piece: string; ms: number }[] {
  const meshes: Batch[] = [];
  const pieces = ['ground'];
  const steps: (() => void)[] = [
    () => {
      groundGeometry(payload.ground).dispose();
    },
  ];
  const batches: [string, PackedBatch][] = [
    ...payload.roads.map((tier): [string, PackedBatch] => [`${tier.tier} roads`, tier.surface]),
    ['outlines', payload.outlines],
    ['facades', payload.facades],
    ['blocks', payload.blocks],
  ];
  for (const [name, batch] of batches) {
    if (batch.parts.length === 0) continue;
    const fill = fillOfPacked(batch, material);
    meshes.push(fill.mesh);
    fill.steps.forEach((step, i) => {
      steps.push(step);
      pieces.push(`${name} step ${i}`);
    });
  }
  const times = steps.map((step, i) => {
    const started = performance.now();
    step();
    return { piece: pieces[i] as string, ms: performance.now() - started };
  });
  for (const mesh of meshes) mesh.dispose();
  return times;
}

  it('plants a chunk within its budget', () => {
    const times = measuredWorlds().slice(0, HEAVY_WORLDS).map((world) => {
      const source = chunkSourceOf(world);
      const vegetation = source.layers.vegetation;
      const at = chunkAt(world.core.x, world.core.y);
      // The chunk is cut once, untimed: the scatter is handed the parcel ground
      // the chunk holds, as `ChunkSource` hands it.
      const bounds = chunkBounds(at.cx, at.cy);
      const ground = source.chunk(at.cx, at.cy).parcels;
      // Warm: the boundary index of a parcel is built the first time a plant is
      // asked for on it, and every chunk after that reads it.
      vegetation.plantsIn(bounds, ground);
      return bestUnder(RUNS, BUDGET_MS.chunkPlants, () => {
        vegetation.plantsIn(bounds, ground);
      });
    });
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(1)} ms worst`).toBeLessThan(BUDGET_MS.chunkPlants);
  });

  it('builds the buildings of a chunk of the core within its budget', () => {
    const times = measuredWorlds().slice(0, HEAVY_WORLDS).map((world) => {
      const source = chunkSourceOf(world);
      const lookup = buildingLookup(world, source.layers);
      // The chunk on the core, which is where the towers stand and so where a
      // chunk costs the most to build.
      const at = chunkAt(world.core.x, world.core.y);
      const chunk = source.chunk(at.cx, at.cy);
      // The first run of a process costs about twice what the ones after it
      // do, and warming the generator up on a few of the buildings first does
      // not take that away: the run pays for the heap it grows. So a miss gets
      // a third run, which costs nothing when the first run keeps the budget.
      return bestUnder(RUNS, BUDGET_MS.chunkBuildings, () => {
        for (const one of buildChunkBuildings(chunk, lookup)) {
          one.shell.dispose();
          one.hull?.dispose();
        }
      });
    });
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.chunkBuildings);
  });

  it('puts a chunk of the core into the scene a piece at a time, inside the frame', () => {
    const material = new MeshBasicMaterial();
    const times = measuredWorlds().slice(0, HEAVY_WORLDS).map((world) => {
      const source = chunkSourceOf(world);
      const lookups = chunkLookups(world, source.layers);
      const at = chunkAt(world.core.x, world.core.y);
      const chunk = source.chunk(at.cx, at.cy);
      // Building the payload is the worker's work and is not timed here; the
      // frame is charged only for the pieces of the upload. It is built once,
      // and each run uploads a copy, because an upload releases what it copies.
      // The copy carries the storage of every batch, so the clone allocates it
      // untimed, as the worker does.
      //
      // Every copy is made before the first run, rather than one before each
      // run: a clone of a chunk of the core is tens of megabytes, and made
      // between two runs it leaves a collection to land inside the next one.
      // That is garbage this test makes and the game does not.
      //
      // Each piece is then scored on its fastest run, as `bestOf` scores a
      // whole measurement: a collection that lands in one piece of one run
      // would otherwise be read as the cost of that piece.
      const payload = buildChunkPayload(chunk, lookups, 'near');
      const copies = [0, 1, 2].map(() => structuredClone(payload));
      const runs = copies.map((copy) => uploadSteps(copy, material));
      let dearest = { piece: '', ms: 0 };
      (runs[0] as { piece: string }[]).forEach(({ piece }, i) => {
        const ms = Math.min(...runs.map((run) => (run[i] as { ms: number }).ms));
        if (ms > dearest.ms) dearest = { piece: `seed ${world.seed}, ${piece}`, ms };
      });
      return dearest;
    });
    material.dispose();
    const worst = times.reduce((a, b) => (b.ms > a.ms ? b : a));

    expect(worst.ms, `${worst.ms.toFixed(2)} ms worst piece: ${worst.piece}`).toBeLessThan(BUDGET_MS.chunkUpload);
  });
});
