/**
 * The smoke, the flames, the embers and the blast of a damaged vehicle (spec
 * sections 11.3, 20.3).
 *
 * `src/sim/vehicles/damage.ts` says what state a vehicle is in and this draws it. A car
 * that is merely dented shows nothing here; one that is smoking trails a pale
 * plume from its engine, one that is burning stands in flames under a column of
 * black smoke, and one that reaches the end of its fuse throws a fireball out
 * and then smoulders.
 *
 * The blazes of `src/sim/vehicles/fire.ts` — what a wreck leaves burning on the ground
 * — are drawn from the same batches, so every fire in the scene costs the
 * frame the same draw calls however many there are. A blaze throws embers
 * and a column of smoke as well as flame: the embers fly further and live
 * longer, which is what tells a fire on the ground from a car alight.
 *
 * It is three draw calls, whatever is going on: one batch of puffs blended the
 * ordinary way for the smoke, one blended additively for the fire, and one of
 * heat haze that bends the frame behind it. The haze is hidden while there is
 * none, and at the tiers that draw no bloom, since reading the frame it bends
 * copies it. A puff is
 * a soft, ragged square turned to face the camera (`puffs.ts`), placed and
 * faded from its age alone, so a frame only ever reads the record and the tick.
 * Smoke leans with the wind of `weather-fx.ts`, and smoke low over a fire is lit
 * orange from below.
 *
 * Every puff is jittered from `rngFor(seed, tick, Subsystem.Damage, n)`, so the
 * same fire at the same tick of the same seed looks the same in a replay as it
 * did when it was driven.
 */
import { Group, Quaternion, Vector3 } from 'three';
import { rngFor, Subsystem } from '../../core/rng.ts';
import { isSmoking, type DamageState } from '../../sim/vehicles/damage.ts';
import type { Blaze } from '../../sim/vehicles/fire.ts';
import type { VehicleSpec, VehicleState } from '../../sim/vehicles/vehicle.ts';
import { flameMaterial, hazeMaterial, smokeMaterial } from './puff-material.ts';
import { Puffs, smokePuff, type Puff } from './puffs.ts';
import { windHeading } from '../environment/weather-fx.ts';

/** Puffs each batch holds. The oldest is taken when a new one has nowhere to go. */
export const SMOKE_CAP = 96;
export const FLAME_CAP = 160;
export const HAZE_CAP = 48;

/** Ticks between puffs of smoke, and between the flames of a fire. */
const SMOKE_PERIOD = 6;
const FLAME_PERIOD = 3;

/** Ticks a puff of smoke lives for, and a flame. */
const SMOKE_LIFE = 150;
const FLAME_LIFE = 40;

/** Ticks between the flames of a blaze, its embers and its smoke, and how long that smoke lives. */
const BLAZE_PERIOD = 4;
const EMBER_PERIOD = 7;
const BLAZE_SMOKE_PERIOD = 10;
const BLAZE_SMOKE_LIFE = 220;

/** Metres a blaze reaches across, and how fast an ember leaves it. */
const BLAZE_SPREAD = 2.4;
const EMBER_SPEED = 2.2;

/** Ticks between the patches of haze over a blaze and over a burning vehicle, and how long one lives. */
const BLAZE_HAZE_PERIOD = 8;
const BURNING_HAZE_PERIOD = 10;
const HAZE_LIFE = 100;

/** Metres a second hot air rises off a fire. */
const HAZE_RISE = 3;

/** Ticks an ember lives for, which is longer than a flame: it is what carries a fire. */
const EMBER_LIFE = 90;

/** Puffs one explosion throws out, and how fast they leave it. */
const BLAST_PUFFS = 20;
const BLAST_SPEED = 9;

/** Ticks of catch-up one call will spawn for, so a stalled frame is not a fireball. */
const MAX_CATCH_UP = 30;

/** Metres a second smoke leaves the fire at, rising. */
const SMOKE_RISE = 2.4;

/** Where the stream ids of a blaze's smoke begin, clear of every other stream of the subsystem. */
const BLAZE_SMOKE_STREAM = 60_000;

