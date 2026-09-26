import { beforeAll, describe, expect, it } from 'vitest';
import { isMilitary } from '../../../src/sim/vehicles/aircraft-roster.ts';
import { CEILING } from '../../../src/sim/vehicles/flight.ts';
import { EMPTY_INPUT, type InputFrame } from '../../../src/sim/input.ts';
import { initPhysics, SimPhysics, type Ground } from '../../../src/sim/physics/physics.ts';
import { createSimState, stepSim } from '../../../src/sim/simulation.ts';
import { headingOf, rideHeight, ROSTER, type VehicleClass } from '../../../src/sim/vehicles/vehicle.ts';
import { AIRCRAFT_CLASSES } from '../../../src/world/types.ts';
import { DRY } from '../../support/helpers.ts';

/**
 * The aircraft of spec section 11.3 and the arcade flight of `flight.ts`, on a
 * level runway with the sea out of reach, and on open water for the seaplane.
 */

const RUNWAY: Ground = { heightAt: () => 0, surfaceAt: () => 'asphalt', seaLevel: DRY };
const SEA: Ground = { heightAt: () => -30, surfaceAt: () => 'ground', seaLevel: 0 };

/** Where an aircraft is after a run, and the least upright it was on the way. */
interface Flown {
  clearance: number;
  path: number;
  speed: number;
  turned: number;
  upright: number;
  afloat: boolean;
}

/** Stand a class on the ground and fly a list of inputs, each held for its ticks. */
function fly(cls: VehicleClass, ground: Ground, legs: [number, Partial<InputFrame>][]): Flown {
  const state = createSimState(1);
  const physics = new SimPhysics(ground, state);
  physics.spawn(state, 0, 0, 0, cls);
  for (let i = 0; i < 30; i++) stepSim(state, EMPTY_INPUT, physics);
  let path = 0;
  let turned = 0;
  let upright = 1;
  let heading = headingOf(state.vehicle);
  for (const [ticks, input] of legs) {
    const frame = { ...EMPTY_INPUT, ...input };
    for (let i = 0; i < ticks; i++) {
      const x = state.vehicle.x;
      const z = state.vehicle.z;
      stepSim(state, frame, physics);
      const v = state.vehicle;
      path += Math.hypot(v.x - x, v.z - z);
      let step = headingOf(v) - heading;
      while (step > Math.PI) step -= 2 * Math.PI;
      while (step < -Math.PI) step += 2 * Math.PI;
      turned += step;
      heading = headingOf(v);
      upright = Math.min(upright, 1 - 2 * (v.qx * v.qx + v.qz * v.qz));
    }
  }
  const v = state.vehicle;
  const spec = ROSTER[cls];
  const floor = spec.hull === undefined ? ground.heightAt(v.x, v.z) : Math.max(ground.heightAt(v.x, v.z), ground.seaLevel);
  const flown = { clearance: v.y - rideHeight(spec) - floor, path, speed: v.speed, turned, upright, afloat: v.afloat };
  physics.dispose();
  return flown;
}

describe('the aircraft of the roster', () => {
  it('gives every aircraft a flight, and a lock', () => {
    for (const cls of AIRCRAFT_CLASSES) {
      const spec = ROSTER[cls];
      expect(spec.flight, cls).toBeDefined();
      expect(spec.alarm, cls).toBe(true);
      // A plane rolls on wheels or floats; a helicopter stands on its skids.
      if (spec.flight?.kind === 'wing') expect(spec.wheels.length > 0 || spec.hull !== undefined, cls).toBe(true);
      else expect(spec.wheels.length, cls).toBe(0);
    }
    expect(AIRCRAFT_CLASSES.filter((cls) => isMilitary(cls))).toEqual(['heli-attack', 'fighter']);
  });
});

describe('flying', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('lifts a helicopter off with the climb key, holds it there, and flies it forward', () => {
    const idle = fly('heli-light', RUNWAY, [[120, { throttle: 1 }]]);
    // Nothing leaves the ground until it is asked to climb.
    expect(idle.clearance).toBeLessThan(0.3);
    expect(idle.path).toBeLessThan(1);
    const up = fly('heli-light', RUNWAY, [[180, { jump: true }], [120, {}]]);
    expect(up.clearance).toBeGreaterThan(8);
    expect(up.path).toBeLessThan(3);
    expect(up.upright).toBeGreaterThan(0.9);
    const ahead = fly('heli-light', RUNWAY, [[120, { jump: true }], [300, { throttle: 1 }]]);
    expect(ahead.path).toBeGreaterThan(60);
    expect(ahead.clearance).toBeGreaterThan(4);
    const turning = fly('heli-light', RUNWAY, [[120, { jump: true }], [180, { steer: 1 }]]);
    expect(Math.abs(turning.turned)).toBeGreaterThan(1.5);
    const down = fly('heli-light', RUNWAY, [[120, { jump: true }], [300, { sprint: true }]]);
    expect(down.clearance).toBeLessThan(0.5);
  });

  it('keeps a plane on the runway until it is fast enough, then lifts it', () => {
    // Pulling up at a standstill does nothing: a wing needs its speed.
    const slow = fly('plane-light', RUNWAY, [[120, { jump: true }]]);
    expect(slow.clearance).toBeLessThan(0.5);
    const off = fly('plane-light', RUNWAY, [[600, { throttle: 1 }], [240, { throttle: 1, jump: true }]]);
    expect(off.clearance).toBeGreaterThan(10);
    expect(off.upright).toBeGreaterThan(0.8);
    expect(off.speed).toBeGreaterThan(ROSTER['plane-light'].flight?.stall ?? 0);
  });

  it('lets a plane that loses its speed sink gently rather than fall', () => {
    const glide = fly('plane-light', RUNWAY, [[600, { throttle: 1 }], [300, { throttle: 1, jump: true }], [240, { throttle: -1 }]]);
    // Down, or on the way down, without having dropped like a stone.
    expect(glide.upright).toBeGreaterThan(0.6);
  });

  it('floats the seaplane and flies it off the water', () => {
    const afloat = fly('seaplane', SEA, [[120, {}]]);
    expect(afloat.afloat).toBe(true);
    const off = fly('seaplane', SEA, [[600, { throttle: 1 }], [240, { throttle: 1, jump: true }]]);
    expect(off.clearance).toBeGreaterThan(5);
  });

  it('flies a fighter faster than a light plane', () => {
    const legs: [number, Partial<InputFrame>][] = [[900, { throttle: 1 }], [300, { throttle: 1, jump: true }]];
    expect(fly('fighter', RUNWAY, legs).speed).toBeGreaterThan(fly('plane-light', RUNWAY, legs).speed + 10);
  });

  it('holds an aircraft under the ceiling', () => {
    const high = fly('heli-attack', RUNWAY, [[60 * 45, { jump: true }]]);
    expect(high.clearance).toBeLessThan(CEILING + 15);
    expect(high.clearance).toBeGreaterThan(CEILING - 30);
  });
});
