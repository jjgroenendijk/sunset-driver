import { beforeAll, describe, expect, it } from 'vitest';
import { FixedStepClock, TICKS_PER_DAY, gameTime } from '../src/sim/clock.ts';
import { EMPTY_INPUT } from '../src/sim/input.ts';
import { initPhysics, SimPhysics } from '../src/sim/physics.ts';
import { cloneSimState, createSimState, stepSim, type SimState } from '../src/sim/simulation.ts';
import { headingOf, rideHeight, SALOON } from '../src/sim/vehicle.ts';
import { type Surface } from '../src/world/surface.ts';
import { inputStream, stableJson, sweepSeeds } from './helpers.ts';
import {
  SEED_COUNT,
  TICKS,
  hills,
  ramp,
  start,
  drive,
  replay,
  walkReplay,
  accelerateTo,
  runPaced,
} from './sim-harness.ts';

/**
 * The sweep drives the car of spec section 11.3 rather than a placeholder, so
 * what it checks is the Rapier world in the loop: the same inputs give the same
 * session, whatever the frame rate and whichever instance runs them. The ground
 * and the session helpers are in `sim-harness.ts`.
 */
describe(`simulation sweep (${SEED_COUNT} seeds)`, () => {
  const seeds = sweepSeeds(SEED_COUNT);

  beforeAll(async () => {
    await initPhysics();
  });

  /**
   * One replay of each seed's stream, which the checks below compare a run of
   * their own against. Each check still makes a run of its own, so two runs
   * are compared every time; they only share the one they compare against.
   */
  const replays = new Map<number, string>();
  const replayOf = (seed: number): string => {
    const known = replays.get(seed);
    if (known !== undefined) return known;
    const built = stableJson(replay(seed, inputStream(seed, TICKS)));
    replays.set(seed, built);
    return built;
  };

  it('replays a recorded input stream to identical state', () => {
    for (const seed of seeds) {
      expect(stableJson(replay(seed, inputStream(seed, TICKS)))).toBe(replayOf(seed));
    }
  });

  it('replays a walk to identical state, with the character in the loop', () => {
    for (const seed of seeds) {
      const inputs = inputStream(seed, TICKS);
      const run = walkReplay(seed, inputs);
      expect(stableJson(run.state)).toBe(stableJson(walkReplay(seed, inputs).state));
      // The player did walk, so what was replayed is a character in the loop
      // and not someone who got straight back into the car.
      expect(run.walked, `seed ${seed}`).toBeGreaterThan(2);
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
      const b = cloneSimState(replay(seed, inputStream(seed, TICKS)));
      expect(stableJson(b)).toBe(replayOf(seed));
    }
  });

  it('drives the car somewhere, so the sweep is checking a moving vehicle', () => {
    const inputs = inputStream(seeds[0] as number, TICKS);
    const state = createSimState(seeds[0] as number);
    const physics = new SimPhysics(hills(), state);
    physics.spawn(state, 0, 0, 0);
    // Metres of ground covered, not distance from where it set off: a car that
    // drives a loop ends where it started and has still been driven.
    let path = 0;
    let x = state.player.x;
    let y = state.player.y;
    for (const frame of inputs) {
      stepSim(state, frame, physics);
      path += Math.hypot(state.player.x - x, state.player.y - y);
      x = state.player.x;
      y = state.player.y;
    }
    physics.dispose();
    expect(path).toBeGreaterThan(50);
  });
});

