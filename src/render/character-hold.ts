/**
 * How the player's arms hold a gun (spec sections 11.5, 11.6).
 *
 * A gun is held in the right hand and drawn where that hand is, so the arms
 * have to be where a gun is held. A pistol is carried in one hand, low and in
 * front, and raised in both hands when the player aims. A long gun is held in
 * both hands with the body turned side on: the right hand on the grip, the
 * left hand on the fore end. Aimed, it comes up to the shoulder.
 *
 * Each arm is one straight piece turned at the shoulder, so a hand is put on a
 * point by pointing the arm at it. That is all the reach there is: the pose
 * names where each hand should be and this turns the shoulders toward it.
 *
 * Like `character-pose.ts` this holds no three.js and no state. The angles
 * follow the rig of `character.ts`: a turn of `arm` about the across axis
 * swings a hanging arm forward, and a turn of `yaw` about up carries it round
 * toward -z, which is across the body for the right arm.
 */
import { currentWeapon, type LoadoutState, type WeaponClass } from '../sim/weapon.ts';
import type { CharacterPose } from './character-pose.ts';

/** How a weapon is held: not at all, in one hand, or in both. */
export type Grip = 'none' | 'one' | 'pistol' | 'long';

/** The grip a class of weapon is held in. A melee weapon swings instead. */
export function gripOf(cls: WeaponClass): Grip {
  if (cls === 'melee') return 'none';
  if (cls === 'thrown') return 'one';
  if (cls === 'pistol') return 'pistol';
  return 'long';
}

/** What the hands are doing this frame. */
export interface Hold {
  grip: Grip;
  /** 0 at the hip and 1 fully aimed, eased between them by the model. */
  aim: number;
  /** 0 at rest and 1 at the moment a shot leaves, which kicks the hands up. */
  kick: number;
}

/** Ticks a shot's kick takes to die away. */
export const KICK_TICKS = 9;

/**
 * The hold the record asks for at `tick`, which may fall between two ticks:
 * the grip of the weapon in hand, whether it is aimed, and the kick of the
 * last shot, strongest as the round leaves and gone {@link KICK_TICKS} later.
 */
export function holdOf(loadout: LoadoutState, tick: number): Hold {
  const grip = gripOf(currentWeapon(loadout).cls);
  const age = tick - loadout.firedTick;
  const kick = loadout.firedTick >= 0 && age >= 0 && age < KICK_TICKS ? (1 - age / KICK_TICKS) ** 2 : 0;
  return { grip, aim: loadout.aiming ? 1 : 0, kick };
}

/** The sizes of the rig the arms are pointed in. */
export interface HoldRig {
  /** Metres from the middle of the body out to each shoulder. */
  shoulderX: number;
  /** Metres from the hips up to the shoulders. */
  shoulderY: number;
  /** Metres from the shoulder to the middle of the fist. */
  reach: number;
}

/**
 * Where the hands go for one grip at the hip and aimed. `twist` turns the
 * shoulders about up; a negative one draws the right shoulder back, which is
 * the side-on stance of a long gun. `right` is where the right fist goes, as
 * (along, below the shoulders, across), each a share of the reach. `fore` is
 * how far along the gun ahead of the right fist the left fist goes, also a
 * share of the reach, and undefined where the left hand is free.
 */
interface Stand {
  twist: number;
  right: readonly [number, number, number];
  fore: number | undefined;
}

const STANDS: Record<Exclude<Grip, 'none'>, { hip: Stand; aimed: Stand }> = {
  one: {
    hip: { twist: 0, right: [0.55, 0.85, 0.45], fore: undefined },
    aimed: { twist: 0, right: [0.55, 0.85, 0.45], fore: undefined },
  },
  pistol: {
    hip: { twist: 0, right: [0.6, 0.8, 0.4], fore: undefined },
    aimed: { twist: -0.12, right: [0.95, 0.2, 0.08], fore: -0.02 },
  },
  long: {
    hip: { twist: -0.45, right: [0.5, 0.72, 0.15], fore: 0.5 },
    aimed: { twist: -0.55, right: [0.6, 0.38, 0.08], fore: 0.55 },
  },
};

/** Radians the arms are thrown up by a shot at its strongest. */
const KICK_LIFT = 0.22;

