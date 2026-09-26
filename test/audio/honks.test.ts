import { describe, expect, it } from 'vitest';
import { hearHonks, type HonkSource } from '../../src/audio/honks.ts';
import type { Cue } from '../../src/audio/cue.ts';
import { TICK_RATE } from '../../src/sim/clock.ts';
import { createSimState, type SimState } from '../../src/sim/simulation.ts';
import type { Personality } from '../../src/sim/traffic/driver.ts';
import type { AmbientPose } from '../../src/sim/traffic/traffic.ts';

/** One car standing still at `(10, 0)`, driven by somebody of `personality`. */
function source(personality: Personality): HonkSource {
  return {
    vehicles: [{ driver: { personality } }],
    poseAt: (_id: number, _time: number, out: AmbientPose): AmbientPose => Object.assign(out, { x: 10, y: 0, heading: 0, speed: 0 }),
  };
}

/**
 * Stand car 0 for `seconds` behind something, a frame every `frameTicks`
 * ticks, and answer the ticks a honk was heard on, heard from `(x, 0)`.
 */
function honksOver(personality: Personality, seconds: number, frameTicks: number, x = 0): number[] {
  const state: SimState = createSimState(1);
  const traffic = source(personality);
  const heard: number[] = [];
  let was = state.tick;
  for (let waited = 1; waited <= seconds * TICK_RATE; waited++) {
    state.tick++;
    state.traffic.held = { tick: state.tick, x: 0, y: 0, list: [{ id: 0, lag: waited, step: 1, waited }] };
    if (waited % frameTicks !== 0) continue;
    const cues: Cue[] = [];
    hearHonks(state, was, traffic, x, 0, cues);
    was = state.tick;
    for (const cue of cues) if (cue.kind === 'honk') heard.push(state.tick);
  }
  return heard;
}

describe('the horns of the traffic', () => {
  it('honks after the driver stands a while, a minor third at a time, and gives up', () => {
    const heard = honksOver('steady', 60, 1);
    // Two notes at once for each honk.
    expect(heard.length % 2).toBe(0);
    expect(heard.length / 2).toBeGreaterThan(1);
    expect(heard.length / 2).toBeLessThanOrEqual(6);
    expect(heard[0]).toBeGreaterThanOrEqual(3 * TICK_RATE);
  });

  it('lets a tailgater lose patience before a hesitant driver does', () => {
    const [tailgater] = honksOver('tailgater', 20, 1);
    const [hesitant] = honksOver('hesitant', 20, 1);
    expect(tailgater).toBeLessThan(hesitant as number);
  });

  it('hears the same honks whatever the frame rate', () => {
    const every = honksOver('brisk', 30, 1).length;
    expect(honksOver('brisk', 30, 3)).toHaveLength(every);
    expect(honksOver('brisk', 30, 7)).toHaveLength(every);
  });

  it('is not heard far off', () => {
    expect(honksOver('tailgater', 20, 1, 500)).toEqual([]);
  });
});
