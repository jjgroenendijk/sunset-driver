import { describe, expect, it } from 'vitest';
import { FixedStepClock, TICK_MS, TICKS_PER_DAY, gameTime } from '../src/sim/clock';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input';
import { cloneSimState, createSimState, stepSim } from '../src/sim/simulation';
import { stableJson, sweepSeeds } from './helpers';

/** A deterministic recorded input stream for a seed. */
function inputStream(seed: number, ticks: number): InputFrame[] {
  const frames: InputFrame[] = [];
  let x = seed >>> 0;
  for (let i = 0; i < ticks; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    frames.push({
      ...EMPTY_INPUT,
      throttle: ((x >>> 8) & 3) === 0 ? -1 : ((x >>> 8) & 3) === 1 ? 0 : 1,
      steer: ((x >>> 12) % 3) - 1,
      sprint: ((x >>> 16) & 1) === 1,
      handbrake: ((x >>> 20) & 7) === 0,
    });
  }
  return frames;
}

/** Run the sim with a given frame pacing (ms per render frame) for a wall-clock duration. */
function runPaced(seed: number, inputs: InputFrame[], frameMs: number): ReturnType<typeof createSimState> {
  const state = createSimState(seed);
  const clock = new FixedStepClock();
  let tick = 0;
  let elapsed = 0;
  const total = inputs.length * TICK_MS;
  while (elapsed < total + frameMs) {
    const steps = clock.advance(frameMs);
    for (let i = 0; i < steps && tick < inputs.length; i++) stepSim(state, inputs[tick++]);
    elapsed += frameMs;
  }
  // Drain any remaining ticks so every pacing reaches the same tick.
  while (tick < inputs.length) stepSim(state, inputs[tick++]);
  return state;
}

describe('simulation sweep', () => {
  const TICKS = 600;
  const seeds = sweepSeeds(50);

  it('replays a recorded input stream to identical state', () => {
    for (const seed of seeds) {
      const inputs = inputStream(seed, TICKS);
      const a = createSimState(seed);
      const b = createSimState(seed);
      for (const f of inputs) stepSim(a, f);
      for (const f of inputs) stepSim(b, f);
      expect(stableJson(a)).toBe(stableJson(b));
    }
  });

  it('yields identical state at the same tick at 30, 60 and 144 fps', () => {
    for (const seed of seeds) {
      const inputs = inputStream(seed, TICKS);
      const s30 = runPaced(seed, inputs, 1000 / 30);
      const s60 = runPaced(seed, inputs, 1000 / 60);
      const s144 = runPaced(seed, inputs, 1000 / 144);
      expect(s30.tick).toBe(s60.tick);
      expect(stableJson(s30)).toBe(stableJson(s60));
      expect(stableJson(s60)).toBe(stableJson(s144));
    }
  });

  it('two independent instances agree at the same tick', () => {
    for (const seed of seeds) {
      const inputs = inputStream(seed, TICKS);
      const a = createSimState(seed);
      for (const f of inputs) stepSim(a, f);
      const b = cloneSimState(createSimState(seed));
      for (const f of inputs) stepSim(b, f);
      expect(stableJson(a)).toBe(stableJson(b));
    }
  });
});

describe('clock', () => {
  it('steps exactly once per 1/60 s regardless of frame pacing', () => {
    for (const frameMs of [1000 / 30, 1000 / 60, 1000 / 144, 7.3, 23.9]) {
      const clock = new FixedStepClock();
      let steps = 0;
      let elapsed = 0;
      while (elapsed < 10_000) {
        steps += clock.advance(frameMs);
        elapsed += frameMs;
      }
      expect(Math.abs(steps - 600)).toBeLessThanOrEqual(2);
    }
  });
  it('caps steps per frame after a stall', () => {
    const clock = new FixedStepClock();
    expect(clock.advance(5000)).toBe(8);
    expect(clock.advance(0)).toBe(0);
  });
  it('maps ticks to a 24-minute day', () => {
    expect(TICKS_PER_DAY).toBe(86_400);
    expect(gameTime(0)).toMatchObject({ day: 0, hour: 0, minute: 0 });
    expect(gameTime(TICKS_PER_DAY / 2)).toMatchObject({ day: 0, hour: 12, minute: 0 });
    expect(gameTime(TICKS_PER_DAY + 90 * 60)).toMatchObject({ day: 1, hour: 1, minute: 30 });
  });
});
