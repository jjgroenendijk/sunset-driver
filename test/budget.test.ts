import { describe, expect, it } from 'vitest';
import { TICKS_PER_HOUR } from '../src/sim/clock.ts';
import type { InputFrame } from '../src/sim/input.ts';
import { createSimState, stepSim } from '../src/sim/simulation.ts';
import { buildFootprint } from '../src/world/footprint.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
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
    // A few worlds rather than all of them: laying a footprint is expensive
    // enough that the full tier cannot afford one per measured seed.
    const times = measuredWorlds().slice(0, 4).map((world) => {
      const graph = buildRoadGraph(world.roads);
      return bestOf(2, () => void buildFootprint(world.roads, world.corridors, graph));
    });
    const worst = Math.max(...times);

    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.footprint);
  });
});
