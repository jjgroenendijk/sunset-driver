/**
 * The body a pedestrian is drawn with, and the walk cycles that move it (spec
 * sections 13.1, 22.1).
 *
 * The body is boxes, like the player's, each bound to one bone of a skeleton:
 * hips, torso, head, and a thigh, shin, foot, upper arm and forearm each side,
 * and the props a hand may hold. It is
 * a real `SkinnedMesh`, and each gait of `pedestrian-look.ts` is a generated
 * `AnimationClip` of keyframe tracks that swing the legs and arms against each
 * other and bob the hips. `AnimationClipCreator` has no clip that swings a
 * limb, so the tracks are built here.
 *
 * A `SkinnedMesh` is one draw per person, and a crowd is hundreds. So the clips
 * are played once, headless, through an `AnimationMixer`, and each bone's
 * matrix at every frame of every gait is written into a texture. The crowd is
 * then one instanced draw: each instance says which gait and how far through
 * its cycle, and the vertex shader of `pedestrian-material.ts` reads its bone's
 * matrix from the texture. Nothing here touches the renderer, so it runs in
 * the tests.
 */
import {
  AnimationClip,
  AnimationMixer,
  BoxGeometry,
  Bone,
  BufferAttribute,
  BufferGeometry,
  Euler,
  KeyframeTrack,
  MeshBasicMaterial,
  Quaternion,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GAITS, STRIDE_HEIGHT, type Gait } from '../sim/pedestrian-look.ts';
import { clipPose } from './pedestrian-clips.ts';

export { SWINGS } from './pedestrian-clips.ts';

/** The bones, in the order their matrices are written. */
export const BONES = [
  'hips',
  'torso',
  'head',
  'thighL',
  'shinL',
  'thighR',
  'shinR',
  'armL',
  'armR',
  // Added after the first nine, so the ragdoll's nine keep their places.
  'foreL',
  'foreR',
  'footL',
  'footR',
] as const;
export type BoneName = (typeof BONES)[number];

/** Frames of each cycle written into the texture. The shader blends between two. */
export const FRAMES = 32;

/** What colour a box of the body takes from its instance. */
export const PART_SKIN = 0;
export const PART_HAIR = 1;
export const PART_TOP = 2;
export const PART_LEGS = 3;
export const PART_SHOES = 4;

/**
 * The things a person may hold. Each is a part of its own, drawn only on an
 * instance whose prop is that part (`pedestrian-material.ts`).
 */
export const PART_PHONE = 5;
export const PART_SMOKE = 6;
export const PART_UMBRELLA = 7;
export const PART_GUITAR = 8;

/** The first part that is a prop rather than the body. */
export const PART_PROP = PART_PHONE;

/** The prop each gait holds, or 0 for none. */
export function propOf(gait: Gait): number {
  switch (gait) {
    case 'phone':
    case 'film':
      return PART_PHONE;
    case 'smoke':
      return PART_SMOKE;
    case 'umbrella':
      return PART_UMBRELLA;
    case 'busk':
      return PART_GUITAR;
    default:
      return 0;
  }
}

/** Keyframes of each clip; the last repeats the first so the clip loops. */
const KEYS = 32;

/** The proportions of the body, for a person {@link STRIDE_HEIGHT} tall. The instance scales it. */
const H = STRIDE_HEIGHT;
const HIP = 0.52 * H;
/** Where the hips stand in the bind pose, the point a stoop tips the upper body about. */
export const HIP_HEIGHT = HIP;
const KNEE = 0.28 * H;
const SHOULDER = 0.82 * H;
const SHOE = 0.05;
const ARM_TOP = SHOULDER - 0.04;
const ELBOW = ARM_TOP - 0.26;
const HAND = ARM_TOP - 0.51;
const HIP_ACROSS = 0.1;
const SHOULDER_ACROSS = 0.26;

/** Where each bone stands in the bind pose, in the model's frame, and its parent. */
export const JOINTS: Record<BoneName, { parent: BoneName | null; at: [number, number, number] }> = {
  hips: { parent: null, at: [0, HIP, 0] },
  torso: { parent: 'hips', at: [0, HIP, 0] },
  head: { parent: 'torso', at: [0, SHOULDER, 0] },
  thighL: { parent: 'hips', at: [0, HIP, -HIP_ACROSS] },
  shinL: { parent: 'thighL', at: [0, KNEE, -HIP_ACROSS] },
  thighR: { parent: 'hips', at: [0, HIP, HIP_ACROSS] },
  shinR: { parent: 'thighR', at: [0, KNEE, HIP_ACROSS] },
  armL: { parent: 'torso', at: [0, ARM_TOP, -SHOULDER_ACROSS] },
  armR: { parent: 'torso', at: [0, ARM_TOP, SHOULDER_ACROSS] },
  foreL: { parent: 'armL', at: [0, ELBOW, -SHOULDER_ACROSS] },
  foreR: { parent: 'armR', at: [0, ELBOW, SHOULDER_ACROSS] },
  footL: { parent: 'shinL', at: [0, SHOE, -HIP_ACROSS] },
  footR: { parent: 'shinR', at: [0, SHOE, HIP_ACROSS] },
};

