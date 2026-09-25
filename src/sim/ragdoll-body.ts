/**
 * The body a ragdoll is built from: nine boxes, one to each bone of the
 * crowd's rig (`src/render/pedestrian-rig.ts`), and the joints between them.
 *
 * The numbers are the rig's, copied here because `src/sim` may not import
 * `src/render`. `test/ragdoll.test.ts` holds the two to the same joints.
 *
 * Everything is in the model's frame, as the rig's is: the model faces local
 * +x, `y` is up and `z` is across, with the left side at -z. A person stands
 * {@link STRIDE_HEIGHT} tall with their feet at the origin.
 */
import { STRIDE_HEIGHT } from './pedestrian-look.ts';

/** The bones, in the order of the rig's, which is the order of `Casualty.ragdoll`. */
export const RAGDOLL_BONES = ['hips', 'torso', 'head', 'thighL', 'shinL', 'thighR', 'shinR', 'armL', 'armR'] as const;
type RagdollBone = (typeof RAGDOLL_BONES)[number];

/** Numbers a bone takes in `Casualty.ragdoll`: its place, then its turn as a quaternion. */
export const BONE_STRIDE = 7;

/** One bone of the ragdoll. */
export interface RagdollPart {
  bone: RagdollBone;
  /** The index of the bone it hangs from, or -1 for the hips. */
  parent: number;
  /** Where its joint stands in the bind pose. This is the origin of the bone and of its body. */
  at: readonly [number, number, number];
  /** The middle of its box in the bind pose, and the half sizes of the box. */
  centre: readonly [number, number, number];
  half: readonly [number, number, number];
  /** Kilograms. */
  mass: number;
  /** A ball joint turns every way; a knee turns about `z` only, and one way. */
  joint: 'ball' | 'knee';
  /** How hard the joint holds the bind pose, in newton metres a radian: a slack muscle. */
  tone: number;
}

const H = STRIDE_HEIGHT;
const HIP = 0.52 * H;
const KNEE = 0.28 * H;
const SHOULDER = 0.82 * H;
const HIP_ACROSS = 0.1;
const SHOULDER_ACROSS = 0.26;
const HEAD = 0.13 * H;
const ARM = 0.56;

/**
 * The boxes are the rig's, a little simplified: the head takes in the hair,
 * the shin the shoe, the arm the hand. The rig draws nothing on the hips, so
 * the ragdoll gives them a pelvis between the thighs. The torso starts a
 * little above the hip joint, so a thigh does not touch it while standing.
 */
export const RAGDOLL_PARTS: readonly RagdollPart[] = [
  { bone: 'hips', parent: -1, at: [0, HIP, 0], centre: [0, HIP - 0.08, 0], half: [0.1, 0.08, 0.17], mass: 11, joint: 'ball', tone: 0 },
  {
    bone: 'torso',
    parent: 0,
    at: [0, HIP, 0],
    centre: [0, (SHOULDER + HIP + 0.02) / 2, 0],
    half: [0.11, (SHOULDER - HIP - 0.02) / 2, 0.2],
    mass: 26,
    joint: 'ball',
    tone: 60,
  },
  {
    bone: 'head',
    parent: 1,
    at: [0, SHOULDER, 0],
    centre: [0, SHOULDER + 0.02 + HEAD * 0.65, 0],
    half: [HEAD * 0.55, HEAD * 0.65, HEAD * 0.52],
    mass: 5.5,
    joint: 'ball',
    tone: 12,
  },
  ...leg('L', -HIP_ACROSS),
  ...leg('R', HIP_ACROSS),
  arm('L', -SHOULDER_ACROSS),
  arm('R', SHOULDER_ACROSS),
];

/** A thigh and a shin, the shin hanging from the thigh by the knee. */
function leg(side: 'L' | 'R', z: number): RagdollPart[] {
  const thigh = RAGDOLL_BONES.indexOf(`thigh${side}`);
  return [
    { bone: `thigh${side}`, parent: 0, at: [0, HIP, z], centre: [0, (HIP + KNEE) / 2, z], half: [0.075, (HIP - KNEE) / 2, 0.075], mass: 8, joint: 'ball', tone: 30 },
    { bone: `shin${side}`, parent: thigh, at: [0, KNEE, z], centre: [0.015, KNEE / 2, z], half: [0.08, KNEE / 2, 0.065], mass: 4.5, joint: 'knee', tone: 4 },
  ];
}

/** An arm, from the shoulder to the hand. */
function arm(side: 'L' | 'R', z: number): RagdollPart {
  const top = SHOULDER - 0.04;
  return { bone: `arm${side}`, parent: 1, at: [0, top, z], centre: [0, top - ARM / 2, z], half: [0.05, ARM / 2, 0.05], mass: 3.75, joint: 'ball', tone: 6 };
}

/** Radians a knee bends through, least and most: it bends so the shin goes back, and never forward. */
export const KNEE_LIMITS: readonly [number, number] = [-2.4, 0];
