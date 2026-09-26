/**
 * The pose a frame is drawn at, between two ticks (`src/render/frame/smooth.ts`).
 *
 * What is pinned here is that a frame drawn part way through a step stands
 * part way between the two ticks, and that nothing but the pose is changed:
 * the class and the damage the model reads are the record's own.
 */
import { describe, expect, it } from 'vitest';
import { lerpAngle, RenderSmoother } from '../../../src/render/frame/smooth.ts';
import { createSimState, type SimState } from '../../../src/sim/simulation.ts';

/** Put the record somewhere: a step of the simulation, without the physics. */
function place(state: SimState, x: number, heading: number): void {
  state.player.x = x;
  state.player.y = x * 2;
  state.player.height = x / 2;
  state.player.heading = heading;
  state.player.speed = x;
  state.vehicle.x = x;
  state.vehicle.y = x / 2;
  state.vehicle.z = x * 2;
  for (const wheel of state.vehicle.wheels) {
    wheel.rotation = x;
    wheel.steer = x / 10;
    wheel.suspension = 0.3 + x / 100;
  }
}

describe('lerpAngle', () => {
  it('turns the short way round', () => {
    // 3 rad to -3 rad is a turn of 0.28 rad across PI, not one of 6 rad back
    // through zero, so the half way point is PI itself.
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 9);
  });

  it('is the plain blend well inside a turn', () => {
    expect(lerpAngle(0.2, 0.8, 0.5)).toBeCloseTo(0.5, 9);
  });
});

describe('RenderSmoother', () => {
  it('draws the record itself before a step has been taken', () => {
    const state = createSimState(1);
    place(state, 7, 0.4);
    const smooth = new RenderSmoother();
    expect(smooth.playerAt(state, 0.5).x).toBe(7);
    expect(smooth.vehicleAt(state, 0.5)).toBe(state.vehicle);
  });

  it('draws the player part way between the last two ticks', () => {
    const state = createSimState(1);
    const smooth = new RenderSmoother();
    place(state, 10, 0);
    smooth.capture(state);
    place(state, 20, 1);
    const drawn = smooth.playerAt(state, 0.25);
    expect(drawn.x).toBeCloseTo(12.5, 9);
    expect(drawn.y).toBeCloseTo(25, 9);
    expect(drawn.height).toBeCloseTo(6.25, 9);
    expect(drawn.heading).toBeCloseTo(0.25, 9);
    expect(drawn.speed).toBeCloseTo(12.5, 9);
  });

  it('lands on the newer tick at the end of a step and the older at the start', () => {
    const state = createSimState(2);
    const smooth = new RenderSmoother();
    place(state, 4, 0);
    smooth.capture(state);
    place(state, 6, 0);
    expect(smooth.playerAt(state, 0).x).toBeCloseTo(4, 9);
    expect(smooth.playerAt(state, 1).x).toBeCloseTo(6, 9);
  });

  it('blends the vehicle pose and keeps the rest of the record', () => {
    const state = createSimState(3);
    const smooth = new RenderSmoother();
    place(state, 0, 0);
    smooth.capture(state);
    place(state, 8, 0);
    const drawn = smooth.vehicleAt(state, 0.5);
    expect(drawn.x).toBeCloseTo(4, 9);
    expect(drawn.y).toBeCloseTo(2, 9);
    expect(drawn.z).toBeCloseTo(8, 9);
    expect(drawn.cls).toBe(state.vehicle.cls);
    expect(drawn.damage).toBe(state.vehicle.damage);
    expect(drawn.wheels).toHaveLength(state.vehicle.wheels.length);
    expect(drawn.wheels[0]?.suspension).toBeCloseTo(0.34, 9);
    expect(drawn.wheels[0]?.steer).toBeCloseTo(0.4, 9);
  });

  it('answers a unit quaternion between two orientations', () => {
    const state = createSimState(4);
    const smooth = new RenderSmoother();
    state.vehicle.qx = 0;
    state.vehicle.qy = 0;
    state.vehicle.qz = 0;
    state.vehicle.qw = 1;
    smooth.capture(state);
    const half = Math.SQRT1_2;
    state.vehicle.qy = half;
    state.vehicle.qw = half;
    const drawn = smooth.vehicleAt(state, 0.5);
    expect(Math.hypot(drawn.qx, drawn.qy, drawn.qz, drawn.qw)).toBeCloseTo(1, 9);
    expect(drawn.qy).toBeGreaterThan(0);
    expect(drawn.qy).toBeLessThan(half);
  });

  it('writes into one scratch record rather than allocating a pose a frame', () => {
    const state = createSimState(5);
    const smooth = new RenderSmoother();
    smooth.capture(state);
    expect(smooth.vehicleAt(state, 0.5)).toBe(smooth.vehicleAt(state, 0.75));
  });

  it('draws the record itself again after a reset', () => {
    const state = createSimState(6);
    const smooth = new RenderSmoother();
    place(state, 1, 0);
    smooth.capture(state);
    place(state, 100, 0);
    smooth.reset();
    expect(smooth.playerAt(state, 0.5).x).toBe(100);
  });
});