/** How much of the walk's lean a body holding a gun keeps: the hands stay on it. */
const HOLD_LEAN = 0.3;

/** The angles that point an arm from `shoulder` at `target`, in the body's frame, under a torso turned by `twist`. */
export function pointArm(
  shoulder: readonly [number, number, number],
  target: readonly [number, number, number],
  twist: number,
): { arm: number; yaw: number } {
  const dx = target[0] - shoulder[0];
  const dy = target[1] - shoulder[1];
  const dz = target[2] - shoulder[2];
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return { arm: 0, yaw: 0 };
  // The arm hangs along -y. Turned by `arm` about z and then by the torso's
  // twist plus its own yaw about y, it points along
  // (sin arm · cos ψ, -cos arm, -sin arm · sin ψ).
  const arm = Math.acos(Math.max(-1, Math.min(1, -dy / length)));
  const yaw = Math.atan2(-dz, dx) - twist;
  return { arm, yaw };
}

/** Where a shoulder stands in the body's frame, with the torso turned by `twist` about up. */
function shoulderAt(rig: HoldRig, side: number, twist: number): [number, number, number] {
  const z = side * rig.shoulderX;
  return [z * Math.sin(twist), rig.shoulderY, z * Math.cos(twist)];
}

function mixStand(a: Stand, b: Stand, t: number): { twist: number; right: [number, number, number]; fore: number } {
  const lerp = (p: number, q: number): number => p + (q - p) * t;
  return {
    twist: lerp(a.twist, b.twist),
    right: [lerp(a.right[0], b.right[0]), lerp(a.right[1], b.right[1]), lerp(a.right[2], b.right[2])],
    fore: lerp(a.fore ?? b.fore ?? 0, b.fore ?? a.fore ?? 0),
  };
}

/**
 * Lay a hold over a pose. The legs keep walking, standing or jumping under it;
 * the arms that hold the gun leave the swing of the stance and point at the
 * gun. A left hand that is free at the hip joins the gun as the aim comes up,
 * so a pistol raised to aim is taken in both hands. A grip of `none` leaves
 * the pose alone.
 */
export function holdOver(pose: CharacterPose, hold: Hold, rig: HoldRig): CharacterPose {
  if (hold.grip === 'none') return pose;
  const aim = Math.min(1, Math.max(0, hold.aim));
  const stands = STANDS[hold.grip];
  const stand = mixStand(stands.hip, stands.aimed, aim);
  const r = rig.reach;
  const kick = Math.min(1, Math.max(0, hold.kick)) * KICK_LIFT;

  pose.twist = stand.twist;
  pose.lean *= HOLD_LEAN;
  const rightShoulder = shoulderAt(rig, 1, stand.twist);
  const target: [number, number, number] = [
    stand.right[0] * r,
    rig.shoulderY - stand.right[1] * r,
    stand.right[2] * r,
  ];
  const right = pointArm(rightShoulder, target, stand.twist);
  pose.armR = right.arm + kick;
  pose.yawR = right.yaw;

  // The left hand reaches for the gun where the right fist actually is, one
  // reach along the arm, since the target may lie nearer or further than that.
  let leftShare = 0;
  if (stands.hip.fore !== undefined) leftShare = 1;
  else if (stands.aimed.fore !== undefined) leftShare = aim;
  if (leftShare > 0) {
    const d = [target[0] - rightShoulder[0], target[1] - rightShoulder[1], target[2] - rightShoulder[2]];
    const length = Math.hypot(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0) || 1;
    const fist: [number, number, number] = [
      rightShoulder[0] + ((d[0] ?? 0) / length) * r,
      rightShoulder[1] + ((d[1] ?? 0) / length) * r,
      rightShoulder[2] + ((d[2] ?? 0) / length) * r,
    ];
    const fore: [number, number, number] = [fist[0] + stand.fore * r, fist[1], fist[2]];
    const left = pointArm(shoulderAt(rig, -1, stand.twist), fore, stand.twist);
    pose.armL = pose.armL * (1 - leftShare) + (left.arm + kick) * leftShare;
    pose.yawL = pose.yawL * (1 - leftShare) + left.yaw * leftShare;
  }
  return pose;
}
