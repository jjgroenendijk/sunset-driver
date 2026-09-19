/**
 * The armed people near the player, as Rapier bodies: the faction enforcers of
 * spec section 17.2 and the police officers on foot of spec section 14. One of
 * these holds one list of them, which a getter reads off the record.
 *
 * `police-bodies.ts` is the same file for the police cars, and this follows it:
 * a person inside the box of ground the physics holds stands as a kinematic
 * capsule moved to where the record says they are, and one outside it carries
 * no body at all. They are people rather than cars, so the shape is the capsule
 * a person stands in (`on-foot.ts`) rather than a box.
 *
 * The capsule is what makes them shootable: {@link PersonBodies.unitAt} is how
 * a round finds out which of them it went into, so `gunfire.ts` can take health
 * off that one.
 *
 * It is a sensor, which in Rapier means a shape that is found by a ray but
 * pushes nothing: a car drives through an enforcer and a player walks through
 * one. A solid person would be an immovable post the car stops dead against,
 * and knocking somebody down is spec section 13.1's question rather than this
 * one. A body is found by a cast only from the step after it was built, so an
 * enforcer who has just walked into the box cannot be shot until the next tick.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { DEFAULT_APPEARANCE } from './character.ts';
import { capsuleOf } from './on-foot.ts';
import type { SimState } from './simulation.ts';

/**
 * The body every one of them stands in. They are the crowd's own build rather
 * than the player's, so one capsule serves them all.
 */
export const PERSON_CAPSULE = capsuleOf(DEFAULT_APPEARANCE);

/** Where the record has a person: all a body needs of them. */
export interface Placed {
  id: number;
  x: number;
  y: number;
  height: number;
}

/** A person standing in the world, and the body they stand as. */
interface Standing {
  id: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export class PersonBodies {
  private readonly world: RAPIER.World;
  /** Who of the record is held: the enforcers, or the officers. */
  private readonly list: (state: SimState) => readonly Placed[];
  /** The people who carry a body, in the order they were given one. */
  private readonly standing: Standing[] = [];
  private readonly spot = { x: 0, y: 0, z: 0 };

  constructor(world: RAPIER.World, list: (state: SimState) => readonly Placed[]) {
    this.world = world;
    this.list = list;
  }

  /** How many of them stand in the world as bodies. */
  get count(): number {
    return this.standing.length;
  }

  /**
   * Give a body to everybody in the box and take it from everybody who has
   * left it or been put down, then put each body where the record says its
   * person is. Called after they have been stepped, so a body stands where
   * its person ended the tick.
   */
  settle(state: SimState, minX: number, minY: number, maxX: number, maxY: number): void {
    const people = this.list(state);
    const inBox = (unit: Placed): boolean => unit.x >= minX && unit.x < maxX && unit.y >= minY && unit.y < maxY;
    for (let i = this.standing.length - 1; i >= 0; i--) {
      const held = this.standing[i] as Standing;
      const unit = people.find((u) => u.id === held.id);
      if (unit !== undefined && inBox(unit)) continue;
      this.world.removeRigidBody(held.body);
      this.standing.splice(i, 1);
    }
    for (const unit of people) {
      if (!inBox(unit)) continue;
      // The record says where their feet are; the capsule is held by its
      // middle, which stands `rise` above them.
      this.spot.x = unit.x;
      this.spot.y = unit.height + PERSON_CAPSULE.rise;
      this.spot.z = unit.y;
      const held = this.standing.find((s) => s.id === unit.id);
      if (held === undefined) {
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.spot.x, this.spot.y, this.spot.z),
        );
        const collider = this.world.createCollider(
          RAPIER.ColliderDesc.capsule(PERSON_CAPSULE.halfHeight, PERSON_CAPSULE.radius).setSensor(true),
          body,
        );
        this.standing.push({ id: unit.id, body, collider });
        continue;
      }
      held.body.setNextKinematicTranslation(this.spot);
    }
  }

  /** The person a collider belongs to, or undefined where the collider is not one of them. */
  unitAt(handle: number): number | undefined {
    const held = this.standing.find((s) => s.collider.handle === handle);
    return held?.id;
  }

  /** Take every body out of the world. */
  clear(): void {
    for (const held of this.standing) this.world.removeRigidBody(held.body);
    this.standing.length = 0;
  }
}
