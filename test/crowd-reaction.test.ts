import { describe, expect, it } from 'vitest';
import {
  BLAST_FRIGHT,
  CAR_REACH,
  CAR_SPEED,
  CRASH_FLEE,
  CRASH_SEVERITY,
  CRASH_WATCH,
  crowdFeelsBlast,
  crowdHearsShot,
  RELEASE_FAR,
  SHOT_REACH,
  stepCrowdReactions,
} from '../src/sim/crowd-reaction.ts';
import {
  AmbientPedestrians,
  startledPose,
  type PedestrianPose,
  type StartledPedestrian,
} from '../src/sim/pedestrians.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import { STANDING } from '../src/sim/pedestrian-look.ts';
import { stableJson } from './helpers.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

/**
 * The crowd reactions of spec section 20.1: what the people on the pavement do
 * about a shot, a blast, a car and a crash. The fright itself — who is taken
 * off their loop and where they stand then — is `pedestrians.test.ts`.
 */
const SEED = 4711;
const TICK = 9_000;

const roads = { ...gridTrafficRoads(), heightAt: () => 0 };
const crowd = new AmbientPedestrians(SEED, roads);
const pose = (): PedestrianPose => ({ x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' });

/** A state whose car stands at a place, driven at a speed along the map's x axis. */
function driving(x: number, y: number, speed = 0): SimState {
  const state = createSimState(SEED);
  state.tick = TICK;
  state.player.driving = true;
  state.player.x = x;
  state.player.y = y;
  state.vehicle.x = x;
  state.vehicle.z = y;
  state.vehicle.vx = speed;
  return state;
}

/** Where the crowd is thickest at {@link TICK}: the busiest person's place. */
function busiest(): PedestrianPose {
  let best = crowd.poseAt(0, TICK, pose());
  let most = -1;
  const at = pose();
  const ids: number[] = [];
  for (const id of crowd.near(-300, -300, 300, 300, ids)) {
    const here = crowd.poseAt(id, TICK, at);
    let count = 0;
    for (const other of crowd.near(here.x - CRASH_WATCH, here.y - CRASH_WATCH, here.x + CRASH_WATCH, here.y + CRASH_WATCH, [])) {
      const there = crowd.poseAt(other, TICK, pose());
      if (Math.hypot(there.x - here.x, there.y - here.y) <= CRASH_WATCH) count++;
    }
    if (count <= most) continue;
    most = count;
    best = { ...here };
  }
  return best;
}

const CROWDED = busiest();

describe('crowd reactions (spec section 20.1)', () => {
  it('rings a crash: the people on top of it run, the people around it come and watch', () => {
    const state = driving(CROWDED.x, CROWDED.y);
    stepCrowdReactions(state, crowd, CRASH_SEVERITY);
    const records = state.pedestrians.startled;
    expect(records.length).toBeGreaterThan(0);
    let ran = 0;
    let watched = 0;
    for (const record of records) {
      const gap = Math.hypot(record.x - CROWDED.x, record.y - CROWDED.y);
      if (record.reaction === 'flee') {
        ran++;
        expect(gap).toBeLessThanOrEqual(CRASH_FLEE);
      } else {
        watched++;
        expect(record.reaction).toBe('gather');
        expect(gap).toBeGreaterThan(CRASH_FLEE);
        expect(gap).toBeLessThanOrEqual(CRASH_WATCH);
      }
      // They move the way they reacted: off the wreck, or over to it.
      const moved = startledPose(record, state.tick + 30, pose());
      const after = Math.hypot(moved.x - CROWDED.x, moved.y - CROWDED.y);
      expect(record.reaction === 'flee' ? after > gap : after < gap).toBe(true);
    }
    expect(ran).toBeGreaterThan(0);
    expect(watched).toBeGreaterThan(0);
    // A gatherer stands and watches the wreck once they are there.
    const stood = startledPose(records.find((r) => r.reaction === 'gather') as StartledPedestrian, state.tick + 10_000, pose());
    expect(STANDING.has(stood.gait)).toBe(true);
    expect(stood.speed).toBe(0);
  });

  it('scatters the people a car is about to run over, and only once it is moving', () => {
    const slow = driving(CROWDED.x, CROWDED.y, CAR_SPEED - 0.1);
    stepCrowdReactions(slow, crowd, 0);
    expect(slow.pedestrians.startled).toEqual([]);

    const fast = driving(CROWDED.x, CROWDED.y, CAR_SPEED);
    stepCrowdReactions(fast, crowd, 0);
    const records = fast.pedestrians.startled;
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.reaction).toBe('dodge');
      expect(Math.hypot(record.x - CROWDED.x, record.y - CROWDED.y)).toBeLessThanOrEqual(CAR_REACH);
    }
  });

  it('empties the pavement round a gunshot, and a blast over a wider ring', () => {
    const shot = driving(CROWDED.x, CROWDED.y);
    expect(crowdHearsShot(shot, crowd, CROWDED.x, CROWDED.y)).toBeGreaterThan(0);
    for (const record of shot.pedestrians.startled) {
      expect(record.reaction).toBe('flee');
      expect(Math.hypot(record.x - CROWDED.x, record.y - CROWDED.y)).toBeLessThanOrEqual(SHOT_REACH);
    }
    // The same blast radius reaches further as a fright than a shot of its own size.
    const blast = driving(CROWDED.x, CROWDED.y);
    const radius = (2 * SHOT_REACH) / BLAST_FRIGHT;
    expect(crowdFeelsBlast(blast, crowd, CROWDED.x, CROWDED.y, radius)).toBeGreaterThan(
      shot.pedestrians.startled.length,
    );
  });

  it('gives everyone back to their loops once the player has driven away', () => {
    const state = driving(CROWDED.x, CROWDED.y);
    stepCrowdReactions(state, crowd, CRASH_SEVERITY);
    expect(state.pedestrians.startled.length).toBeGreaterThan(0);
    // Still there while the player is in sight of them.
    state.tick += 600;
    state.player.x = CROWDED.x + RELEASE_FAR - 20;
    state.vehicle.x = state.player.x;
    stepCrowdReactions(state, crowd, 0);
    expect(state.pedestrians.startled.length).toBeGreaterThan(0);
    state.tick += 600;
    state.player.x = CROWDED.x + 4 * RELEASE_FAR;
    state.vehicle.x = state.player.x;
    stepCrowdReactions(state, crowd, 0);
    expect(state.pedestrians.startled).toEqual([]);
  });

  it('frights the same people in the same places on a second run of the same ticks', () => {
    const run = (): string => {
      const state = driving(CROWDED.x - 60, CROWDED.y, CAR_SPEED + 3);
      for (let i = 0; i < 120; i++) {
        state.vehicle.x += (CAR_SPEED + 3) / 60;
        state.player.x = state.vehicle.x;
        stepCrowdReactions(state, crowd, i === 90 ? CRASH_SEVERITY : 0);
        state.tick += 1;
      }
      return stableJson(state.pedestrians.startled);
    };
    const first = run();
    expect(run()).toBe(first);
    expect(JSON.parse(first)).toHaveLength(new Set((JSON.parse(first) as StartledPedestrian[]).map((r) => r.id)).size);
  });
});
