import { describe, expect, it } from 'vitest';
import { Suspension, type Lean } from '../src/render/suspension.ts';

/** A car of the traffic on its springs (`suspension.ts`), driven along x at 60 frames a second. */
describe('suspension', () => {
  const lean: Lean = { pitch: 0, roll: 0 };

  it('dips the nose under braking, and rocks back past level once it has stopped', () => {
    const springs = new Suspension();
    let x = 0;
    let speed = 12;
    let least = 0;
    let most = 0;
    for (let tick = 0; tick < 600; tick++) {
      springs.begin();
      speed = Math.max(0, speed - 3 / 60);
      x += speed / 60;
      springs.lean(1, tick, x, 0, 0, 12, false, lean);
      springs.end();
      if (speed > 0) least = Math.min(least, lean.pitch);
      else most = Math.max(most, lean.pitch);
    }
    expect(least).toBeLessThan(-0.02);
    expect(most).toBeGreaterThan(0.002);
    expect(Math.abs(lean.pitch)).toBeLessThan(1e-3);
  });

  it('leans a car out of a turn and a bike into it', () => {
    const car = new Suspension();
    const bike = new Suspension();
    const bikeLean: Lean = { pitch: 0, roll: 0 };
    // A turn to the right hand, at 8 m/s round a 20 m circle.
    for (let tick = 0; tick < 240; tick++) {
      const heading = (8 / 20) * (tick / 60);
      const x = 20 * Math.sin(heading);
      const y = 20 - 20 * Math.cos(heading);
      car.lean(1, tick, x, y, heading, 8, false, lean);
      bike.lean(1, tick, x, y, heading, 8, true, bikeLean);
    }
    expect(lean.roll).toBeLessThan(-0.02);
    expect(bikeLean.roll).toBeGreaterThan(0.2);
    expect(bikeLean.pitch).toBeCloseTo(0, 6);
  });
});
