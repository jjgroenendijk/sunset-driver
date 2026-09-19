/**
 * The body a pedestrian is drawn with, and the walk cycles that move it (spec
 * sections 13.1, 22.1).
 *
 * The body is boxes, like the player's, each bound to one bone of a skeleton:
 * hips, torso, head, a thigh and a shin each side, and an arm each side. It is
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

/** The bones, in the order their matrices are written. */
export const BONES = ['hips', 'torso', 'head', 'thighL', 'shinL', 'thighR', 'shinR', 'armL', 'armR'] as const;
export type BoneName = (typeof BONES)[number];

/** Frames of each cycle written into the texture. The shader blends between two. */
export const FRAMES = 32;

/** What colour a box of the body takes from its instance. */
export const PART_SKIN = 0;
export const PART_HAIR = 1;
export const PART_TOP = 2;
export const PART_LEGS = 3;
export const PART_SHOES = 4;

/** How far each gait swings the body, in radians and metres. */
interface Swing {
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
}

export const SWINGS: Record<Gait, Swing> = {
  stroll: { leg: 0.42, knee: 0.55, arm: 0.35, bob: 0.02, lean: 0.02 },
  brisk: { leg: 0.52, knee: 0.65, arm: 0.5, bob: 0.025, lean: 0.05 },
  amble: { leg: 0.28, knee: 0.35, arm: 0.14, bob: 0.012, lean: 0.1 },
  run: { leg: 0.85, knee: 1.5, arm: 0.95, bob: 0.05, lean: 0.22 },
  stand: { leg: 0, knee: 0, arm: 0.03, bob: 0.004, lean: 0 },
};

/** Keyframes of each clip; the last repeats the first so the clip loops. */
const KEYS = 16;

/** The proportions of the body, for a person {@link STRIDE_HEIGHT} tall. The instance scales it. */
const H = STRIDE_HEIGHT;
const HIP = 0.52 * H;
const KNEE = 0.28 * H;
const SHOULDER = 0.82 * H;
const SHOE = 0.05;
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
  armL: { parent: 'torso', at: [0, SHOULDER - 0.04, -SHOULDER_ACROSS] },
  armR: { parent: 'torso', at: [0, SHOULDER - 0.04, SHOULDER_ACROSS] },
};

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
    boxes.push({ size: [0.26, SHOE, 0.14], at: [0.05, SHOE / 2, z], bone: `shin${side}`, part: PART_SHOES });
    const elbow = SHOULDER - 0.04 - 0.46;
    boxes.push({ size: [0.1, 0.46, 0.1], at: [0, SHOULDER - 0.04 - 0.23, arm], bone: `arm${side}`, part: PART_TOP });
    boxes.push({ size: [0.09, 0.1, 0.09], at: [0, elbow - 0.05, arm], bone: `arm${side}`, part: PART_SKIN });
  }
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
 * The walk cycle of one gait, one second long: each thigh swings forward and
 * back, a half cycle apart; the knee bends while its leg swings through; each
 * arm swings against the leg on its side; the hips bob at every step.
 */
export function walkClip(gait: Gait): AnimationClip {
  const swing = SWINGS[gait];
  const times: number[] = [];
  for (let k = 0; k <= KEYS; k++) times.push(k / KEYS);
  const turn = (name: BoneName, angle: (phase: number) => number, axis: 'y' | 'z' = 'z'): QuaternionKeyframeTrack => {
    const values: number[] = [];
    const q = new Quaternion();
    const euler = new Euler();
    for (const t of times) {
      const a = angle(2 * Math.PI * t);
      euler.set(0, axis === 'y' ? a : 0, axis === 'z' ? a : 0);
      values.push(...q.setFromEuler(euler).toArray());
    }
    return new QuaternionKeyframeTrack(`${name}.quaternion`, times, values);
  };
  // A turn about +z carries a hanging limb forward, to +x; a torso tips forward the other way.
  const leg = (offset: number) => (p: number) => swing.leg * Math.sin(p + offset);
  const knee = (offset: number) => (p: number) => -swing.knee * Math.max(0, Math.cos(p + offset));
  const arm = (offset: number) => (p: number) => -swing.arm * Math.sin(p + offset);
  const hips: number[] = [];
  for (const t of times) hips.push(0, HIP + swing.bob * Math.cos(4 * Math.PI * t), 0);
  const tracks = [
    new VectorKeyframeTrack('hips.position', times, hips),
    turn('torso', () => -swing.lean),
    turn('thighL', leg(0)),
    turn('shinL', knee(0)),
    turn('thighR', leg(Math.PI)),
    turn('shinR', knee(Math.PI)),
    turn('armL', arm(0)),
    turn('armR', arm(Math.PI)),
    turn('head', (p) => 0.04 * swing.leg * Math.sin(p), 'y'),
  ];
  return new AnimationClip(gait, 1, tracks);
}

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
