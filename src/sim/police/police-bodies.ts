/**
 * The police units near the player, as Rapier bodies (spec sections 2.4, 14).
 *
 * A unit inside the box of ground the physics holds is a kinematic box moved
 * to where the record says it is. The player's car hits it as a solid, which is
 * what makes a roadblock a wall rather than a picture of one, and no crash
 * pushes a unit off its route. Outside the box a unit has no body: it is still
 * driving, and it is simply given one when it comes back into range.
 *
 * The helicopter has no body at all. It flies {@link HELICOPTER_HEIGHT} over
 * the roofs, where nothing the player drives can reach it.
 *
 * {@link PoliceBodies.unitAt} is how a shot finds out which unit it hit, so
 * `gunfire.ts` can take health off the car the round went into.
 */
import { cos, sin } from '../../core/libm.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { HELICOPTER_HEIGHT, type PoliceUnit } from './police.ts';
import type { SimState } from '../simulation.ts';
import { rideHeight, specOf } from '../vehicles/vehicle.ts';

/** The roster row every police car is built from. */
const UNIT_CLASS = 'emergency';

/** What a car standing as a body needs of the record: who it is and where it stands. */
export interface StandingCar {
  id: number;
  x: number;
  y: number;
  height: number;
  heading: number;
}

/** The box a car stands as, in metres, and how far its middle rides over the road. */
export interface CarBox {
  halfLength: number;
  halfWidth: number;
  halfHeight: number;
  ride: number;
}

/** A unit standing in the world, and the body it stands as. */
interface Standing {
  id: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

/**
 * Cars of the record near the player as kinematic boxes. `cars` says which of
 * the record's units stand as cars, and `boxOf` how big each one is, so the
 * police and the emergency services (`emergency-bodies.ts`) share this file.
 */
export class CarBodies<Car extends StandingCar> {
  private readonly world: RAPIER.World;
  /** The units that carry a body, in the order they were given one. */
  private readonly standing: Standing[] = [];
  private readonly spot = { x: 0, y: 0, z: 0 };
  private readonly turn = { x: 0, y: 0, z: 0, w: 1 };

  private readonly cars: (state: SimState) => readonly Car[];
  private readonly boxOf: (car: Car) => CarBox;

  constructor(world: RAPIER.World, cars: (state: SimState) => readonly Car[], boxOf: (car: Car) => CarBox) {
    this.world = world;
    this.cars = cars;
    this.boxOf = boxOf;
  }

  /** How many units stand in the world as bodies. */
  get count(): number {
    return this.standing.length;
  }

  /**
   * Give a body to every unit in the box and take it from every unit that has
   * left it, then put each body where the record says its unit is. Called after
   * the units have been stepped, so a body stands where its unit ended the tick.
   */
  settle(state: SimState, minX: number, minY: number, maxX: number, maxY: number): void {
    const cars = this.cars(state);
    const inBox = (unit: Car): boolean => unit.x >= minX && unit.x < maxX && unit.y >= minY && unit.y < maxY;
    for (let i = this.standing.length - 1; i >= 0; i--) {
      const held = this.standing[i] as Standing;
      const unit = cars.find((u) => u.id === held.id);
      if (unit !== undefined && inBox(unit)) continue;
      this.world.removeRigidBody(held.body);
      this.standing.splice(i, 1);
    }
    for (const unit of cars) {
      if (!inBox(unit)) continue;
      const size = this.boxOf(unit);
      this.place(unit, size.ride);
      const held = this.standing.find((s) => s.id === unit.id);
      if (held === undefined) {
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.spot.x, this.spot.y, this.spot.z).setRotation(this.turn),
        );
        const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(size.halfLength, size.halfHeight, size.halfWidth), body);
        this.standing.push({ id: unit.id, body, collider });
        continue;
      }
      held.body.setNextKinematicTranslation(this.spot);
      held.body.setNextKinematicRotation(this.turn);
    }
  }

  /** The unit a collider belongs to, or undefined where the collider is not one of these cars. */
  unitAt(handle: number): number | undefined {
    const held = this.standing.find((s) => s.collider.handle === handle);
    return held?.id;
  }

  /** Take every body out of the world. */
  clear(): void {
    for (const held of this.standing) this.world.removeRigidBody(held.body);
    this.standing.length = 0;
  }

  /** The middle of a unit's body and its turn, for where the record says it stands. */
  private place(unit: StandingCar, ride: number): void {
    this.spot.x = unit.x;
    this.spot.y = unit.height + ride;
    this.spot.z = unit.y;
    // A yaw of minus the heading points local +x along the map heading.
    this.turn.x = 0;
    this.turn.y = sin(-unit.heading / 2);
    this.turn.z = 0;
    this.turn.w = cos(-unit.heading / 2);
  }
}

/** The police cars: every unit but the helicopter, each the size of the patrol row. */
export class PoliceBodies extends CarBodies<PoliceUnit> {
  constructor(world: RAPIER.World) {
    const spec = specOf(UNIT_CLASS);
    const box: CarBox = { halfLength: spec.halfLength, halfWidth: spec.halfWidth, halfHeight: spec.halfHeight, ride: rideHeight(spec) };
    super(world, (state) => state.police.units.filter((unit) => unit.kind !== 'helicopter'), () => box);
  }
}
