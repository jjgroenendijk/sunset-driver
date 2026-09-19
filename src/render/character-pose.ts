/**
 * How the player's limbs stand at a moment (spec sections 11.2, 11.5).
 *
 * The model in `character.ts` is a rig of groups: a hip and a knee each side,
 * a shoulder each side, a torso and the body itself. This says what angle each
 * of them takes, and nothing else: it holds no three.js and no state, so the
 * whole of the movement can be read and tested without a renderer.
 *
 * There are four stances and the record picks between them. A player standing
 * still breathes, a walking one swings the legs and the arms against each
 * other, one in the air holds the pose of a jump or of a fall, and one in deep
 * water lies forward and swims. `advancePhase` carries the cycle along at the
 * pace the stance asks for, so the feet keep up with the ground and a sprint
 * reads as a run rather than as a fast walk.
 *
 * An angle is radians about the model's across axis, which is local z. A
 * hanging limb turned by a positive angle swings forward, to local +x; the
 * torso leans forward the other way, so `lean` is applied negated.
 */
import { JUMP_SPEED, SPRINT_SPEED, SWIM_DEPTH } from '../sim/on-foot.ts';

/** What the body is doing, which is all the pose is chosen from. */
export interface CharacterMotion {
  /** Metres per second over the ground. */
  speed: number;
  /** True while the feet are on the ground. */
  grounded: boolean;
  /** Metres per second up: what tells a rise from a fall. */
  vy: number;
  /** Metres of water standing over the feet, and 0 on dry land. */
  depth: number;
  /** Metres from the feet to the top of the head. It says how deep is deep. */
  stature: number;
  /**
   * How far through a swing of a melee weapon the body is, 0 to 1, or -1 while
   * nothing is being swung (spec section 11.6). `swingProgress` in
   * `src/sim/melee.ts` reads it off the record.
   */
  swing?: number;
  /** True while the player has their hands up: given up, or being cuffed (spec section 14). */
  handsUp?: boolean;
}

export type Stance = 'stand' | 'walk' | 'air' | 'swim';

/** The angle of every joint, and where the body itself sits. */
export interface CharacterPose {
  /** Radians the whole body tips forward. A swimmer lies nearly flat. */
  pitch: number;
  /** Radians the torso turns about the body's own up axis, which is a swing's wind-up. */
  twist: number;
  /** Metres the whole body steps forward along its heading, which is a swing's lunge. */
  lunge: number;
  /** Metres the whole body is lifted, which is how a swimmer reaches the surface. */
  lift: number;
  /** Metres the hips rise over the step. */
  bob: number;
  /** Radians the torso leans forward over the legs. */
  lean: number;
  thighL: number;
  thighR: number;
  kneeL: number;
  kneeR: number;
  armL: number;
  armR: number;
  /**
   * Radians each shoulder turns about up, which is what carries an arm across
   * the body rather than along it. The camera of spec section 10.7 looks
   * straight down, so this is the half of a swing that reads.
   */
  yawL: number;
  yawR: number;
}

/** Metres walked for one full cycle of two steps. It sets the pace of the legs. */
export const STRIDE = 2.1;

/** Metres per second under which the player counts as standing still. */
export const IDLE_SPEED = 0.2;

/** Cycles per second of the breath of a player standing still, and of a swimmer's stroke. */
export const IDLE_RATE = 0.28;
export const SWIM_RATE = 0.55;

/** How much faster a swimmer strokes for every metre per second they make. */
export const SWIM_URGENCY = 0.3;

/** Radians a swimmer's body tips forward from standing. */
export const SWIM_PITCH = 1.25;

/** How far under the surface a floating body lies, as a share of its height. */
export const SWIM_DRAFT = 0.2;

/** What each stance swings, at its slowest and at its fastest. */
const SWING = {
  leg: [0.34, 0.85],
  knee: [0.5, 1.5],
  arm: [0.28, 0.95],
  bob: [0.018, 0.05],
  lean: [0.03, 0.22],
} as const;

/** Mix two ends of a range by `t`, which is already between 0 and 1. */
function mix(range: readonly [number, number], t: number): number {
  return range[0] + (range[1] - range[0]) * t;
}

/** True when the water over the feet is deep enough to swim in rather than wade through. */
export function inDeepWater(motion: CharacterMotion): boolean {
  return motion.depth > SWIM_DEPTH * motion.stature;
}

