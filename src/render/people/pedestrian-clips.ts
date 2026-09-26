/**
 * The motion of each gait of the crowd, as turns of the rig's bones over one
 * cycle (spec sections 13.1, 20.1).
 *
 * A walking gait is a {@link Swing}: the thighs swing against each other, the
 * knees bend as a leg swings through, the feet roll from heel to toe, the arms
 * swing against the legs with a bend at the elbow, and the hips bob twice a
 * cycle. A standing gait — a call, a cigarette, arms folded, a guitar — is a
 * pose of its own with a slow movement in it, and a walk with an umbrella is a
 * walk whose right arm holds still.
 *
 * `pedestrian-rig.ts` turns these into keyframe tracks and bakes them. Every
 * turn is three angles about the bone's own axes: `x` rolls a limb out to the
 * side, `y` twists it, and `z` carries a hanging limb forward. The body faces
 * +x, so a torso tips forward with a turn of -z.
 */
import type { Gait } from '../../sim/crowd/pedestrian-look.ts';
import type { BoneName } from './pedestrian-rig.ts';

/** How far a walking gait swings the body, in radians and metres. */
export interface Swing {
  /** Thigh forward and back. */
  leg: number;
  /** Knee bend while the leg swings through. */
  knee: number;
  /** Arm forward and back, against the leg on its side. */
  arm: number;
  /** Hips up and down, twice a cycle. */
  bob: number;
  /** Torso tipped forward. */
  lean: number;
  /** Both arms held forward of hanging, whatever the cycle: out in front, to aim. */
  raise: number;
  /** Elbow bend at rest, and how much more as the arm swings forward. */
  elbow: number;
  /** Foot roll: toe up at the heel strike, down at the push off. */
  foot: number;
}

export const SWINGS: Record<Gait, Swing> = {
  stroll: { leg: 0.42, knee: 0.55, arm: 0.35, bob: 0.02, lean: 0.02, raise: 0, elbow: 0.15, foot: 0.25 },
  brisk: { leg: 0.52, knee: 0.65, arm: 0.5, bob: 0.025, lean: 0.05, raise: 0, elbow: 0.25, foot: 0.3 },
  amble: { leg: 0.28, knee: 0.35, arm: 0.14, bob: 0.012, lean: 0.1, raise: 0, elbow: 0.1, foot: 0.15 },
  run: { leg: 0.85, knee: 1.5, arm: 0.95, bob: 0.05, lean: 0.22, raise: 0, elbow: 1.4, foot: 0.4 },
  stand: { leg: 0, knee: 0, arm: 0.03, bob: 0.004, lean: 0, raise: 0, elbow: 0.08, foot: 0 },
  // Arms straight out in front at shoulder height, the legs free to walk.
  aim: { leg: 0.4, knee: 0.5, arm: 0, bob: 0.015, lean: 0.04, raise: Math.PI / 2, elbow: 0, foot: 0.2 },
  jog: { leg: 0.62, knee: 1.1, arm: 0.55, bob: 0.04, lean: 0.12, raise: 0, elbow: 1.5, foot: 0.35 },
  shuffle: { leg: 0.17, knee: 0.22, arm: 0.07, bob: 0.006, lean: 0.06, raise: 0, elbow: 0.3, foot: 0.05 },
  phone: { leg: 0, knee: 0, arm: 0, bob: 0.004, lean: 0, raise: 0, elbow: 0, foot: 0 },
  smoke: { leg: 0, knee: 0, arm: 0, bob: 0.004, lean: 0, raise: 0, elbow: 0, foot: 0 },
  window: { leg: 0, knee: 0, arm: 0, bob: 0.004, lean: 0.04, raise: 0, elbow: 0, foot: 0 },
  fold: { leg: 0, knee: 0, arm: 0, bob: 0.004, lean: -0.02, raise: 0, elbow: 0, foot: 0 },
  talk: { leg: 0, knee: 0, arm: 0, bob: 0.004, lean: 0, raise: 0, elbow: 0, foot: 0 },
  film: { leg: 0, knee: 0, arm: 0, bob: 0.004, lean: -0.03, raise: 0, elbow: 0, foot: 0 },
  umbrella: { leg: 0.4, knee: 0.5, arm: 0.3, bob: 0.018, lean: 0.03, raise: 0, elbow: 0.2, foot: 0.22 },
  hunch: { leg: 0.5, knee: 0.62, arm: 0.12, bob: 0.02, lean: 0.24, raise: 0, elbow: 0.9, foot: 0.25 },
  busk: { leg: 0, knee: 0, arm: 0, bob: 0.006, lean: 0.03, raise: 0, elbow: 0, foot: 0 },
  shout: { leg: 0, knee: 0, arm: 0, bob: 0.01, lean: 0.12, raise: 0, elbow: 0, foot: 0 },
};