/** Where the stream ids of a blaze's haze begin, past those of its smoke. */
const BLAZE_HAZE_STREAM = 70_000;

/** The smoke and fire of the player's vehicle. */
export class DamageFx {
  readonly group = new Group();
  private readonly smoke = new Puffs(SMOKE_CAP, smokeMaterial());
  private readonly flame = new Puffs(FLAME_CAP, flameMaterial());
  private readonly heat = new Puffs(HAZE_CAP, hazeMaterial());
  /**
   * Whether heat haze is drawn, which the quality tier sets (spec section 9.2).
   * Drawing it copies the frame, so it goes with the bloom.
   */
  haze = true;
  /** The last tick that was spawned for, so a frame spawns each tick once. */
  private spawned = -1;
  /** The explosion already drawn, so a blast is thrown out once and not every frame. */
  private blown = -1;
  /** The seed the wind was last read for, so it is read once per world. */
  private windSeed = Number.NaN;
  /** The blazes of the record, and the ground under them; set by {@link watch}. */
  private blazes: readonly Blaze[] = [];
  private groundAt: (x: number, y: number) => number = () => 0;
  private readonly turn = new Quaternion();
  private readonly at = new Vector3();

  constructor() {
    this.group.add(this.smoke.mesh, this.flame.mesh, this.heat.mesh);
    // Fire is drawn over smoke, so a flame shows through the plume it feeds.
    // The haze goes first, so it bends the street and the cars and not the
    // smoke and flame, which would smear.
    this.heat.mesh.renderOrder = -1;
    this.flame.mesh.renderOrder = 1;
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
    if (seed !== this.windSeed) {
      this.windSeed = seed;
      this.smoke.blow(windHeading(seed));
    }
    if (tick < this.spawned) this.reset(tick);
    const from = Math.max(this.spawned + 1, tick - MAX_CATCH_UP);
    for (let t = from; t <= tick; t++) this.spawn(v, spec, seed, t);
    this.spawned = tick;
    this.smoke.draw(tick);
    this.flame.draw(tick);
    this.heat.draw(tick);
    // A hidden batch is left out of the frame, and so is the copy of the frame
    // it reads. An empty one would still be drawn and still copy it.
    this.heat.mesh.visible = this.haze && this.heat.mesh.count > 0;
  }

  /** Forget everything in flight: a new session, a loaded save or a new vehicle. */
  reset(tick: number): void {
    this.smoke.clear();
    this.flame.clear();
    this.heat.clear();
    this.spawned = tick - 1;
    this.blown = -1;
  }

  dispose(): void {
    this.group.clear();
    this.smoke.dispose();
    this.flame.dispose();
    this.heat.dispose();
  }

  /** What one tick of this vehicle's state puts into the air. */
  private spawn(v: VehicleState, spec: VehicleSpec, seed: number, tick: number): void {
    for (const blaze of this.blazes) this.spawnBlaze(blaze, seed, tick);
    const damage: DamageState = v.damage;
    if (damage.blownTick >= 0 && damage.blownTick !== this.blown && tick >= damage.blownTick) {
      this.blown = damage.blownTick;
      this.burst(v, spec, seed, tick);
    }
    if (!isSmoking(damage)) return;
    const burning = damage.stage === 'burning';
    if (tick % SMOKE_PERIOD === 0) this.spawnSmoke(v, spec, seed, tick, burning);
    if (burning && tick % FLAME_PERIOD === 0) this.spawnFlame(v, spec, seed, tick);
    if (burning && tick % BURNING_HAZE_PERIOD === 0) {
      const rng = rngFor(seed, tick, Subsystem.Damage, 3);
      this.place(v, rng.range(-0.5, 0.5) * spec.halfLength, spec.halfHeight * 2, 0, 0);
      this.heat.add(this.hazePuff(tick, spec.halfLength * rng.range(1.2, 1.6), rng.range(0, 1)));
    }
  }