describe('driving', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('stands the car on the ground it is given', () => {
    for (const slope of [0, 0.1, -0.15]) {
      const session = start(ramp('asphalt', slope));
      const v = session.state.vehicle;
      const ground = slope * v.x;
      expect(v.wheels.every((w) => w.contact), `slope ${slope}`).toBe(true);
      // At rest the springs carry the weight, so the body sits a little below
      // the height it hangs at with the wheels off the ground.
      expect(v.y - ground, `slope ${slope}`).toBeGreaterThan(rideHeight(SALOON) - 0.3);
      expect(v.y - ground, `slope ${slope}`).toBeLessThan(rideHeight(SALOON) + 0.05);
      session.physics.dispose();
    }
  });

  it('steers toward the side the input steers toward', () => {
    const session = start(ramp('asphalt', 0));
    accelerateTo(session, 10);
    const before = headingOf(session.state.vehicle);
    drive(session, 90, { throttle: 0.4, steer: 1 });
    // The map's heading grows toward +y, which is the driver's right hand.
    expect(headingOf(session.state.vehicle)).toBeGreaterThan(before + 0.2);
    session.physics.dispose();
  });

  it('climbs slower than it runs on the flat, and faster downhill', () => {
    const speeds = [0.12, 0, -0.12].map((slope) => {
      const session = start(ramp('asphalt', slope));
      drive(session, 600, { throttle: 1 });
      const speed = session.state.vehicle.speed;
      session.physics.dispose();
      return speed;
    });
    const [climbing, flat, descending] = speeds as [number, number, number];
    expect(climbing).toBeLessThan(flat - 1);
    expect(descending).toBeGreaterThan(flat + 1);
  });

  it('takes longer to stop running downhill than running uphill', () => {
    const distances = [-0.1, 0.1].map((slope) => {
      const session = start(ramp('asphalt', slope));
      expect(accelerateTo(session, 20), `slope ${slope}`).toBe(true);
      const from = session.state.vehicle.x;
      for (let i = 0; i < 900 && session.state.vehicle.speed > 0.5; i++) drive(session, 1, { throttle: -1 });
      const travelled = Math.abs(session.state.vehicle.x - from);
      session.physics.dispose();
      return travelled;
    });
    const [downhill, uphill] = distances as [number, number];
    expect(downhill).toBeGreaterThan(uphill);
  });

  it('grips asphalt best, then dirt, then open ground, then sand', () => {
    const surfaces: Surface[] = ['asphalt', 'dirt', 'ground', 'sand'];
    const turns = surfaces.map((surface) => {
      const session = start(ramp(surface, 0));
      expect(accelerateTo(session, 18), surface).toBe(true);
      const before = headingOf(session.state.vehicle);
      drive(session, 120, { throttle: 0.3, steer: 1 });
      const turned = headingOf(session.state.vehicle) - before;
      session.physics.dispose();
      return turned;
    });
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i] as number, `${surfaces[i]} against ${surfaces[i - 1]}`).toBeLessThan(turns[i - 1] as number);
    }
  });

  it('leaves a parked car where it was parked, even on a hill', () => {
    const session = start(ramp('asphalt', 0.1));
    const from = session.state.vehicle.x;
    drive(session, 900);
    expect(Math.abs(session.state.vehicle.x - from)).toBeLessThan(0.5);
    session.physics.dispose();
  });

  it('carries a session through its record and back', () => {
    const ground = hills();
    const session = start(ground);
    drive(session, 300, { throttle: 1, steer: 1 });

    // The record is plain data: it survives JSON, and a physics world built
    // from it puts the car back where the record says it was.
    const revived = cloneSimState(JSON.parse(JSON.stringify(session.state)) as SimState);
    const physics = new SimPhysics(ground, revived);
    physics.step(revived, EMPTY_INPUT);
    session.physics.step(session.state, EMPTY_INPUT);

    const a = session.state.vehicle;
    const b = revived.vehicle;
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.01);
    expect(Math.abs(a.speed - b.speed)).toBeLessThan(0.05);
    physics.dispose();
    session.physics.dispose();
  });

  it('holds the ground under the car as it drives away from where it started', () => {
    const session = start(hills());
    const tiles = session.physics.groundTiles;
    expect(accelerateTo(session, 25)).toBe(true);
    // Half throttle, not full: a wet hillside at 130 km/h launches the car and
    // the crash that follows is the weather of spec section 13.4 doing its job,
    // not the ground failing to follow. Half still covers half a kilometre,
    // which is what leaves the tiles the car started on behind.
    drive(session, 900, { throttle: 0.5 });
    // The car has left the tiles it started on, and it is still on the ground.
    expect(session.physics.groundTiles).toBe(tiles);
    expect(session.state.vehicle.wheels.some((w) => w.contact)).toBe(true);
    session.physics.dispose();
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
