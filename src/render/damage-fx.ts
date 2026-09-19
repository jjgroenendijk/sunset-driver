/**
 * The smoke, the flames, the embers and the blast of a damaged vehicle (spec
 * sections 11.3, 20.3).
 *
 * `src/sim/damage.ts` says what state a vehicle is in and this draws it. A car
 * that is merely dented shows nothing here; one that is smoking trails a plume
 * from its engine, one that is burning stands in flames, and one that reaches
 * the end of its fuse throws a burst out and then smoulders.
 *
 * The blazes of `src/sim/fire.ts` — what a wreck leaves burning on the ground
 * — are drawn from the same two batches, so every fire in the scene costs the
 * frame the same two draw calls however many there are. A blaze throws embers
 * as well as flame: a few small puffs that fly further and live longer, which
 * is what tells a fire on the ground from a car alight.
 *
 * It is two draw calls, whatever is going on: one batch of puffs blended the
 * ordinary way for the smoke and one blended additively for the fire. A puff is
 * a disc laid flat, because the camera of spec section 10.7 looks straight down
 * at it, and it is placed and coloured from its age alone, so a frame only ever
 * reads the record and the tick.
 *
 * Every puff is jittered from `rngFor(seed, tick, Subsystem.Damage, n)`, so the
 * same fire at the same tick of the same seed looks the same in a replay as it
 * did when it was driven.
 */
import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  Group,
  InstancedMesh,
  MeshBasicMaterial,
  NormalBlending,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { rngFor, Subsystem } from '../core/rng.ts';
import { isSmoking, type DamageState } from '../sim/damage.ts';
import type { Blaze } from '../sim/fire.ts';
import { TICK_RATE } from '../sim/clock.ts';
import type { VehicleSpec, VehicleState } from '../sim/vehicle.ts';
import { tinted } from './tint.ts';

/** Puffs each batch holds. The oldest is taken when a new one has nowhere to go. */
export const SMOKE_CAP = 48;
export const FLAME_CAP = 48;

/** Ticks between puffs of smoke, and between the flames of a fire. */
const SMOKE_PERIOD = 9;
const FLAME_PERIOD = 4;

/** Ticks a puff of smoke lives for, and a flame. */
const SMOKE_LIFE = 110;
const FLAME_LIFE = 40;

/** Ticks between the flames of a blaze, and between its embers. */
const BLAZE_PERIOD = 5;
const EMBER_PERIOD = 7;

/** Metres a blaze reaches across, and how fast an ember leaves it. */
const BLAZE_SPREAD = 2.4;
const EMBER_SPEED = 2.2;

/** Ticks an ember lives for, which is longer than a flame: it is what carries a fire. */
const EMBER_LIFE = 90;

/** Puffs one explosion throws out, and how fast they leave it. */
const BLAST_PUFFS = 20;
const BLAST_SPEED = 9;

/** Ticks of catch-up one call will spawn for, so a stalled frame is not a fireball. */
const MAX_CATCH_UP = 30;

/** Metres a puff of smoke rises per second, and how much wider any puff gets over its life. */
const SMOKE_RISE = 1.2;
const PUFF_GROWTH = 1.8;

/** The colours a puff is drawn in as it ages. */
const SMOKE_YOUNG = new Color(0x241f1c);
const SMOKE_OLD = new Color(0x6a6663);
const FLAME_YOUNG = new Color(0xff7a1e);
const FLAME_OLD = new Color(0x8a1e05);

/** One puff in flight. Everything about it is read off its age. */
interface Puff {
  born: number;
  life: number;
  x: number;
  y: number;
  z: number;
  /** Metres per second it drifts in, in world axes. */
  dx: number;
  dy: number;
  dz: number;
  /** Metres across it starts at. */
  size: number;
}

/** One batch of puffs: the mesh, the pool behind it and the colours it fades between. */
class Puffs {
  readonly mesh: InstancedMesh;
  private readonly live: Puff[] = [];
  private readonly dummy = new Object3D();
  private readonly colour = new Color();

  constructor(
    private readonly cap: number,
    private readonly young: Color,
    private readonly old: Color,
    additive: boolean,
  ) {
    const geometry = new CircleGeometry(0.5, 12);
    // The camera looks down, so a puff laid flat is a puff facing it.
    geometry.rotateX(-Math.PI / 2);
    const material = new MeshBasicMaterial({
      transparent: true,
      opacity: additive ? 1 : 0.5,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
      fog: !additive,
    });
    this.mesh = tinted(new InstancedMesh(geometry, material, cap));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
  }

