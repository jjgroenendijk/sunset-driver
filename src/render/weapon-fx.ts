/**
 * What the heavy and the thrown weapons look like (spec section 11.6): the
 * rocket, the grenade and the bottle in the air, the burst each one ends in,
 * and the stream of a flamethrower.
 *
 * `src/sim/gunfire.ts` carries the projectiles in `SimState.projectiles`,
 * writes every burst into `SimState.blasts` and every tongue of a
 * flamethrower's stream into `SimState.tracers` with `flame` set. This draws
 * all three off the record. A rocket trails fire and smoke, a Molotov burns at
 * the rag, a grenade tumbles; a blast is a fireball, a ring of dust and a
 * column of smoke, a Molotov a splash of flame, and smoke and gas a cloud that
 * hangs over the street for as long as the canister pours.
 *
 * It is three draw calls whatever is going on: the bodies in flight as one
 * instanced batch, and the smoke and the fire as the two puff batches of
 * `puffs.ts`. A puff is placed from its age alone and jittered from
 * `rngFor(seed, tick, Subsystem.WeaponFx, n)`, so a replay burns the way the
 * fight did.
 */
import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import { rngFor, Subsystem, type Rng } from '../core/rng.ts';
import type { Blast } from '../sim/blast.ts';
import { TICK_RATE } from '../sim/clock.ts';
import type { Tracer } from '../sim/tracer.ts';
import { weaponOf, type ProjectileState, type WeaponId } from '../sim/weapon.ts';
import { flameMaterial, smokeMaterial } from './puff-material.ts';
import { Puffs, smokePuff } from './puffs.ts';
import { tinted } from './tint.ts';
import { windHeading } from './weather-fx.ts';

/** Puffs each batch holds. A smoke grenade's cloud alone is a few dozen. */
export const FX_SMOKE_CAP = 400;
export const FX_FLAME_CAP = 400;

/** Bodies in flight drawn at once. */
const BODY_CAP = 16;

/** Ticks of catch-up one call will spawn for, so a stalled frame is not a firestorm. */
const MAX_CATCH_UP = 20;

/** Tongues of flame one tongue of the stream is drawn as, along its length. */
const STREAM_PUFFS = 6;

/** Metres a second the fire of the stream still carries forward once thrown. */
const STREAM_SPEED = 7;

/** Puffs of fire a blast throws out, and of dust along the ground. */
const FIREBALL_PUFFS = 26;
const DUST_PUFFS = 12;

/** Puffs a smoke or gas canister pours out, and the seconds it pours for. */
const CLOUD_PUFFS = 40;
const CLOUD_SECONDS = 9;

/** Puffs of fire and of smoke a rocket's motor leaves along each tick of its flight. */
const EXHAUST_FLAMES = 3;
const EXHAUST_SMOKE = 2;

/** How big a body in flight is drawn, as a factor of life size: a speck from 36 m up is no rocket. */
const BODY_SCALE = 1.6;

/** The size and colour of each body in flight: length, thickness, colour. */
const BODY: Readonly<Partial<Record<WeaponId, readonly [number, number, number]>>> = {
  'rpg-7': [0.95, 0.11, 0x4a5232],
  m79: [0.1, 0.045, 0xb08d3c],
  grenade: [0.1, 0.07, 0x3b4a2c],
  molotov: [0.26, 0.08, 0x4d6b2f],
  'pipe-bomb': [0.26, 0.06, 0x7a7d82],
  'smoke-grenade': [0.15, 0.065, 0x8a8f96],
  'tear-gas': [0.15, 0.065, 0xc9b23a],
};

