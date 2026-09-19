/**
 * The flashing lamps of the police and the emergency services (spec sections
 * 14, 20.3), and the light they throw on the road round them.
 *
 * A unit's beacons are boxes in two phases (`emergency-mesh.ts`): the left
 * half of a bar and the right, or a tail beacon on each side. Each phase is
 * one instanced mesh, with the colour of every lamp on its vertices and how
 * hard it burns on the instance, so one half of every bar in view flashes while
 * the other is dark. The flash is a double flash — two short bursts on one
 * side, then two on the other — which is what a real bar does and what reads as
 * urgent rather than as a slow blink.
 *
 * {@link BeaconGlow} is the light on the ground. It is a soft disc added over
 * the road, not a light: a point light turns the clustered path on for every
 * fragment in the city (`docs/lighting.md`). It is faint by day and strong
 * after dark, in the colour of whichever half is burning.
 */
import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import type { Beacon } from './emergency-mesh.ts';
import { boxOf, coloured, instanced, merged } from './traffic.ts';
import { tinted } from './tint.ts';

/** Ticks of one whole flash: both bursts of one phase, then both of the other. */
export const FLASH_CYCLE = 36;

/** The ticks of the cycle each phase burns on: two bursts of four ticks. */
const BURSTS: readonly (readonly [number, number])[][] = [
  [
    [0, 4],
    [7, 11],
  ],
  [
    [18, 22],
    [25, 29],
  ],
];

/**
 * How hard a lit lamp burns, as a multiple of its colour. At 1 it stays under
 * the bloom threshold of `post.ts` once exposed, and a bar does not glow.
 */
export const BEACON_GLOW = 5;

/** How bright an unlit lens is: dark, but still red or blue, as a lens is. */
export const BEACON_DARK = 0.28;

/** Metres across the light a bar throws on the road. */
const GLOW_SIZE = 13;

/** How hard that light is by day and after dark. */
const GLOW_DAY = 0.04;
const GLOW_NIGHT = 0.5;

/**
 * Metres over the road the light is laid. The disc is flat and a street is
 * not: at less than this, one side of it sinks under a road on a slope and
 * shows as a hard edge. It lies over the kerb too, which is where light falls.
 */
const GLOW_LIFT = 0.4;

/** Whether a phase of a unit's beacons is lit on a tick. Each unit is on its own offset, so two never flash in step. */
export function flashLit(tick: number, id: number, phase: 0 | 1): boolean {
  const at = (((tick + id * 11) % FLASH_CYCLE) + FLASH_CYCLE) % FLASH_CYCLE;
  return (BURSTS[phase] ?? []).some(([from, to]) => at >= from && at < to);
}

/** One phase of the beacons of a kind of unit, as one instanced mesh. */
export class BeaconPhase {
  readonly mesh: InstancedMesh;
  /** The colour of the first lamp of this phase, which is the colour its light throws. */
  readonly colour: Color;
  private readonly bright = new Color();

  constructor(beacons: readonly Beacon[], phase: 0 | 1, material: MeshBasicMaterial, cap: number) {
    const own = beacons.filter((beacon) => beacon.phase === phase);
    this.colour = new Color(own[0]?.box.colour ?? 0xffffff);
    this.mesh = tinted(instanced(merged(own.map((beacon) => coloured(boxOf(beacon.box, 0), beacon.box.colour))), material, false, cap));
  }

  /** Stand one unit's lamps of this phase, lit or dark. */
  set(index: number, matrix: Matrix4, lit: boolean): void {
    this.mesh.setMatrixAt(index, matrix);
    const k = lit ? BEACON_GLOW : BEACON_DARK;
    this.mesh.setColorAt(index, this.bright.setRGB(k, k, k));
  }

  /** Show the first `count` units and hide the mesh when there are none. */
  commit(count: number): void {
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    if (count === 0) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
  }
}

/** The material every beacon is drawn with: its own colour, unlit, and past the tone map so it blooms. */
export function beaconMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
}

/** A disc bright in the middle and black at the rim, which added over the scene is a soft pool of light. */
function softDisc(): BufferGeometry {
  const geometry = new CircleGeometry(0.5, 20);
  geometry.rotateX(-Math.PI / 2);
  const count = geometry.getAttribute('position').count;
  const shade = new Float32Array(count * 3);
  // CircleGeometry puts the middle first and the rim after it.
  shade.set([1, 1, 1], 0);
  geometry.setAttribute('color', new Float32BufferAttribute(shade, 3));
  return geometry;
}

/** The light the bars in view throw on the road: one soft disc per unit, one draw call for them all. */
export class BeaconGlow {
  readonly mesh: InstancedMesh;
  /** How far on the street lamps are, 0 by day and 1 after dark, which is how hard the light shows. */
  night = 0;
  private count = 0;
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly flat = new Quaternion();
  private readonly size = new Vector3(GLOW_SIZE, 1, GLOW_SIZE);
  private readonly colour = new Color();

  constructor(cap: number) {
    const material = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });
    this.mesh = tinted(new InstancedMesh(softDisc(), material, cap));
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** Start a frame with no light on the road. */
  begin(): void {
    this.count = 0;
  }

  /** Throw a pool of `colour` on the road at a place, if there is room for one. */
  add(x: number, ground: number, y: number, colour: Color): void {
    if (this.count >= this.mesh.instanceMatrix.count) return;
    this.at.set(x, ground + GLOW_LIFT, y);
    this.matrix.compose(this.at, this.flat, this.size);
    this.mesh.setMatrixAt(this.count, this.matrix);
    const strength = GLOW_DAY + (GLOW_NIGHT - GLOW_DAY) * this.night;
    this.mesh.setColorAt(this.count, this.colour.copy(colour).multiplyScalar(strength));
    this.count++;
  }

  /** Show what was added this frame. */
  commit(): void {
    if (this.count === 0 && this.mesh.count === 0) return;
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.dispose();
  }
}
