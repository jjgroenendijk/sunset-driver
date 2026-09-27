import { describe, expect, it } from 'vitest';
import { hypot } from '../../../src/core/libm.ts';
import { TICKS_PER_HOUR } from '../../../src/sim/clock.ts';
import { ParkedCars, type ParkedCar } from '../../../src/sim/traffic/parked.ts';
import { PULL_ACROSS, PULL_ALONG, PULL_TICKS, pullChange, pullPhase, pullPose, type ParkedPose } from '../../../src/sim/traffic/parked-pull.ts';
import { createTrafficState } from '../../../src/sim/traffic/traffic.ts';
import { baysOf } from '../../support/parked-bays.ts';

const pose = (): ParkedPose => ({ x: 0, y: 0, heading: 0, moving: false });

describe('a parked car pulling in and out (spec section 20.2)', () => {
  it('pulls in over the head of its stay, stands, and pulls out over the tail', () => {
    const stay = 2 * TICKS_PER_HOUR;
    expect(pullPhase(0, stay)).toBe(-1);
    expect(pullPhase(PULL_TICKS / 2, stay)).toBeCloseTo(-0.5);
    expect(pullPhase(PULL_TICKS, stay)).toBe(0);
    expect(pullPhase(stay - PULL_TICKS, stay)).toBe(0);
    expect(pullPhase(stay - 1, stay)).toBeGreaterThan(0.99);
    // A stay too short for both stands still.
    expect(pullPhase(0, PULL_TICKS)).toBe(0);
  });

  it('starts in the lane behind the bay and ends in the lane ahead of it', () => {
    // A bay facing +x has its lane at -y: `(sin h, -cos h)`.
    const start = pullPose(0, 0, 0, -1, pose());
    expect(start.x).toBeCloseTo(-PULL_ALONG);
    expect(start.y).toBeCloseTo(-PULL_ACROSS);
    expect(start.moving).toBe(true);
    const end = pullPose(0, 0, 0, 1 - 1e-9, pose());
    expect(end.x).toBeCloseTo(PULL_ALONG);
    expect(end.y).toBeCloseTo(-PULL_ACROSS);
    const still = pullPose(3, 4, 1, 0, pose());
    expect(still).toEqual({ x: 3, y: 4, heading: 1, moving: false });
  });

  it('moves smoothly, facing the way it goes', () => {
    for (const sign of [-1, 1]) {
      let last = pullPose(10, 20, 0.7, sign < 0 ? -1 : 1e-9, pose());
      for (let tick = 1; tick <= PULL_TICKS; tick++) {
        const phase = sign < 0 ? tick / PULL_TICKS - 1 : tick / PULL_TICKS;
        const next = pullPose(10, 20, 0.7, phase === 1 ? 1 - 1e-9 : phase, pose());
        const step = hypot(next.x - last.x, next.y - last.y);
        // Never more than a walking pace's jump between two ticks.
        expect(step).toBeLessThan(0.1);
        if (step > 1e-3) {
          const way = Math.atan2(next.y - last.y, next.x - last.x);
          expect(Math.abs(Math.atan2(Math.sin(way - next.heading), Math.cos(way - next.heading)))).toBeLessThan(0.05);
        }
        last = next;
      }
    }
  });

  it('asks again every tick while the car moves and at the pull out while it stands', () => {
    const stay = 3 * TICKS_PER_HOUR;
    expect(pullChange(0, stay)).toBe(1);
    expect(pullChange(PULL_TICKS, stay)).toBe(stay - PULL_TICKS);
    expect(pullChange(stay - PULL_TICKS, stay)).toBe(stay - PULL_TICKS + 1);
    expect(pullChange(0, PULL_TICKS)).toBe(PULL_TICKS);
  });

  it('moves a street bay car at the ends of its stay and never a car park car', () => {
    const traffic = createTrafficState();
    const car: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
    for (const street of [true, false]) {
      const bays = baysOf('town', 50);
      bays.street.fill(street ? 1 : 0);
      const cars = new ParkedCars(9, bays);
      let seen = 0;
      for (let bay = 0; bay < bays.count; bay++) {
        const tick = 10 * TICKS_PER_HOUR;
        if (!cars.carAt(bay, tick, traffic, car)) continue;
        const end = cars.stayEnd(bay, tick);
        expect(cars.poseAt(bay, car.since, pose()).moving).toBe(street);
        expect(cars.poseAt(bay, car.since + PULL_TICKS, pose()).moving).toBe(false);
        expect(cars.poseAt(bay, end - 1, pose()).moving).toBe(street);
        expect(cars.changeAt(bay, car.since + PULL_TICKS)).toBe(street ? end - PULL_TICKS : end);
        seen++;
      }
      expect(seen).toBeGreaterThan(0);
    }
  });
});
