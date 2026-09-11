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
 * only thing that overruns the slice.
 */
import { BatchedMesh, Matrix4, type BufferGeometry, type Material } from 'three';
import { unpackGeometry, type PackedGeometry, type PackedPart } from './chunk-payload.ts';

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
  const mesh = new BatchedMesh(parts.length, vertices, indices, material);
  const steps = parts.map((part) => () => {
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
 * Prepare a batch of parts a worker built (spec section 9.1). The batch is
 * sized off the arrays, so nothing is unpacked until its step runs and the
 * frame is charged for one part at a time.
 */
export function fillOfPacked(parts: readonly PackedPart[], material: Material): BatchFill {
  let vertices = 0;
  let indices = 0;
  for (const part of parts) {
    vertices += vertexCount(part.geometry);
    indices += part.geometry.index?.length ?? 0;
  }
  const mesh = new BatchedMesh(parts.length, vertices, indices, material);
  const steps = parts.map((part) => () => {
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
export function batchOfPacked(parts: readonly PackedPart[], material: Material): BatchedMesh {
  return filled(fillOfPacked(parts, material));
}

function filled(fill: BatchFill): BatchedMesh {
  for (const step of fill.steps) step();
  return fill.mesh;
}

/** Vertices a packed geometry holds, read off its positions. */
function vertexCount(geometry: PackedGeometry): number {
  const position = geometry.attributes.find((attribute) => attribute.name === 'position');
  return position === undefined ? 0 : position.array.length / position.itemSize;
}
