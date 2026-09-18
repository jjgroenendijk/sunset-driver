/**
 * The skid marks of spec section 11.3.
 *
 * A tyre that is sliding across the road rather than rolling along it leaves a
 * mark. The simulation says which wheels are doing that — `WheelState.skid` —
 * and this lays a decal on the ground under each of them, every
 * {@link SKID_STEP} metres, so a drift comes out as one continuous stripe per
 * tyre however fast the car was going.
 *
 * A mark is a `DecalGeometry`, which is the clipped shape of the ground it is
 * laid on, so it follows a kerb, a camber and a hill instead of floating over
 * them. It is not projected onto the chunk the car is standing on: a chunk's
 * ground is twenty thousand triangles and a decal is clipped against every one
 * of them. It is projected onto a patch of a few cells sampled from the same
 * carve the chunk was built from, aligned to the same grid, so the mark lands
 * on the ground the player can see and costs two dozen triangles to cut.
 *
 * Only a paved road takes a mark. Dirt and sand are where a car slides most and
 * hold no rubber, so a tyre sliding there lays nothing; the dust it throws up
 * belongs with the weather and the particles instead.
 *
 * Every mark goes into one buffer with one material, so the whole road's worth
 * of rubber is a single draw call. The buffer is a ring: once it is full the
 * oldest marks are written over, which is what bounds a long drive. A mark
 * fades as the ring comes round to it, so the oldest rubber thins away rather
 * than going out between one frame and the next.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { headingOf, isLoose, type VehicleSpec, type VehicleState, type WheelSpec, type WheelState } from '../sim/vehicle.ts';
import type { Surface } from '../world/surface.ts';
import { CHUNK_TERRAIN_CELL } from '../world/terrain.ts';
import { attribute, float } from './tsl.ts';

/** Vertices the buffer holds. About four hundred marks, which is a long drift. */
export const SKID_VERTEX_CAP = 12_000;

/** Metres of ground between one mark of a tyre and the next. */
export const SKID_STEP = 1.2;

/** Metres a mark is lifted off the ground it is cut from, so the road does not hide it. */
const SKID_LIFT = 0.03;

/** Metres each way of the contact point the patch of ground covers. */
const PATCH_CELLS = 2;

/** How deep the projector reaches through the ground, in metres. */
const PROJECT_DEPTH = 1.5;

/** How much longer than the step a mark is cut, so one overlaps the next. */
const OVERLAP = 1.35;

/** The rubber left on the road. */
const RUBBER = 0x14100f;

/** How dark a fresh mark is laid, before anything has aged it. */
const RUBBER_OPACITY = 0.65;

/** The share of the ring a mark spends fading, at the end of its life in the buffer. */
const FADE_SHARE = 0.35;

/** Where a tyre last left a mark, so the next one is a step further on. */
interface LastMark {
  x: number;
  z: number;
  marked: boolean;
}

/** The rubber a drifting car leaves on the road, as one mesh. */
export class SkidMarks {
  readonly mesh: Mesh;
  private readonly positions: Float32Array;
  private readonly normals: Float32Array;
  /** What is left of each vertex's rubber, from 1 when it is laid to 0 as the ring reaches it. */
  private readonly alphas: Float32Array;
  /**
   * Vertices the buffer had taken when each vertex was laid, which is what its
   * age is measured from. It is never uploaded, so it counts in doubles: a
   * float stops counting whole numbers long before a long session stops laying
   * rubber.
   */
  private readonly stamps: Float64Array;
  /** Vertices written since the buffer was cleared. It counts on past the cap; the ring does not. */
  private written = 0;
  private readonly geometry = new BufferGeometry();
  /** Where the next mark is written, and whether the ring has come round. */
  private cursor = 0;
  private wrapped = false;
  /** Marks laid since the buffer was last cleared, which is what the tests count. */
  private laid = 0;
  private readonly last: LastMark[] = [];
  /** The patch of ground a mark is cut from, rebuilt under each wheel. */
  private readonly patch: Mesh;
  private readonly at = new Vector3();
  private readonly pose = new Quaternion();
  private readonly axisX = new Vector3();
  private readonly axisY = new Vector3();
  private readonly axisZ = new Vector3(0, 1, 0);
  private readonly basis = new Matrix4();
  private readonly facing = new Euler();
  private readonly size = new Vector3();

