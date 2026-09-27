/**
 * The parked cars near the player, as Rapier bodies (spec sections 5.3, 13.1).
 *
 * Inside the box of ground the physics holds, each bay that holds a car
 * carries a kinematic body the shape of that car. A bay is only asked again
 * when its stay ends or its car pulls in or out, so a tick costs a look at the
 * bays whose car is moving or whose stay has just turned over, and nothing for
 * the rest. A car standing in its bay never moves its body. `traffic-bodies.ts` owns this and
 * promotes a car the player touches, the way it promotes the traffic.
 */
import { cos, hypot, sin } from '../../core/libm.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import type { ParkedCar, ParkedCars } from './parked.ts';
import type { ParkedPose } from './parked-pull.ts';
import type { SimState } from '../simulation.ts';
import { footprintsTouch, type Footprint } from './traffic.ts';
import { rideHeight, specOf, type VehicleSpec } from '../vehicles/vehicle.ts';

/** A bay in the box: the car it holds, if any, and the tick it has to be asked again on. */
interface Bay {
  bay: number;
  until: number;
  /** Where the car stands on this tick: in the bay, or pulling in or out of it. */
  pose: ParkedPose;
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

  /** Before the world is stepped: stand a body in every bay of the box that holds a car on this tick. */
  lead(state: SimState, minX: number, minY: number, maxX: number, maxY: number): void {
    const box = this.box;
    if (box.minX !== minX || box.minY !== minY || box.maxX !== maxX || box.maxY !== maxY) {
      Object.assign(box, { minX, minY, maxX, maxY });
      this.rebox(minX, minY, maxX, maxY);
    }
    for (const entry of this.bays) this.refresh(state, entry);
  }

  /** Keep the bays still in the new box, drop the bodies of those that left it, and add the new ones empty. */
  private rebox(minX: number, minY: number, maxX: number, maxY: number): void {
    const kept: Bay[] = [];
    let k = 0;
    for (const bay of this.cars.near(minX, minY, maxX, maxY, this.ids)) {
      while (k < this.bays.length && (this.bays[k] as Bay).bay < bay) this.drop(this.bays[k++] as Bay);
      const known = this.bays[k]?.bay === bay ? (this.bays[k++] as Bay) : undefined;
      kept.push(known ?? { bay, until: -Infinity, pose: { x: 0, y: 0, heading: 0, moving: false }, car: undefined, spec: undefined, body: undefined });
    }
    while (k < this.bays.length) this.drop(this.bays[k++] as Bay);
    this.bays = kept;
  }

  /**
   * Ask one bay again when its stay has turned over or its car moves, and
   * stand, move or drop its body to match.
   */
  private refresh(state: SimState, entry: Bay): void {
    if (state.tick < entry.until && state.tick >= (entry.car?.since ?? -Infinity)) return;
    const car: ParkedCar = { cls: 'saloon', paint: 0, since: 0 };
    const held = this.cars.carAt(entry.bay, state.tick, state.traffic, car);
    entry.until = this.cars.changeAt(entry.bay, state.tick);
    if (held && entry.car?.since === car.since && entry.body !== undefined) {
      this.move(entry, state.tick);
      return;
    }
    this.drop(entry);
    if (held) this.stand(entry, car, state.tick);
  }

  /** Carry the body of a bay's car to where it stands on this tick. */
  private move(entry: Bay, tick: number): void {
    const pose = this.cars.poseAt(entry.bay, tick, entry.pose);
    const body = entry.body as RAPIER.RigidBody;
    const y = body.translation().y;
    body.setNextKinematicTranslation({ x: pose.x, y, z: pose.y });
    body.setNextKinematicRotation({ x: 0, y: sin(-pose.heading / 2), z: 0, w: cos(-pose.heading / 2) });
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
    for (const entry of this.bays) {
      if (entry.body === undefined) continue;
      const x = entry.pose.x;
      const y = entry.pose.y;
      const spec = entry.spec as VehicleSpec;
      const theirs = this.theirs;
      theirs.x = x;
      theirs.y = y;
      theirs.heading = entry.pose.heading;
      theirs.halfLength = spec.halfLength;
      theirs.halfWidth = spec.halfWidth;
      const byCar = hypot(car.x - x, car.y - y) < NEAR && footprintsTouch(car, theirs, margin);
      const byWalker = walker !== undefined && hypot(walker.x - x, walker.y - y) < NEAR && footprintsTouch(walker, theirs, margin);
      if (!byCar && !byWalker) continue;
      this.release(entry, promote);
    }
  }

  /**
   * Take the car whose body a shot, a swing or a blast met out of its bay, and
   * hand it to `promote`. Answers the bay, or undefined where the body is not
   * one of these cars.
   */
  take(body: number, promote: (bay: number, parked: ParkedCar, spec: VehicleSpec) => void): number | undefined {
    const entry = this.bays.find((candidate) => candidate.body?.handle === body);
    if (entry === undefined) return undefined;
    this.release(entry, promote);
    return entry.bay;
  }

  /** Empty a bay for as long as the record of its car lasts, and hand the car over. */
  private release(entry: Bay, promote: (bay: number, parked: ParkedCar, spec: VehicleSpec) => void): void {
    const parked = entry.car as ParkedCar;
    const spec = entry.spec as VehicleSpec;
    this.drop(entry);
    entry.until = Infinity;
    promote(entry.bay, parked, spec);
  }

  private stand(entry: Bay, car: ParkedCar, tick: number): void {
    const bays = this.cars.bays;
    const spec = specOf(car.cls);
    const pose = this.cars.poseAt(entry.bay, tick, entry.pose);
    const heading = pose.heading;
    // A yaw of minus the heading points local +x along the map heading.
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(pose.x, (bays.height[entry.bay] as number) + rideHeight(spec), pose.y)
        .setRotation({ x: 0, y: sin(-heading / 2), z: 0, w: cos(-heading / 2) }),
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
