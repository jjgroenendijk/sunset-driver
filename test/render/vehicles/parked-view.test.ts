import type { InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { ParkedView } from '../../../src/render/vehicles/parked.ts';
import { TICKS_PER_HOUR } from '../../../src/sim/clock.ts';
import { PARKED_ID, ParkedCars, type ParkedCar } from '../../../src/sim/traffic/parked.ts';
import { PULL_TICKS } from '../../../src/sim/traffic/parked-pull.ts';
import { createSimState } from '../../../src/sim/simulation.ts';
import { createVehicleState, specOf } from '../../../src/sim/vehicles/vehicle.ts';
import { baysOf, share } from '../../support/parked-bays.ts';

const at = (hour: number): number => 3 * 24 * TICKS_PER_HOUR + hour * TICKS_PER_HOUR;

describe('the parked cars, drawn (spec section 13.1)', () => {
  it('holds the paint of every class before its first car, so the warm-up compiles it', () => {
    // The warm-up draws each empty pool once; a program built without instance colours draws white.
    const view = new ParkedView(new ParkedCars(9, baysOf('home', 40)));
    const pools = view.group.children as InstancedMesh[];
    // Each class is its paint, its trim and its glass, in that order.
    for (let i = 0; i < pools.length; i += 3) {
      const paint = pools[i] as InstancedMesh;
      expect(paint.instanceColor?.count).toBe(paint.instanceMatrix.count);
    }
  });

  it('draws one instance per car in view, and writes nothing again until something changes', () => {
    // Car park bays: a car in a street bay moves as it pulls in or out.
    const bays = baysOf('home', 400);
    bays.street.fill(0);
    const cars = new ParkedCars(9, bays);
    const view = new ParkedView(cars);
    const state = createSimState(9, undefined, 0);
    state.tick = at(1);
    view.update(state, 30, 30);
    const full = share(cars, state.tick);
    expect(view.drawn).toBe(Math.round(full * 400));
    expect(view.drawn).toBeGreaterThan(0);
    // A frame a few ticks on and a metre over uploads nothing.
    const versions = (): number[] => view.group.children.map((mesh) => (mesh as InstancedMesh).instanceMatrix.version);
    const before = versions();
    state.tick += 5;
    view.update(state, 31, 30);
    expect(versions()).toEqual(before);
    // A car taken is gone from the view on the next frame.
    const car: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
    let bay = 0;
    while (!cars.carAt(bay, state.tick, state.traffic, car)) bay++;
    state.traffic.promoted.push({ id: PARKED_ID + bay, paint: car.paint, vehicle: createVehicleState(specOf(car.cls), 0, 0, 0, 0) });
    view.update(state, 30, 30);
    expect(view.drawn).toBe(Math.round(full * 400) - 1);
    view.dispose();
  });

  it('moves a car pulling out of a street bay on every tick, and only then', () => {
    const cars = new ParkedCars(4, baysOf('town', 1));
    const view = new ParkedView(cars);
    const state = createSimState(4, undefined, 0);
    const car: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
    let tick = at(12);
    while (!cars.carAt(0, tick, state.traffic, car)) tick = cars.stayEnd(0, tick);
    const pullOut = cars.changeAt(0, car.since + PULL_TICKS);
    const place = (): number[] => {
      const pool = view.group.children.find((mesh) => (mesh as InstancedMesh).count > 0) as InstancedMesh;
      return [pool.instanceMatrix.array[12] as number, pool.instanceMatrix.array[14] as number];
    };
    state.tick = pullOut - 2;
    view.update(state, 0, 0);
    const standing = place();
    expect(standing).toEqual([cars.bays.x[0], cars.bays.y[0]]);
    state.tick = pullOut - 1;
    view.update(state, 0, 0);
    expect(place()).toEqual(standing);
    for (const ahead of [10, 60, 120]) {
      state.tick = pullOut + ahead;
      view.update(state, 0, 0);
      const pose = cars.poseAt(0, state.tick, { x: 0, y: 0, heading: 0, moving: false });
      expect(place()[0]).toBeCloseTo(pose.x, 4);
      expect(place()[1]).toBeCloseTo(pose.y, 4);
    }
    expect(place()).not.toEqual(standing);
    view.dispose();
  });
});