/**
 * What the body is doing. Deep water beats everything, because a swimmer is
 * neither on the ground nor falling; after that the feet decide.
 */
export function stanceOf(motion: CharacterMotion): Stance {
  if (inDeepWater(motion)) return 'swim';
  if (!motion.grounded) return 'air';
  return motion.speed > IDLE_SPEED ? 'walk' : 'stand';
}

/** Cycles per second the stance runs its loop at. The air holds its pose, so it runs at none. */
export function cycleRate(stance: Stance, speed: number): number {
  if (stance === 'walk') return Math.max(speed, IDLE_SPEED) / STRIDE;
  if (stance === 'swim') return SWIM_RATE + SWIM_URGENCY * Math.max(0, speed);
  if (stance === 'stand') return IDLE_RATE;
  return 0;
}

/**
 * The cycle `dt` seconds on, kept between 0 and 2π. It is carried by the speed
 * rather than by the clock, so the stride matches the ground the player covers
 * whatever the frame rate.
 */
export function advancePhase(phase: number, stance: Stance, speed: number, dt: number): number {
  const next = phase + 2 * Math.PI * cycleRate(stance, speed) * Math.max(0, dt);
  const turn = 2 * Math.PI;
  return ((next % turn) + turn) % turn;
}

/** A body standing straight, which every stance is written over. */
function rest(): CharacterPose {
  return {
    pitch: 0,
    twist: 0,
    lunge: 0,
    lift: 0,
    bob: 0,
    lean: 0,
    thighL: 0,
    thighR: 0,
    kneeL: 0,
    kneeR: 0,
    armL: 0,
    armR: 0,
    yawL: 0,
    yawR: 0,
  };
}

/**
 * The walk of spec section 11.5: each thigh swings forward and back a half
 * cycle apart, the knee bends while its leg swings through, each arm swings
 * against the leg on its side, and the hips rise at every step. How far any of
 * it swings grows with the speed, so the same cycle carries a stroll and a
 * sprint.
 */
function walkPose(phase: number, speed: number): CharacterPose {
  const t = Math.min(1, Math.max(0, (speed - IDLE_SPEED) / (SPRINT_SPEED - IDLE_SPEED)));
  const leg = mix(SWING.leg, t);
  const bend = mix(SWING.knee, t);
  const arm = mix(SWING.arm, t);
  const pose = rest();
  pose.thighL = leg * Math.sin(phase);
  pose.thighR = leg * Math.sin(phase + Math.PI);
  pose.kneeL = -bend * Math.max(0, Math.cos(phase));
  pose.kneeR = -bend * Math.max(0, Math.cos(phase + Math.PI));
  pose.armL = -arm * Math.sin(phase);
  pose.armR = -arm * Math.sin(phase + Math.PI);
  pose.bob = mix(SWING.bob, t) * Math.cos(2 * phase);
  pose.lean = mix(SWING.lean, t);
  return pose;
}

/** The breath of a player standing still: the arms sway and the chest rises. */
function standPose(phase: number): CharacterPose {
  const pose = rest();
  pose.armL = 0.05 * Math.sin(phase);
  pose.armR = -0.05 * Math.sin(phase);
  pose.bob = 0.006 * Math.sin(phase);
  return pose;
}

/**
 * The jump and the fall of spec section 11.2. There is no cycle: the pose is
 * read off the speed the body has up, so the legs tuck as the jump rises and
 * reach for the ground as it comes down, and the arms come up with them.
 */
function airPose(vy: number): CharacterPose {
  const rise = Math.min(1, Math.max(-1, vy / JUMP_SPEED));
  const tuck = 0.5 + 0.5 * rise;
  const pose = rest();
  pose.thighL = 0.25 + 0.55 * tuck;
  pose.kneeL = -(0.35 + 0.85 * tuck);
  pose.thighR = -0.15 - 0.3 * tuck;
  pose.kneeR = -(0.7 + 0.5 * tuck);
  pose.armL = -0.9 - 1.3 * tuck;
  pose.armR = pose.armL + 0.3;
  pose.lean = 0.1 * (1 - rise);
  return pose;
}

/**
 * The front crawl of a player in deep water. The body lies forward on the
 * surface, each arm turns a full circle a half cycle apart — entering ahead of
 * the head and pulling through to the hip — and the legs flutter twice a
 * stroke. `lift` carries the body up to the surface, since the record stands
 * its feet below it.
 */
