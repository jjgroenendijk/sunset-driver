/**
 * The body of a person who has been hit, posed (spec sections 11.6, 13.1).
 *
 * `casualty-motion.ts` says where a casualty is and what they are doing: a
 * phase, and how far through it. This turns that into the nine bone matrices
 * of the crowd's rig (`pedestrian-rig.ts`), the same matrices `bakeWalks`
 * writes. The crowd's shader reads them from a texture, so a casualty is drawn
 * with the crowd's own body and material.
 *
 * A pose is built as three parts: the turn of the whole body about the hips,
 * where the hips are, and the turn of each other bone against its parent. The
 * whole body's turn carries the heading, so the instance is drawn with a
 * heading of zero. The rig is then moved to the pose and its matrices read
 * off, which is cheap enough to do for every casualty in view every frame.
 *
 * Where the Rapier ragdoll holds a body, its bones are drawn from where the
 * ragdoll put them instead (`ragdollMatrices`).
 */
import { Euler, Matrix4, Quaternion, Vector3, type Bone, type BufferGeometry, type Skeleton, type SkinnedMesh } from 'three';
import type { Casualty, CasualtyPose } from '../sim/casualty-motion.ts';
import { BONES, CARRIER, JOINTS, PART_PROP, pedestrianRig, SWINGS } from './pedestrian-rig.ts';

/** Floats the matrices of one body take: sixteen for each bone. */
export const BODY_FLOATS = BONES.length * 16;

/** Where the hips stand, and the knees, in the rig's bind pose. */
const HIP = JOINTS.hips.at[1];
const KNEE = JOINTS.shinL.at[1];

/**
 * Metres the line from the hips to the head lies above the ground. The torso
 * is 0.22 m deep and 0.4 m wide, so this keeps its lowest face on the ground
 * when the body is rolled a little onto one side.
 */
const LIE_LIFT = 0.14;

/** Metres the hips of a person on one knee stand above the ground. */
const KNEEL_HIPS = KNEE + 0.03;

/** The share of a `rise` spent getting from lying to kneeling. The rest is kneeling to standing. */
const TO_KNEEL = 0.55;

const INDEX = {
  torso: 1,
  head: 2,
  thighL: 3,
  shinL: 4,
  thighR: 5,
  shinR: 6,
  armL: 7,
  armR: 8,
} as const;

/** A pose: the body's turn, where its hips are, and each bone's turn. Bone 0 is the hips, turned by `root`. */
interface Body {
  root: Quaternion;
  hips: Vector3;
  bones: Quaternion[];
}

function body(): Body {
  return { root: new Quaternion(), hips: new Vector3(), bones: BONES.map(() => new Quaternion()) };
}

