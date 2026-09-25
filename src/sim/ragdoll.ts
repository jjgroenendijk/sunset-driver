/**
 * The Rapier ragdolls of the freshest casualties near the player (spec
 * sections 11.6, 13.1).
 *
 * Every hit person moves on the closed form of `casualty-motion.ts`. That is
 * cheap, and a replay and a save carry it as numbers. Up to
 * {@link RAGDOLL_CAP} of the bodies hit near the player also get a real
 * ragdoll: nine boxes joined like the crowd's rig (`ragdoll-body.ts`), thrown
 * with the speed of the hit, which tumbles and lands on the ground and the
 * decks and stops at a wall. It steps in the one `world.step` of `physics.ts`,
 * and it writes the place and turn of each bone into `Casualty.ragdoll` every
 * tick, so the renderer draws it from the record.
 *
 * A ragdoll freezes when it comes to rest, after {@link RAGDOLL_TICKS}, or
 * when the player goes {@link RAGDOLL_FAR} away. The bodies go, the last
 * transforms stay in the record, and the record is re-based so the closed form
 * agrees with where the ragdoll left the body: it lies there, it gets up there
 * when its time comes, and on getting up the record drops the transforms.
 *
 * A record is live while it holds transforms and still has a throw in it
 * (`push` or `lift` above zero); re-basing zeroes both. So a save caught
 * mid-ragdoll says so, and the bodies are built again from the transforms,
 * at rest. The record is the truth: a ragdoll whose record no longer holds
 * the array it writes into has been replaced by a load, and is built again.
 */
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { TICK_RATE } from './clock.ts';
import { casualtyPose, emptyCasualtyPose, restTicks, TUMBLE_RATE, type Casualty } from './casualty-motion.ts';
import { RAGDOLL_GROUPS, SHUNS_RAGDOLL } from './collision-groups.ts';
import type { Ground } from './ground-bodies.ts';
import { BONE_STRIDE, KNEE_LIMITS, RAGDOLL_BONES, RAGDOLL_PARTS } from './ragdoll-body.ts';
import type { SimState } from './simulation.ts';

/** Ragdolls live at once. A fresh hit past this freezes the oldest. */
const RAGDOLL_CAP = 3;

/** Metres from the player within which a hit gets a ragdoll. */
const RAGDOLL_NEAR = 40;

/** Metres from the player beyond which a ragdoll freezes. */
const RAGDOLL_FAR = 60;

/** Ticks a ragdoll lives at most: four seconds. */
export const RAGDOLL_TICKS = 4 * TICK_RATE;

/** Ticks every bone has to be still before the ragdoll counts as at rest: half a second. */
const REST_TICKS = Math.round(0.5 * TICK_RATE);

/** Metres a second, and radians a second, below which a bone counts as still. */
const REST_SPEED = 0.2;
const REST_SPIN = 0.8;

/** Damping on every bone, so a body settles rather than rocking. */
const LINEAR_DAMPING = 0.4;
const ANGULAR_DAMPING = 2;

/** Damping of the joints' slack muscles, in newton metre seconds a radian. */
const TONE_DAMPING = 1.5;

const FRICTION = 0.9;

/** The share of a throw's speed that spins the body over, as the closed form's tumble does. */
const SPIN_SHARE = 0.5;

/** The extra share of the push a car gives the thighs and the shins, which it sweeps. */
const SWEEP_THIGH = 0.25;
const SWEEP_SHIN = 0.6;

/** Metres above the hips the ground under them is looked for from, and how far down. */
const GROUND_LOOK = 0.1;
const GROUND_DEPTH = 4;

/** One ragdoll in the world. */
interface Live {
  id: number;
  /** The `since` of the record it answers, so a second hit is known. */
  since: number;
  /** The tick its time counts from. */
  start: number;
  /** Ticks every bone has been still in a row. */
  calm: number;
  bodies: RAPIER.RigidBody[];
  /** The array it writes into, which is the record's `ragdoll`. */
  pose: number[];
}

/** True while a record has a throw in it: a live ragdoll's, not a re-based one's. */
function thrown(record: Casualty): boolean {
  return record.push > 0 || record.lift > 0;
}

