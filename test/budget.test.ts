import { describe, expect, it } from 'vitest';
import { TICKS_PER_HOUR } from '../src/sim/clock.ts';
import type { InputFrame } from '../src/sim/input.ts';
import { createSimState, stepSim } from '../src/sim/simulation.ts';
import { generateWorld } from '../src/world/world.ts';
import { BUDGET_MS, FRAME_MS, FRAME_SLICE_MS, SIM_SLICE_MS } from './budgets.ts';
import { bestOf, inputStream, sweepSeeds } from './helpers.ts';

/** A handful of seeds: enough for a median, cheap enough for the quick tier. */
const GEN_SEEDS = sweepSeeds(4);

/** Repetitions of each measurement; the fastest one is scored. */
const RUNS = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
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
      generateWorld(seed);
      return performance.now() - t0;
    });
    const worst = Math.max(...times);
    const typical = median(times);

    expect(typical, `${typical.toFixed(0)} ms median`).toBeLessThan(BUDGET_MS.worldGen);
    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.worldGenWorst);
  });
});
