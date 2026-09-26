/**
 * One batch of puffs for `damage-fx.ts`: the pool of smoke or of fire in
 * flight, and how each puff moves, grows, fades and turns as it ages.
 *
 * A puff is a square turned to face the camera, and `puff-material.ts` cuts a
 * soft, ragged shape out of it. Smoke rises fast and slows as it cools, spreads
 * as it goes and leans with the wind. Flame climbs faster the longer it burns,
 * flares and dies within a second, and flickers. An ember keeps its size and
 * flies on.
 */
import {
  Color,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  type Material,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { TICK_RATE } from '../../sim/clock.ts';
import { CAMERA_HEADING, CAMERA_PITCH } from '../camera/camera.ts';
import { tinted } from '../look/tint.ts';

/** Metres a second the wind carries smoke. */
const WIND_DRIFT = 0.9;

/** How much wider a puff of smoke is at the end of its life than at the start. */
const SMOKE_GROWTH = 2.6;

/** How fast each kind of puff loses its speed, per second: smoke cools, a blast stalls. */
const DRAG = { smoke: 0.55, flame: 1.6, ember: 0.35 } as const;

/** Metres a second squared that hot air pushes a flame up by. */
const BUOYANCY = 3;

/** How much taller than wide a flame is drawn. */
const FLAME_TALL = 1.5;

/** Soot at one end of a smoke's tone and pale steam at the other, and what either thins to. */
const SOOT = new Color(0x1b1816);
const STEAM = new Color(0xb8b4ae);
const THINNED = new Color(0x8c8884);

/** The tint of an ember, over the flame's own ramp. */
const EMBER_TINT = new Color(1, 0.75, 0.45);
const WHITE = new Color(1, 1, 1);

type Kind = keyof typeof DRAG;

/** One puff in flight. Everything about it is read off its age. */
export interface Puff {
  kind: Kind;
  born: number;
  life: number;
  x: number;
  y: number;
  z: number;
  /** Metres per second it leaves at, in world axes, before drag. */
  dx: number;
  dy: number;
  dz: number;
  /** Metres across it starts at. */
  size: number;
  /** A number of its own, 0 to 1: its patch of noise, its flicker and its turn. */
  variant: number;
  /** Smoke only: 0 for soot, 1 for pale steam. */
  tone: number;
  /** Smoke only: how much the fire under it lights it at birth, 0 to 1. */
  glow: number;
}

/** A puff of smoke with nothing but its place, speed, size, tone and glow to set. */
export function smokePuff(p: Omit<Puff, 'kind' | 'variant'>, variant: number): Puff {
  return { kind: 'smoke', variant, ...p };
}

/** Metres covered by something that left at `speed` and loses it at `drag` per second. */
function drifted(speed: number, drag: number, seconds: number): number {
  return (speed * (1 - Math.exp(-drag * seconds))) / drag;
}

/** One batch of puffs: the mesh, the pool behind it and what each instance is drawn with. */
export class Puffs {
  readonly mesh: InstancedMesh;
  private readonly live: Puff[] = [];
  private readonly data: InstancedBufferAttribute;
  private readonly dummy = new Object3D();
  private readonly colour = new Color();
  private readonly spin = new Quaternion();
  private readonly axis = new Vector3(0, 0, 1);
  private readonly cap: number;
  /** The way the wind blows, as a unit vector in world axes; set by {@link blow}. */
  private windX = 0;
  private windZ = 0;

  /** Which way the camera looks: every puff is turned to face it. */
  readonly facing = new Quaternion().setFromEuler(new Euler(-CAMERA_PITCH, CAMERA_HEADING, 0, 'YXZ'));

  constructor(cap: number, material: Material) {
    this.cap = cap;
    const geometry = new PlaneGeometry(1, 1);
    this.data = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    geometry.setAttribute('puff', this.data);
    this.mesh = tinted(new InstancedMesh(geometry, material, cap));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    // The camera of the frame being drawn, kept for the next frame's puffs.
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      this.facing.copy(camera.quaternion);
    };
  }

  /** The way the wind blows, in radians in the map's axes, which smoke leans with. */
  blow(heading: number): void {
    this.windX = Math.cos(heading);
    this.windZ = Math.sin(heading);
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
    // Newest first, so the oldest — the highest, nearest the camera — is blended last.
    for (let i = this.live.length - 1; i >= 0; i--) {
      const puff = this.live[i] as Puff;
      const age = (tick - puff.born) / puff.life;
      if (age < 0 || age >= 1) {
        if (age >= 1) this.live.splice(i, 1);
        continue;
      }
      this.place(puff, drawn, age, (tick - puff.born) / TICK_RATE, tick);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(drawn, this.dummy.matrix);
      this.mesh.setColorAt(drawn, this.colour);
      drawn++;
    }
    // Nothing to draw and nothing drawn last frame is nothing to upload: a
    // car that is not burning should cost the frame no buffer at all.
    if (drawn === 0 && this.mesh.count === 0) return;
    this.mesh.count = drawn;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
    this.data.needsUpdate = true;
  }

  /** Set the dummy, the colour and the shader's data of one puff at one moment of its life. */
  private place(puff: Puff, slot: number, age: number, seconds: number, tick: number): void {
    const drag = DRAG[puff.kind];
    const across = drifted(1, drag, seconds);
    let rise: number;
    let width: number;
    let tall = 1;
    let fade: number;
    let turn = 0;
    let glow = 0;
    if (puff.kind === 'smoke') {
      rise = drifted(puff.dy, drag, seconds);
      // It swells out of the fire quickly, then keeps spreading as it thins.
      width = puff.size * (0.5 + 0.5 * Math.min(1, age * 6)) * (1 + SMOKE_GROWTH * age);
      fade = Math.min(1, age / 0.12) * Math.pow(1 - age, 1.3);
      turn = puff.variant * Math.PI * 2 + seconds * (puff.variant - 0.5) * 0.6;
      glow = puff.glow * Math.max(0, 1 - age * 2.5);
      this.colour
        .copy(SOOT)
        .lerp(STEAM, puff.tone)
        .lerp(THINNED, age * 0.45);
    } else {
      const flicker = 0.82 + 0.36 * (0.5 + 0.5 * Math.sin(tick * 1.7 + puff.variant * 40));
      if (puff.kind === 'flame') {
        rise = puff.dy * seconds + 0.5 * BUOYANCY * seconds * seconds;
        // It flares up out of nothing, burns, and dies back into nothing.
        width = puff.size * (0.35 + 0.65 * Math.sin(Math.PI * Math.sqrt(age))) * flicker;
        tall = FLAME_TALL;
        fade = 1 - age * age;
        this.colour.copy(WHITE);
      } else {
        rise = drifted(puff.dy, drag, seconds);
        width = puff.size * flicker;
        fade = 1 - age;
        this.colour.copy(EMBER_TINT);
      }
    }
    this.dummy.position.set(puff.x + puff.dx * across, puff.y + rise, puff.z + puff.dz * across);
    if (puff.kind === 'smoke') {
      this.dummy.position.x += this.windX * WIND_DRIFT * seconds;
      this.dummy.position.z += this.windZ * WIND_DRIFT * seconds;
    }
    this.dummy.quaternion.copy(this.facing).multiply(this.spin.setFromAxisAngle(this.axis, turn));
    this.dummy.scale.set(width, width * tall, 1);
    this.data.setXYZW(slot, fade, puff.variant, age, glow);
  }

  clear(): void {
    this.live.length = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as Material).dispose();
    this.mesh.dispose();
  }
}
