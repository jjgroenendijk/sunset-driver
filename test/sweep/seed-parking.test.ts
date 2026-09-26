import { expect, it } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../src/sim/clock.ts';
import { ParkedCars, type ParkedCar } from '../../src/sim/traffic/parked.ts';
import { createTrafficState } from '../../src/sim/traffic/traffic.ts';
import { BAY_USES, buildParkingBays, type ParkingBays } from '../../src/world/city/parking.ts';
import type { WorldDescription } from '../../src/world/types.ts';
import { bayFaults } from '../support/parking-checks.ts';
import { carveOf, junctionsOf, parcelsOf, seeds, worlds } from './seed-fixture.ts';
import { FOOTPRINT_COUNT } from './seed-limits.ts';
import { sweepSuite } from './seed-suite.ts';

/** Bays of a kind a seed needs before its share at one hour is read as a share. */
const FILL_SAMPLE = 200;

/**
 * The seed sweep of spec section 3, on the parked cars of spec section 13.1:
 * the streets and the car parks of a real city carry bays, no bay stands on a
 * lane or on another bay, and the bays fill by the time of day.
 *
 * The bays need the parcels, so these run on the seeds the pool cut.
 */
sweepSuite('parking', () => {
  it('lines the streets and fills the car parks, clear of every lane, by the time of day', () => {
    let lots = 0;
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const world = worlds.get(seed) as WorldDescription;
      const parcels = parcelsOf(seed);
      const bays = buildParkingBays(world, junctionsOf(seed), parcels, carveOf(seed));
      expect(bayFaults(bays, world.roads, parcels.parcels).slice(0, 5), `seed ${seed}`).toEqual([]);
      const street = count(bays, (bay) => bays.street[bay] === 1);
      expect(street, `seed ${seed}: no street bays`).toBeGreaterThan(0);
      lots += bays.count - street;

      const cars = new ParkedCars(seed, bays);
      const day = 2 * TICKS_PER_DAY;
      const home = (bay: number): boolean => bays.street[bay] === 1 && BAY_USES[bays.use[bay] as number] === 'home';
      const away = (bay: number): boolean => !home(bay);
      for (const [name, kind, fuller, emptier] of [
        ['streets of houses', home, 3, 12],
        ['town, works, shops and car parks', away, 12, 3],
      ] as const) {
        if (count(bays, kind) < FILL_SAMPLE) continue;
        const full = share(cars, kind, day + fuller * TICKS_PER_HOUR);
        const empty = share(cars, kind, day + emptier * TICKS_PER_HOUR);
        expect(full, `seed ${seed}: ${name} at ${fuller}:00 against ${emptier}:00`).toBeGreaterThan(empty + 0.15);
      }
    }
    expect(lots, 'no car park carries a bay').toBeGreaterThan(0);
  });
});

function count(bays: ParkingBays, kind: (bay: number) => boolean): number {
  let n = 0;
  for (let bay = 0; bay < bays.count; bay++) if (kind(bay)) n++;
  return n;
}

function share(cars: ParkedCars, kind: (bay: number) => boolean, tick: number): number {
  const traffic = createTrafficState();
  const car: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
  let full = 0;
  let all = 0;
  for (let bay = 0; bay < cars.bays.count; bay++) {
    if (!kind(bay)) continue;
    all++;
    if (cars.carAt(bay, tick, traffic, car)) full++;
  }
  return full / all;
}
