import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../../../src/sim/clock.ts';
import { callAmbulance, callTow, EmergencyServices, onCall, sounding, TOWS_OUT, UNITS_OUT, type EmergencyUnit } from '../../../src/sim/city/emergency.ts';
import { DECK_ALONG, DECK_UP, liftAt, loadPose, WINCH_DELAY, WINCH_TICKS, type LoadPose } from '../../../src/sim/city/tow-truck.ts';
import type { DistrictAt } from '../../../src/sim/police/police.ts';
import { createSimState, type SimState } from '../../../src/sim/simulation.ts';
import { stepTowing, TOW_WAIT } from '../../../src/sim/traffic/tow.ts';
import { createDamageState } from '../../../src/sim/vehicles/damage.ts';
import { createVehicleState, rideHeight, specOf } from '../../../src/sim/vehicles/vehicle.ts';
import { gridTrafficRoads } from '../../support/traffic-grid.ts';

/** The grid of `traffic-grid.ts` is the city, and every district answers at once. */
const roads = gridTrafficRoads();
const downtown: DistrictAt = () => ({ zone: 'core', wealth: 1 });

/** A session on foot in the middle of the grid, with a burnt-out shell 60 m east of the player. */
function session(): { state: SimState; service: EmergencyServices } {
  const state = createSimState(5);
  state.player.driving = false;
  state.player.x = 0;
  state.player.y = 0;
  const vehicle = createVehicleState(specOf('saloon'), 60, 0, 0, 0);
  vehicle.damage = { ...createDamageState(), stage: 'burnt', blownTick: 0, integrity: 0 };
  state.traffic.promoted.push({ id: 3, paint: 0x3f7d63, vehicle });
  state.tick = TOW_WAIT;
  return { state, service: new EmergencyServices(roads, downtown) };
}

/** Step the towing and the service the way `stepSim` does. */
function run(state: SimState, service: EmergencyServices, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    stepTowing(state);
    service.step(state);
    state.tick += 1;
  }
}

function tows(state: SimState): EmergencyUnit[] {
  return state.emergency.units.filter((unit: EmergencyUnit) => unit.kind === 'tow');
}

describe('the tow truck (spec section 20.2)', () => {
  it('drives to a wreck the player can see, lifts it onto its deck and takes it away', () => {
    const { state, service } = session();
    run(state, service, 1);
    expect(state.emergency.calls.map((call) => [call.kind, call.target])).toEqual([['tow', 3]]);
    // It comes out and drives the road graph to the shell; the shell is still on the ground.
    let truck: EmergencyUnit | undefined;
    for (let i = 0; i < 90 * TICK_RATE && truck?.load === undefined; i++) {
      run(state, service, 1);
      truck = tows(state)[0];
    }
    expect(truck?.load?.id, 'the truck never hooked the wreck').toBe(3);
    expect(state.traffic.promoted).toEqual([]);
    const hooked = truck as EmergencyUnit;
    expect(Math.hypot(hooked.x - 60, hooked.y)).toBeLessThan(15);
    // Its beacons are lit while it works; it never sounds a siren.
    expect(onCall(hooked)).toBe(true);
    expect(sounding(hooked)).toBe(false);
    // The winch brings the load up onto the deck.
    run(state, service, WINCH_DELAY + WINCH_TICKS);
    const pose: LoadPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
    loadPose(hooked, hooked.load!, state.tick, pose);
    expect(pose.y).toBeCloseTo(hooked.height + DECK_UP + rideHeight(specOf('saloon')));
    expect(Math.hypot(pose.x - hooked.x, pose.z - hooked.y)).toBeCloseTo(-DECK_ALONG);
    // And it drives off with it, and is gone once out of sight.
    run(state, service, 20 * TICK_RATE);
    expect(hooked.task).toBe('leave');
    expect(onCall(hooked)).toBe(false);
    run(state, service, 120 * TICK_RATE);
    expect(tows(state)).toEqual([]);
    expect(state.emergency.calls).toEqual([]);
  });

  it('lifts a load smoothly from where it stood', () => {
    const load = { id: 1, cls: 'saloon' as const, paint: 0, since: 100, x: 5, y: 1, z: 2, qx: 0, qy: 0, qz: 0, qw: 1 };
    expect(liftAt(load, 100)).toBe(0);
    expect(liftAt(load, 100 + WINCH_DELAY)).toBe(0);
    expect(liftAt(load, 100 + WINCH_DELAY + WINCH_TICKS)).toBe(1);
    const unit = { x: 0, y: 0, height: 0, heading: Math.PI / 2 } as EmergencyUnit;
    const pose: LoadPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
    loadPose(unit, load, 100, pose);
    expect([pose.x, pose.y, pose.z, pose.qw]).toEqual([5, 1, 2, 1]);
    let last = { ...pose };
    for (let tick = 101; tick <= 100 + WINCH_DELAY + WINCH_TICKS; tick++) {
      loadPose(unit, load, tick, pose);
      expect(Math.hypot(pose.x - last.x, pose.y - last.y, pose.z - last.z)).toBeLessThan(0.05);
      expect(Math.hypot(pose.qx, pose.qy, pose.qz, pose.qw)).toBeCloseTo(1);
      last = { ...pose };
    }
  });

  it('drives off empty when the vehicle has gone before it got there', () => {
    const { state, service } = session();
    run(state, service, 1);
    run(state, service, 5 * TICK_RATE);
    expect(tows(state)).toHaveLength(1);
    state.traffic.promoted.length = 0;
    run(state, service, 90 * TICK_RATE);
    const truck = tows(state)[0];
    expect(truck === undefined || (truck.task === 'leave' && truck.load === undefined)).toBe(true);
  });

  it('drops a call for a vehicle that has gone before any truck set out', () => {
    const { state, service } = session();
    callTow(state, 99, 30, 0);
    expect(state.emergency.calls).toHaveLength(1);
    run(state, service, 1);
    expect(state.emergency.calls.map((call) => call.target)).toEqual([3]);
  });

  it('sends its trucks on top of the engines and the ambulances, never in their place', () => {
    const { state, service } = session();
    for (let i = 0; i < 6; i++) callAmbulance(state, 100 * i - 250, 150);
    for (let i = 0; i < 3; i++) callTow(state, 3, 0, 0);
    run(state, service, 60 * TICK_RATE);
    expect(tows(state).length).toBeLessThanOrEqual(TOWS_OUT);
    expect(tows(state).length).toBeGreaterThan(0);
    expect(state.emergency.units.length - tows(state).length).toBe(UNITS_OUT);
  });
});
