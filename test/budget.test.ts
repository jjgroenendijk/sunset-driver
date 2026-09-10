import { describe, expect, it } from 'vitest';
import { TICKS_PER_HOUR } from '../src/sim/clock.ts';
import type { InputFrame } from '../src/sim/input.ts';
import { createSimState, stepSim } from '../src/sim/simulation.ts';
import { ChunkSource } from '../src/world/chunk.ts';
import { buildFootprint, type RoadFootprint } from '../src/world/footprint.ts';
import { buildParcels, type ParcelMap } from '../src/world/parcels.ts';
import { buildRoadGraph, type RoadGraph } from '../src/world/graph.ts';
import { buildTensorField } from '../src/world/tensor.ts';
import type { WorldDescription } from '../src/world/types.ts';
import { generateWorld } from '../src/world/world.ts';
import { BUDGET_MS, BUDGET_US, FRAME_MS, FRAME_SLICE_MS, SIM_SLICE_MS } from './budgets.ts';
import { bestOf, inputStream, landPoints, sweepSeeds } from './helpers.ts';

/**
 * A handful of seeds: enough for a median, cheap enough for the quick tier.
 * This file measures wall-clock cost, so it may not share the machine with the
 * sweeps and its seeds are generated one after another. The full tier, which
 * has the time, takes more of them.
 */
const GEN_SEEDS = sweepSeeds(process.env.SWEEP_SEEDS ? 12 : 3);

/** Repetitions of each measurement; the fastest one is scored. */
const RUNS = 3;

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
 * Worlds the footprint and the parcels are measured on. Laying a footprint and
 * cutting the parcels of a world are the two dearest things this file does, so
 * the quick tier measures one world and leaves the spread of seeds to the full
 * tier.
 */
const HEAVY_WORLDS = process.env.SWEEP_SEEDS ? 4 : 1;

/**
 * The parcels of a measured world. As with the footprint above, the test that
 * measures cutting them keeps the cut it timed, so the chunk tests below are not
 * charged for cutting them again.
 */
const parcelMaps = new Map<number, ParcelMap>();

function parcelsOf(world: WorldDescription): ParcelMap {
  const known = parcelMaps.get(world.seed);
  if (known !== undefined) return known;
  const built = buildParcels(world, footprintOf(world), graphOf(world), buildTensorField(world));
  parcelMaps.set(world.seed, built);
  return built;
}

/** The worlds the chunk tests measure: the heavy ones, whose parcels are cut. */
function chunkedWorlds(): WorldDescription[] {
  return measuredWorlds().slice(0, HEAVY_WORLDS);
}

describe('performance budgets', () => {
  it('keeps every enforced budget inside its spec section 2.4 slice', () => {
    const slices = FRAME_SLICE_MS;
    const total =
      slices.render + slices.physics + slices.gameplayAndAi + slices.streaming + slices.headroom;
    expect(total).toBe(FRAME_MS);
    expect(BUDGET_MS.simTick).toBeLessThanOrEqual(SIM_SLICE_MS);
  });

  it('steps one game hour within the per-tick budget', () => {
    const inputs = inputStream(0x5717, TICKS_PER_HOUR);
    const run = (ticks: number): void => {
      const state = createSimState(0x5717);
      for (let i = 0; i < ticks; i++) stepSim(state, inputs[i] as InputFrame);
    };

    run(600); // Warm up, so the measurement is of steady-state code and not of the JIT.
    const perTick = bestOf(RUNS, () => run(TICKS_PER_HOUR)) / TICKS_PER_HOUR;

    expect(perTick, `${perTick.toFixed(4)} ms/tick`).toBeLessThan(BUDGET_MS.simTick);
  });

  it('generates a world within the per-seed budget', () => {
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
    const times = measuredWorlds().map((world) => bestOf(RUNS, () => void buildRoadGraph(world.roads)));
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(1)} ms worst`).toBeLessThan(BUDGET_MS.roadGraph);
  });

  it('builds the tensor field of a world within its budget', () => {
    const times = measuredWorlds().map((world) => bestOf(RUNS, () => void buildTensorField(world)));
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.tensorField);
  });

  it('samples the tensor field fast enough to trace streamlines with', () => {
    const perSample = measuredWorlds().map((world) => {
      const field = buildTensorField(world);
      const points = landPoints(world, 500, 0x51e);
      const ms = bestOf(RUNS, () => {
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
      return bestOf(2, () => footprints.set(world.seed, buildFootprint(world.roads, world.corridors, graph)));
    });
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.footprint);
  });

  it('cuts the parcels of a world within its budget', () => {
    const times = measuredWorlds().slice(0, HEAVY_WORLDS).map((world) => {
      const graph = graphOf(world);
      const footprint = footprintOf(world);
      const field = buildTensorField(world);
      // The last cut is kept: the chunk tests below need the parcels, and
      // cutting a world's parcels is the dearest thing this file does.
      return bestOf(2, () => parcelMaps.set(world.seed, buildParcels(world, footprint, graph, field)));
    });
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.parcels);
  });

  it('indexes a world by chunk within its budget', () => {
    const times = chunkedWorlds().map((world) => {
      const parcels = parcelsOf(world).parcels;
      return bestOf(RUNS, () => void new ChunkSource(world, parcels));
    });
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.chunkSource);
  });

  it('cuts a chunk out of an indexed world fast enough to stream it', () => {
    // The block around the origin, where the city is densest and a chunk holds
    // the most: the worst chunk of the map, not an average one.
    const perChunk = chunkedWorlds().map((world) => {
      const source = new ChunkSource(world, parcelsOf(world).parcels);
      let worst = 0;
      for (let cy = -1; cy <= 1; cy++) {
        for (let cx = -1; cx <= 1; cx++) worst = Math.max(worst, bestOf(RUNS, () => void source.chunk(cx, cy)));
      }
      return worst * 1000;
    });
    const worst = Math.max(...perChunk);

    expect(worst, `${worst.toFixed(0)} µs per chunk`).toBeLessThan(BUDGET_US.chunkSlice);
  });
});
