/**
 * The parked cars near the player, as Rapier bodies (spec sections 5.3, 13.1).
 *
 * Inside the box of ground the physics holds, each bay that holds a car
 * carries a fixed body the shape of that car. A bay is only asked again when
 * its stay ends, so a tick costs a look at the bays whose stay has just
 * turned over and nothing for the rest. `traffic-bodies.ts` owns this and
 * promotes a car the player touches, the way it promotes the traffic.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { ParkedCar, ParkedCars } from './parked.ts';
import type { SimState } from './simulation.ts';
import { footprintsTouch, type Footprint } from './traffic.ts';
import { rideHeight, specOf, type VehicleSpec } from './vehicle.ts';

/** A bay in the box: the car it holds, if any, and the tick it has to be asked again on. */
interface Bay {
  bay: number;
  until: number;
  car: ParkedCar | undefined;
  spec: VehicleSpec | undefined;
  body: RAPIER.RigidBody | undefined;
}

/** Metres beyond which a footprint cannot touch a car, whatever the two are turned to. */
const NEAR = 12;

export class ParkedBodies {
  readonly cars: ParkedCars;
  private readonly world: RAPIER.World;
  /** Ascending by bay. */
  private bays: Bay[] = [];
  private readonly ids: number[] = [];
  private readonly box = { minX: NaN, minY: NaN, maxX: NaN, maxY: NaN };
  private readonly theirs: Footprint = { x: 0, y: 0, heading: 0, halfLength: 0, halfWidth: 0 };

  constructor(world: RAPIER.World, cars: ParkedCars) {
    this.world = world;
    this.cars = cars;
  }

  /** How many parked cars have a body in the world. */
  get count(): number {
    let count = 0;
    for (const entry of this.bays) if (entry.body !== undefined) count++;
    return count;
  }

  /** True where a body standing in the world is one of these parked cars. */
  holds(body: number): boolean {
    return this.bays.some((entry) => entry.body?.handle === body);
  }

  /** Before the world is stepped: stand a body in every bay of the box that holds a car on this tick. */
  lead(state: SimState, minX: number, minY: number, maxX: number, maxY: number): void {
    const box = this.box;
    if (box.minX !== minX || box.minY !== minY || box.maxX !== maxX || box.maxY !== maxY) {
      Object.assign(box, { minX, minY, maxX, maxY });
      const kept: Bay[] = [];
      let k = 0;
      for (const bay of this.cars.near(minX, minY, maxX, maxY, this.ids)) {
        while (k < this.bays.length && (this.bays[k] as Bay).bay < bay) this.drop(this.bays[k++] as Bay);
        const known = this.bays[k]?.bay === bay ? (this.bays[k++] as Bay) : undefined;
        kept.push(known ?? { bay, until: -Infinity, car: undefined, spec: undefined, body: undefined });
      }
      while (k < this.bays.length) this.drop(this.bays[k++] as Bay);
      this.bays = kept;
    }
    for (const entry of this.bays) {
      if (state.tick < entry.until && state.tick >= (entry.car?.since ?? -Infinity)) continue;
      const car: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
      const held = this.cars.carAt(entry.bay, state.tick, state.traffic, car);
      entry.until = this.cars.stayEnd(entry.bay, state.tick);
      if (held && entry.car?.since === car.since && entry.body !== undefined) continue;
      this.drop(entry);
      if (held) this.stand(entry, car);
    }
  }

  /**
   * After the world is stepped: take every car the footprints touch out of its
   * bay, and hand it to `promote`. The bay stays empty while the record lasts.
   */
  touched(
    car: Footprint,
    walker: Footprint | undefined,
    margin: number,
    promote: (bay: number, parked: ParkedCar, spec: VehicleSpec) => void,
  ): void {
    const bays = this.cars.bays;
    for (const entry of this.bays) {
      if (entry.body === undefined) continue;
      const x = bays.x[entry.bay] as number;
      const y = bays.y[entry.bay] as number;
      const spec = entry.spec as VehicleSpec;
      const theirs = this.theirs;
      theirs.x = x;
      theirs.y = y;
      theirs.heading = bays.heading[entry.bay] as number;
      theirs.halfLength = spec.halfLength;
      theirs.halfWidth = spec.halfWidth;
      const byCar = Math.hypot(car.x - x, car.y - y) < NEAR && footprintsTouch(car, theirs, margin);
      const byWalker = walker !== undefined && Math.hypot(walker.x - x, walker.y - y) < NEAR && footprintsTouch(walker, theirs, margin);
      if (!byCar && !byWalker) continue;
      const parked = entry.car as ParkedCar;
      this.drop(entry);
      entry.until = Infinity;
      promote(entry.bay, parked, spec);
    }
  }

  private stand(entry: Bay, car: ParkedCar): void {
    const bays = this.cars.bays;
    const spec = specOf(car.cls);
    const heading = bays.heading[entry.bay] as number;
    // A yaw of minus the heading points local +x along the map heading.
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(bays.x[entry.bay] as number, (bays.height[entry.bay] as number) + rideHeight(spec), bays.y[entry.bay] as number)
        .setRotation({ x: 0, y: Math.sin(-heading / 2), z: 0, w: Math.cos(-heading / 2) }),
    );
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(spec.halfLength, spec.halfHeight, spec.halfWidth), body);
    entry.car = car;
    entry.spec = spec;
    entry.body = body;
  }

  private drop(entry: Bay): void {
    if (entry.body !== undefined) this.world.removeRigidBody(entry.body);
    entry.body = undefined;
    entry.car = undefined;
    entry.spec = undefined;
  }
}
