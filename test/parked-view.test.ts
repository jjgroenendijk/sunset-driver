import type { InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import { ParkedView } from '../src/render/parked.ts';
import { TICKS_PER_HOUR } from '../src/sim/clock.ts';
import { PARKED_ID, ParkedCars, type ParkedCar } from '../src/sim/parked.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { createVehicleState, specOf } from '../src/sim/vehicle.ts';
import { baysOf, share } from './parked-bays.ts';

const at = (hour: number): number => 3 * 24 * TICKS_PER_HOUR + hour * TICKS_PER_HOUR;

describe('the parked cars, drawn (spec section 13.1)', () => {
  it('holds the paint of every class before its first car, so the warm-up compiles it', () => {
    // The warm-up draws each empty pool once; a program built without instance colours draws white.
    const view = new ParkedView(new ParkedCars(9, baysOf('home', 40)));
    const pools = view.group.children as InstancedMesh[];
    for (let i = 0; i < pools.length; i += 3) {
      const paint = pools[i] as InstancedMesh;
      expect(paint.instanceColor?.count).toBe(paint.instanceMatrix.count);
    }
  });

  it('draws one instance per car in view, and writes nothing again until something changes', () => {
    const cars = new ParkedCars(9, baysOf('home', 400));
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
});