function swimPose(phase: number, motion: CharacterMotion): CharacterPose {
  const pose = rest();
  pose.pitch = -SWIM_PITCH;
  pose.lift = Math.max(0, motion.depth - SWIM_DRAFT * motion.stature);
  pose.armL = Math.PI - phase;
  pose.armR = -phase;
  pose.thighL = 0.22 * Math.sin(2 * phase);
  pose.thighR = 0.22 * Math.sin(2 * phase + Math.PI);
  pose.kneeL = -0.3 * Math.max(0, Math.sin(2 * phase));
  pose.kneeR = -0.3 * Math.max(0, Math.sin(2 * phase + Math.PI));
  pose.lean = -0.08;
  return pose;
}

/**
 * The three parts of a swing, as shares of it (spec section 11.6): the weapon
 * is drawn back, thrown through, and carried to rest. The strike is the short
 * middle, which is what makes a blow read as a blow rather than as a wave.
 */
export const WIND_END = 0.3;
export const STRIKE_END = 0.52;

/** Radians the arm is drawn back behind the body, and carried past it. */
export const SWING_WIND = 0.95;
export const SWING_FOLLOW = 1.25;

/** Radians the arm is raised in front of the body while the blow is thrown. */
export const SWING_RAISE = 1.15;

/** How much of the arm's turn the torso and the off arm take. */
export const TWIST_SHARE = 0.4;
export const OFF_ARM_SHARE = 0.35;

/** Metres the body steps into the blow at the moment it lands. */
export const SWING_LUNGE = 0.2;

/** Ease a share of a part of the swing: slow at the ends and quick in the middle. */
function ease(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Where the swinging arm stands, in radians about up, `progress` of the way
 * through a swing: behind the body while it is drawn back, past the body once
 * the blow is through, and home again as it comes to rest.
 */
export function swingAngle(progress: number): number {
  if (progress < WIND_END) return -SWING_WIND * ease(progress / WIND_END);
  if (progress < STRIKE_END) {
    const t = ease((progress - WIND_END) / (STRIKE_END - WIND_END));
    return -SWING_WIND + (SWING_WIND + SWING_FOLLOW) * t;
  }
  return SWING_FOLLOW * (1 - ease((progress - STRIKE_END) / (1 - STRIKE_END)));
}

/**
 * Lay a swing over a stance (spec section 11.6). The body keeps walking,
 * standing or falling underneath: the arm is carried across it, the torso
 * turns with the arm, the off arm swings the other way to balance it, and the
 * body steps into the blow as it lands. `progress` is what `swingProgress` in
 * `src/sim/melee.ts` answers, and a negative one leaves the pose alone.
 */
export function swingOver(pose: CharacterPose, progress: number): CharacterPose {
  if (progress < 0) return pose;
  const angle = swingAngle(progress);
  const through = Math.sin(Math.PI * Math.min(1, progress));
  pose.yawR = angle;
  pose.yawL = -angle * OFF_ARM_SHARE;
  // The weapon is held out in front while the blow is thrown, and the arm falls
  // back to whatever the stance underneath was doing as the swing ends.
  pose.armR = pose.armR * (1 - through) - SWING_RAISE * through;
  pose.armL = pose.armL * (1 - through);
  pose.twist = angle * TWIST_SHARE;
  pose.lunge = SWING_LUNGE * through;
  return pose;
}

/** The pose of a stance at a point of its cycle, with any swing laid over it. */
export function poseFor(stance: Stance, phase: number, motion: CharacterMotion): CharacterPose {
  if (motion.handsUp === true && stance !== 'swim') return handsUp(standPose(phase));
  if (stance === 'swim') return swingOver(swimPose(phase, motion), motion.swing ?? -1);
  if (stance === 'air') return swingOver(airPose(motion.vy), motion.swing ?? -1);
  if (stance === 'walk') return swingOver(walkPose(phase, motion.speed), motion.swing ?? -1);
  return swingOver(standPose(phase), motion.swing ?? -1);
}

/** Radians both arms stand from hanging with the hands up: a little short of straight up. */
export const HANDS_UP = Math.PI - 0.25;

/** Both arms up over the head, and nothing else moving, which is what giving up looks like. */
function handsUp(pose: CharacterPose): CharacterPose {
  pose.armL = HANDS_UP;
  pose.armR = HANDS_UP;
  pose.yawL = 0;
  pose.yawR = 0;
  return pose;
}
