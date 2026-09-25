/**
 * What a round looks like (spec section 11.6): the flash at the muzzle, the
 * glow it throws on the ground, the streak it draws through the air and the
 * burst where it lands.
 *
 * `src/sim/tracer.ts` carries the path of every round and this draws them. The
 * flash, the glow and the streak are read off the record and the tick alone,
 * so there is nothing to carry from one frame to the next. The burst is the
 * spark batch of `melee-fx.ts`, fed a hit for every round that met something:
 * blood off a person, sparks off a panel, dust off a wall or the road. The
 * blood follows the gore level the way a blow's does.
 *
 * It is three draw calls whatever is going on, all blended additively: one
 * batch of discs for the flashes and the glows, one of streaks, one of sparks.
 * The glow stands in for a light. A point light would switch the clustered
 * path of `clustered-lights.ts` on for every fragment in the city, which is
 * what `docs/lighting.md` says a light costs; a disc on the ground costs the
 * pixels it covers. Being additive, it shows at night and fades into the day,
 * as a flash does.
 */
import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  type BufferGeometry,
} from 'three';
import type { MeleeHit } from '../sim/melee.ts';
import type { Tracer } from '../sim/tracer.ts';
import { MUZZLE_HEIGHT } from '../sim/weapon.ts';
import type { Gore } from './gore.ts';
import { MeleeFx } from './melee-fx.ts';
import { tinted } from './tint.ts';

/** Ticks a flash, a glow and a streak are drawn for. A round is quick. */
export const FLASH_TICKS = 3;
export const GLOW_TICKS = 5;
export const STREAK_TICKS = 5;

/** Metres across a flash and a glow, and metres wide a streak is drawn. */
const FLASH_SIZE = 0.9;
const GLOW_SIZE = 7;
const STREAK_WIDTH = 0.09;

/** Metres above the player's feet the glow is laid, clear of the road under it. */
const GLOW_LIFT = 0.08;

/** Discs and streaks the batches hold: a few shotgun blasts in the air at once. */
const DISC_CAP = 24;
const STREAK_CAP = 48;

/** How hard a round lands, on the 0-to-1 scale a blow of `melee.ts` is measured on. */
const ROUND_STRENGTH = 0.5;

/** The stream of the seed the bursts are jittered from, clear of the blows'. */
const IMPACT_STREAM = 900;

const FLASH_COLOUR = new Color(0xfff1c4);
const GLOW_COLOUR = new Color(0x9a5a1c);
const STREAK_COLOUR = new Color(0xffd9a0);

/** A disc bright in the middle and black at the rim, which added over the scene is a soft spot of light. */
function softDisc(): BufferGeometry {
  const geometry = new CircleGeometry(0.5, 16);
  geometry.rotateX(-Math.PI / 2);
  const count = geometry.getAttribute('position').count;
  const shade = new Float32Array(count * 3);
  // CircleGeometry puts the middle first and the rim after it.
  shade.fill(0);
  shade.set([1, 1, 1], 0);
  geometry.setAttribute('color', new Float32BufferAttribute(shade, 3));
  return geometry;
}

/** A flat strip one metre long along `+x`, dim at the muzzle end and bright at the far one. */
function streak(): BufferGeometry {
  const geometry = new PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0.5, 0, 0);
  const position = geometry.getAttribute('position');
  const shade = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) shade.fill(0.15 + 0.85 * position.getX(i), i * 3, i * 3 + 3);
  geometry.setAttribute('color', new Float32BufferAttribute(shade, 3));
  return geometry;
}

function additive(geometry: BufferGeometry, cap: number): InstancedMesh {
  const material = new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    fog: false,
  });
  const mesh = tinted(new InstancedMesh(geometry, material, cap));
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.count = 0;
  return mesh;
}

/** The rounds in the air. Three batches, three draw calls. */
export class ShotFx {
  readonly group = new Group();
  private readonly discs = additive(softDisc(), DISC_CAP);
  private readonly streaks = additive(streak(), STREAK_CAP);
  private readonly impacts = new MeleeFx(undefined, IMPACT_STREAM);
  /** The rounds that met something, as the hits the spark batch reads; reused frame to frame. */
  private readonly landed: MeleeHit[] = [];
  private readonly dummy = new Object3D();
  private readonly colour = new Color();

