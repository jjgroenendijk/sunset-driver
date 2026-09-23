import { describe, expect, it } from 'vitest';
import { vehicleAction } from '../src/sim/interact.ts';
import { EXIT_SPEED } from '../src/sim/on-foot.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import { createVehicleState, specOf, type VehicleClass } from '../src/sim/vehicle.ts';

/** A session with the player on foot at `x` along the street, the own car standing at the origin. */
function onFoot(x: number, cls: VehicleClass = 'compact'): SimState {
  const state = createSimState(1);
  state.vehicle = createVehicleState(specOf(cls));
  state.vehicle.hotwired = false;
  state.player.driving = false;
  state.player.x = x;
  state.player.y = specOf(cls).halfWidth + 0.5;
  return state;
}

/** The prompt of spec sections 11.2 and 11.4: what the interact key would do to a vehicle. */
describe('vehicleAction', () => {
  it('offers to get in beside an open car, and nothing out of reach of it', () => {
    expect(vehicleAction(onFoot(0))).toBe('get in');
    expect(vehicleAction(onFoot(30))).toBeNull();
  });

  it('names the saddle of a motorcycle and the deck of a boat', () => {
    expect(vehicleAction(onFoot(0, 'motorcycle'))).toBe('get on');
    const boat = onFoot(0, 'boat');
    boat.vehicle.hotwired = true;
    expect(vehicleAction(boat)).toBe('board');
  });

  it('offers the lock of a car worth stealing, and the door once it is beaten', () => {
    const state = onFoot(0, 'sports');
    expect(vehicleAction(state)).toBe('hotwire');
    state.vehicle.hotwired = true;
    expect(vehicleAction(state)).toBe('get in');
  });

  it('offers to get out only at a crawl', () => {
    const state = createSimState(1);
    expect(vehicleAction(state)).toBe('get out');
    state.vehicle.speed = EXIT_SPEED + 1;
    expect(vehicleAction(state)).toBeNull();
  });

  it('offers a promoted car of the city in reach', () => {
    const state = onFoot(30);
    state.traffic.promoted.push({ id: 7, paint: 0, vehicle: createVehicleState(specOf('compact'), 30, 0) });
    expect(vehicleAction(state)).toBe('get in');
  });

  it('offers nothing while something else holds the key', () => {
    const state = onFoot(0);
    state.shop = { shop: 0, started: 0, said: '' };
    expect(vehicleAction(state)).toBeNull();
    state.shop = null;
    state.police.surrendered = true;
    expect(vehicleAction(state)).toBeNull();
  });
});
