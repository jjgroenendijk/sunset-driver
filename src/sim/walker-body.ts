/**
 * The player's own body in the physics world (spec section 11.2): the
 * kinematic capsule they stand in and the controller that walks it.
 *
 * It is one body rather than a collection, so it is built here and owned by
 * `physics.ts`, which walks it: `ground-bodies.ts`, `unit-bodies.ts` and
 * `parked-bodies.ts` are the same idea for the things there are many of.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { capsuleOf, MAX_CLIMB, MIN_SLIDE, SKIN, SNAP_DISTANCE, STEP_HEIGHT, STEP_WIDTH } from './on-foot.ts';
import type { SimState } from './simulation.ts';

/** The player on foot: the kinematic capsule and the controller that walks it. */
export interface Walker {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController;
  /** Metres from the middle of the capsule down to the feet. */
  rise: number;
}

/**
 * The player's capsule and the controller that walks it (spec section 11.2).
 *
 * The capsule is the build they picked, so a broad character is a broader body
 * than a slim one. The controller climbs a kerb, slides along a wall rather
 * than stopping dead at it, and holds the feet on the ground over a slope
 * instead of hopping down it.
 */
export function buildWalker(world: RAPIER.World, state: SimState): Walker {
  const capsule = capsuleOf(state.character);
  const p = state.player;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.height + capsule.rise, p.y),
  );
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(capsule.halfHeight, capsule.radius), body);
  const controller = world.createCharacterController(SKIN);
  controller.setUp({ x: 0, y: 1, z: 0 });
  controller.setSlideEnabled(true);
  controller.setMaxSlopeClimbAngle(MAX_CLIMB);
  controller.setMinSlopeSlideAngle(MIN_SLIDE);
  controller.enableAutostep(STEP_HEIGHT, STEP_WIDTH, false);
  controller.enableSnapToGround(SNAP_DISTANCE);
  return { body, collider, controller, rise: capsule.rise };
}