  add(puff: Puff): void {
    // A pool that is full drops its oldest puff, so a long fire costs the same
    // as a short one.
    if (this.live.length >= this.cap) this.live.shift();
    this.live.push(puff);
  }

  /** Age every puff, drop the ones that are done, and write the rest into the batch. */
  draw(tick: number): void {
    let drawn = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const puff = this.live[i] as Puff;
      const age = (tick - puff.born) / puff.life;
      if (age < 0 || age >= 1) {
        this.live.splice(i, 1);
        continue;
      }
      const seconds = (tick - puff.born) / TICK_RATE;
      // It grows as it rises and shrinks away at the end of its life, which is
      // how a puff leaves without anything to fade it out with.
      const spread = 1 + PUFF_GROWTH * age;
      const size = puff.size * spread * Math.min(1, 3 * (1 - age));
      this.dummy.position.set(puff.x + puff.dx * seconds, puff.y + puff.dy * seconds, puff.z + puff.dz * seconds);
      this.dummy.scale.set(size, size, size);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(drawn, this.dummy.matrix);
      this.colour.copy(this.young).lerp(this.old, age);
      this.mesh.setColorAt(drawn, this.colour);
      drawn++;
    }
    // Nothing to draw and nothing drawn last frame is nothing to upload: a
    // car that is not burning should cost the frame no buffer at all.
    if (drawn === 0 && this.mesh.count === 0) return;
    this.mesh.count = drawn;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    this.live.length = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.dispose();
  }
}

/** The smoke and fire of the player's vehicle. */
export class DamageFx {
  readonly group = new Group();
  private readonly smoke = new Puffs(SMOKE_CAP, SMOKE_YOUNG, SMOKE_OLD, false);
  private readonly flame = new Puffs(FLAME_CAP, FLAME_YOUNG, FLAME_OLD, true);
  /** The last tick that was spawned for, so a frame spawns each tick once. */
  private spawned = -1;
  /** The explosion already drawn, so a blast is thrown out once and not every frame. */
  private blown = -1;
  /** The blazes of the record, and the ground under them; set by {@link watch}. */
  private blazes: readonly Blaze[] = [];
  private groundAt: (x: number, y: number) => number = () => 0;
  private readonly turn = new Quaternion();
  private readonly at = new Vector3();

  constructor() {
    this.group.add(this.smoke.mesh, this.flame.mesh);
  }

  /**
   * The blazes to draw with the vehicle, and the ground under a place. A blaze
   * on the record is a place and not a height, because the simulation drives on
   * the roads and the renderer is what knows how high the ground is.
   */
  watch(blazes: readonly Blaze[], groundAt: (x: number, y: number) => number): void {
    this.blazes = blazes;
    this.groundAt = groundAt;
  }

  /**
   * Draw what the vehicle's damage and the blazes call for at this tick. Call
   * it once a frame, after the record has been stepped.
   */
  update(v: VehicleState, spec: VehicleSpec, seed: number, tick: number): void {
    if (tick < this.spawned) this.reset(tick);
    const from = Math.max(this.spawned + 1, tick - MAX_CATCH_UP);
    for (let t = from; t <= tick; t++) this.spawn(v, spec, seed, t);
    this.spawned = tick;
    this.smoke.draw(tick);
    this.flame.draw(tick);
  }

  /** Forget everything in flight: a new session, a loaded save or a new vehicle. */
  reset(tick: number): void {
    this.smoke.clear();
    this.flame.clear();
    this.spawned = tick - 1;
    this.blown = -1;
  }

  dispose(): void {
    this.group.clear();
    this.smoke.dispose();
    this.flame.dispose();
  }

  /** What one tick of this vehicle's state puts into the air. */
  private spawn(v: VehicleState, spec: VehicleSpec, seed: number, tick: number): void {
    for (const blaze of this.blazes) this.spawnBlaze(blaze, seed, tick);
    const damage = v.damage;
    if (damage.blownTick >= 0 && damage.blownTick !== this.blown && tick >= damage.blownTick) {
      this.blown = damage.blownTick;
      this.burst(v, spec, seed, tick);
    }
    if (!isSmoking(damage)) return;
    const burning = damage.stage === 'burning';
    if (tick % SMOKE_PERIOD === 0) {
      const rng = rngFor(seed, tick, Subsystem.Damage, 1);
      // The smoke comes off the engine, which is under the nose of everything
      // in the roster but the buggy, and a buggy on fire is close enough.
      this.place(v, spec.halfLength * 0.7, spec.halfHeight, 0, rng.range(-0.3, 0.3));
      this.smoke.add({
        born: tick,
        life: SMOKE_LIFE,
        x: this.at.x,
        y: this.at.y,
        z: this.at.z,
        dx: rng.range(-0.4, 0.4),
        dy: SMOKE_RISE,
        dz: rng.range(-0.4, 0.4),
        size: spec.halfWidth * (burning ? 0.85 : 0.6),
      });
    }
    if (burning && tick % FLAME_PERIOD === 0) {
      const rng = rngFor(seed, tick, Subsystem.Damage, 2);
      this.place(v, rng.range(-spec.halfLength, spec.halfLength), spec.halfHeight, rng.range(-1, 1) * spec.halfWidth, 0);
      this.flame.add({
        born: tick,
        life: FLAME_LIFE,
        x: this.at.x,
        y: this.at.y,
        z: this.at.z,
        dx: 0,
        dy: rng.range(1.5, 3),
        dz: 0,
        size: spec.halfWidth * rng.range(0.45, 0.8),
      });
    }
  }

