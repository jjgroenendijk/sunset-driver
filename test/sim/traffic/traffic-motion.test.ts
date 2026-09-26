import { describe, expect, it } from 'vitest';
import { TICK_RATE } from '../../../src/sim/clock.ts';
import { ACCEL, plateauOf, rampTicks, stepMotion, turnSpeed, type Plateau, type StepMotion } from '../../../src/sim/traffic/traffic-motion.ts';

/**
 * The speed profile of one step of an ambient vehicle's tour
 * (`traffic-motion.ts`): it covers the step in its ticks, starts and ends at
 * the speeds asked for, and changes speed no harder than it has to.
 */
describe('traffic motion', () => {
  const plateau: Plateau = { top: 0, accel: 0 };
  const at: StepMotion = { share: 0, speed: 0 };

  /** Walk a step tick by tick: the largest change of speed a second, and the speed at its end. */
  const walk = (metres: number, ticks: number, enter: number, leave: number): { accel: number; last: number; share: number } => {
    plateauOf(metres, ticks, enter, leave, plateau);
    let accel = 0;
    let speed = stepMotion(metres, ticks, 0, enter, leave, plateau, at).speed;
    let share = 0;
    for (let i = 1; i <= ticks; i++) {
      stepMotion(metres, ticks, i, enter, leave, plateau, at);
      expect(at.share).toBeGreaterThanOrEqual(share - 1e-12);
      share = at.share;
      accel = Math.max(accel, Math.abs(at.speed - speed) * TICK_RATE);
      speed = at.speed;
    }
    return { accel, last: speed, share };
  };

  it('pulls away from rest and brakes to a halt within the ticks the timing gave the drive', () => {
    const top = 12;
    const metres = 100;
    const ticks = Math.ceil((metres / top) * TICK_RATE) + rampTicks(metres, top, 0, 0);
    const run = walk(metres, ticks, 0, 0);
    expect(stepMotion(metres, ticks, 0, 0, 0, plateau, at).speed).toBe(0);
    expect(run.share).toBeCloseTo(1, 9);
    expect(run.last).toBeLessThan(0.1);
    expect(run.accel).toBeLessThanOrEqual(ACCEL * 1.01);
    // Timed with its ramps, the drive never has to go faster than it cruises.
    expect(plateau.top).toBeLessThanOrEqual(top * 1.001);
  });

  it('slows a drive the timing stretched without stopping it on the way', () => {
    const run = walk(30, 900, 10, 0);
    expect(run.share).toBeCloseTo(1, 9);
    expect(plateau.top).toBeGreaterThan(0);
    expect(plateau.top).toBeLessThan(10);
  });

  it('changes speed harder only where the ticks leave no other way', () => {
    const run = walk(10, 30, 0, 0);
    expect(run.share).toBeCloseTo(1, 9);
    expect(run.accel).toBeGreaterThan(ACCEL);
  });

  it('takes a tighter turn slower, and a straight at any speed', () => {
    expect(turnSpeed(0, 5)).toBe(Infinity);
    expect(turnSpeed(Math.PI / 6, 5)).toBeGreaterThan(turnSpeed(Math.PI / 2, 5));
    expect(turnSpeed(Math.PI / 2, 5)).toBeLessThan(6);
    expect(turnSpeed(Math.PI, 5)).toBeGreaterThan(0);
  });
});