  /** A puff of smoke off a damaged vehicle: black off the whole body when it burns, else off the engine. */
  private spawnSmoke(v: VehicleState, spec: VehicleSpec, seed: number, tick: number, burning: boolean): void {
    const rng = rngFor(seed, tick, Subsystem.Damage, 1);
    if (burning) {
      // A car alight pours black smoke off the whole of its body.
      this.place(
        v,
        rng.range(-0.8, 0.8) * spec.halfLength,
        spec.halfHeight * 1.2,
        rng.range(-0.6, 0.6) * spec.halfWidth,
        0,
      );
    } else {
      // The smoke comes off the engine, which is under the nose of everything
      // in the roster but the buggy, and a buggy on fire is close enough.
      this.place(v, spec.halfLength * 0.7, spec.halfHeight, 0, rng.range(-0.3, 0.3));
    }
    this.smoke.add(
      smokePuff(
        {
          born: tick,
          life: Math.round((burning ? SMOKE_LIFE * 1.3 : SMOKE_LIFE) * rng.range(0.85, 1.15)),
          x: this.at.x,
          y: this.at.y,
          z: this.at.z,
          dx: rng.range(-0.4, 0.4),
          dy: SMOKE_RISE * (burning ? 1 : 0.7) * rng.range(0.8, 1.2),
          dz: rng.range(-0.4, 0.4),
          size: spec.halfWidth * (burning ? 1.1 : 0.6) * rng.range(0.8, 1.2),
          tone: burning ? rng.range(0, 0.12) : rng.range(0.7, 0.9),
          glow: burning ? 0.8 : 0,
        },
        rng.range(0, 1),
      ),
    );
  }

  /** A tongue of flame somewhere over a burning vehicle's body. */
  private spawnFlame(v: VehicleState, spec: VehicleSpec, seed: number, tick: number): void {
    const rng = rngFor(seed, tick, Subsystem.Damage, 2);
    this.place(
      v,
      rng.range(-spec.halfLength, spec.halfLength),
      spec.halfHeight,
      rng.range(-1, 1) * spec.halfWidth,
      0,
    );
    this.flame.add(
      this.flamePuff(tick, FLAME_LIFE, rng.range(0.4, 1.4), spec.halfWidth * rng.range(0.9, 1.5), rng.range(0, 1)),
    );
  }

  /**
   * One tick of one blaze: a low flame over the ground it covers, now and then
   * an ember thrown clear of it, and the column of smoke it stands under. All
   * are keyed on the blaze's own id, so two fires in one street never draw the
   * same puff twice.
   */
  private spawnBlaze(blaze: Blaze, seed: number, tick: number): void {
    const height = this.groundAt(blaze.x, blaze.y);
    if (tick % BLAZE_PERIOD === 0) {
      const rng = rngFor(seed, tick, Subsystem.Damage, 300 + blaze.id);
      this.at.set(blaze.x + rng.range(-1, 1) * BLAZE_SPREAD, height + 0.3, blaze.y + rng.range(-1, 1) * BLAZE_SPREAD);
      this.flame.add(this.flamePuff(tick, FLAME_LIFE, rng.range(0.3, 1.2), rng.range(1.4, 2.4), rng.range(0, 1)));
    }
    if (tick % BLAZE_SMOKE_PERIOD === 0) {
      const rng = rngFor(seed, tick, Subsystem.Damage, BLAZE_SMOKE_STREAM + blaze.id);
      this.smoke.add(
        smokePuff(
          {
            born: tick,
            life: Math.round(BLAZE_SMOKE_LIFE * rng.range(0.85, 1.15)),
            x: blaze.x + rng.range(-0.5, 0.5) * BLAZE_SPREAD,
            y: height + 1.5,
            z: blaze.y + rng.range(-0.5, 0.5) * BLAZE_SPREAD,
            dx: rng.range(-0.3, 0.3),
            dy: SMOKE_RISE * rng.range(1, 1.4),
            dz: rng.range(-0.3, 0.3),
            size: rng.range(1.6, 2.4),
            tone: rng.range(0, 0.15),
            glow: 1,
          },
          rng.range(0, 1),
        ),
      );
    }
    if (tick % BLAZE_HAZE_PERIOD === 0) {
      const rng = rngFor(seed, tick, Subsystem.Damage, BLAZE_HAZE_STREAM + blaze.id);
      this.at.set(blaze.x + rng.range(-0.4, 0.4) * BLAZE_SPREAD, height + 1.2, blaze.y + rng.range(-0.4, 0.4) * BLAZE_SPREAD);
      this.heat.add(this.hazePuff(tick, BLAZE_SPREAD * rng.range(1.3, 1.8), rng.range(0, 1)));
    }
    if (tick % EMBER_PERIOD !== 0) return;
    const rng = rngFor(seed, tick, Subsystem.Damage, 400 + blaze.id);
    const heading = rng.range(0, Math.PI * 2);
    const speed = rng.range(0.3, 1) * EMBER_SPEED;
    this.flame.add({
      kind: 'ember',
      born: tick,
      life: EMBER_LIFE,
      x: blaze.x,
      y: height + 0.5,
      z: blaze.y,
      dx: Math.cos(heading) * speed,
      dy: rng.range(1.5, 3.5),
      dz: Math.sin(heading) * speed,
      size: rng.range(0.12, 0.28),
      variant: rng.range(0, 1),
      tone: 0,
      glow: 0,
    });
  }

