/**
 * A pool of instances that shares its shader with every pool of its material.
 *
 * three.js 0.186 puts the `uuid` of an `InstancedMesh` into the key of its
 * program, because the mesh's instance buffer is built into the program's
 * bindings. Every pool is therefore a node build of its own in every pass it is
 * drawn in, and the traffic, the parked cars and the services hold one pool per
 * class and part: 157 pools were 4.5 s of the 5.6 s the warm-up of `warm.ts`
 * took on an Apple M1 (issue #786).
 *
 * A pool here is a plain `Mesh` over an `InstancedBufferGeometry`. The
 * instances are geometry attributes, read by name in the material's vertex
 * stage, as the crowd reads its own (`pedestrian-material.ts`). A vertex buffer
 * is bound per object, so the pools of one material with the same attribute
 * layout share one build.
 *
 * The mesh keeps `count` at 1, because three.js puts the `uuid` of an object
 * whose `count` is above 1 into the key as well. The number of instances is
 * the geometry's `instanceCount`, which is what three.js draws.
 *
 * The API is the part of `InstancedMesh` the pools use, so a view fills a pool
 * the same way it filled an `InstancedMesh`.
 */
import {
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  Object3D,
  type BufferGeometry,
  type Color,
  type Matrix4,
} from 'three';
import type { NodeMaterial } from 'three/webgpu';
import { attribute, Fn, mat4, materialColor, normalLocal, positionLocal, transformNormal } from '../tsl.ts';

/** Where an instance's tint starts, after its matrix. */
const TINT = 16;

/**
 * Numbers per instance: the matrix and the tint in one buffer. A WebGPU
 * pipeline reads at most eight vertex buffers, and the trim of a vehicle
 * already reads six (`docs/render-traffic.md`).
 */
const STRIDE = TINT + 3;

/** The materials whose vertex stage already reads a pool's instances. */
const dressed = new WeakSet<NodeMaterial>();

/**
 * Make `material` draw a pool: move each vertex by its instance's matrix and
 * multiply the colour by its instance's tint. The material is changed in
 * place, so a node set on it later, such as the fade of `fade.ts`, still
 * reaches it. It must therefore be drawn by pools and by nothing else.
 */
function dress(material: NodeMaterial): void {
  if (dressed.has(material)) return;
  dressed.add(material);
  if (material.positionNode !== null) throw new Error('A pool cannot draw a material that moves its own vertices.');
  const matrix = mat4(
    attribute('poolRow0', 'vec4'),
    attribute('poolRow1', 'vec4'),
    attribute('poolRow2', 'vec4'),
    attribute('poolRow3', 'vec4'),
  );
  material.positionNode = Fn(() => {
    normalLocal.assign(transformNormal(normalLocal, matrix));
    return matrix.mul(positionLocal).xyz;
  })();
  material.colorNode = (material.colorNode ?? materialColor).mul(attribute('poolTint', 'vec3'));
}

export class Pool extends Object3D {
  /** The geometry of one instance, as the view made it. The view disposes of it. */
  readonly geometry: BufferGeometry;
  /** The material every instance is drawn with. The view disposes of it. */
  readonly material: NodeMaterial;
  /**
   * Each instance's matrix and tint, {@link STRIDE} numbers: the matrix column
   * by column, as `Matrix4.toArray` writes it, then the tint, white until it is
   * set. `needsUpdate` on either uploads both.
   */
  readonly instanceMatrix: InstancedInterleavedBuffer;
  /** The tint of each instance, a view of {@link Pool.instanceMatrix}. */
  readonly instanceColor: InterleavedBufferAttribute;
  /** What three.js draws: the instance's geometry, with the instances as attributes of it. */
  private readonly shape = new InstancedBufferGeometry();

  constructor(geometry: BufferGeometry, material: NodeMaterial, cap: number, castShadow: boolean) {
    super();
    this.geometry = geometry;
    this.material = material;
    this.shape.index = geometry.index;
    for (const [name, values] of Object.entries(geometry.attributes)) this.shape.setAttribute(name, values);
    for (const group of geometry.groups) this.shape.addGroup(group.start, group.count, group.materialIndex);
    this.shape.instanceCount = 0;
    const values = new Float32Array(cap * STRIDE);
    for (let i = 0; i < cap; i++) values.fill(1, i * STRIDE + TINT, (i + 1) * STRIDE);
    this.instanceMatrix = new InstancedInterleavedBuffer(values, STRIDE);
    for (let row = 0; row < 4; row++) {
      this.shape.setAttribute(`poolRow${row}`, new InterleavedBufferAttribute(this.instanceMatrix, 4, row * 4));
    }
    this.instanceColor = new InterleavedBufferAttribute(this.instanceMatrix, 3, TINT);
    this.shape.setAttribute('poolTint', this.instanceColor);
    dress(material);
    const mesh = new Mesh(this.shape, material);
    // The instances are spread over hundreds of metres; the geometry's own bounds say nothing about them.
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    this.add(mesh);
    // Only the mesh is drawn; the pool says what it casts so a reader of the pool need not ask it.
    this.castShadow = castShadow;
  }

  /** The instances drawn: the first `count` of the pool. */
  override get count(): number {
    return this.shape.instanceCount;
  }

  override set count(value: number) {
    this.shape.instanceCount = value;
  }

  setMatrixAt(index: number, matrix: Matrix4): void {
    matrix.toArray(this.instanceMatrix.array, index * STRIDE);
  }

  getMatrixAt(index: number, matrix: Matrix4): void {
    matrix.fromArray(this.instanceMatrix.array, index * STRIDE);
  }

  setColorAt(index: number, colour: Color): void {
    colour.toArray(this.instanceMatrix.array, index * STRIDE + TINT);
  }

  /** Free the instance buffers. The geometry and the material are the view's to dispose of. */
  override dispose(): void {
    this.shape.dispose();
  }
}
