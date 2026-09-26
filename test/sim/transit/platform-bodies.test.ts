import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT } from '../../../src/sim/input.ts';
import { initPhysics, SimPhysics, type Ground } from '../../../src/sim/physics/physics.ts';
import { createSimState, stepSim } from '../../../src/sim/simulation.ts';
import { specOf } from '../../../src/sim/vehicles/vehicle.ts';
import { TRAM_LANE } from '../../../src/world/roads/tiers.ts';
import { DRY } from '../../support/helpers.ts';
import { ring, ringHeight } from '../../support/tram-ring.ts';

/** Metres out from the traffic's side of the platform the car starts. */
const RUN_UP = 6;
/** Ticks of full throttle at the platform. */
const TICKS = 150;

/**
 * The island platform of a tram stop in the physics (spec section 13.2): a car
 * driven across the road at its shelter is stopped there, and never reaches
 * the track on the other side of it.
 */
describe('a tram stop in the physics', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('stops a car driven at its shelter short of the track', () => {
    const r = ring(1);
    const place = r.line.stopPlaces()[0];
    if (place === undefined) throw new Error('no stop on the ring');
    const ground: Ground = { heightAt: ringHeight, surfaceAt: () => 'asphalt', seaLevel: DRY, traffic: r.traffic, tram: r.line };
    // The stop's own frame: `x` along the platform, `z` across it, turned by the heading.
    const across = -(TRAM_LANE.platformInner + TRAM_LANE.platform / 2);
    const toWorld = (x: number, z: number): { x: number; y: number } => ({
      x: place.x + x * Math.cos(place.heading) - z * Math.sin(place.heading),
      y: place.y + x * Math.sin(place.heading) + z * Math.cos(place.heading),
    });
    const start = toWorld(0, across - TRAM_LANE.platform / 2 - RUN_UP);
    const state = createSimState(1, undefined, 0);
    const physics = new SimPhysics(ground, state);
    // Facing `+z` of the stop's frame: across the platform towards the track.
    physics.spawn(state, start.x, start.y, place.heading + Math.PI / 2);
    for (let i = 0; i < TICKS; i++) stepSim(state, { ...EMPTY_INPUT, throttle: 1 }, physics);
    const laid = physics.traffic?.trams?.platforms.count ?? 0;
    physics.dispose();
    expect(laid).toBeGreaterThan(0);
    // How far across towards the track the front of the car got: it starts on the traffic's side of the platform.
    const side = -(state.vehicle.x - place.x) * Math.sin(place.heading) + (state.vehicle.z - place.y) * Math.cos(place.heading);
    const front = side + specOf(state.vehicle.cls).halfLength;
    // Stopped at the shelter's back wall, not at the tram standing beyond it.
    expect(front).toBeLessThan(across - TRAM_LANE.platform / 2 + 0.4);
  });
});
