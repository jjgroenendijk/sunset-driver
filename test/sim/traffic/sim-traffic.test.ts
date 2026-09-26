import { beforeAll, describe, expect, it } from 'vitest';
import { heldPose, heldTime } from '../../../src/sim/traffic/hold.ts';
import { EMPTY_INPUT, type InputFrame } from '../../../src/sim/input.ts';
import { initPhysics, SimPhysics } from '../../../src/sim/physics/physics.ts';
import { createSimState, stepSim, type SimState } from '../../../src/sim/simulation.ts';
import { PARKED_ID, ParkedCars, type ParkedCar } from '../../../src/sim/traffic/parked.ts';
import { addPromoted, laneOffset, type AmbientPose, type AmbientTraffic } from '../../../src/sim/traffic/traffic.ts';
import { createVehicleState, rideHeight, specOf } from '../../../src/sim/vehicles/vehicle.ts';
import { BAY_USES, type ParkingBays } from '../../../src/world/city/parking.ts';
import { TIERS } from '../../../src/world/roads/tiers.ts';
import { inputStream, stableJson, sweepSeeds } from '../../support/helpers.ts';
import { SEED_COUNT, TICKS } from '../../support/sim-harness.ts';
import { GRID_SPACING, gridGround, gridHeight, gridTraffic } from '../../support/traffic-grid.ts';

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

  /** Drive past the traffic of one seed and hold each stepped vehicle to where evaluating it puts it. */
  const checkStepping = (seed: number): void => {
    const traffic = gridTraffic(seed);
    const { state, physics } = session(seed, traffic);
    const bodies = physics.traffic;
    if (bodies === undefined) throw new Error('no traffic in the physics');
    const seen = new Set<number>();
    let startedWith = -1;
    const drive: InputFrame = { ...EMPTY_INPUT, throttle: 1 };
    for (let i = 0; i < TICKS; i++) {
      stepSim(state, drive, physics);
      for (const cursor of bodies.cursors) seen.add(cursor.id);
      if (startedWith < 0) startedWith = seen.size;
      if (i % 50 !== 49) continue;
      for (const cursor of bodies.cursors) {
        expect(cursor, `seed ${seed}, tick ${state.tick}`).toEqual(traffic.cursorAt(cursor.id, heldTime(state.traffic.held, cursor.id, state.tick)));
      }
    }
    // Vehicles came into range during the run, so what was checked is the
    // evaluation on arrival as well as the stepping.
    expect(bodies.cursors.length, `seed ${seed}`).toBeGreaterThan(0);
    expect(seen.size, `seed ${seed}`).toBeGreaterThan(startedWith);
    physics.dispose();
  };

  it('steps every vehicle near the player to exactly where evaluating it on demand puts it', () => {
    for (const seed of seeds) checkStepping(seed);
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

  /**
   * Step a session for `ticks` and answer the ambient cars that drove past
   * `x` eastbound within 6 m of `y`, and whether any of them swerved.
   */
  const passing = (state: SimState, physics: SimPhysics, traffic: AmbientTraffic, x: number, y: number, ticks: number): { passed: number; swerved: boolean } => {
    const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    const behind = new Set<number>();
    const past = new Set<number>();
    let swerved = false;
    for (let i = 0; i < ticks; i++) {
      stepSim(state, EMPTY_INPUT, physics);
      swerved ||= state.traffic.held.list.some((hold) => hold.swerve !== undefined && hold.swerve.side !== 0);
      for (const id of traffic.near(x - 30, y - 10, x + 30, y + 10, [])) {
        if (state.traffic.promoted.some((record) => record.id === id)) continue;
        heldPose(traffic, state.traffic.held, id, state.tick, pose);
        if (Math.abs(pose.y - y) > 6 || Math.cos(pose.heading) < 0.5) continue;
        if (pose.x < x - 8) behind.add(id);
        else if (pose.x > x + 8 && behind.has(id)) past.add(id);
      }
    }
    return { passed: past.size, swerved };
  };

  it('steers the traffic round the car parked in its lane, and drives into nothing', () => {
    const seed = seeds[0] as number;
    const traffic = gridTraffic(seed);
    const { state, physics } = session(seed, traffic);
    // In the inner eastbound lane of the arterial, between two junctions.
    const lane = laneOffset({ tier: 'arterial', lanes: TIERS.arterial.lanes }, 0);
    physics.spawn(state, 60, lane, 0);
    const { passed, swerved } = passing(state, physics, traffic, 60, lane, 1800);
    // Nobody drives into the car and is left standing in the lane (`swerve.ts`).
    expect(state.traffic.promoted).toEqual([]);
    expect(swerved, 'no car steered round the parked one').toBe(true);
    expect(passed, 'no car got past the parked one').toBeGreaterThan(0);
    physics.dispose();
  });

  /**
   * A place along a lane running east, 30 m ahead of where a car's tour drives
   * it 2 to 10 s from now, clear of the junctions and of every car now.
   */
  const aheadOfTraffic = (traffic: AmbientTraffic, tick: number, lane: number): number => {
    const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    const clear = (x: number): boolean =>
      traffic.near(x - 12, lane - 12, x + 12, lane + 12, []).every((id) => {
        traffic.poseAt(id, tick, pose);
        return Math.hypot(pose.x - x, pose.y - lane) > 10;
      });
    for (let t = tick + 120; t < tick + 600; t += 10) {
      for (let id = 0; id < traffic.vehicles.length; id++) {
        traffic.poseAt(id, t, pose);
        const x = pose.x + 30;
        const off = ((x % GRID_SPACING) + GRID_SPACING) % GRID_SPACING;
        if (Math.abs(pose.y - lane) > 0.3 || Math.cos(pose.heading) < 0.99 || off < 20 || off > GRID_SPACING - 20) continue;
        if (clear(x)) return x;
      }
    }
    throw new Error('no car drives the lane');
  };

  it('drives up on the verge round a car parked in the middle of a narrow road', () => {
    const seed = seeds[0] as number;
    const traffic = gridTraffic(seed);
    const { state, physics } = session(seed, traffic);
    // The dirt road: 5 m kerb to kerb, a lane each way, a metre of verge. The car leaves too little of the carriageway.
    const road = 2 * GRID_SPACING;
    const lane = road + laneOffset({ tier: 'dirt', lanes: TIERS.dirt.lanes }, 0);
    // Parked ahead of a car whose tour drives the road eastward soon, clear of the junctions.
    const x = aheadOfTraffic(traffic, state.tick, lane);
    physics.spawn(state, x, road, 0);
    const { passed } = passing(state, physics, traffic, x, lane, 1800);
    expect(state.traffic.promoted).toEqual([]);
    expect(passed, 'no car got past the parked one').toBeGreaterThan(0);
    physics.dispose();
  });

  it('steers the traffic round a player on foot standing in the lane', () => {
    const seed = seeds[1] as number;
    const traffic = gridTraffic(seed);
    const { state, physics } = session(seed, traffic);
    // The car is left far off the grid, and the player stands in the inner eastbound lane of the arterial.
    const arterial = laneOffset({ tier: 'arterial', lanes: TIERS.arterial.lanes }, 0);
    state.vehicle.x = 5000;
    state.vehicle.z = 5000;
    state.player.driving = false;
    state.player.x = 60;
    state.player.y = arterial;
    state.player.height = gridHeight(60, arterial);
    physics.adopt(state);
    const { passed } = passing(state, physics, traffic, 60, arterial, 1800);
    expect(state.traffic.promoted).toEqual([]);
    expect(passed, 'no car got past the player').toBeGreaterThan(0);
    physics.dispose();
  });

  it('puts a bumped car that stands clear back on its tour, where it stands', () => {
    const seed = seeds[0] as number;
    const traffic = gridTraffic(seed);
    const { state, physics } = session(seed, traffic);
    for (let i = 0; i < 60; i++) stepSim(state, EMPTY_INPUT, physics);
    // A car of the box away from the player's, stopped where it stands as a blow would leave it.
    const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    const id = (physics.traffic?.cursors ?? []).map((cursor) => cursor.id).find((at) => {
      heldPose(traffic, state.traffic.held, at, state.tick, pose);
      return Math.hypot(pose.x - state.vehicle.x, pose.y - state.vehicle.z) > 20;
    });
    if (id === undefined) throw new Error('no car in the box');
    heldPose(traffic, state.traffic.held, id, state.tick, pose);
    const spec = specOf((traffic.vehicles[id] as AmbientTraffic['vehicles'][number]).cls);
    const vehicle = createVehicleState(spec, pose.x, pose.y, pose.height + rideHeight(spec), pose.heading + 0.2);
    addPromoted(state.traffic, { id, paint: 0, vehicle });
    const stood = { x: vehicle.x, y: vehicle.z };
    let joined = -1;
    for (let i = 0; i < 90 && joined < 0; i++) {
      stepSim(state, EMPTY_INPUT, physics);
      if (!state.traffic.promoted.some((record) => record.id === id)) joined = state.tick;
    }
    expect(joined, 'the car never rejoined its tour').toBeGreaterThan(0);
    // It went back to its tour where it stood, turned as it was: nothing jumped.
    heldPose(traffic, state.traffic.held, id, state.tick, pose);
    expect(Math.hypot(pose.x - stood.x, pose.y - stood.y)).toBeLessThan(0.5);
    expect(state.traffic.held.list.find((at) => at.id === id)?.swerve?.yaw).toBeCloseTo(0.2, 1);
    physics.dispose();
  });

  it("leaves the player's own car where they left it", () => {
    const seed = seeds[0] as number;
    const traffic = gridTraffic(seed);
    const { state, physics } = session(seed, traffic);
    const spec = specOf(state.vehicle.cls);
    const pose = traffic.poseAt(0, state.tick, { x: 0, y: 0, height: 0, heading: 0, speed: 0 });
    const vehicle = createVehicleState(spec, pose.x, pose.y, pose.height + rideHeight(spec), pose.heading);
    addPromoted(state.traffic, { id: 0, paint: 0, vehicle, left: true });
    physics.spawn(state, pose.x + 40, pose.y, 0);
    for (let i = 0; i < 90; i++) stepSim(state, EMPTY_INPUT, physics);
    expect(state.traffic.promoted.map((record) => record.id)).toContain(0);
    physics.dispose();
  });

  it('stands the parked cars near the player as bodies, and promotes the one they walk into', () => {
    const seed = seeds[0] as number;
    const traffic = gridTraffic(seed);
    const { state, physics } = session(seed, traffic);
    // A row of bays facing east, off the grid, at midnight when a street of houses is full.
    const count = 12;
    const bays: ParkingBays = {
      count,
      x: Float64Array.from({ length: count }, (_, i) => 1000 + 6 * i),
      y: new Float64Array(count).fill(1000),
      height: Float32Array.from({ length: count }, (_, i) => gridHeight(1000 + 6 * i, 1000)),
      heading: new Float32Array(count),
      use: new Uint8Array(count).fill(BAY_USES.indexOf('home')),
      street: new Uint8Array(count).fill(1),
    };
    const parked = new ParkedCars(seed, bays);
    const ground = gridGround(traffic);
    ground.parked = parked;
    physics.dispose();
    const walked = new SimPhysics(ground, state);
    const car: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
    let bay = 0;
    while (!parked.carAt(bay, state.tick, state.traffic, car)) bay++;
    // The car is left off the row, and the player stands south of the bay and walks north into it.
    state.vehicle.x = 5000;
    state.vehicle.z = 5000;
    state.player.driving = false;
    state.player.x = bays.x[bay] as number;
    state.player.y = 1004;
    state.player.height = gridHeight(state.player.x, state.player.y);
    walked.adopt(state);
    stepSim(state, EMPTY_INPUT, walked);
    expect(walked.traffic?.parkedBodies).toBeGreaterThan(0);
    expect(state.traffic.promoted).toEqual([]);
    let tick = 0;
    for (; tick < 240 && state.traffic.promoted.length === 0; tick++) stepSim(state, { ...EMPTY_INPUT, throttle: 1 }, walked);
    expect(state.traffic.promoted.map((record) => record.id), 'the player never reached the car').toEqual([PARKED_ID + bay]);
    const promoted = state.traffic.promoted[0] as SimState['traffic']['promoted'][number];
    expect(promoted.paint).toBe(car.paint);
    expect(promoted.vehicle.cls).toBe(car.cls);
    expect(Math.hypot(promoted.vehicle.x - (bays.x[bay] as number), promoted.vehicle.z - 1000)).toBeLessThan(0.5);
    expect(parked.carAt(bay, state.tick, state.traffic, car)).toBe(false);
    expect(walked.traffic?.promotedBodies).toBe(1);
    walked.dispose();
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
