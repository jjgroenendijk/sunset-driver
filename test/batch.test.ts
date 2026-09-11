import { Euler, Matrix3, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { batchOfPacked, fillOfPacked } from '../src/render/batch.ts';
import { packedVertexCount, type PackedBatch, type PackedGeometry, type PackedPart } from '../src/render/chunk-payload.ts';

/**
 * A wedge, indexed, with a normal per vertex and a tint the batch has to carry
 * across untouched. The shape is deliberately lopsided, so a part put down the
 * wrong way round cannot land on the shape it should have had.
 */
function wedge(tint: number): PackedGeometry {
  const positions = new Float32Array([0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, 7]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1]);
  const tints = new Float32Array([tint, tint, tint, tint]);
  return {
    attributes: [
      { name: 'position', array: positions, itemSize: 3, normalized: false },
      { name: 'normal', array: normals, itemSize: 3, normalized: false },
      { name: 'tint', array: tints, itemSize: 1, normalized: false },
    ],
    index: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

/** A part of a chunk: a wedge, and the frame it stands in if it has one. */
function part(tint: number, matrix?: Matrix4): PackedPart {
  const packed: PackedPart = { geometry: wedge(tint) };
  if (matrix !== undefined) packed.matrix = new Float32Array(matrix.toArray());
  return packed;
}

/**
 * The parts of one batch with the storage a worker would have allocated for
 * them: every attribute of the first part, at the length of all of them
 * together. `chunk-payload.ts` allocates this off the frame thread, and the
 * batch is merged into those very arrays.
 */
function packed(parts: PackedPart[]): PackedBatch {
  const first = parts[0]?.geometry;
  if (first === undefined) return { parts, storage: { attributes: [] } };
  let vertices = 0;
  let indices = 0;
  for (const one of parts) {
    vertices += packedVertexCount(one.geometry);
    indices += one.geometry.index?.length ?? 0;
  }
  const storage: PackedGeometry = {
    attributes: first.attributes.map((attribute) => ({
      name: attribute.name,
      array: new Float32Array(vertices * attribute.itemSize),
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
    })),
  };
  if (first.index !== undefined) storage.index = new Uint16Array(indices);
  return { parts, storage };
}

/** A turn, a move and a scale together: everything a placement can do to a part. */
function frame(x: number, y: number, z: number, turn: number, scale = 1): Matrix4 {
  return new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromEuler(new Euler(0, turn, 0)),
    new Vector3(scale, scale, scale),
  );
}

/** The `i`-th vertex of a packed geometry, before anything is done to it. */
function vertexOf(geometry: PackedGeometry, name: string, i: number): Vector3 {
  const attribute = geometry.attributes.find((entry) => entry.name === name);
  const array = attribute?.array as Float32Array;
  return new Vector3(array[i * 3] as number, array[i * 3 + 1] as number, array[i * 3 + 2] as number);
}

describe('a chunk batch', () => {
  const material = new MeshBasicMaterial();

  it('stands every part where its own frame says, in one geometry', () => {
    const frames = [frame(120, 3, -40, 0.7), frame(-8, 0, 260, -2.1, 0.5), undefined];
    const parts = frames.map((matrix, i) => part(i + 1, matrix));
    const batch = batchOfPacked(packed(parts), material);

    const position = batch.geometry.getAttribute('position');
    const normal = batch.geometry.getAttribute('normal');
    const tint = batch.geometry.getAttribute('tint');
    const index = batch.geometry.getIndex();
    expect(batch.parts).toBe(parts.length);
    expect(position.count).toBe(parts.length * 4);
    expect(index?.count).toBe(parts.length * 6);
    // Everything is in, so the whole of it is drawn.
    expect(batch.geometry.drawRange.count).toBe(parts.length * 6);

    let complaint: string | undefined;
    for (let p = 0; p < parts.length; p++) {
      const matrix = frames[p];
      const packed = (parts[p] as PackedPart).geometry;
      for (let v = 0; v < 4; v++) {
        const at = p * 4 + v;
        // A place moves with the part, and turns and scales with it.
        const wanted = vertexOf(packed, 'position', v);
        if (matrix !== undefined) wanted.applyMatrix4(matrix);
        const stood = new Vector3().fromBufferAttribute(position, at);
        if (stood.distanceTo(wanted) > 1e-4) complaint ??= `part ${p} vertex ${v} stands at ${stood.toArray()}, not ${wanted.toArray()}`;

        // A direction only turns, and comes back the length it went in.
        const way = vertexOf(packed, 'normal', v);
        if (matrix !== undefined) way.applyMatrix3(new Matrix3().getNormalMatrix(matrix)).normalize();
        const faces = new Vector3().fromBufferAttribute(normal, at);
        if (faces.distanceTo(way) > 1e-4) complaint ??= `part ${p} normal ${v} faces ${faces.toArray()}, not ${way.toArray()}`;

        // Anything that is neither is carried across as it stands.
        if (tint.getX(at) !== p + 1) complaint ??= `part ${p} vertex ${v} lost its tint`;
      }
      // Each part's triangles read its own vertices and nobody else's.
      for (let k = 0; k < 6; k++) {
        const read = index?.getX(p * 6 + k) ?? -1;
        if (read < p * 4 || read >= (p + 1) * 4) complaint ??= `part ${p} index ${k} reads vertex ${read}`;
      }
    }
    expect(complaint).toBeUndefined();

    // The bounds are what the view culls the chunk by, so they hold the parts.
    const bounds = batch.geometry.boundingBox;
    expect(bounds?.containsPoint(new Vector3(120, 3, -40))).toBe(true);
    expect(bounds?.containsPoint(new Vector3(-8, 0, 260))).toBe(true);
    batch.dispose();
  });

  it('is drawn as far as it is filled, and not at all until its first part is in', () => {
    const fill = fillOfPacked(packed([part(1, frame(0, 0, 0, 0)), part(2, frame(50, 0, 0, 1))]), material);
    // A batch with nothing in it has no attributes for the renderer to read.
    expect(fill.mesh.visible).toBe(false);
    expect(fill.mesh.geometry.drawRange.count).toBe(0);

    (fill.steps[0] as () => void)();
    expect(fill.mesh.visible).toBe(true);
    expect(fill.mesh.parts).toBe(1);
    // Half a batch draws half a batch: the second part is still to come.
    expect(fill.mesh.geometry.drawRange.count).toBe(6);

    (fill.steps[1] as () => void)();
    expect(fill.mesh.parts).toBe(2);
    expect(fill.mesh.geometry.drawRange.count).toBe(12);
    fill.mesh.dispose();
  });
});