  constructor(cap = SKID_VERTEX_CAP) {
    this.positions = new Float32Array(cap * 3);
    this.normals = new Float32Array(cap * 3);
    this.alphas = new Float32Array(cap);
    this.stamps = new Float64Array(cap);
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(this.normals, 3));
    this.geometry.setAttribute('rubber', new BufferAttribute(this.alphas, 1));
    this.geometry.setDrawRange(0, 0);
    // The fade is a per-vertex attribute rather than a material uniform,
    // because each mark thins away on its own age: the shader reads what
    // {@link SkidMarks.refade} worked out for the vertex it is drawing.
    const material = new MeshBasicNodeMaterial({
      color: RUBBER,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    material.opacityNode = attribute('rubber', 'float').mul(float(RUBBER_OPACITY));
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.patch = buildPatch();
  }

  /**
   * Lay whatever marks this frame calls for. Call it once a frame with the
   * record the simulation has just written and the carved ground of the world.
   * `surfaceAt` is what that ground is made of, which decides whether a sliding
   * tyre leaves anything at all.
   */
  update(
    v: VehicleState,
    spec: VehicleSpec,
    heightAt: (x: number, y: number) => number,
    surfaceAt: (x: number, y: number) => Surface,
  ): void {
    if (spec.wheels.length === 0) return;
    const heading = headingOf(v);
    for (let i = 0; i < spec.wheels.length; i++) {
      const wheel = spec.wheels[i] as WheelSpec;
      const state = v.wheels[i] as WheelState;
      // A two-wheeler stands on four wheels and rides on two, so it leaves the
      // two the rider sees (`vehicle.ts`).
      if (spec.inline && wheel.z < 0) continue;
      const last = this.lastOf(i);
      if (!state.skid || !state.contact) {
        last.marked = false;
        continue;
      }
      this.contact(v, spec, wheel, state);
      const x = this.at.x;
      const z = this.at.z;
      // Dirt, sand and open ground hold no rubber (spec section 11.3). A tyre
      // that slides off the tarmac and back on leaves two stripes rather than
      // one, so the stripe it was laying is ended here.
      if (isLoose(surfaceAt(x, z))) {
        last.marked = false;
        continue;
      }
      const step = last.marked ? Math.hypot(x - last.x, z - last.z) : SKID_STEP;
      if (step < SKID_STEP) continue;
      last.x = x;
      last.z = z;
      last.marked = true;
      this.lay(x, z, heading, spec.wheelWidth * 1.3, Math.min(step, SKID_STEP * 3) * OVERLAP, heightAt);
    }
  }

  /** How many marks have been laid. A mark is one decal, cut from the ground. */
  get marks(): number {
    return this.laid;
  }

  /** Forget every mark: a new session, a loaded save or a vehicle put down somewhere else. */
  clear(): void {
    this.positions.fill(0);
    this.normals.fill(0);
    this.alphas.fill(0);
    this.stamps.fill(0);
    this.written = 0;
    this.cursor = 0;
    this.wrapped = false;
    this.laid = 0;
    this.last.length = 0;
    this.geometry.setDrawRange(0, 0);
    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('rubber') as BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
    this.patch.geometry.dispose();
  }

  /** Where a tyre last left a mark, made on the first frame it is asked for. */
  private lastOf(index: number): LastMark {
    let last = this.last[index];
    if (last === undefined) {
      last = { x: 0, z: 0, marked: false };
      this.last[index] = last;
    }
    return last;
  }

  /** The place a wheel touches the ground, in world axes. */
  private contact(v: VehicleState, spec: VehicleSpec, wheel: WheelSpec, state: WheelState): void {
    this.at.set(wheel.x, wheel.y - state.suspension - spec.wheelRadius, spec.inline ? 0 : wheel.z);
    this.pose.set(v.qx, v.qy, v.qz, v.qw);
    this.at.applyQuaternion(this.pose);
    this.at.set(v.x + this.at.x, v.y + this.at.y, v.z + this.at.z);
  }

  /** Cut one mark out of the ground and copy it into the buffer. */
  private lay(
    x: number,
    z: number,
    heading: number,
    width: number,
    length: number,
    heightAt: (x: number, y: number) => number,
  ): void {
    layPatch(this.patch, x, z, heightAt);
    // The projector looks down the ground's normal, with the mark's length
    // along the way the tyre was dragged.
    this.axisX.set(Math.cos(heading), 0, Math.sin(heading));
    this.axisY.set(Math.sin(heading), 0, -Math.cos(heading));
    this.basis.makeBasis(this.axisX, this.axisY, this.axisZ);
    this.facing.setFromRotationMatrix(this.basis);
    this.at.set(x, heightAt(x, z), z);
    this.size.set(length, width, PROJECT_DEPTH);
    const decal = new DecalGeometry(this.patch, this.at, this.facing, this.size);
    this.laid++;
    this.copy(decal);
    decal.dispose();
  }

  /** Write a decal's vertices into the ring, lifted clear of the ground. */
  private copy(decal: BufferGeometry): void {
    const from = decal.getAttribute('position') as BufferAttribute;
    const normals = decal.getAttribute('normal') as BufferAttribute;
    const count = from.count;
    const cap = this.positions.length / 3;
    if (count === 0 || count > cap) return;
    if (this.cursor + count > cap) {
      // The ring has come round. What is left at the end is collapsed onto the
      // origin, where three vertices in one place draw nothing.
      this.positions.fill(0, this.cursor * 3);
      this.normals.fill(0, this.cursor * 3);
      this.cursor = 0;
      this.wrapped = true;
    }
    this.written += count;
    for (let i = 0; i < count; i++) {
      const out = (this.cursor + i) * 3;
      this.positions[out] = from.getX(i);
      this.positions[out + 1] = from.getY(i) + SKID_LIFT;
      this.positions[out + 2] = from.getZ(i);
      this.normals[out] = normals.getX(i);
      this.normals[out + 1] = normals.getY(i);
      this.normals[out + 2] = normals.getZ(i);
      this.stamps[this.cursor + i] = this.written;
    }
    this.cursor += count;
    this.geometry.setDrawRange(0, this.wrapped ? cap : this.cursor);
    this.refade();
    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('normal') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('rubber') as BufferAttribute).needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  /**
   * Work out what is left of every mark in the buffer. A vertex is written over
   * once the ring has taken another buffer's worth of vertices, so how much of
   * that it has already spent is how far through its life it is. It is walked
   * whole rather than kept up per frame: a mark is laid a few times a second at
   * most, and the buffer is a few thousand floats.
   */
  private refade(): void {
    const cap = this.alphas.length;
    const fading = cap * FADE_SHARE;
    for (let i = 0; i < cap; i++) {
      const left = cap - (this.written - (this.stamps[i] as number));
      this.alphas[i] = Math.max(0, Math.min(1, left / fading));
    }
  }
}

/** Cells each way of the patch, and the vertices that takes. */
const PATCH_SPAN = PATCH_CELLS * 2;
const PATCH_SIDE = PATCH_SPAN + 1;

/** The little mesh of ground a mark is cut from, built once and moved under each wheel. */
function buildPatch(): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(PATCH_SIDE * PATCH_SIDE * 3), 3));
  const indices: number[] = [];
  for (let j = 0; j < PATCH_SPAN; j++) {
    for (let i = 0; i < PATCH_SPAN; i++) {
      const a = j * PATCH_SIDE + i;
      const b = a + 1;
      const c = a + PATCH_SIDE;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  geometry.setIndex(indices);
  return new Mesh(geometry);
}

/**
 * Sample the carve into the patch around a place. The grid is anchored on the
 * origin at the chunk terrain cell, so the patch is cut from the same samples
 * the chunk's ground was built from and the mark lands on the ground drawn.
 */
function layPatch(patch: Mesh, x: number, z: number, heightAt: (x: number, y: number) => number): void {
  const position = patch.geometry.getAttribute('position') as BufferAttribute;
  const x0 = Math.floor(x / CHUNK_TERRAIN_CELL) * CHUNK_TERRAIN_CELL - PATCH_CELLS * CHUNK_TERRAIN_CELL;
  const z0 = Math.floor(z / CHUNK_TERRAIN_CELL) * CHUNK_TERRAIN_CELL - PATCH_CELLS * CHUNK_TERRAIN_CELL;
  for (let j = 0; j < PATCH_SIDE; j++) {
    for (let i = 0; i < PATCH_SIDE; i++) {
      const px = x0 + i * CHUNK_TERRAIN_CELL;
      const pz = z0 + j * CHUNK_TERRAIN_CELL;
      position.setXYZ(j * PATCH_SIDE + i, px, heightAt(px, pz), pz);
    }
  }
  position.needsUpdate = true;
  patch.geometry.computeVertexNormals();
  patch.updateMatrixWorld();
}