/** A bone's turn: roll out to the side, twist, and forward swing, in radians. */
type Turn = readonly [number, number, number];

/** The body at one moment of a cycle: the hips' height over their rest, and each bone's turn. */
export interface ClipPose {
  bob: number;
  turns: Partial<Record<BoneName, Turn>>;
}

/** A clip as a function of the phase through its cycle, 0 to 2π. */
type ClipAt = (phase: number) => ClipPose;

/** The walking part of every gait: legs, feet, the swing of the arms, the bob and the lean. */
function walking(swing: Swing, phase: number): ClipPose {
  const leg = (offset: number): number => swing.leg * Math.sin(phase + offset);
  const knee = (offset: number): number => -swing.knee * Math.max(0, Math.cos(phase + offset));
  // Toe up as the leg reaches forward, pointed as it pushes off behind.
  const foot = (offset: number): number => swing.foot * Math.cos(phase + offset + 0.6);
  const arm = (offset: number): number => swing.raise - swing.arm * Math.sin(phase + offset);
  // The elbow bends more as the arm comes forward.
  const elbow = (offset: number): number => swing.elbow + 0.5 * swing.elbow * Math.max(0, -Math.sin(phase + offset));
  return {
    bob: swing.bob * Math.cos(2 * phase),
    turns: {
      torso: [0, 0.05 * swing.arm * Math.sin(phase), -swing.lean],
      head: [0, 0.04 * swing.leg * Math.sin(phase), swing.lean * 0.6],
      thighL: [0, 0, leg(0)],
      shinL: [0, 0, knee(0)],
      footL: [0, 0, foot(0)],
      thighR: [0, 0, leg(Math.PI)],
      shinR: [0, 0, knee(Math.PI)],
      footR: [0, 0, foot(Math.PI)],
      armL: [0, 0, arm(0)],
      armR: [0, 0, arm(Math.PI)],
      foreL: [0, 0, elbow(0)],
      foreR: [0, 0, elbow(Math.PI)],
    },
  };
}

/**
 * A standing body: weight shifting slowly from foot to foot, arms hanging and
 * moving a little. At the start of its cycle a plain stand is the bind pose.
 */
function standing(phase: number, lean = 0): ClipPose {
  const shift = 0.03 * Math.sin(phase);
  const ease = 0.5 - 0.5 * Math.cos(phase);
  return {
    bob: 0.004 * Math.cos(2 * phase),
    turns: {
      torso: [shift * 0.5, 0, -lean],
      thighL: [shift, 0, 0],
      thighR: [shift, 0, 0],
      armL: [-0.03 * ease, 0, 0.03 * Math.sin(phase)],
      armR: [0.03 * ease, 0, -0.03 * Math.sin(phase)],
      foreL: [0, 0, 0.1 * ease],
      foreR: [0, 0, 0.1 * ease],
    },
  };
}

/** A pose on top of another, bone by bone. */
function over(base: ClipPose, turns: Partial<Record<BoneName, Turn>>, bob = 0): ClipPose {
  return { bob: base.bob + bob, turns: { ...base.turns, ...turns } };
}