/** The bone a bone added after the ragdoll's nine moves with when the ragdoll holds the body. */
export const CARRIER: Partial<Record<BoneName, BoneName>> = { foreL: 'armL', foreR: 'armR', footL: 'shinL', footR: 'shinR' };

/** One box of the body: its size along, up and across, its middle, its bone and its part. */
interface BodyBox {
  size: [number, number, number];
  at: [number, number, number];
  bone: BoneName;
  part: number;
}

/**
 * The boxes of the body. The model faces local +x, as the player's does, so
 * along is x and across is z.
 */
function bodyBoxes(): BodyBox[] {
  const boxes: BodyBox[] = [];
  const head = 0.13 * H;
  boxes.push({ size: [0.22, SHOULDER - HIP, 0.4], at: [0, (SHOULDER + HIP) / 2, 0], bone: 'torso', part: PART_TOP });
  boxes.push({ size: [head * 1.05, head * 1.15, head], at: [0, SHOULDER + 0.02 + head * 0.575, 0], bone: 'head', part: PART_SKIN });
  boxes.push({ size: [head * 1.12, head * 0.35, head * 1.08], at: [0.012, SHOULDER + 0.02 + head * 1.15, 0], bone: 'head', part: PART_HAIR });
  for (const side of ['L', 'R'] as const) {
    const z = side === 'L' ? -HIP_ACROSS : HIP_ACROSS;
    const arm = side === 'L' ? -SHOULDER_ACROSS : SHOULDER_ACROSS;
    boxes.push({ size: [0.15, HIP - KNEE, 0.15], at: [0, (HIP + KNEE) / 2, z], bone: `thigh${side}`, part: PART_LEGS });
    boxes.push({ size: [0.13, KNEE - SHOE, 0.13], at: [0, (KNEE + SHOE) / 2, z], bone: `shin${side}`, part: PART_LEGS });
    boxes.push({ size: [0.26, SHOE, 0.14], at: [0.05, SHOE / 2, z], bone: `foot${side}`, part: PART_SHOES });
    boxes.push({ size: [0.1, ARM_TOP - ELBOW, 0.1], at: [0, (ARM_TOP + ELBOW) / 2, arm], bone: `arm${side}`, part: PART_TOP });
    boxes.push({ size: [0.09, ELBOW - HAND + 0.05, 0.09], at: [0, (ELBOW + HAND + 0.05) / 2, arm], bone: `fore${side}`, part: PART_TOP });
    boxes.push({ size: [0.09, 0.1, 0.09], at: [0, HAND - 0.05, arm], bone: `fore${side}`, part: PART_SKIN });
  }
  // The props, in the right hand or across the body. In the bind pose the
  // forearm hangs, so what a raised hand holds upright lies along +x here.
  const hand = HAND - 0.06;
  boxes.push({ size: [0.03, 0.13, 0.07], at: [0.03, hand, SHOULDER_ACROSS - 0.03], bone: 'foreR', part: PART_PHONE });
  boxes.push({ size: [0.08, 0.016, 0.016], at: [0.07, hand, SHOULDER_ACROSS], bone: 'foreR', part: PART_SMOKE });
  boxes.push({ size: [0.85, 0.025, 0.025], at: [0.42, hand, SHOULDER_ACROSS], bone: 'foreR', part: PART_UMBRELLA });
  boxes.push({ size: [0.05, 0.95, 0.95], at: [0.85, hand, SHOULDER_ACROSS], bone: 'foreR', part: PART_UMBRELLA });
  boxes.push({ size: [0.09, 0.34, 0.32], at: [0.2, HIP + 0.1, 0.06], bone: 'torso', part: PART_GUITAR });
  boxes.push({ size: [0.05, 0.05, 0.5], at: [0.2, HIP + 0.24, -0.3], bone: 'torso', part: PART_GUITAR });
  return boxes;
}

/**
 * The body as one geometry. Each vertex carries its bone twice: as `bone`, a
 * float the crowd's shader reads, and as `skinIndex` and `skinWeight`, which a
 * `SkinnedMesh` reads. `part` says which instance colour it takes.
 */
