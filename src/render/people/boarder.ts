/**
 * The player's model put where `boarding.ts` says it is while they get into
 * their vehicle or out of it (spec sections 11.2, 11.5).
 *
 * `boarding.ts` answers in the vehicle's own frame, so the body moves with the
 * vehicle it is getting into: the whole of the vehicle's turn is applied, as a
 * rider's is (`rider.ts`), and then the body's own turn about up on top of it.
 */
import { Quaternion, Vector3 } from 'three';
import { walkShare, type BoardingState } from '../../sim/player/boarding.ts';
import type { VehicleSpec, VehicleState } from '../../sim/vehicles/vehicle.ts';
import { boardingFrame, type BoardingFrame } from './boarding.ts';
import type { CharacterModel } from './character.ts';

/** Scratch, so a frame allocates nothing for the turn. */
const offset = new Vector3();
const forward = new Vector3();
const turn = new Quaternion();
const inverse = new Quaternion();
const yaw = new Quaternion();
const up = new Vector3(0, 1, 0);

/** Where the wheels meet the ground, in the vehicle's frame; the bottom of the hull for a boat. */
export function groundUnder(v: VehicleState, spec: VehicleSpec): number {
  let lowest = Infinity;
  for (let i = 0; i < spec.wheels.length; i++) {
    const wheel = spec.wheels[i];
    const state = v.wheels[i];
    if (wheel === undefined || state === undefined) continue;
    lowest = Math.min(lowest, wheel.y - state.suspension - spec.wheelRadius);
  }
  return Number.isFinite(lowest) ? lowest : -spec.halfHeight;
}

/**
 * Stand the model at `progress` of a move into `v` or out of it, and answer
 * the frame it was stood from, whose `door` is how far to swing the door open.
 * `feet` is where the player's record stands them, which is where a move in
 * starts from: the record holds them still at that place until the move ends.
 */
export function placeBoarder(
  model: CharacterModel,
  v: VehicleState,
  spec: VehicleSpec,
  boarding: BoardingState,
  progress: number,
  feet: { x: number; y: number; height: number; heading: number },
): BoardingFrame {
  turn.set(v.qx, v.qy, v.qz, v.qw);
  // Where the record stands the player, turned into the vehicle's frame.
  offset.set(feet.x - v.x, feet.height - v.y, feet.y - v.z).applyQuaternion(inverse.copy(turn).invert());
  forward.set(1, 0, 0).applyQuaternion(turn);
  const vehicleYaw = Math.atan2(-forward.z, forward.x);
  const frame = boardingFrame({
    way: boarding.way,
    side: boarding.side,
    progress,
    walk: walkShare(boarding, spec),
    spec,
    hipsAt: model.hipsAt,
    stature: model.height,
    rig: model.reach,
    fromX: offset.x,
    fromY: offset.y,
    fromZ: offset.z,
    // The model is turned by -heading on the map, and the vehicle's frame by its own yaw.
    fromYaw: -feet.heading - vehicleYaw,
    ground: groundUnder(v, spec),
  });
  offset.set(frame.x, frame.y, frame.z).applyQuaternion(turn);
  model.group.position.set(v.x + offset.x, v.y + offset.y, v.z + offset.z);
  model.group.quaternion.copy(turn).multiply(yaw.setFromAxisAngle(up, frame.yaw));
  model.pose(frame.pose);
  return frame;
}
