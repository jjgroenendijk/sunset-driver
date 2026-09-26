import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../../src/sim/clock.ts';
import { fillAt, PARKED_ID, PARKED_MIX, ParkedCars, type ParkedCar } from '../../../src/sim/traffic/parked.ts';
import { createTrafficState } from '../../../src/sim/traffic/traffic.ts';
import { createVehicleState, specOf, type VehicleClass } from '../../../src/sim/vehicles/vehicle.ts';
import { BAY_USES, LOT_BAY_LENGTH, LOT_BAY_WIDTH, STREET_BAY_LENGTH, type BayUse } from '../../../src/world/city/parking.ts';
import { TIERS } from '../../../src/world/roads/tiers.ts';
import { baysOf, share } from '../../support/parked-bays.ts';

const DAY = 3 * TICKS_PER_DAY;
const at = (hour: number): number => DAY + hour * TICKS_PER_HOUR;

describe('parked cars (spec section 13.1)', () => {
  it('fills the streets of houses by night and the works, the shops and the town by day', () => {
    const cars = (use: BayUse): ParkedCars => new ParkedCars(7, baysOf(use, 1600));
    const home = cars('home');
    expect(share(home, at(3))).toBeGreaterThan(share(home, at(12)) + 0.25);
    for (const use of ['town', 'work', 'shops', 'leisure'] as const) {
      const place = cars(use);
      expect(share(place, at(12)), use).toBeGreaterThan(share(place, at(3)) + 0.25);
    }
    // What is measured follows the table it is drawn from.
    for (const use of BAY_USES) {
      for (const hour of [3, 12, 18]) expect(Math.abs(share(cars(use), at(hour)) - fillAt(use, at(hour))), `${use} at ${hour}`).toBeLessThan(0.12);
    }
  });

  it('keeps the same car in a bay for its whole stay, and agrees with itself', () => {
    const bays = baysOf('town', 200);
    const a = new ParkedCars(11, bays);
    const b = new ParkedCars(11, bays);
    const traffic = createTrafficState();
    const one: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
    const two: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
    let changes = 0;
    for (let bay = 0; bay < bays.count; bay++) {
      const tick = at(10) + bay * 97;
      const end = a.stayEnd(bay, tick);
      expect(end).toBeGreaterThan(tick);
      const held = a.carAt(bay, tick, traffic, one);
      expect(b.carAt(bay, tick, traffic, two)).toBe(held);
      expect(a.carAt(bay, end - 1, traffic, two)).toBe(held);
      if (held) expect(two).toEqual(one);
      if (held !== a.carAt(bay, end, traffic, two) || (held && two.since !== one.since)) changes++;
      expect(a.stayEnd(bay, end)).toBeGreaterThan(end);
    }
    expect(changes).toBeGreaterThan(0);
  });

  it('empties the bay of a car the player has taken', () => {
    const bays = baysOf('home', 100);
    const cars = new ParkedCars(3, bays);
    const traffic = createTrafficState();
    const car: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
    const tick = at(2);
    let bay = 0;
    while (!cars.carAt(bay, tick, traffic, car)) bay++;
    traffic.promoted.push({ id: PARKED_ID + bay, paint: car.paint, vehicle: createVehicleState(specOf(car.cls), 0, 0, 0, 0) });
    expect(cars.carAt(bay, tick, traffic, car)).toBe(false);
    expect(cars.carAt(bay, tick + 10 * TICKS_PER_DAY, traffic, car)).toBe(false);
  });

  it('finds exactly the bays inside a box', () => {
    const cars = new ParkedCars(5, baysOf('work', 900));
    const found = cars.near(20, 40, 95, 130, []);
    const expected: number[] = [];
    for (let bay = 0; bay < 900; bay++) {
      const x = cars.bays.x[bay] as number;
      const y = cars.bays.y[bay] as number;
      if (x >= 20 && x <= 95 && y >= 40 && y <= 130) expected.push(bay);
    }
    expect(found).toEqual(expected);
  });

  it('fits every class a place parks inside its bays', () => {
    const fits = (cls: VehicleClass): boolean => {
      const spec = specOf(cls);
      const street = spec.halfLength <= STREET_BAY_LENGTH / 2 && spec.halfWidth <= TIERS.street.parking / 2;
      const lot = spec.halfLength <= LOT_BAY_LENGTH / 2 && spec.halfWidth <= LOT_BAY_WIDTH / 2;
      return street && lot;
    };
    for (const use of BAY_USES) {
      for (const cls of Object.keys(PARKED_MIX[use]) as VehicleClass[]) expect(fits(cls), `${cls} at ${use}`).toBe(true);
    }
  });
});
