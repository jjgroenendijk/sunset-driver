/**
 * Packing a chunk's geometry into as few draw calls as it can be (spec section
 * 9.2).
 *
 * Everything of one kind in a chunk — every run of road, every tower, every
 * outline — goes into one `BatchedMesh`. The batch is sized to exactly what it
 * is given, because a chunk's contents are known before any of them is drawn,
 * and each part is released once it has been copied in. Instances that share a
 * geometry are added once and drawn many times, so a street of identical houses
 * costs one copy of the house.
 */
import { BatchedMesh, type BufferGeometry, type Material, type Matrix4 } from 'three';

/** One thing to draw: a geometry, and where it stands if not at the origin. */
export interface BatchPart {
  geometry: BufferGeometry;
  /** Its frame in the world. Geometry already in world places needs none. */
  matrix?: Matrix4;
}

/**
 * Pack parts into a single batch. The parts are disposed as they are copied in,
 * so a caller hands over its geometry rather than keeping it.
 */
export function batchOf(parts: readonly BatchPart[], material: Material): BatchedMesh {
  let vertices = 0;
  let indices = 0;
  const shared = new Map<BufferGeometry, number>();
  for (const part of parts) {
    if (shared.has(part.geometry)) continue;
    shared.set(part.geometry, -1);
    vertices += part.geometry.getAttribute('position').count;
    indices += part.geometry.getIndex()?.count ?? 0;
  }
  const batch = new BatchedMesh(parts.length, vertices, indices, material);
  for (const part of parts) {
    let id = shared.get(part.geometry) as number;
    if (id < 0) {
      id = batch.addGeometry(part.geometry);
      shared.set(part.geometry, id);
      part.geometry.dispose();
    }
    const instance = batch.addInstance(id);
    if (part.matrix !== undefined) batch.setMatrixAt(instance, part.matrix);
  }
  return batch;
}
