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
import RAPIER from '@dimforge/rapier3d-compat';
import { HELICOPTER_HEIGHT, type PoliceUnit } from './police.ts';
import type { SimState } from './simulation.ts';
import { rideHeight, specOf } from './vehicle.ts';

/** The roster row every police car is built from. */
const UNIT_CLASS = 'emergency';

/** A unit standing in the world, and the body it stands as. */
interface Standing {
  id: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export class PoliceBodies {
  private readonly world: RAPIER.World;
  /** The units that carry a body, in the order they were given one. */
  private readonly standing: Standing[] = [];
  private readonly spot = { x: 0, y: 0, z: 0 };
  private readonly turn = { x: 0, y: 0, z: 0, w: 1 };

  constructor(world: RAPIER.World) {
    this.world = world;
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
    const spec = specOf(UNIT_CLASS);
    const inBox = (unit: PoliceUnit): boolean =>
      unit.kind !== 'helicopter' && unit.x >= minX && unit.x < maxX && unit.y >= minY && unit.y < maxY;
    for (let i = this.standing.length - 1; i >= 0; i--) {
      const held = this.standing[i] as Standing;
      const unit = state.police.units.find((u) => u.id === held.id);
      if (unit !== undefined && inBox(unit)) continue;
      this.world.removeRigidBody(held.body);
      this.standing.splice(i, 1);
    }
    for (const unit of state.police.units) {
      if (!inBox(unit)) continue;
      this.place(unit, rideHeight(spec));
      const held = this.standing.find((s) => s.id === unit.id);
      if (held === undefined) {
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.spot.x, this.spot.y, this.spot.z).setRotation(this.turn),
        );
        const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(spec.halfLength, spec.halfHeight, spec.halfWidth), body);
        this.standing.push({ id: unit.id, body, collider });
        continue;
      }
      held.body.setNextKinematicTranslation(this.spot);
      held.body.setNextKinematicRotation(this.turn);
    }
  }

  /** The unit a collider belongs to, or undefined where the collider is not a police car. */
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
  private place(unit: PoliceUnit, ride: number): void {
    this.spot.x = unit.x;
    this.spot.y = unit.height + ride;
    this.spot.z = unit.y;
    // A yaw of minus the heading points local +x along the map heading.
    this.turn.x = 0;
    this.turn.y = Math.sin(-unit.heading / 2);
    this.turn.z = 0;
    this.turn.w = Math.cos(-unit.heading / 2);
  }
}

export { HELICOPTER_HEIGHT };