export function pedestrianBody(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const box of bodyBoxes()) {
    const geometry = new BoxGeometry(...box.size).toNonIndexed();
    geometry.translate(...box.at);
    const count = geometry.getAttribute('position').count;
    const bone = BONES.indexOf(box.bone);
    const index = new Uint16Array(count * 4);
    const weight = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      index[i * 4] = bone;
      weight[i * 4] = 1;
    }
    geometry.setAttribute('bone', new BufferAttribute(new Float32Array(count).fill(bone), 1));
    geometry.setAttribute('part', new BufferAttribute(new Float32Array(count).fill(box.part), 1));
    geometry.setAttribute('skinIndex', new BufferAttribute(index, 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(weight, 4));
    geometry.deleteAttribute('uv');
    parts.push(geometry);
  }
  const body = mergeGeometries(parts) as BufferGeometry;
  for (const part of parts) part.dispose();
  return body;
}

/** The skinned body in its bind pose, with the skeleton the clips move. */
export function pedestrianRig(): { mesh: SkinnedMesh; skeleton: Skeleton } {
  const bones = new Map<BoneName, Bone>();
  for (const name of BONES) {
    const bone = new Bone();
    bone.name = name;
    bones.set(name, bone);
  }
  const mesh = new SkinnedMesh(pedestrianBody(), new MeshBasicMaterial());
  for (const name of BONES) {
    const joint = JOINTS[name];
    const bone = bones.get(name) as Bone;
    const parentAt = joint.parent === null ? [0, 0, 0] : JOINTS[joint.parent].at;
    bone.position.set(joint.at[0] - (parentAt[0] as number), joint.at[1] - (parentAt[1] as number), joint.at[2] - (parentAt[2] as number));
    if (joint.parent === null) mesh.add(bone);
    else (bones.get(joint.parent) as Bone).add(bone);
  }
  mesh.updateMatrixWorld(true);
  const skeleton = new Skeleton(BONES.map((name) => bones.get(name) as Bone));
  mesh.bind(skeleton);
  return { mesh, skeleton };
}

/**
 * The cycle of one gait, one second long, as keyframe tracks: the hips' height
 * and every other bone's turn, from `pedestrian-clips.ts`.
 */
export function walkClip(gait: Gait): AnimationClip {
  const times: number[] = [];
  for (let k = 0; k <= KEYS; k++) times.push(k / KEYS);
  const poses = times.map((t) => clipPose(gait, 2 * Math.PI * t));
  const q = new Quaternion();
  const euler = new Euler();
  const hips: number[] = [];
  for (const pose of poses) hips.push(0, HIP + pose.bob, 0);
  const tracks: KeyframeTrack[] = [new VectorKeyframeTrack('hips.position', times, hips)];
  for (const name of BONES) {
    if (name === 'hips') continue;
    const values: number[] = [];
    for (const pose of poses) {
      const turn = pose.turns[name] ?? REST;
      values.push(...q.setFromEuler(euler.set(turn[0], turn[1], turn[2])).toArray());
    }
    tracks.push(new QuaternionKeyframeTrack(`${name}.quaternion`, times, values));
  }
  return new AnimationClip(gait, 1, tracks);
}

const REST = [0, 0, 0] as const;

/**
 * Every bone's matrix at every frame of every gait, as the texels of an RGBA
 * float texture {@link BONES}.length × 4 wide and {@link GAITS}.length ×
 * {@link FRAMES} tall. Row `gait * FRAMES + frame` holds one frame; the four
 * texels from `bone * 4` are the four columns of that bone's matrix, which
 * carries a vertex of the bind pose to where the clip puts it.
 */
export function bakeWalks(): Float32Array {
  const { mesh, skeleton } = pedestrianRig();
  const width = BONES.length * 4;
  const data = new Float32Array(width * GAITS.length * FRAMES * 4);
  for (const [g, gait] of GAITS.entries()) {
    const mixer = new AnimationMixer(mesh);
    mixer.clipAction(walkClip(gait)).play();
    for (let f = 0; f < FRAMES; f++) {
      mixer.setTime(f / FRAMES);
      mesh.updateMatrixWorld(true);
      skeleton.update();
      const row = (g * FRAMES + f) * width * 4;
      data.set(skeleton.boneMatrices as Float32Array, row);
    }
    mixer.stopAllAction();
    skeleton.pose();
  }
  mesh.geometry.dispose();
  (mesh.material as MeshBasicMaterial).dispose();
  return data;
}

/** Where a bind-pose point of a bone ends up at a frame of a gait, read off the baked data. */
export function bakedPoint(data: Float32Array, gait: Gait, frame: number, bone: BoneName, point: Vector3): Vector3 {
  const width = BONES.length * 4;
  const at = (GAITS.indexOf(gait) * FRAMES + frame) * width * 4 + BONES.indexOf(bone) * 16;
  const m = data.subarray(at, at + 16);
  const { x, y, z } = point;
  return new Vector3(
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
  );
}
