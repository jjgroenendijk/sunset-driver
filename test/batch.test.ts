import { BoxGeometry, type BufferAttribute, Euler, Matrix3, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  batchOfPacked,
  fillOfPacked,
  fillsOf,
  MAX_STEP_VERTICES,
  stopUploadingWith,
  tilePartOf,
  uploadBatchesWith,
} from '../src/render/batch.ts';
import { cellGrid } from '../src/render/cells.ts';
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

/**
 * One part too large for a single step, indexed in order. Its `n`-th vertex
 * stands at `x = n`, so a step that copies the wrong range of it is caught.
 */
function big(vertices: number): PackedPart {
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const tints = new Float32Array(vertices);
  const index = new Uint32Array(vertices);
  for (let v = 0; v < vertices; v++) {
    positions[v * 3] = v;
    normals[v * 3 + 1] = 1;
    tints[v] = 1;
    index[v] = v;
  }
  return {
    geometry: {
      attributes: [
        { name: 'position', array: positions, itemSize: 3, normalized: false },
        { name: 'normal', array: normals, itemSize: 3, normalized: false },
        { name: 'tint', array: tints, itemSize: 1, normalized: false },
      ],
      index,
    },
  };
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

  it('lets go of an array only once the renderer holds its current version', () => {
    const fill = fillOfPacked(packed([part(1), part(2)]), material);
    const mesh = fill.mesh;
    const geometry = mesh.geometry;
    // The renderer's record, as three.js keeps it: the version it uploaded.
    const record = new Map<unknown, { version: number }>();
    const renderer = { _attributes: { has: (a: unknown) => record.has(a), get: (a: unknown) => record.get(a) } };
    const attribute = (name: string): BufferAttribute => geometry.getAttribute(name) as BufferAttribute;
    const draw = (): void => mesh.onAfterRender(renderer as never, null as never, null as never, geometry, material, null as never);

    (fill.steps[0] as () => void)();
    record.set(attribute('position'), { version: attribute('position').version });
    draw();
    // A batch still filling keeps every array: the next step writes into them.
    expect(geometry.getAttribute('position').array.length).toBe(24);

    (fill.steps[1] as () => void)();
    const position = attribute('position');
    const normal = attribute('normal');
    const index = geometry.getIndex();
    record.set(position, { version: position.version - 1 });
    record.set(normal, { version: normal.version });
    record.set(index, { version: index?.version ?? 0 });
    draw();
    // The positions on the GPU are a version behind, so they stay; the rest go.
    expect(position.array.length).toBe(24);
    expect(normal.array.length).toBe(0);
    expect(normal.array).toBeInstanceOf(Float32Array);
    expect(index?.array).toBeInstanceOf(Uint16Array);
    expect(index?.array.length).toBe(0);
    // The renderer draws through the count, which an attribute keeps.
    expect(normal.count).toBe(8);
    expect(index?.count).toBe(12);

    record.set(position, { version: position.version });
    record.set(attribute('tint'), { version: attribute('tint').version });
    draw();
    expect(position.array.length).toBe(0);
    mesh.dispose();
  });

  it('uploads a batch as its steps fill it, and lets go of it after the last step, drawn or not', () => {
    // The renderer's record, as three.js keeps it, and the calls a step makes.
    const record = new Map<unknown, { version: number }>();
    const uploads: unknown[] = [];
    const freed: unknown[] = [];
    const renderer = {
      _attributes: {
        has: (a: unknown) => record.has(a),
        get: (a: unknown) => record.get(a),
        update: (a: BufferAttribute) => {
          uploads.push(a);
          record.set(a, { version: a.version });
        },
        delete: (a: unknown) => freed.push(a),
      },
    };
    uploadBatchesWith(renderer);
    try {
      const fill = fillOfPacked(packed([part(1), part(2)]), material);
      const geometry = fill.mesh.geometry;
      // A step of its own creates each buffer, the three attributes and the
      // index, so no frame pays for every buffer of a batch at once.
      expect(fill.steps).toHaveLength(6);
      for (let i = 0; i < 4; i++) {
        (fill.steps[i] as () => void)();
        expect(uploads).toHaveLength(i + 1);
      }
      (fill.steps[4] as () => void)();
      // Each attribute and the index are uploaded again by the step that wrote them.
      expect(uploads).toHaveLength(8);
      expect(geometry.getAttribute('position').array.length).toBe(24);

      (fill.steps[5] as () => void)();
      // Never drawn, and every array is gone: the GPU holds the batch.
      expect(geometry.getAttribute('position').array.length).toBe(0);
      expect(geometry.getAttribute('normal').array.length).toBe(0);
      expect(geometry.getIndex()?.array.length).toBe(0);
      expect(geometry.getAttribute('position').count).toBe(8);

      // The renderer frees what a draw uploaded; the batch frees what it did.
      fill.mesh.dispose();
      expect(freed).toHaveLength(4);
    } finally {
      uploadBatchesWith(undefined);
    }
  });

  it('keeps its arrays once the renderer it uploaded into is disposed', () => {
    // A renderer disposed but left as the uploader took the arrays of every
    // batch built after it, and the next renderer drew buffers of no bytes.
    const record = new Map<unknown, { version: number }>();
    const renderer = {
      _attributes: {
        has: (a: unknown) => record.has(a),
        get: (a: unknown) => record.get(a),
        update: (a: BufferAttribute) => record.set(a, { version: a.version }),
        delete: () => {},
      },
    };
    uploadBatchesWith(renderer);
    try {
      stopUploadingWith({});
      stopUploadingWith(renderer);
      const fill = fillOfPacked(packed([part(1)]), material);
      for (const step of fill.steps) step();
      expect(record.size).toBe(0);
      expect(fill.mesh.geometry.getAttribute('position').array.length).toBe(12);
    } finally {
      uploadBatchesWith(undefined);
    }
  });

  it('turns a normal packed in signed bytes by the frame of its part', () => {
    // A quarter turn about the vertical takes +x to -z.
    const turn = new Matrix4().makeRotationY(Math.PI / 2);
    const geometry: PackedGeometry = {
      attributes: [
        { name: 'position', array: new Float32Array([1, 0, 0]), itemSize: 3, normalized: false },
        { name: 'normal', array: new Int8Array([127, 0, 0, 9]), itemSize: 4, normalized: true },
      ],
    };
    const storage: PackedGeometry = {
      attributes: [
        { name: 'position', array: new Float32Array(3), itemSize: 3, normalized: false },
        { name: 'normal', array: new Int8Array(4), itemSize: 4, normalized: true },
      ],
    };
    const mesh = batchOfPacked({ parts: [{ geometry, matrix: new Float32Array(turn.toArray()) }], storage }, material);
    expect([...(mesh.geometry.getAttribute('normal').array as Int8Array)]).toEqual([0, 0, -127, 9]);
    expect(mesh.geometry.getAttribute('position').getZ(0)).toBeCloseTo(-1);
    mesh.dispose();
  });

  it('copies a part larger than a step over several of them, and draws it once', () => {
    // A tower of a chunk of the core is about sixteen steps of this size. What
    // a frame overruns its streaming slice by is one step, so the overrun is
    // this number of vertices and not whatever the generator built.
    const vertices = MAX_STEP_VERTICES * 3 + 17;
    const tower = big(vertices);
    const fill = fillOfPacked(packed([tower]), material);
    expect(fill.steps.length).toBe(4);

    // The part is drawn only once its last step is in: the index is what the
    // renderer reads vertices through, so a half-copied part must not be in it.
    for (const step of fill.steps.slice(0, -1)) {
      step();
      expect(fill.mesh.geometry.drawRange.count).toBe(0);
      expect(fill.mesh.parts).toBe(0);
    }
    (fill.steps[fill.steps.length - 1] as () => void)();
    expect(fill.mesh.parts).toBe(1);
    expect(fill.mesh.geometry.drawRange.count).toBe(vertices);

    // Every vertex of it landed, each one once and in its own place.
    const position = fill.mesh.geometry.getAttribute('position');
    let complaint: string | undefined;
    for (let v = 0; v < vertices; v++) {
      if (position.getX(v) !== v) complaint ??= `vertex ${v} stands at ${position.getX(v)}`;
    }
    expect(complaint).toBeUndefined();
    fill.mesh.dispose();
  });

  it('cuts parts into the cells they stand in, and lets a shared model go once, after its last copy', () => {
    const grid = cellGrid({ minX: 0, minY: 0, maxX: 250, maxY: 250 }, 'near');
    const model = new BoxGeometry(1, 1, 1);
    let disposed = 0;
    model.addEventListener('dispose', () => disposed++);
    // Three copies of one model: two in the far corner cell, one in the near
    // corner. The far corner is listed first, and the near corner comes first
    // in cell order.
    const at = (x: number, z: number): Matrix4 => new Matrix4().makeTranslation(x, 0, z);
    const parts = [at(200, 200), at(10, 20), at(180, 240)].map((matrix) => ({ geometry: model, matrix }));
    const fills = fillsOf(grid, parts, material);
    expect(fills).toHaveLength(2);
    const tile = tilePartOf(fills);
    expect(tile.drawCalls).toBe(2);
    expect(tile.objects).toHaveLength(2);

    // Each cell's bounds hold only its own parts, which is what lets the view
    // cull one cell and draw the other.
    const [near, far] = fills as [(typeof fills)[number], (typeof fills)[number]];
    for (const step of tile.steps.slice(0, -1)) step();
    expect(disposed).toBe(0);
    (tile.steps[tile.steps.length - 1] as () => void)();
    expect(disposed).toBe(1);
    expect(near.mesh.parts).toBe(1);
    expect(far.mesh.parts).toBe(2);
    expect(near.mesh.geometry.boundingBox?.max.x).toBeLessThan(125);
    expect(far.mesh.geometry.boundingBox?.min.x).toBeGreaterThan(125);
    tile.dispose();
  });
});