/** The record under an id, in a list kept in id order. */
function recordOf(list: readonly Casualty[], id: number): Casualty | undefined {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const record = list[mid] as Casualty;
    if (record.id === id) return record;
    if (record.id < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** The ragdolls of a {@link SimPhysics}, which owns the world they are built in. */
export class Ragdolls {
  private readonly world: RAPIER.World;
  private readonly ground: Ground;
  /** The live ragdolls, in id order. */
  private live: Live[] = [];
  private readonly scratch = emptyCasualtyPose();
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(world: RAPIER.World, ground: Ground) {
    this.world = world;
    this.ground = ground;
  }

  /** How many ragdolls are live, which the tests read. */
  get count(): number {
    return this.live.length;
  }

  /**
   * One tick, after the world has stepped and every hit of the tick has
   * landed: read the live ragdolls into their records and freeze the ones
   * that are done, then build ragdolls for this tick's hits, build again the
   * ones a load brought in, and let go of the transforms of anyone who got up.
   */
  step(state: SimState): void {
    const list = state.pedestrians.casualties;
    const p = state.player;
    const px = p.driving ? state.vehicle.x : p.x;
    const py = p.driving ? state.vehicle.z : p.y;
    const keep: Live[] = [];
    for (const doll of this.live) {
      const record = recordOf(list, doll.id);
      if (record === undefined || record.gone || record.ragdoll !== doll.pose) {
        this.remove(doll);
        continue;
      }
      if (record.since !== doll.since) {
        // Hit again while the ragdoll holds them: the new hit throws the bodies it has.
        if (record.since !== state.tick || !thrown(record)) {
          this.remove(doll);
          continue;
        }
        this.kick(doll, record, false);
        doll.since = record.since;
        doll.start = state.tick;
        doll.calm = 0;
      }
      this.read(doll);
      const still = this.still(doll);
      doll.calm = still ? doll.calm + 1 : 0;
      const away = hypot((doll.pose[0] as number) - px, (doll.pose[2] as number) - py);
      if (doll.calm >= REST_TICKS || state.tick - doll.start >= RAGDOLL_TICKS || away > RAGDOLL_FAR) {
        this.remove(doll);
        this.rebase(record, state.tick);
        continue;
      }
      keep.push(doll);
    }
    this.live = keep;
    for (const record of list) {
      if (record.gone || this.holds(record.id)) continue;
      const fresh = record.since === state.tick && record.down !== 0 && thrown(record);
      if (fresh) {
        if (hypot(record.x - px, record.y - py) > RAGDOLL_NEAR) {
          record.ragdoll = null;
          continue;
        }
        this.room(list, state.tick);
        // A body hit again after its ragdoll froze starts from where it lay.
        const doll = this.build(record, record.ragdoll, state.tick);
        this.kick(doll, record, true);
        continue;
      }
      if (record.ragdoll === null) continue;
      if (thrown(record)) {
        // A save caught mid-ragdoll: build it again from the record, at rest,
        // or freeze it at once if the player is far from it.
        const pose = record.ragdoll;
        if (hypot((pose[0] as number) - px, (pose[2] as number) - py) > RAGDOLL_FAR) {
          this.rebase(record, state.tick);
          continue;
        }
        this.room(list, state.tick);
        this.build(record, pose, record.since);
        continue;
      }
      // Re-based and lying still. Once they get up, the closed form draws them again.
      if (casualtyPose(record, state.tick, this.scratch).phase !== 'lie') record.ragdoll = null;
    }
    this.live.sort((a, b) => a.id - b.id);
  }

  /** Take every ragdoll out of the world, leaving the records as they are. */
  clear(): void {
    for (const doll of this.live) this.remove(doll);
    this.live = [];
  }

  private holds(id: number): boolean {
    return this.live.some((doll) => doll.id === id);
  }

  /** Make room for one more ragdoll: at the cap, the oldest freezes where it is. */
  private room(list: readonly Casualty[], tick: number): void {
    while (this.live.length >= RAGDOLL_CAP) {
      let oldest = 0;
      for (let i = 1; i < this.live.length; i++) {
        const a = this.live[i] as Live;
        const b = this.live[oldest] as Live;
        if (a.start < b.start || (a.start === b.start && a.id < b.id)) oldest = i;
      }
      const doll = this.live[oldest] as Live;
      this.live.splice(oldest, 1);
      this.remove(doll);
      const record = recordOf(list, doll.id);
      if (record !== undefined) this.rebase(record, tick);
    }
  }

  /**
   * Build a ragdoll for a record: from the transforms given, or else standing
   * where the record says, facing its heading. It is still until kicked.
   */
  private build(record: Casualty, from: number[] | null, start: number): Live {
    const pose = from ?? new Array<number>(RAGDOLL_PARTS.length * BONE_STRIDE).fill(0);
    if (from === null) this.stand(record, pose);
    const bodies: RAPIER.RigidBody[] = [];
    for (let i = 0; i < RAGDOLL_PARTS.length; i++) {
      const part = RAGDOLL_PARTS[i] as (typeof RAGDOLL_PARTS)[number];
      const o = i * BONE_STRIDE;
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(pose[o] as number, pose[o + 1] as number, pose[o + 2] as number)
          .setRotation({ x: pose[o + 3] as number, y: pose[o + 4] as number, z: pose[o + 5] as number, w: pose[o + 6] as number })
          .setLinearDamping(LINEAR_DAMPING)
          .setAngularDamping(ANGULAR_DAMPING)
          .setCcdEnabled(true),
      );
      // The body's origin is the bone's joint, so its box sits off it.
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(part.half[0], part.half[1], part.half[2])
          .setTranslation(part.centre[0] - part.at[0], part.centre[1] - part.at[1], part.centre[2] - part.at[2])
          .setMass(part.mass)
          .setFriction(FRICTION)
          .setRestitution(0)
          .setCollisionGroups(RAGDOLL_GROUPS),
        body,
      );
      bodies.push(body);
      if (part.parent >= 0) this.join(bodies[part.parent] as RAPIER.RigidBody, body, i);
    }
    record.ragdoll = pose;
    const doll: Live = { id: record.id, since: record.since, start, calm: 0, bodies, pose };
    this.live.push(doll);
    return doll;
  }

  /** Join a bone to the one it hangs from, at its own joint, and let the two pass through each other. */
  private join(parent: RAPIER.RigidBody, child: RAPIER.RigidBody, i: number): void {
    const part = RAGDOLL_PARTS[i] as (typeof RAGDOLL_PARTS)[number];
    const up = RAGDOLL_PARTS[part.parent] as (typeof RAGDOLL_PARTS)[number];
    const anchor1 = { x: part.at[0] - up.at[0], y: part.at[1] - up.at[1], z: part.at[2] - up.at[2] };
    const anchor2 = { x: 0, y: 0, z: 0 };
    if (part.joint === 'knee') {
      const joint = this.world.createImpulseJoint(
        RAPIER.JointData.revolute(anchor1, anchor2, { x: 0, y: 0, z: 1 }),
        parent,
        child,
        true,
      ) as RAPIER.RevoluteImpulseJoint;
      joint.setLimits(KNEE_LIMITS[0], KNEE_LIMITS[1]);
      joint.configureMotorPosition(0, part.tone, TONE_DAMPING);
      joint.setContactsEnabled(false);
      return;
    }
    const joint = this.world.createImpulseJoint(RAPIER.JointData.spherical(anchor1, anchor2), parent, child, true);
    // Rapier 0.20 hands a spherical joint back as a generic one, which has no
    // motor methods. The spherical class's own method needs only the handle
    // and the joint set, which every joint carries, so it is borrowed.
    const motor = RAPIER.SphericalImpulseJoint.prototype.configureMotorPosition;
    for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
      motor.call(joint as RAPIER.SphericalImpulseJoint, axis, 0, part.tone, TONE_DAMPING);
    }
    joint.setContactsEnabled(false);
  }

  /** The transforms of a person standing where the record starts, facing its heading. */
  private stand(record: Casualty, pose: number[]): void {
    // The model faces local +x, so a heading turns it by minus that about up.
    const qy = sin(-record.heading / 2);
    const qw = cos(-record.heading / 2);
    const c = cos(record.heading);
    const s = sin(record.heading);
    for (let i = 0; i < RAGDOLL_PARTS.length; i++) {
      const [ax, ay, az] = (RAGDOLL_PARTS[i] as (typeof RAGDOLL_PARTS)[number]).at;
      const o = i * BONE_STRIDE;
      // Local +x goes to (cos, sin) of the map and local +z to (-sin, cos).
      pose[o] = record.x + ax * c - az * s;
      pose[o + 1] = record.height + ay;
      pose[o + 2] = record.y + ax * s + az * c;
      pose[o + 3] = 0;
      pose[o + 4] = qy;
      pose[o + 5] = 0;
      pose[o + 6] = qw;
    }
  }

  /**
   * Give every bone the speed of a hit: the push along its way and the lift
   * up, and for a car more at the legs it swept. A hit brings a bone up to
   * that speed and never adds to a bone already going faster, so a car that
   * strikes the same body on tick after tick does not fling it further each
   * time. A fresh ragdoll also spins over to the side the record falls to.
   */
  private kick(doll: Live, record: Casualty, fresh: boolean): void {
    const dx = cos(record.dir);
    const dz = sin(record.dir);
    // A roll about the way of the push, as fast as the closed form's tumble.
    const spin = fresh ? record.side * 2 * Math.PI * TUMBLE_RATE * record.push * SPIN_SHARE : 0;
    const wx = dx * spin;
    const wz = dz * spin;
    const hips = (doll.bodies[0] as RAPIER.RigidBody).translation();
    for (let i = 0; i < doll.bodies.length; i++) {
      const body = doll.bodies[i] as RAPIER.RigidBody;
      const bone = RAGDOLL_BONES[i] as (typeof RAGDOLL_BONES)[number];
      const t = body.translation();
      const rx = t.x - hips.x;
      const ry = t.y - hips.y;
      const rz = t.z - hips.z;
      let sweep = 0;
      if (record.cause === 'car') sweep = bone.startsWith('shin') ? SWEEP_SHIN : bone.startsWith('thigh') ? SWEEP_THIGH : 0;
      const v = body.linvel();
      const gain = Math.max(0, record.push * (1 + sweep) - (v.x * dx + v.z * dz));
      const rise = Math.max(0, record.lift - v.y);
      // The speed of a point of a turning body: the spin crossed with where it is.
      body.setLinvel({ x: v.x + dx * gain - wz * ry, y: v.y + rise + wz * rx - wx * rz, z: v.z + dz * gain + wx * ry }, true);
      if (!fresh) continue;
      const w = body.angvel();
      body.setAngvel({ x: w.x + wx, y: w.y, z: w.z + wz }, true);
    }
  }

  /** Write every bone's place and turn into the record's array. */
  private read(doll: Live): void {
    const pose = doll.pose;
    for (let i = 0; i < doll.bodies.length; i++) {
      const body = doll.bodies[i] as RAPIER.RigidBody;
      const t = body.translation();
      const q = body.rotation();
      const o = i * BONE_STRIDE;
      pose[o] = t.x;
      pose[o + 1] = t.y;
      pose[o + 2] = t.z;
      pose[o + 3] = q.x;
      pose[o + 4] = q.y;
      pose[o + 5] = q.z;
      pose[o + 6] = q.w;
    }
  }

  /** True while no bone moves faster than the rest speeds. */
  private still(doll: Live): boolean {
    for (const body of doll.bodies) {
      const v = body.linvel();
      const w = body.angvel();
      if (hypot(v.x, v.y, v.z) > REST_SPEED || hypot(w.x, w.y, w.z) > REST_SPIN) return false;
    }
    return true;
  }

  private remove(doll: Live): void {
    // Removing a body takes its colliders and its joints with it.
    for (const body of doll.bodies) this.world.removeRigidBody(body);
    doll.bodies = [];
  }

  /**
   * Make the closed form agree with where the ragdoll left the body: it lies
   * on the ground under the hips, along the line from its knees to its head,
   * and its time on the ground counts from this tick.
   */
  private rebase(record: Casualty, tick: number): void {
    const pose = record.ragdoll;
    if (pose === null) return;
    const hx = pose[0] as number;
    const hh = pose[1] as number;
    const hz = pose[2] as number;
    const ground = this.groundUnder(hx, hh, hz);
    record.x = hx;
    record.y = hz;
    record.height = ground;
    record.rest = ground;
    record.push = 0;
    record.lift = 0;
    record.reach = 0;
    const head = RAGDOLL_BONES.indexOf('head') * BONE_STRIDE;
    const shinL = RAGDOLL_BONES.indexOf('shinL') * BONE_STRIDE;
    const shinR = RAGDOLL_BONES.indexOf('shinR') * BONE_STRIDE;
    const ax = (pose[head] as number) - ((pose[shinL] as number) + (pose[shinR] as number)) / 2;
    const az = (pose[head + 2] as number) - ((pose[shinL + 2] as number) + (pose[shinR + 2] as number)) / 2;
    if (hypot(ax, az) > 0.05) record.dir = atan2(az, ax);
    // With no throw left, the closed form comes to rest `restTicks` after the
    // hit, and lies `down` ticks after that. So the hit is put that far back.
    record.since = tick - restTicks(record);
  }

  /** The height of whatever the hips lie on: a deck, a car, or the ground. */
  private groundUnder(x: number, h: number, z: number): number {
    const ray = this.ray;
    ray.origin = { x, y: h + GROUND_LOOK, z };
    const hit = this.world.castRay(ray, GROUND_DEPTH, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, SHUNS_RAGDOLL);
    return hit === null ? this.ground.heightAt(x, z) : h + GROUND_LOOK - hit.timeOfImpact;
  }
}
