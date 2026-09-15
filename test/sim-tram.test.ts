import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT } from '../src/sim/input.ts';
import { initPhysics, SimPhysics, type Ground } from '../src/sim/physics.ts';
import { createSimState, stepSim, type SimState } from '../src/sim/simulation.ts';
import type { AmbientPose } from '../src/sim/traffic.ts';
import { TRAM_CARS } from '../src/sim/tram.ts';
import { DRY, stableJson } from './helpers.ts';
import { RING, ring, ringHeight, type Ring } from './tram-ring.ts';

/** Ticks the car stands in the tram's way before it arrives. */
const LEAD = 90;
/** Ticks the run lasts: the tram reaches the car and carries on past it. */
const RUN = 240;

/**
 * The tram of spec section 13.2 in the simulation, on the ring of
 * `tram-ring.ts`: a car left standing on the track is struck and shoved aside,
 * and the run replays to the same record.
 */
describe('the tram in the simulation', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  const ground = (r: Ring): Ground => ({ heightAt: ringHeight, surfaceAt: () => 'asphalt', seaLevel: DRY, traffic: r.traffic, tram: r.line });

  /** A tick on which the first tram's front drives down a side of the ring, clear of corners and crossings. */
  const driving = (r: Ring): { tick: number; at: AmbientPose } => {
    const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    for (let tick = 0; tick < (r.line.tour?.period ?? 0); tick += 7) {
      const at = r.line.carPose(0, 0, tick + LEAD, pose);
      const across = Math.min(Math.abs(at.x), Math.abs(at.y));
      if (at.speed < 8 || across < 60 || across > RING - 60) continue;
      if (r.line.carPose(0, 0, tick + LEAD - 30, { ...pose }).speed < 8) continue;
      return { tick, at: { ...at } };
    }
    throw new Error('the tram never drives down a side');
  };

  const run = (): { state: SimState; moved: number; bodies: number } => {
    const r = ring(1);
    const { tick, at } = driving(r);
    const state = createSimState(1, undefined, tick);
    const physics = new SimPhysics(ground(r), state);
    // Across the track, where the front of the tram will be.
    physics.spawn(state, at.x, at.y, at.heading + Math.PI / 2);
    const x = state.vehicle.x;
    const z = state.vehicle.z;
    let bodies = 0;
    for (let i = 0; i < RUN; i++) {
      stepSim(state, EMPTY_INPUT, physics);
      bodies = Math.max(bodies, physics.traffic?.trams?.count ?? 0);
    }
    physics.dispose();
    return { state, moved: Math.hypot(state.vehicle.x - x, state.vehicle.z - z), bodies };
  };

  it('stands its cars in the world as solids that shove a car off the track', () => {
    const { moved, bodies, state } = run();
    expect(bodies).toBeGreaterThan(0);
    expect(bodies).toBeLessThanOrEqual(TRAM_CARS * 8);
    // A car left alone on its springs moves by centimetres; one hit by a tram by metres.
    expect(moved).toBeGreaterThan(2);
    expect(state.vehicle.damage.integrity).toBeLessThan(1);
  });

  it('replays the same run to the same record', () => {
    expect(stableJson(run().state)).toBe(stableJson(run().state));
  });
});