/** The rockets, grenades and bottles in the air, their bursts, and the flamethrower's stream. */
export class WeaponFx {
  readonly group = new Group();
  private readonly smoke = new Puffs(FX_SMOKE_CAP, smokeMaterial());
  private readonly flame = new Puffs(FX_FLAME_CAP, flameMaterial());
  private readonly bodies = tinted(
    new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ roughness: 0.6, metalness: 0.2 }), BODY_CAP),
  );
  /** The last tick spawned for, the newest burst drawn and the newest tongue of flame drawn. */
  private spawned = -1;
  private blasted = -1;
  private flamed = -1;
  private windSeed = Number.NaN;
  private readonly dummy = new Object3D();
  private readonly colour = new Color();

  constructor() {
    this.bodies.count = 0;
    this.bodies.castShadow = true;
    this.group.add(this.smoke.mesh, this.flame.mesh, this.bodies);
    this.flame.mesh.renderOrder = 1;
  }

  /**
   * Draw the record at this tick. Call once a frame, after the record has been
   * stepped. The projectiles stand where the record's own tick left them, and
   * a trail laid for an earlier tick is laid that far back along the flight.
   */
  update(
    record: { tick: number; projectiles: readonly ProjectileState[]; blasts: readonly Blast[]; tracers: readonly Tracer[] },
    seed: number,
    tick: number,
  ): void {
    if (seed !== this.windSeed) {
      this.windSeed = seed;
      this.smoke.blow(windHeading(seed));
    }
    if (tick < this.spawned) this.reset(tick);
    const from = Math.max(this.spawned + 1, tick - MAX_CATCH_UP);
    for (let t = from; t <= tick; t++) this.trail(record.projectiles, seed, t, Math.max(tick, record.tick));
    this.spawned = tick;
    this.bursts(record.blasts, seed, tick);
    this.stream(record.tracers, seed, tick);
    this.drawBodies(record.projectiles);
    this.smoke.draw(tick);
    this.flame.draw(tick);
  }

  /** Forget everything in flight: a new session, a loaded save or a respawn. */
  reset(tick: number): void {
    this.smoke.clear();
    this.flame.clear();
    this.spawned = tick - 1;
    this.blasted = tick;
    this.flamed = tick;
  }

  dispose(): void {
    this.group.clear();
    this.smoke.dispose();
    this.flame.dispose();
    this.bodies.geometry.dispose();
    (this.bodies.material as MeshStandardMaterial).dispose();
    this.bodies.dispose();
  }

  /**
   * One tick of what each projectile leaves behind it. The record holds only
   * where it is now, so a tick the frame is catching up on is placed back
   * along its flight by its speed.
   */
  private trail(projectiles: readonly ProjectileState[], seed: number, t: number, now: number): void {
    const back = (now - t) / TICK_RATE;
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i] as ProjectileState;
      const x = p.x - p.vx * back;
      const y = p.y - p.vy * back;
      const h = p.h - p.vh * back;
      const rng = rngFor(seed, t, Subsystem.WeaponFx, p.thrownTick * 8 + i);
      if (p.weapon === 'rpg-7') {
        // The motor burns at the tail, a rocket's length behind the warhead,
        // and each tick of flight is filled along its length, so the trail is
        // a line and not a row of dots.
        const speed = Math.hypot(p.vx, p.vy, p.vh) || 1;
        const tail = 0.6 / speed;
        const step = 1 / TICK_RATE;
        for (let k = 0; k < EXHAUST_FLAMES; k++) {
          const f = tail + (k / EXHAUST_FLAMES) * step;
          this.flame.add({
            kind: 'flame',
            born: t,
            life: Math.round(rng.range(7, 12)),
            x: x - p.vx * f,
            y: h - p.vh * f,
            z: y - p.vy * f,
            dx: -p.vx * 0.05,
            dy: 0,
            dz: -p.vy * 0.05,
            size: rng.range(0.6, 1),
            variant: rng.range(0, 1),
            tone: 0,
            glow: 0,
          });
        }
        for (let k = 0; k < EXHAUST_SMOKE; k++) {
          const f = tail * 1.5 + (k / EXHAUST_SMOKE) * step;
          this.smoke.add(
            smokePuff(
              {
                born: t,
                life: Math.round(rng.range(80, 130)),
                x: x - p.vx * f + rng.range(-0.1, 0.1),
                y: h + rng.range(-0.1, 0.1),
                z: y - p.vy * f + rng.range(-0.1, 0.1),
                dx: rng.range(-0.3, 0.3),
                dy: rng.range(0.2, 0.6),
                dz: rng.range(-0.3, 0.3),
                size: rng.range(0.5, 0.8),
                tone: rng.range(0.45, 0.65),
                glow: 0.6,
              },
              rng.range(0, 1),
            ),
          );
        }
      } else if (p.weapon === 'molotov' && t % 2 === 0) {
        // The rag burns all the way there.
        this.flame.add({
          kind: 'flame',
          born: t,
          life: Math.round(rng.range(10, 16)),
          x,
          y: h + 0.1,
          z: y,
          dx: 0,
          dy: 0.3,
          dz: 0,
          size: rng.range(0.25, 0.4),
          variant: rng.range(0, 1),
          tone: 0,
          glow: 0,
        });
      } else if ((p.weapon === 'smoke-grenade' || p.weapon === 'tear-gas') && t % 6 === 0) {
        // A canister already pours a thin thread before it lets go.
        this.smoke.add(
          smokePuff(
            { born: t, life: 60, x, y: h, z: y, dx: 0, dy: 0.6, dz: 0, size: 0.25, tone: 0.9, glow: 0 },
            rng.range(0, 1),
          ),
        );
      }
    }
  }

  /** Every burst newer than the last one drawn: a fireball, a splash of fire or a cloud. */
  private bursts(blasts: readonly Blast[], seed: number, tick: number): void {
    let newest = this.blasted;
    for (let i = 0; i < blasts.length; i++) {
      const b = blasts[i] as Blast;
      if (b.tick <= this.blasted || b.tick > tick) continue;
      newest = Math.max(newest, b.tick);
      const effect = weaponOf(b.weapon).effect;
      if (effect === 'smoke' || effect === 'gas') this.cloud(b, seed, effect === 'gas');
      else if (effect === 'fire') this.splash(b, seed);
      else this.fireball(b, seed);
    }
    this.blasted = newest;
  }

  /** A grenade, a pipe bomb or a rocket going off: fire thrown out, dust along the ground, smoke over it. */
  private fireball(b: Blast, seed: number): void {
    const r = b.radius;
    // The flash: one big flame at the heart of it that is gone at once.
    this.flame.add({
      kind: 'flame',
      born: b.tick,
      life: 14,
      x: b.x,
      y: b.h + 0.6,
      z: b.y,
      dx: 0,
      dy: 1,
      dz: 0,
      size: r * 1.1,
      variant: 0.5,
      tone: 0,
      glow: 0,
    });
    for (let i = 0; i < FIREBALL_PUFFS; i++) {
      const rng = this.rng(seed, b, i);
      const [ux, uh, uy] = direction(rng, 0.1);
      const speed = rng.range(0.4, 1) * r * 1.6;
      this.flame.add({
        kind: 'flame',
        born: b.tick,
        life: Math.round(rng.range(25, 50)),
        x: b.x,
        y: b.h + 0.4,
        z: b.y,
        dx: ux * speed,
        dy: uh * speed * 0.5 + 1,
        dz: uy * speed,
        size: r * rng.range(0.3, 0.5),
        variant: rng.range(0, 1),
        tone: 0,
        glow: 0,
      });
    }
    for (let i = 0; i < DUST_PUFFS; i++) {
      const rng = this.rng(seed, b, 100 + i);
      const heading = (i / DUST_PUFFS) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const speed = r * rng.range(0.9, 1.3);
      this.smoke.add(
        smokePuff(
          {
            born: b.tick,
            life: Math.round(rng.range(60, 100)),
            x: b.x,
            y: b.h + 0.3,
            z: b.y,
            dx: Math.cos(heading) * speed,
            dy: 0.3,
            dz: Math.sin(heading) * speed,
            size: r * 0.2,
            tone: rng.range(0.55, 0.75),
            glow: 0.4,
          },
          rng.range(0, 1),
        ),
      );
    }
    for (let i = 0; i < 9; i++) {
      const rng = this.rng(seed, b, 200 + i);
      this.smoke.add(
        smokePuff(
          {
            born: b.tick + i * 3,
            life: Math.round(rng.range(180, 260)),
            x: b.x + rng.range(-0.3, 0.3) * r,
            y: b.h + 1 + i * 0.3,
            z: b.y + rng.range(-0.3, 0.3) * r,
            dx: rng.range(-0.5, 0.5),
            dy: rng.range(2.5, 4),
            dz: rng.range(-0.5, 0.5),
            size: r * rng.range(0.3, 0.45),
            tone: rng.range(0, 0.15),
            glow: 1,
          },
          rng.range(0, 1),
        ),
      );
    }
    this.embers(b, seed, 14, r * 1.4);
  }

  /** A Molotov breaking: the fuel thrown out low in a splash, and a few drops alight. The blaze takes over. */
  private splash(b: Blast, seed: number): void {
    for (let i = 0; i < 18; i++) {
      const rng = this.rng(seed, b, i);
      const heading = rng.range(0, Math.PI * 2);
      const speed = rng.range(0.5, 1) * b.radius * 1.4;
      this.flame.add({
        kind: 'flame',
        born: b.tick + Math.round(rng.range(0, 6)),
        life: Math.round(rng.range(30, 60)),
        x: b.x,
        y: b.h + 0.2,
        z: b.y,
        dx: Math.cos(heading) * speed,
        dy: rng.range(0, 0.6),
        dz: Math.sin(heading) * speed,
        size: rng.range(0.9, 1.6),
        variant: rng.range(0, 1),
        tone: 0,
        glow: 0,
      });
    }
    this.embers(b, seed, 8, 3);
  }

  /** A smoke or gas canister letting go: a cloud that swells over its radius and hangs there. */
  private cloud(b: Blast, seed: number, gas: boolean): void {
    for (let i = 0; i < CLOUD_PUFFS; i++) {
      const rng = this.rng(seed, b, i);
      const heading = rng.range(0, Math.PI * 2);
      const speed = rng.range(0.1, 0.35) * b.radius;
      const born = b.tick + Math.round((i / CLOUD_PUFFS) * CLOUD_SECONDS * TICK_RATE);
      this.smoke.add(
        smokePuff(
          {
            born,
            life: Math.round(rng.range(8, 12) * TICK_RATE),
            x: b.x,
            y: b.h + 0.3,
            z: b.y,
            dx: Math.cos(heading) * speed,
            dy: rng.range(0.1, 0.4),
            dz: Math.sin(heading) * speed,
            size: b.radius * rng.range(0.28, 0.4),
            tone: gas ? 1 : rng.range(0.78, 0.92),
            glow: 0,
          },
          rng.range(0, 1),
        ),
      );
    }
  }

  /** Sparks thrown out of a burst, flying further than its fire. */
  private embers(b: Blast, seed: number, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const rng = this.rng(seed, b, 300 + i);
      const [ux, uh, uy] = direction(rng, 0.3);
      const s = rng.range(0.5, 1) * speed;
      this.flame.add({
        kind: 'ember',
        born: b.tick,
        life: Math.round(rng.range(40, 80)),
        x: b.x,
        y: b.h + 0.5,
        z: b.y,
        dx: ux * s,
        dy: uh * s + 2,
        dz: uy * s,
        size: rng.range(0.1, 0.22),
        variant: rng.range(0, 1),
        tone: 0,
        glow: 0,
      });
    }
  }

  /**
   * The flamethrower's stream: every tongue newer than the last one drawn is
   * laid as a few flames along the line it was cast on, small at the nozzle
   * and wide at the far end, each still carrying forward. Where it met
   * something it splashes.
   */
  private stream(tracers: readonly Tracer[], seed: number, tick: number): void {
    let newest = this.flamed;
    for (let i = 0; i < tracers.length; i++) {
      const t = tracers[i] as Tracer;
      if (t.flame !== true || t.tick <= this.flamed || t.tick > tick) continue;
      newest = Math.max(newest, t.tick);
      const dx = t.ex - t.x;
      const dy = t.ey - t.y;
      const dh = t.eh - t.h;
      const reach = Math.hypot(dx, dy, dh) || 1;
      const ux = dx / reach;
      const uy = dy / reach;
      const uh = dh / reach;
      for (let k = 0; k < STREAM_PUFFS; k++) {
        const rng = rngFor(seed, t.tick, Subsystem.WeaponFx, 50_000 + t.pellet * 16 + k);
        const f = (k + rng.range(0, 1)) / STREAM_PUFFS;
        const speed = STREAM_SPEED * (1 - f * 0.6);
        this.flame.add({
          kind: 'flame',
          born: t.tick,
          life: Math.round(rng.range(14, 24)),
          x: t.x + dx * f * 0.85,
          y: t.h + dh * f * 0.85,
          z: t.y + dy * f * 0.85,
          dx: ux * speed + rng.range(-0.4, 0.4),
          dy: uh * speed,
          dz: uy * speed + rng.range(-0.4, 0.4),
          size: 0.25 + f * 1.3 * rng.range(0.8, 1.2),
          variant: rng.range(0, 1),
          tone: 0,
          glow: 0,
        });
      }
      if (t.end === 'none') continue;
      const rng = rngFor(seed, t.tick, Subsystem.WeaponFx, 60_000 + t.pellet);
      this.flame.add({
        kind: 'flame',
        born: t.tick,
        life: Math.round(rng.range(20, 34)),
        x: t.ex,
        y: t.eh,
        z: t.ey,
        dx: rng.range(-1, 1),
        dy: 0.5,
        dz: rng.range(-1, 1),
        size: rng.range(1, 1.6),
        variant: rng.range(0, 1),
        tone: 0,
        glow: 0,
      });
      if (t.pellet === 0 && t.tick % 4 === 0) {
        this.smoke.add(
          smokePuff(
            {
              born: t.tick,
              life: 120,
              x: t.ex,
              y: t.eh + 1,
              z: t.ey,
              dx: rng.range(-0.3, 0.3),
              dy: 2,
              dz: rng.range(-0.3, 0.3),
              size: 1,
              tone: 0.05,
              glow: 0.8,
            },
            rng.range(0, 1),
          ),
        );
      }
    }
    this.flamed = newest;
  }

  /** The rockets, grenades and bottles in the air, each turned along the way it flies. */
  private drawBodies(projectiles: readonly ProjectileState[]): void {
    let drawn = 0;
    for (let i = 0; i < projectiles.length && drawn < BODY_CAP; i++) {
      const p = projectiles[i] as ProjectileState;
      const body = BODY[p.weapon];
      if (body === undefined) continue;
      const [length, thick, colour] = body;
      const flat = Math.hypot(p.vx, p.vy);
      this.dummy.position.set(p.x, p.h, p.y);
      this.dummy.rotation.set(0, -Math.atan2(p.vy, p.vx), Math.atan2(p.vh, flat), 'YZX');
      this.dummy.scale.set(length * BODY_SCALE, thick * BODY_SCALE, thick * BODY_SCALE);
      this.dummy.updateMatrix();
      this.bodies.setMatrixAt(drawn, this.dummy.matrix);
      this.bodies.setColorAt(drawn, this.colour.setHex(colour));
      drawn++;
    }
    if (drawn === 0 && this.bodies.count === 0) return;
    this.bodies.count = drawn;
    this.bodies.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor !== null) this.bodies.instanceColor.needsUpdate = true;
  }

  /** The stream one puff of a burst is jittered from. */
  private rng(seed: number, b: Blast, n: number): Rng {
    return rngFor(seed, b.tick, Subsystem.WeaponFx, Math.round(b.x * 7 + b.y * 13) * 1024 + n);
  }
}

/** A unit direction drawn at random, leaning up by at least `up`: `[x, h, y]` in map axes. */
function direction(rng: Rng, up: number): [number, number, number] {
  const heading = rng.range(0, Math.PI * 2);
  const climb = rng.range(up, 1);
  const flat = Math.sqrt(1 - climb * climb);
  return [Math.cos(heading) * flat, climb, Math.sin(heading) * flat];
}
