import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT, type InputFrame } from '../src/sim/input.ts';
import { initPhysics, SimPhysics } from '../src/sim/physics.ts';
import { createSimState, stepSim, type SimState } from '../src/sim/simulation.ts';
import { laneOffset, type AmbientPose, type AmbientTraffic } from '../src/sim/traffic.ts';
import { rideHeight, SALOON } from '../src/sim/vehicle.ts';
import { TIERS } from '../src/world/tiers.ts';
import { inputStream, stableJson, sweepSeeds } from './helpers.ts';
import { SEED_COUNT, TICKS } from './sim-harness.ts';
import { GRID_SPACING, gridGround, gridHeight, gridTraffic } from './traffic-grid.ts';

/**
 * The simulation sweep of spec section 3 with the traffic of spec section 13.1
 * in the loop, on the made-up grid of `traffic-grid.ts`. The player drives
 * along the arterial, so vehicles come into the box round them, are evaluated
 * on arrival, and are stepped from then on.
 */
describe(`traffic in the simulation (${SEED_COUNT} seeds)`, () => {
  const seeds = sweepSeeds(SEED_COUNT);

  beforeAll(async () => {
    await initPhysics();
  });

  /** A session on the grid, the car on the arterial's eastbound lane at its west end. */
  const session = (seed: number, traffic: AmbientTraffic): { state: SimState; physics: SimPhysics } => {
    const state = createSimState(seed, undefined, 0);
    const physics = new SimPhysics(gridGround(traffic), state);
    physics.spawn(state, -2 * GRID_SPACING + 15, 7, 0);
    return { state, physics };
  };

  it('steps every vehicle near the player to exactly where evaluating it on demand puts it', () => {
    for (const seed of seeds) {
      const traffic = gridTraffic(seed);
      const { state, physics } = session(seed, traffic);
      const bodies = physics.traffic;
      if (bodies === undefined) throw new Error('no traffic in the physics');
      const seen = new Set<number>();
      let startedWith = -1;
      const drive: InputFrame = { ...EMPTY_INPUT, throttle: 0.6 };
      for (let i = 0; i < TICKS; i++) {
        stepSim(state, drive, physics);
        for (const cursor of bodies.cursors) seen.add(cursor.id);
        if (startedWith < 0) startedWith = seen.size;
        if (i % 50 !== 49) continue;
        for (const cursor of bodies.cursors) {
          expect(cursor, `seed ${seed}, tick ${state.tick}`).toEqual(traffic.cursorAt(cursor.id, state.tick));
        }
      }
      // Vehicles came into range during the run, so what was checked is the
      // evaluation on arrival as well as the stepping.
      expect(bodies.cursors.length, `seed ${seed}`).toBeGreaterThan(0);
      expect(seen.size, `seed ${seed}`).toBeGreaterThan(startedWith);
      physics.dispose();
    }
  });

  it('replays a recorded input stream to identical state with the traffic in the loop', () => {
    for (const seed of seeds) {
      const inputs = inputStream(seed, TICKS);
      const run = (): string => {
        const traffic = gridTraffic(seed);
        const { state, physics } = session(seed, traffic);
        for (const frame of inputs) stepSim(state, frame, physics);
        physics.dispose();
        return stableJson(state);
      };
      expect(run()).toBe(run());
    }
  });

  it('promotes a vehicle that runs into the parked car, and hands it to the physics', () => {
    const seed = seeds[0] as number;
    const traffic = gridTraffic(seed);
    const { state, physics } = session(seed, traffic);
    // Across the eastbound lanes of the arterial, between two junctions.
    physics.spawn(state, 60, 4, Math.PI / 2);
    let tick = 0;
    for (; tick < 3600 && state.traffic.promoted.length === 0; tick++) stepSim(state, EMPTY_INPUT, physics);
    expect(state.traffic.promoted.length, 'nothing ran into the car').toBeGreaterThan(0);
    // It was driven into the car, not standing on it when the car was put down.
    expect(tick).toBeGreaterThan(10);
    const promoted = state.traffic.promoted[0] as SimState['traffic']['promoted'][number];
    expect(Math.hypot(promoted.vehicle.x - state.vehicle.x, promoted.vehicle.z - state.vehicle.z)).toBeLessThan(10);
    // Off its tour: no longer stepped as a kinematic body, and given a body of its own.
    expect(physics.traffic?.cursors.some((cursor) => cursor.id === promoted.id)).toBe(false);
    expect(physics.traffic?.promotedBodies).toBe(state.traffic.promoted.length);
    // It carries on as a body, and slides to a stop rather than driving on.
    for (let i = 0; i < 300; i++) stepSim(state, EMPTY_INPUT, physics);
    expect(Math.hypot(promoted.vehicle.vx, promoted.vehicle.vz)).toBeLessThan(1);
    expect(Math.abs(promoted.vehicle.y - (gridHeight(promoted.vehicle.x, promoted.vehicle.z) + rideHeight(SALOON)))).toBeLessThan(1.5);
    physics.dispose();
  });

  it('promotes a vehicle that a player on foot is standing in the way of', () => {
    const seed = seeds[1] as number;
    const traffic = gridTraffic(seed);
    const { state, physics } = session(seed, traffic);
    // The car is left far off the grid, and the player stands in the lane.
    // The inner eastbound lane of the arterial.
    const arterial = laneOffset({ tier: 'arterial', lanes: TIERS.arterial.lanes }, 0);
    state.vehicle.x = 5000;
    state.vehicle.z = 5000;
    state.player.driving = false;
    state.player.x = -60;
    state.player.y = arterial;
    state.player.height = gridHeight(-60, arterial);
    physics.adopt(state);
    let tick = 0;
    for (; tick < 3600 && state.traffic.promoted.length === 0; tick++) stepSim(state, EMPTY_INPUT, physics);
    expect(state.traffic.promoted.length, 'nothing ran into the player').toBeGreaterThan(0);
    expect(tick).toBeGreaterThan(10);
    const promoted = state.traffic.promoted[0] as SimState['traffic']['promoted'][number];
    expect(Math.hypot(promoted.vehicle.x - state.player.x, promoted.vehicle.z - state.player.y)).toBeLessThan(10);
    physics.dispose();
  });

  it('leaves the traffic alone while nobody touches it', () => {
    const seed = seeds[0] as number;
    const traffic = gridTraffic(seed);
    const { state, physics } = session(seed, traffic);
    // Off the grid entirely, so nothing can reach the car.
    physics.spawn(state, 1000, 1000, 0);
    for (let i = 0; i < 600; i++) stepSim(state, EMPTY_INPUT, physics);
    expect(state.traffic.promoted).toEqual([]);
    expect(physics.traffic?.cursors.length).toBe(0);
    // And the traffic still has a place at that tick, whoever is looking.
    const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    expect(Number.isFinite(traffic.poseAt(0, state.tick, pose).x)).toBe(true);
    physics.dispose();
  });
});
