import type { ParkedCars, ParkedCar } from '../src/sim/parked.ts';
import { createTrafficState, type TrafficState } from '../src/sim/traffic.ts';
import { BAY_USES, type BayUse, type ParkingBays } from '../src/world/parking.ts';

/** Bays of one use in a square grid, 6 m apart. */
export function baysOf(use: BayUse, count: number): ParkingBays {
  const side = Math.ceil(Math.sqrt(count));
  const bays: ParkingBays = {
    count,
    x: new Float64Array(count),
    y: new Float64Array(count),
    height: new Float32Array(count),
    heading: new Float32Array(count),
    use: new Uint8Array(count).fill(BAY_USES.indexOf(use)),
    street: new Uint8Array(count).fill(1),
  };
  for (let i = 0; i < count; i++) {
    bays.x[i] = (i % side) * 6;
    bays.y[i] = Math.floor(i / side) * 6;
  }
  return bays;
}

/** The share of the bays that hold a car at a tick. */
export function share(cars: ParkedCars, tick: number, traffic: TrafficState = createTrafficState()): number {
  const car: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
  let full = 0;
  for (let bay = 0; bay < cars.bays.count; bay++) if (cars.carAt(bay, tick, traffic, car)) full++;
  return full / cars.bays.count;
}