  /**
   * One tick of one blaze: a low flame over the ground it covers, and now and
   * then an ember thrown clear of it. Both are keyed on the blaze's own id, so
   * two fires in one street never draw the same puff twice.
   */
  private spawnBlaze(blaze: Blaze, seed: number, tick: number): void {
    const height = this.groundAt(blaze.x, blaze.y);
    if (tick % BLAZE_PERIOD === 0) {
      const rng = rngFor(seed, tick, Subsystem.Damage, 300 + blaze.id);
      this.flame.add({
        born: tick,
        life: FLAME_LIFE,
        x: blaze.x + rng.range(-1, 1) * BLAZE_SPREAD,
        y: height + 0.3,
        z: blaze.y + rng.range(-1, 1) * BLAZE_SPREAD,
        dx: 0,
        dy: rng.range(1, 2.4),
        dz: 0,
        size: rng.range(0.8, 1.6),
      });
    }
    if (tick % EMBER_PERIOD !== 0) return;
    const rng = rngFor(seed, tick, Subsystem.Damage, 400 + blaze.id);
    const heading = rng.range(0, Math.PI * 2);
    const speed = rng.range(0.3, 1) * EMBER_SPEED;
    this.flame.add({
      born: tick,
      life: EMBER_LIFE,
      x: blaze.x,
      y: height + 0.5,
      z: blaze.y,
      dx: Math.cos(heading) * speed,
      dy: rng.range(1.5, 3.5),
      dz: Math.sin(heading) * speed,
      size: rng.range(0.12, 0.28),
    });
  }

  /** The explosion itself: a burst of fire thrown out from the vehicle. */
  private burst(v: VehicleState, spec: VehicleSpec, seed: number, tick: number): void {
    for (let i = 0; i < BLAST_PUFFS; i++) {
      const rng = rngFor(seed, tick, Subsystem.Damage, 100 + i);
      const heading = rng.range(0, Math.PI * 2);
      const speed = rng.range(0.3, 1) * BLAST_SPEED;
      this.place(v, 0, spec.halfHeight * 0.5, 0, 0);
      this.flame.add({
        born: tick,
        life: FLAME_LIFE + Math.round(rng.range(0, 30)),
        x: this.at.x,
        y: this.at.y,
        z: this.at.z,
        dx: Math.cos(heading) * speed,
        dy: rng.range(1, 6),
        dz: Math.sin(heading) * speed,
        size: spec.halfWidth * rng.range(0.6, 1.2),
      });
    }
    // The column of smoke that stands over it once the fire has gone through.
    for (let i = 0; i < 6; i++) {
      const rng = rngFor(seed, tick, Subsystem.Damage, 200 + i);
      this.place(v, rng.range(-1, 1) * spec.halfLength, spec.halfHeight, rng.range(-1, 1) * spec.halfWidth, 0);
      this.smoke.add({
        born: tick + i * 6,
        life: SMOKE_LIFE,
        x: this.at.x,
        y: this.at.y,
        z: this.at.z,
        dx: rng.range(-0.6, 0.6),
        dy: SMOKE_RISE * 1.5,
        dz: rng.range(-0.6, 0.6),
        size: spec.halfWidth * 1.1,
      });
    }
  }

  /** A point of the vehicle's own frame, in world axes, with a little jitter along it. */
  private place(v: VehicleState, along: number, up: number, across: number, jitter: number): void {
    this.turn.set(v.qx, v.qy, v.qz, v.qw);
    this.at.set(along + jitter, up, across).applyQuaternion(this.turn);
    this.at.set(v.x + this.at.x, v.y + this.at.y, v.z + this.at.z);
  }
}
