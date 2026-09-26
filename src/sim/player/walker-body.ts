/**
 * The player's own body in the physics world (spec section 11.2): the
 * kinematic capsule they stand in and the controller that walks it.
 *
 * It is one body rather than a collection, so it is built and walked here and
 * owned by `physics.ts`: `ground-bodies.ts`, `unit-bodies.ts` and
 * `parked-bodies.ts` are the same idea for the things there are many of.
 */
import { AIM_TURN_RATE, aimYaw, facesAim } from './aim.ts';
import { atan2, hypot } from '../../core/libm.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { TICK_RATE } from '../clock.ts';
import { SHUNS_RAGDOLL } from '../physics/collision-groups.ts';
import type { InputFrame } from '../input.ts';
import {
  capsuleOf,
  FLOAT_DEPTH,
  JUMP_SPEED,
  MAX_CLIMB,
  MIN_SLIDE,
  paceOf,
  SKIN,
  SNAP_DISTANCE,
  STEP_HEIGHT,
  STEP_WIDTH,
  swimPaceOf,
  swimRise,
  swims,
  TERMINAL_SPEED,
  TURN_RATE,
  turnToward,
} from './on-foot.ts';
import type { SimState } from '../simulation.ts';

/** Metres per second squared. Earth's, so a player falls the way a person falls. */
export const GRAVITY = 9.81;

/** Scratch vectors, so a step allocates nothing. */
const step = { x: 0, y: 0, z: 0 };
const done = { x: 0, y: 0, z: 0 };
const at = { x: 0, y: 0, z: 0 };

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
  // The player walks through a ragdoll, as through a body lying still.
  const collider = world.createCollider(
    RAPIER.ColliderDesc.capsule(capsule.halfHeight, capsule.radius).setCollisionGroups(SHUNS_RAGDOLL),
    body,
  );
  const controller = world.createCharacterController(SKIN);
  controller.setUp({ x: 0, y: 1, z: 0 });
  controller.setSlideEnabled(true);
  controller.setMaxSlopeClimbAngle(MAX_CLIMB);
  controller.setMinSlopeSlideAngle(MIN_SLIDE);
  controller.enableAutostep(STEP_HEIGHT, STEP_WIDTH, false);
  controller.enableSnapToGround(SNAP_DISTANCE);
  return { body, collider, controller, rise: capsule.rise };
}

/**
 * Walk the player one tick (spec sections 11.2, 11.5).
 *
 * The camera never turns (spec section 10.7), so the forward axis walks up
 * the screen and the steering axis walks across it, whatever the player
 * faces; they then turn to face the way they are walking. Gravity is
 * integrated here rather than by Rapier, because a kinematic body is moved
 * and never pushed: the jump is a speed the ground takes back.
 *
 * Water chest deep or deeper swims instead (spec section 11.5): the sea
 * holds the body at the surface rather than pulling it down, the pace is a
 * swimmer's, and there is nothing to jump off.
 */
export function walk(walker: Walker, state: SimState, input: InputFrame, seaLevel: number): void {
  const p = state.player;
  // The capsule stands the player's own height, so half of it up from the
  // feet is the middle of the body and twice that is how tall they are.
  const stature = walker.rise * 2;
  const swimming = swims(p.height, seaLevel, stature);

  const jumped = input.jump && !p.held.jump;
  p.held.jump = input.jump;
  if (jumped && p.grounded && !swimming) p.vy = JUMP_SPEED;

  let dx = input.steer;
  let dy = -input.throttle;
  const length = hypot(dx, dy);
  if (length > 1) {
    dx /= length;
    dy /= length;
  }
  // A player aiming, or one who has just fired, faces the aim and may walk
  // any way under it (spec section 11.5). Otherwise they face the way they walk.
  const aim = facesAim(state, input) ? aimYaw(state, input) : undefined;
  if (aim !== undefined) p.heading = turnToward(p.heading, aim, AIM_TURN_RATE / TICK_RATE);
  else if (length > 0) p.heading = turnToward(p.heading, atan2(dy, dx), TURN_RATE / TICK_RATE);
  if (swimming) {
    const float = seaLevel - FLOAT_DEPTH * stature;
    p.vy = swimRise(float - p.height, p.vy);
  } else {
    p.vy = Math.max(-TERMINAL_SPEED, p.vy - GRAVITY / TICK_RATE);
  }

  const pace = (swimming ? swimPaceOf(input.sprint) : paceOf(input.sprint)) / TICK_RATE;
  step.x = dx * pace;
  step.y = p.vy / TICK_RATE;
  step.z = dy * pace;
  walker.controller.computeColliderMovement(walker.collider, step, undefined, SHUNS_RAGDOLL);
  const moved = walker.controller.computedMovement(done);
  p.grounded = walker.controller.computedGrounded();
  // Standing on the ground takes the fall back, so a step off a kerb does not
  // build up a speed the next drop starts from. The sea floor under a swimmer
  // takes nothing back: the water owns their speed up and down.
  if (p.grounded && p.vy < 0 && !swimming) p.vy = 0;
  p.speed = hypot(moved.x, moved.z) * TICK_RATE;

  const t = walker.body.translation();
  at.x = t.x + moved.x;
  at.y = t.y + moved.y;
  at.z = t.z + moved.z;
  walker.body.setNextKinematicTranslation(at);
}