/** The clips that are not a plain walk, each as a function of the phase. */
const POSES: Partial<Record<Gait, ClipAt>> = {
  // The phone at the right ear, the head tipped to it, the other hand on the hip now and then.
  phone: (p) =>
    over(standing(p), {
      armR: [0.25, 0, 0.45],
      foreR: [0, 0, 2.45],
      head: [0.12, 0.2 * Math.sin(p), 0.05 * Math.sin(2 * p)],
      armL: [-0.35, 0, 0.1],
      foreL: [0, 0, 1.2 + 0.2 * Math.sin(p)],
    }),
  // A cigarette to the mouth once a cycle, held low beside the body the rest of it.
  smoke: (p) => {
    const draw = Math.max(0, Math.sin(p)) ** 2;
    return over(standing(p), {
      armR: [0.15 + 0.1 * draw, 0, 0.2 + 0.35 * draw],
      foreR: [0, 0, 1.1 + 1.25 * draw],
      head: [0, 0, 0.1 * draw],
      armL: [-0.2, 0, -0.1],
      foreL: [0, 0, 1.5],
    });
  },
  // Hands behind the back, looking along the window.
  window: (p) =>
    over(standing(p, 0.04), {
      armL: [0.25, 0, -0.35],
      armR: [-0.25, 0, -0.35],
      foreL: [0, 0, 0.35],
      foreR: [0, 0, 0.35],
      head: [0, 0.35 * Math.sin(p), -0.12],
    }),
  // Arms folded across the chest.
  fold: (p) =>
    over(standing(p, -0.02), {
      armL: [0.3, 0, 0.25],
      armR: [-0.3, 0, 0.25],
      foreL: [0, 0.5, 1.75],
      foreR: [0, -0.5, 1.75],
      head: [0, 0.15 * Math.sin(p), 0],
    }),
  // Talking with the hands: the right forearm lifts and falls, the head nods.
  talk: (p) =>
    over(standing(p), {
      armR: [0.05, 0, 0.35 + 0.15 * Math.sin(2 * p)],
      foreR: [0, 0, 1.1 + 0.45 * Math.sin(2 * p + 0.5)],
      armL: [-0.08, 0, 0.15 + 0.1 * Math.sin(p + 2)],
      foreL: [0, 0, 0.6 + 0.3 * Math.sin(p + 2.5)],
      head: [0, 0.1 * Math.sin(p), 0.06 * Math.sin(4 * p)],
    }),
  // A phone held up in both hands at arm's length, steady.
  film: (p) =>
    over(standing(p, -0.03), {
      armR: [0.2, 0, 1.25],
      foreR: [0, 0, 0.55],
      armL: [-0.2, 0, 1.25],
      foreL: [0, 0, 0.55],
      head: [0, 0.02 * Math.sin(p), 0.08],
    }),
  // A walk with the umbrella held up in the right hand and the left arm swinging.
  umbrella: (p) => {
    const walk = walking(SWINGS.umbrella, p);
    return over(walk, { armR: [0.12, 0, 0.35], foreR: [0, 0, 1.2] });
  },
  // Head down against the rain, hands pulled in.
  hunch: (p) => over(walking(SWINGS.hunch, p), { head: [0, 0, -0.1] }),
  // A guitar across the body: the left hand on the neck, the right strumming twice a cycle.
  busk: (p) =>
    over(standing(p, 0.03), {
      armL: [0.35, 0, 0.75],
      foreL: [0, 0.3, 1.35],
      armR: [-0.2, 0, 0.35],
      foreR: [0, 0, 1.25 + 0.22 * Math.sin(4 * p)],
      head: [0, 0.12 * Math.sin(p), -0.15 + 0.05 * Math.sin(2 * p)],
    }),
  // A fist shaken after a car: the right arm up, the forearm jerking.
  shout: (p) =>
    over(standing(p, 0.12), {
      armR: [0.1, 0, 2.3],
      foreR: [0, 0, 1.0 + 0.3 * Math.sin(6 * p)],
      armL: [-0.25, 0, 0.3],
      foreL: [0, 0, 0.5],
      head: [0, 0, 0.18],
    }),
};

/** The body of a gait at a phase of its cycle. */
export function clipPose(gait: Gait, phase: number): ClipPose {
  const pose = POSES[gait];
  if (pose !== undefined) return pose(phase);
  const swing = SWINGS[gait];
  // Every other gait with no leg swing is a standing one.
  return swing.leg === 0 && swing.raise === 0 ? standing(phase, swing.lean) : walking(swing, phase);
}
