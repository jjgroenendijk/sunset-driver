/**
 * The rider on a vehicle that is sat astride (spec sections 11.1, 11.3).
 *
 * A player in a car is behind glass and under a roof, so the model of
 * `character.ts` is not drawn for them. On a motorcycle there is nothing to be
 * behind: the rider is the tallest thing on the bike and the first thing the
 * camera sees, so the same model is put on the saddle instead of hidden.
 *
 * It is the player's own model, in the look they chose, and not a figure of
 * its own: a bike pulling up beside another player carries somebody they can
 * recognise. Everything that draws a player on a bike — the frame, the other
 * players of a room, the preview — comes through {@link seatRider}.
 *
 * The rider takes the whole of the vehicle's pose, roll and pitch included, so
 * a bike leaning into a corner leans the rider with it and one nosing over a
 * kerb tips them forward. `vehicle-mesh.ts` says where the seat, the grips and
 * the pegs of a bike are, and this puts the body on all three.
 */
import { Quaternion, Vector3 } from 'three';
import type { VehicleSpec, VehicleState } from '../../sim/vehicles/vehicle.ts';
import type { CharacterModel } from '../people/character.ts';
import { pointArm, type HoldRig } from '../people/character-hold.ts';
import { restPose, type CharacterPose } from '../people/character-pose.ts';
import { saddleOf, type Saddle } from './vehicle-mesh.ts';

/** Scratch, so a frame that seats six riders allocates nothing. */
const offset = new Vector3();
const turn = new Quaternion();

/**
 * How a rider folds onto a bike: the thighs come up over the tank, the knees
 * fold the shins back down onto the pegs, both legs spread round the engine
 * between them, and the body leans forward far enough to reach the bars.
 *
 * The legs are these angles and nothing else, because a leg is two pieces and
 * a body of any height lands close enough to the pegs with them. The arms are
 * not: they are pointed at the grips, so a tall player and a short one both
 * hold the bars rather than reach past them or stop short.
 */
export const RIDE = { thigh: 1.05, knee: -1.85, spread: 0.24, lean: 0.45 } as const;

/**
 * Sit a character on a vehicle, and answer whether it is a vehicle anybody
 * sits on: false on a car, and the caller hides the model as before.
 *
 * The rig hangs from the hips, so the model is stood the height of its own
 * hips below the saddle — a tall player and a short one then sit on the seat
 * rather than above or through it.
 */
export function seatRider(model: CharacterModel, v: VehicleState, spec: VehicleSpec): boolean {
  const saddle = saddleOf(spec);
  if (saddle === undefined) return false;
  turn.set(v.qx, v.qy, v.qz, v.qw);
  offset.set(saddle.x, saddle.y - model.hipsAt, 0).applyQuaternion(turn);
  model.group.position.set(v.x + offset.x, v.y + offset.y, v.z + offset.z);
  model.group.quaternion.copy(turn);
  model.pose(ridePose(saddle, model.reach));
  return true;
}

/**
 * The pose of a rider sat on `saddle` with the arms of `rig`.
 *
 * The hips are on the saddle, so everything the body reaches for is measured
 * from there. The arms are turned at the shoulder only, as a held gun's are
 * (`character-hold.ts`), and the shoulders hang off a torso already leaning:
 * the grips are turned back through that lean before the arms are pointed at
 * them, or the hands land as far below the bars as the lean carried them.
 */
export function ridePose(saddle: Saddle, rig: HoldRig): CharacterPose {
  const pose = restPose();
  pose.thighL = RIDE.thigh;
  pose.thighR = RIDE.thigh;
  pose.kneeL = RIDE.knee;
  pose.kneeR = RIDE.knee;
  pose.spreadL = RIDE.spread;
  pose.spreadR = RIDE.spread;
  pose.lean = RIDE.lean;
  const cos = Math.cos(RIDE.lean);
  const sin = Math.sin(RIDE.lean);
  const dx = saddle.gripX - saddle.x;
  const dy = saddle.gripY - saddle.y;
  const along = dx * cos - dy * sin;
  const up = dx * sin + dy * cos;
  // The second of the pair of shoulders stands at +z, which is the grip at +z.
  const right = pointArm([0, rig.shoulderY, rig.shoulderX], [along, up, saddle.gripZ], 0);
  const left = pointArm([0, rig.shoulderY, -rig.shoulderX], [along, up, -saddle.gripZ], 0);
  pose.armR = right.arm;
  pose.yawR = right.yaw;
  pose.armL = left.arm;
  pose.yawL = left.yaw;
  return pose;
}