  constructor() {
    this.group.add(this.discs, this.streaks, this.impacts.group);
  }

  /** Draw the rounds of the record at this tick. Call once a frame, after the record has been stepped. */
  update(tracers: readonly Tracer[], seed: number, tick: number): void {
    let discs = 0;
    let streaks = 0;
    let landed = 0;
    for (let i = 0; i < tracers.length; i++) {
      const t = tracers[i] as Tracer;
      const age = tick - t.tick;
      // A tongue of a flamethrower's stream is fire, which `weapon-fx.ts` draws.
      if (age < 0 || t.flame === true) continue;
      if (t.end !== 'none') landed = this.land(landed, t);
      if (t.pellet === 0 && age < FLASH_TICKS && discs < DISC_CAP) {
        this.disc(discs++, t.x, t.h, t.y, FLASH_SIZE * (1 - age / FLASH_TICKS / 2), FLASH_COLOUR, 1 - age / FLASH_TICKS);
      }
      if (t.pellet === 0 && age < GLOW_TICKS && discs < DISC_CAP) {
        this.disc(discs++, t.x, t.h - MUZZLE_HEIGHT + GLOW_LIFT, t.y, GLOW_SIZE, GLOW_COLOUR, 1 - age / GLOW_TICKS);
      }
      if (age < STREAK_TICKS && streaks < STREAK_CAP) this.streak(streaks++, t, 1 - age / STREAK_TICKS);
    }
    this.landed.length = landed;
    this.impacts.update(this.landed, seed, tick);
    commit(this.discs, discs);
    commit(this.streaks, streaks);
  }

  /** How much blood a round throws off a person (`gore.ts`). */
  get gore(): Gore {
    return this.impacts.gore;
  }

  set gore(level: Gore) {
    this.impacts.gore = level;
  }

  /** Forget everything in flight: a new session, a loaded save or a respawn. */
  reset(tick: number): void {
    this.impacts.reset(tick);
  }

  dispose(): void {
    this.group.clear();
    for (const mesh of [this.discs, this.streaks]) {
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
      mesh.dispose();
    }
    this.impacts.dispose();
  }

  /** Write the round's landing into the reused list the spark batch reads, and answer the next slot. */
  private land(slot: number, t: Tracer): number {
    const hit = this.landed[slot] ?? { tick: 0, x: 0, y: 0, h: 0, surface: 'hard', strength: 0 };
    hit.tick = t.tick;
    hit.x = t.ex;
    hit.y = t.ey;
    hit.h = t.eh;
    hit.surface = t.end === 'none' ? 'hard' : t.end;
    hit.strength = ROUND_STRENGTH;
    this.landed[slot] = hit;
    return slot + 1;
  }

  private disc(index: number, x: number, h: number, y: number, size: number, colour: Color, bright: number): void {
    this.dummy.position.set(x, h, y);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(size, 1, size);
    this.dummy.updateMatrix();
    this.discs.setMatrixAt(index, this.dummy.matrix);
    this.discs.setColorAt(index, this.colour.copy(colour).multiplyScalar(bright));
  }

  private streak(index: number, t: Tracer, bright: number): void {
    const dx = t.ex - t.x;
    const dy = t.ey - t.y;
    const dh = t.eh - t.h;
    const flat = Math.hypot(dx, dy);
    this.dummy.position.set(t.x, t.h, t.y);
    // The strip lies along +x: turned about the up axis to the round's heading
    // on the map, whose y is the world's z, then tipped to its climb.
    this.dummy.rotation.set(0, -Math.atan2(dy, dx), Math.atan2(dh, flat), 'YZX');
    this.dummy.scale.set(Math.max(0.01, Math.hypot(flat, dh)), 1, STREAK_WIDTH * (0.5 + 0.5 * bright));
    this.dummy.updateMatrix();
    this.streaks.setMatrixAt(index, this.dummy.matrix);
    this.streaks.setColorAt(index, this.colour.copy(STREAK_COLOUR).multiplyScalar(bright));
  }
}

/** Upload a batch's instances, and skip the upload for a batch that was empty and still is. */
function commit(mesh: InstancedMesh, count: number): void {
  if (count === 0 && mesh.count === 0) return;
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
}