  /** A patch of hot air rising from where {@link at} is, `size` metres across at birth. */
  private hazePuff(tick: number, size: number, variant: number): Puff {
    const { x, y, z } = this.at;
    const life = Math.round(HAZE_LIFE * (0.85 + 0.3 * variant));
    return { kind: 'haze', born: tick, life, x, y, z, dx: 0, dy: HAZE_RISE, dz: 0, size, variant, tone: 0, glow: 0 };
  }

  /** A tongue of flame standing where {@link at} is, rising at `rise` metres a second. */
  private flamePuff(tick: number, life: number, rise: number, size: number, variant: number): Puff {
    const { x, y, z } = this.at;
    return {
      kind: 'flame',
      born: tick,
      life,
      x,
      y,
      z,
      dx: 0,
      dy: rise,
      dz: 0,
      size,
      variant,
      tone: 0,
      glow: 0,
    };
  }

  /** The explosion itself: a fireball thrown out from the vehicle, and the soot it leaves. */
  private burst(v: VehicleState, spec: VehicleSpec, seed: number, tick: number): void {
    for (let i = 0; i < BLAST_PUFFS; i++) {
      const rng = rngFor(seed, tick, Subsystem.Damage, 100 + i);
      const heading = rng.range(0, Math.PI * 2);
      const speed = rng.range(0.3, 1) * BLAST_SPEED;
      this.place(v, 0, spec.halfHeight * 0.5, 0, 0);
      const puff = this.flamePuff(
        tick,
        FLAME_LIFE + Math.round(rng.range(0, 30)),
        rng.range(1, 6),
        spec.halfWidth * rng.range(1, 1.8),
        rng.range(0, 1),
      );
      puff.dx = Math.cos(heading) * speed;
      puff.dz = Math.sin(heading) * speed;
      this.flame.add(puff);
    }
    // The column of smoke that stands over it once the fire has gone through.
    for (let i = 0; i < 6; i++) {
      const rng = rngFor(seed, tick, Subsystem.Damage, 200 + i);
      this.place(v, rng.range(-1, 1) * spec.halfLength, spec.halfHeight, rng.range(-1, 1) * spec.halfWidth, 0);
      this.smoke.add(
        smokePuff(
          {
            born: tick + i * 6,
            life: SMOKE_LIFE * 1.5,
            x: this.at.x,
            y: this.at.y,
            z: this.at.z,
            dx: rng.range(-0.6, 0.6),
            dy: SMOKE_RISE * 1.5,
            dz: rng.range(-0.6, 0.6),
            size: spec.halfWidth * 1.6,
            tone: 0,
            glow: 1,
          },
          rng.range(0, 1),
        ),
      );
    }
  }

  /** A point of the vehicle's own frame, in world axes, with a little jitter along it. */
  private place(v: VehicleState, along: number, up: number, across: number, jitter: number): void {
    this.turn.set(v.qx, v.qy, v.qz, v.qw);
    this.at.set(along + jitter, up, across).applyQuaternion(this.turn);
    this.at.set(v.x + this.at.x, v.y + this.at.y, v.z + this.at.z);
  }
}
