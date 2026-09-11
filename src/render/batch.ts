/**
 * Packing a chunk's geometry into as few draw calls as it can be (spec sections
 * 9.1, 9.2).
 *
 * Everything of one kind in a chunk — every run of road, every tower, every
 * outline — goes into one `BatchedMesh`. The batch is sized to exactly what it
 * is given, because a chunk's contents are known before any of them is drawn,
 * and each part is released once it has been copied in. Instances that share a
 * geometry are added once and drawn many times, so a street of identical houses
 * costs one copy of the house.
 *
 * A batch is filled a part at a time. Copying a whole chunk of the core into
 * its batches costs more than the streaming slice of spec section 2.4, so the
 * scene runs the steps against its frame budget and stops when the budget is
 * spent; a batch half filled is drawn as far as it is filled. One step is
 * indivisible, because a geometry is copied into a batch whole, and it is the
 * only thing that overruns the slice. A batch a worker packed arrives with its
 * buffers already allocated, so a step is a copy and nothing else.
 */
import { BatchedMesh, BufferAttribute, Matrix4, type BufferGeometry, type Material } from 'three';
import { packedVertexCount, unpackGeometry, type PackedBatch, type PackedGeometry } from './chunk-payload.ts';

/** One thing to draw: a geometry, and where it stands if not at the origin. */
export interface BatchPart {
  geometry: BufferGeometry;
  /** Its frame in the world. Geometry already in world places needs none. */
  matrix?: Matrix4;
}

/** A batch, and the steps that fill it. Run the steps in order. */
export interface BatchFill {
  mesh: BatchedMesh;
  steps: (() => void)[];
}

/**
 * Prepare a batch of parts and the steps that copy them in. The parts are
 * disposed as they are copied, so a caller hands over its geometry rather than
 * keeping it.
 */
export function fillOf(parts: readonly BatchPart[], material: Material): BatchFill {
  let vertices = 0;
  let indices = 0;
  const shared = new Map<BufferGeometry, number>();
  for (const part of parts) {
    if (shared.has(part.geometry)) continue;
    shared.set(part.geometry, -1);
    vertices += part.geometry.getAttribute('position').count;
    indices += part.geometry.getIndex()?.count ?? 0;
  }
  const mesh = hiddenBatch(parts.length, vertices, indices, material);
  const steps = parts.map((part) => () => {
    mesh.visible = true;
    let id = shared.get(part.geometry) as number;
    if (id < 0) {
      id = mesh.addGeometry(part.geometry);
      shared.set(part.geometry, id);
      part.geometry.dispose();
    }
    const instance = mesh.addInstance(id);
    if (part.matrix !== undefined) mesh.setMatrixAt(instance, part.matrix);
  });
  return { mesh, steps };
}

/**
 * Prepare a batch of parts a worker built (spec section 9.1). The batch draws
 * from the storage the worker allocated, so nothing is allocated or unpacked
 * until a step runs and the frame is charged for one copy at a time.
 */
export function fillOfPacked(batch: PackedBatch, material: Material): BatchFill {
  const { parts, storage } = batch;
  const mesh = hiddenBatch(parts.length, packedVertexCount(storage), storage.index?.length ?? 0, material);
  if (parts.length > 0) adoptStorage(mesh, storage);
  const steps = parts.map((part) => () => {
    mesh.visible = true;
    const geometry = unpackGeometry(part.geometry);
    const instance = mesh.addInstance(mesh.addGeometry(geometry));
    if (part.matrix !== undefined) mesh.setMatrixAt(instance, new Matrix4().fromArray(part.matrix));
    geometry.dispose();
  });
  return { mesh, steps };
}

/** Pack parts into a single batch, all at once. */
export function batchOf(parts: readonly BatchPart[], material: Material): BatchedMesh {
  return filled(fillOf(parts, material));
}

/** Pack parts a worker built into a single batch, all at once. */
export function batchOfPacked(batch: PackedBatch, material: Material): BatchedMesh {
  return filled(fillOfPacked(batch, material));
}

/**
 * A batch that is not drawn until its first part is in. A batch with no part
 * has no attributes yet, and the renderer compiles a shader for that shape of
 * geometry the first frame it meets one: a stall, for a variant nothing needs.
 */
function hiddenBatch(parts: number, vertices: number, indices: number, material: Material): BatchedMesh {
  const mesh = new BatchedMesh(parts, vertices, indices, material);
  mesh.visible = false;
  return mesh;
}

function filled(fill: BatchFill): BatchedMesh {
  for (const step of fill.steps) step();
  return fill.mesh;
}

/**
 * Give a batch the buffers a worker allocated for it. `BatchedMesh` allocates
 * its own when the first geometry is added, unless it has been told it already
 * has them, and it has no public way to be told: the flag is set here and
 * nowhere else. `test/streaming.test.ts` pins that the batch draws from these
 * very arrays, which is what fails if a three.js upgrade renames the flag.
 */
function adoptStorage(mesh: BatchedMesh, storage: PackedGeometry): void {
  for (const attribute of storage.attributes) {
    mesh.geometry.setAttribute(attribute.name, new BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized));
  }
  if (storage.index !== undefined) mesh.geometry.setIndex(new BufferAttribute(storage.index, 1));
  (mesh as unknown as { _geometryInitialized: boolean })._geometryInitialized = true;
}
