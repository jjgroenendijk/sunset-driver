import { describe, expect, it } from 'vitest';
import { cos, sin } from '../src/core/libm.ts';
import { asideOf } from '../src/sim/crowd-aside.ts';
import { MAKE_WAY_MOST, stepMakeWay } from '../src/sim/make-way.ts';
import { AmbientPedestrians, crowdPoseOf, emptyPose } from '../src/sim/pedestrians.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

/**
 * The crowd making way for the player on foot (`make-way.ts`): a person in
 * the player's path steps off it and back, and heads turn to the player.
 */
const SEED = 4711;
const roads = { ...gridTrafficRoads(), heightAt: () => 0 };
const crowd = new AmbientPedestrians(SEED, roads);

/** A walker of the crowd at a tick, and a player on foot standing in their way a few metres ahead. */
function facing(tick: number): { state: SimState; id: number } {
  const state = createSimState(SEED);
  state.tick = tick;
  const pose = emptyPose();
  const id = crowd.people.findIndex((p) => crowd.poseAt(p.id, tick, pose).speed > 0.5 && p.company === 1);
  crowd.poseAt(id, tick, pose);
  state.player.driving = false;
  state.player.x = pose.x + cos(pose.heading) * 3;
  state.player.y = pose.y + sin(pose.heading) * 3;
  state.player.heading = pose.heading + Math.PI;
  state.player.speed = 1.2;
  return { state, id };
}

describe('making way for the player (spec sections 11.2, 20.1)', () => {
  it('steps a person out of the player\'s path, turns their head, and lets them back after', () => {
    const { state, id } = facing(9_000);
    for (let i = 0; i < 40; i++) {
      stepMakeWay(state, crowd);
      state.tick++;
    }
    const aside = asideOf(state.pedestrians.aside, id);
    expect(aside).toBeDefined();
    expect(Math.abs(aside!.off)).toBeGreaterThan(0.3);
    expect(Math.abs(aside!.off)).toBeLessThanOrEqual(MAKE_WAY_MOST + 1e-9);
    expect(state.pedestrians.aside.map((a) => a.id)).toEqual([...state.pedestrians.aside.map((a) => a.id)].sort((a, b) => a - b));
    // The step moves where they stand, which is what the contacts read.
    const moved = crowdPoseOf(crowd, state.pedestrians, id, state.tick, emptyPose())!;
    const lane = crowd.poseAt(id, state.tick, emptyPose());
    expect(Math.hypot(moved.x - lane.x, moved.y - lane.y)).toBeCloseTo(Math.abs(aside!.off), 6);
    // In the car, everybody goes back to their lane.
    state.player.driving = true;
    for (let i = 0; i < 120; i++) {
      stepMakeWay(state, crowd);
      state.tick++;
    }
    expect(state.pedestrians.aside).toEqual([]);
  });

  it('makes somebody the player sprints into jump clear', () => {
    const { state, id } = facing(9_000);
    const pose = crowd.poseAt(id, state.tick, emptyPose());
    state.player.x = pose.x + 0.4;
    state.player.y = pose.y;
    state.player.speed = 5.5;
    stepMakeWay(state, crowd);
    expect(state.pedestrians.startled.some((r) => r.id === id && r.reaction === 'scatter')).toBe(true);
  });
});