/** A number in [0, 1) that depends only on its two keys: how one body lies differently from the next. */
export function vary(id: number, key: number): number {
  let h = Math.imul(id + 1, 0x9e3779b1) ^ Math.imul(key + 7, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

export class CasualtyPoser {
  private readonly mesh: SkinnedMesh;
  private readonly skeleton: Skeleton;
  private readonly bones: Bone[];
  private readonly a = body();
  private readonly b = body();
  private readonly out = body();
  private readonly euler = new Euler();
  private readonly q = new Quaternion();
  private readonly m = new Matrix4();
  private readonly front = new Vector3();
  private readonly head = new Vector3();
  private readonly side = new Vector3();
  private readonly v = new Vector3();
  /** The corners of the body's boxes, four numbers each: the bone, then x, y and z in the bind pose. */
  private readonly corners: Float32Array;

  constructor() {
    const rig = pedestrianRig();
    this.mesh = rig.mesh;
    this.skeleton = rig.skeleton;
    this.bones = rig.skeleton.bones;
    this.corners = cornersOf(rig.mesh.geometry);
  }

  /**
   * Write the bone matrices of a casualty at a pose into `out` from `at`. The
   * body is placed about the ground under its hips, `pose.x`, `pose.height`,
   * `pose.y`, and drawn with a heading of zero.
   */
  write(record: Casualty, pose: CasualtyPose, out: Float32Array, at: number): void {
    const target = this.out;
    switch (pose.phase) {
      case 'fall':
        this.fall(record, pose, target);
        break;
      case 'air':
        this.air(pose, target);
        break;
      case 'lie':
        this.lie(record, pose, target);
        break;
      case 'rise':
        this.rise(record, pose, target);
        break;
      case 'crawl':
        this.crawl(pose, target);
        break;
      case 'limp':
        this.walk(target, pose.dir, pose.cycle, 'limp', record.side);
        break;
      case 'run':
        this.walk(target, pose.dir, pose.cycle, 'run', 0);
        break;
      case 'stagger':
        this.stagger(pose, target);
        break;
      case 'stand':
        this.stand(target, pose.heading);
        break;
    }
    this.commit(target, out, at);
    this.settle(out, at, restOf(pose));
  }

  /**
   * Write a person on one knee, facing `heading`, reaching down in front of
   * them: a medic working on a body, or a casualty halfway up.
   */
  writeKneel(heading: number, out: Float32Array, at: number): void {
    this.kneel(this.out, heading, 1);
    this.commit(this.out, out, at);
    this.settle(out, at, 1);
  }

  /**
   * Move a posed body up so no corner of it is under the ground. With `rest`
   * at 1, move it down too, so its lowest corner is on the ground; below 1,
   * only that share of the way down. The limbs of a pose are placed by angle,
   * so only this can promise a lying body neither sinks into the road nor
   * floats over it.
   */
  private settle(out: Float32Array, at: number, rest: number): void {
    const c = this.corners;
    let lowest = Infinity;
    for (let i = 0; i < c.length; i += 4) {
      const m = at + (c[i] as number) * 16;
      const y =
        (out[m + 1] as number) * (c[i + 1] as number) +
        (out[m + 5] as number) * (c[i + 2] as number) +
        (out[m + 9] as number) * (c[i + 3] as number) +
        (out[m + 13] as number);
      if (y < lowest) lowest = y;
    }
    const shift = lowest < 0 ? -lowest : -lowest * rest;
    if (shift === 0) return;
    for (let b = 0; b < BONES.length; b++) out[at + b * 16 + 13] = (out[at + b * 16 + 13] as number) + shift;
  }

  /** Move the rig to a pose and copy its bone matrices out. */
  private commit(pose: Body, out: Float32Array, at: number): void {
    const hips = this.bones[0] as Bone;
    hips.position.copy(pose.hips);
    hips.quaternion.copy(pose.root);
    for (let i = 1; i < BONES.length; i++) (this.bones[i] as Bone).quaternion.copy(pose.bones[i] as Quaternion);
    this.mesh.updateMatrixWorld(true);
    this.skeleton.update();
    out.set(this.skeleton.boneMatrices as Float32Array, at);
  }

  /** Set a bone's turn: a swing forward about z, a twist about its length, and a lift out to the side about x. */
  private turn(pose: Body, bone: number, out: number, twist: number, swing: number): void {
    (pose.bones[bone] as Quaternion).setFromEuler(this.euler.set(out, twist, swing));
  }

  /** The body's turn from the way its front faces and the way its head points, both in the world. */
  private frame(q: Quaternion, front: Vector3, head: Vector3): Quaternion {
    this.side.crossVectors(front, head);
    return q.setFromRotationMatrix(this.m.makeBasis(front, head, this.side));
  }

  private upright(q: Quaternion, heading: number): Quaternion {
    return this.frame(q, this.front.set(Math.cos(heading), 0, Math.sin(heading)), this.head.set(0, 1, 0));
  }

  private stand(pose: Body, heading: number): void {
    this.upright(pose.root, heading);
    pose.hips.set(0, HIP, 0);
    for (const q of pose.bones) q.identity();
  }

  /**
   * Flat on the ground, the head along the push. Someone pushed backwards lies
   * on their back, anyone else on their front. The arms and legs lie out in
   * the plane of the ground, so none of them goes into it, and each body
   * places them its own way.
   */
  private lie(record: Casualty, pose: CasualtyPose, out: Body): void {
    const back = Math.cos(pose.dir - pose.heading) < 0;
    this.frame(out.root, this.front.set(0, back ? 1 : -1, 0), this.head.set(Math.cos(pose.dir), 0, Math.sin(pose.dir)));
    // A little roll onto one side, about the body's own length.
    out.root.multiply(this.q.setFromAxisAngle(this.v.set(0, 1, 0), (vary(record.id, 1) - 0.5) * 0.14));
    out.hips.set(0, LIE_LIFT, 0);
    const id = record.id;
    for (const q of out.bones) q.identity();
    this.turn(out, INDEX.armL, 0.35 + 2.3 * vary(id, 2), 0, 0);
    this.turn(out, INDEX.armR, -(0.35 + 2.3 * vary(id, 3)), 0, 0);
    this.turn(out, INDEX.head, 0, (vary(id, 4) - 0.5) * 1.6, 0);
    this.turn(out, INDEX.torso, 0, (vary(id, 5) - 0.5) * 0.3, 0);
    // One leg is drawn up with its knee out to the side, the other lies straight.
    const bent = record.side > 0 ? INDEX.thighR : INDEX.thighL;
    const straight = bent === INDEX.thighR ? INDEX.thighL : INDEX.thighR;
    const out1 = bent === INDEX.thighR ? -1 : 1;
    // Turned a quarter about its length, the thigh bends its knee in the plane of the ground.
    this.turn(out, bent, out1 * (0.15 + 0.35 * vary(id, 6)), (-out1 * Math.PI) / 2, 0);
    this.turn(out, bent + 1, 0, 0, -(0.3 + 1.1 * vary(id, 7)));
    this.turn(out, straight, -out1 * (0.05 + 0.25 * vary(id, 8)), 0, 0);
  }

  /** Going over from standing, about the feet, to lying where the fall ends. The arms fly up on the way. */
  private fall(record: Casualty, pose: CasualtyPose, out: Body): void {
    const s = pose.progress * pose.progress;
    const stand = this.a;
    const lie = this.b;
    this.stand(stand, pose.heading);
    this.lie(record, pose, lie);
    out.root.slerpQuaternions(stand.root, lie.root, s);
    // The hips come down as they would turning about the feet.
    out.hips.set(0, LIE_LIFT + (HIP - LIE_LIFT) * Math.cos((s * Math.PI) / 2), 0);
    const fling = Math.sin(Math.PI * pose.progress);
    for (let i = 1; i < BONES.length; i++) {
      (out.bones[i] as Quaternion).slerpQuaternions(stand.bones[i] as Quaternion, lie.bones[i] as Quaternion, s);
    }
    this.fling(out, INDEX.armL, 0.5 * fling, 1.3 * fling);
    this.fling(out, INDEX.armR, -0.5 * fling, 1.1 * fling);
    this.fling(out, INDEX.thighL, 0, 0.3 * fling);
  }

  /** Add a turn out to the side and forward on top of what a bone already has. */
  private fling(pose: Body, bone: number, out: number, swing: number): void {
    (pose.bones[bone] as Quaternion).multiply(this.q.setFromEuler(this.euler.set(out, 0, swing)));
  }

  /**
   * Thrown: the body spins about its side as it flies, limbs splayed. The hips
   * are lifted by the arc, and by more when the body is upright, so the feet
   * or the head never go into the ground.
   */
  private air(pose: CasualtyPose, out: Body): void {
    this.upright(out.root, pose.dir);
    const spin = this.q.setFromAxisAngle(this.side, -pose.tumble);
    out.root.premultiply(spin);
    const up = Math.abs(Math.cos(pose.tumble));
    out.hips.set(0, Math.max(0, pose.lift) + LIE_LIFT + (HIP - LIE_LIFT) * up, 0);
    this.turn(out, INDEX.torso, 0, 0, 0.2);
    this.turn(out, INDEX.head, 0, 0, 0.3);
    this.turn(out, INDEX.armL, 1.3, 0, 0.7);
    this.turn(out, INDEX.armR, -1.5, 0, -0.4);
    this.turn(out, INDEX.thighL, 0.35, 0, 0.6);
    this.turn(out, INDEX.shinL, 0, 0, -0.7);
    this.turn(out, INDEX.thighR, -0.3, 0, -0.4);
    this.turn(out, INDEX.shinR, 0, 0, -0.3);
  }

  /**
   * On one knee, facing `heading`: the left foot planted in front, the right
   * knee on the ground, bent over towards what is in front. `reach` is how far
   * the arms go down, 0 to 1.
   */
  private kneel(pose: Body, heading: number, reach: number): void {
    this.upright(pose.root, heading);
    pose.hips.set(0, KNEEL_HIPS, 0);
    for (const q of pose.bones) q.identity();
    this.turn(pose, INDEX.torso, 0, 0, -0.3);
    this.turn(pose, INDEX.head, 0, 0, -0.35);
    this.turn(pose, INDEX.thighL, 0, 0, 1.45);
    this.turn(pose, INDEX.shinL, 0, 0, -1.45);
    this.turn(pose, INDEX.thighR, 0, 0, -0.15);
    this.turn(pose, INDEX.shinR, 0, 0, -1.7);
    this.turn(pose, INDEX.armL, 0.1, 0, 0.3 + 0.8 * reach);
    this.turn(pose, INDEX.armR, -0.1, 0, 0.3 + 0.7 * reach);
  }

  /** From lying to standing, through a kneel, facing the way they will move off. */
  private rise(record: Casualty, pose: CasualtyPose, out: Body): void {
    const p = pose.progress;
    const from = this.a;
    const to = this.b;
    let t: number;
    if (p < TO_KNEEL) {
      this.lie(record, pose, from);
      this.kneel(to, pose.dir, 0.3);
      t = smooth(p / TO_KNEEL);
    } else {
      this.kneel(from, pose.dir, 0.3);
      this.stand(to, pose.dir);
      t = smooth((p - TO_KNEEL) / (1 - TO_KNEEL));
    }
    out.root.slerpQuaternions(from.root, to.root, t);
    out.hips.lerpVectors(from.hips, to.hips, t);
    for (let i = 1; i < BONES.length; i++) {
      (out.bones[i] as Quaternion).slerpQuaternions(from.bones[i] as Quaternion, to.bones[i] as Quaternion, t);
    }
  }

  /** Face down along the way they go, the head up, pulling with one arm and pushing with the other leg in turn. */
  private crawl(pose: CasualtyPose, out: Body): void {
    this.frame(out.root, this.front.set(0, -1, 0), this.head.set(Math.cos(pose.dir), 0, Math.sin(pose.dir)));
    out.hips.set(0, LIE_LIFT + 0.03, 0);
    for (const q of out.bones) q.identity();
    const s = Math.sin(2 * Math.PI * pose.cycle);
    this.turn(out, INDEX.head, 0, 0, 0.4);
    this.turn(out, INDEX.armL, 2.3 + 0.5 * s, 0, 0);
    this.turn(out, INDEX.armR, -(2.3 - 0.5 * s), 0, 0);
    this.turn(out, INDEX.thighL, 0.2 + 0.25 * Math.max(0, -s), -Math.PI / 2, 0);
    this.turn(out, INDEX.shinL, 0, 0, -(0.3 + 0.9 * Math.max(0, -s)));
    this.turn(out, INDEX.thighR, -(0.2 + 0.25 * Math.max(0, s)), Math.PI / 2, 0);
    this.turn(out, INDEX.shinR, 0, 0, -(0.3 + 0.9 * Math.max(0, s)));
  }

  /** Knocked back a step and leaning back, upright again by the end. */
  private stagger(pose: CasualtyPose, out: Body): void {
    this.stand(out, pose.heading);
    const lean = Math.sin(Math.PI * pose.progress);
    out.root.multiply(this.q.setFromAxisAngle(this.v.set(0, 0, 1), 0.3 * lean));
    out.hips.y = HIP - 0.06 * lean;
    this.turn(out, INDEX.torso, 0, 0, 0.2 * lean);
    this.turn(out, INDEX.armL, 0.5 * lean, 0, 0.9 * lean);
    this.turn(out, INDEX.armR, -0.4 * lean, 0, 0.7 * lean);
    this.turn(out, INDEX.thighR, 0, 0, -0.35 * lean);
    this.turn(out, INDEX.thighL, 0, 0, 0.15 * lean);
  }

  /**
   * A walk cycle, as `walkClip` swings the rig. A `limp` keeps the knee of one
   * leg straight, swings it less, and leans the body over it; `side` says which.
   */
  private walk(pose: Body, heading: number, cycle: number, kind: 'limp' | 'run', side: number): void {
    const swing = SWINGS[kind === 'run' ? 'run' : 'stroll'];
    const p = 2 * Math.PI * cycle;
    this.upright(pose.root, heading);
    for (const q of pose.bones) q.identity();
    const stiffL = kind === 'limp' && side < 0;
    const stiffR = kind === 'limp' && side >= 0;
    const leg = (thigh: number, offset: number, stiff: boolean): void => {
      this.turn(pose, thigh, 0, 0, (stiff ? 0.5 : 1) * swing.leg * Math.sin(p + offset));
      this.turn(pose, thigh + 1, 0, 0, stiff ? 0 : -swing.knee * Math.max(0, Math.cos(p + offset)));
    };
    leg(INDEX.thighL, 0, stiffL);
    leg(INDEX.thighR, Math.PI, stiffR);
    this.turn(pose, INDEX.armL, 0, 0, -swing.arm * Math.sin(p));
    this.turn(pose, INDEX.armR, 0, 0, -swing.arm * Math.sin(p + Math.PI));
    if (kind === 'run') {
      this.turn(pose, INDEX.torso, 0, 0, -swing.lean);
      pose.hips.set(0, HIP + swing.bob * Math.cos(2 * p), 0);
      return;
    }
    // The body dips and leans over the bad leg each time it takes the weight.
    const load = 0.5 + 0.5 * Math.sin(stiffR ? p : p + Math.PI);
    this.turn(pose, INDEX.torso, (stiffR ? 1 : -1) * (0.08 + 0.1 * load), 0, -0.15);
    pose.hips.set(0, HIP - 0.05 * load, 0);
  }
}

/**
 * The bone matrices of a body the ragdoll holds, from its seven numbers a
 * bone: world place, then world turn. The matrices are written about `place`,
 * the hips' own place, and divided by `scale`, the size the shader draws the
 * body at, so the shader's scaling and placing put each bone back where the
 * ragdoll has it. The ragdoll holds the first nine bones; a forearm or a foot
 * moves with the bone it hangs from, so it takes that bone's matrix.
 */
export function ragdollMatrices(values: readonly number[], place: Vector3, scale: number, out: Float32Array, at: number): void {
  const m = scratch.m;
  for (let i = 0; i < BONES.length; i++) {
    const carrier = CARRIER[BONES[i] as (typeof BONES)[number]];
    if (carrier !== undefined) {
      const from = at + BONES.indexOf(carrier) * 16;
      out.copyWithin(at + i * 16, from, from + 16);
      continue;
    }
    const k = i * 7;
    const joint = JOINTS[BONES[i] as (typeof BONES)[number]].at;
    scratch.q.set(values[k + 3] as number, values[k + 4] as number, values[k + 5] as number, values[k + 6] as number);
    scratch.p.set(values[k] as number, values[k + 1] as number, values[k + 2] as number).sub(place).divideScalar(scale);
    // The bone's frame in the world, after the offset of the bind pose is taken off.
    m.makeRotationFromQuaternion(scratch.q);
    scratch.v.set(-joint[0], -joint[1], -joint[2]).applyQuaternion(scratch.q).add(scratch.p);
    m.setPosition(scratch.v);
    m.toArray(out, at + i * 16);
  }
}

/**
 * How far a pose is brought down onto the ground: all the way for a body lying
 * on it, not at all for one on its feet or in the air, and a share of the way
 * through a fall or a rise, so neither jumps where it meets the lying pose.
 */
function restOf(pose: CasualtyPose): number {
  switch (pose.phase) {
    case 'lie':
    case 'crawl':
      return 1;
    case 'fall':
      return pose.progress * pose.progress;
    case 'rise':
      return Math.max(0, 1 - pose.progress / TO_KNEEL);
    default:
      return 0;
  }
}

/** The distinct corners of the body's boxes, with the bone each moves with. A casualty holds no prop. */
function cornersOf(geometry: BufferGeometry): Float32Array {
  const position = geometry.getAttribute('position');
  const bone = geometry.getAttribute('bone');
  const part = geometry.getAttribute('part');
  const seen = new Set<string>();
  const corners: number[] = [];
  for (let i = 0; i < position.count; i++) {
    if (part.getX(i) >= PART_PROP) continue;
    const corner = [bone.getX(i), position.getX(i), position.getY(i), position.getZ(i)];
    const key = corner.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    corners.push(...corner);
  }
  return new Float32Array(corners);
}

const scratch = { m: new Matrix4(), q: new Quaternion(), p: new Vector3(), v: new Vector3() };
