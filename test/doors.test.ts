import { describe, expect, it } from 'vitest';
import { AJAR_DENT, damageVehicle, PANELS } from '../src/sim/damage.ts';
import { AJAR, LEAF_TICKS, leafTarget, stepDoors, stepLeaves } from '../src/sim/doors.ts';
import { EMPTY_INPUT } from '../src/sim/input.ts';
import { BONNET_LEAF } from '../src/sim/leaves.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { createVehicleState, specOf } from '../src/sim/vehicle.ts';

/** The doors and the bonnet of spec section 11.3, as the record carries them. */
describe('the leaves of a vehicle', () => {
  it('swings a wanted leaf open over its ticks, and shut again', () => {
    const v = createVehicleState(specOf('saloon'));
    v.leaves.want[0] = true;
    for (let i = 0; i < LEAF_TICKS / 2; i++) stepLeaves(v);
    expect(v.leaves.open[0]).toBeCloseTo(0.5, 6);
    for (let i = 0; i < LEAF_TICKS; i++) stepLeaves(v);
    expect(v.leaves.open[0]).toBe(1);
    v.leaves.want[0] = false;
    for (let i = 0; i < LEAF_TICKS; i++) stepLeaves(v);
    expect(v.leaves.open[0]).toBe(0);
    // Nothing else moved.
    expect(v.leaves.open.filter((open) => open !== 0)).toEqual([]);
  });

  it('lifts the bonnet on the key, once a press, from the seat or beside the car', () => {
    const state = createSimState(7, undefined, 0);
    const press = { ...EMPTY_INPUT, bonnet: true };
    state.player.driving = true;
    stepDoors(state, press, false);
    // Held down, the key does not toggle it back.
    stepDoors(state, press, false);
    expect(state.vehicle.leaves.want[BONNET_LEAF]).toBe(true);
    stepDoors(state, EMPTY_INPUT, false);
    stepDoors(state, press, false);
    expect(state.vehicle.leaves.want[BONNET_LEAF]).toBe(false);
    // On foot and far off, the key reaches nothing.
    state.player.driving = false;
    state.player.x = state.vehicle.x + 30;
    stepDoors(state, EMPTY_INPUT, false);
    stepDoors(state, press, false);
    expect(state.vehicle.leaves.want[BONNET_LEAF]).toBe(false);
  });

  it('has the bonnet up for as long as the player is in a workshop', () => {
    const v = createVehicleState(specOf('saloon'));
    expect(leafTarget(v, BONNET_LEAF, true)).toBe(1);
    expect(leafTarget(v, BONNET_LEAF, false)).toBe(0);
    expect(leafTarget(v, 0, true)).toBe(0);
  });

  it('springs the panel a hard hit lands on, before it tears it off', () => {
    const v = createVehicleState(specOf('saloon'));
    const front = PANELS.indexOf('front');
    // A blow on the nose pushes the vehicle back.
    damageVehicle(v.damage, (AJAR_DENT / 1.7) * 1.05, -1, 0, 0, 7, 100);
    expect(v.damage.dents[front]).toBeGreaterThanOrEqual(AJAR_DENT);
    expect(v.damage.lost[front]).toBe(false);
    expect(v.damage.ajar[front]).toBe(true);
    expect(leafTarget(v, BONNET_LEAF)).toBe(AJAR);
    // A sprung driver's door hangs open on the driver's flank only.
    v.damage.ajar[PANELS.indexOf('right')] = true;
    expect(leafTarget(v, 0)).toBe(AJAR);
    expect(leafTarget(v, 1)).toBe(0);
    expect(leafTarget(v, 2)).toBe(0);
  });
});
