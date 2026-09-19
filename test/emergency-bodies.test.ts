import { beforeAll, describe, expect, it } from 'vitest';
import { UNIT_BODY, type EmergencyUnit } from '../src/sim/emergency.ts';
import { initPhysics, type Ground } from '../src/sim/physics.ts';
import { DRY } from './helpers.ts';
import { drive, start } from './sim-harness.ts';

/**
 * The fire engines and ambulances of spec section 20.3 as bodies: a unit
 * standing in the road is something the player's car hits, not a picture it
 * drives through.
 */
describe('the emergency services as bodies (spec section 20.3)', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  const flat: Ground = { heightAt: () => 0, surfaceAt: () => 'asphalt', seaLevel: DRY };

  /** An ambulance standing still across the road at a place, as the record would carry it. */
  function standing(x: number): EmergencyUnit {
    return {
      id: 0, kind: 'ambulance', task: 'work', call: 0, x, y: 0, heading: Math.PI / 2, height: 0, speed: 0,
      edges: [], distance: 0, stop: 0, planned: 0, goalX: x, goalY: 0, homeX: x, homeY: 0, until: -1,
    };
  }

  it('stops a car driven into an ambulance standing across the road', () => {
    const session = start(flat);
    const { state, physics } = session;
    const at = 14;
    state.emergency.units.push(standing(at));
    physics.spawn(state, 0, 0, 0);
    state.vehicle.vx = 18;
    physics.adopt(state);
    drive(session, 90);
    // The car is stopped on the near side of the ambulance, dented by it.
    expect(state.vehicle.x).toBeLessThan(at - UNIT_BODY.ambulance.halfWidth);
    expect(state.vehicle.damage.integrity).toBeLessThan(1);
    physics.dispose();
  });

  it('lets the same car through once the ambulance has gone', () => {
    const session = start(flat);
    const { state, physics } = session;
    physics.spawn(state, 0, 0, 0);
    state.vehicle.vx = 18;
    physics.adopt(state);
    drive(session, 90);
    expect(state.vehicle.x).toBeGreaterThan(14 + UNIT_BODY.ambulance.halfWidth);
    physics.dispose();
  });
});
