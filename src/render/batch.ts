/**
 * Packing a chunk's geometry into as few draw calls as it can be (spec sections
 * 9.1, 9.2).
 *
 * Everything of one kind in a chunk — every run of road, every tower, every
 * outline, every tree — is merged into one geometry and drawn as one mesh. Each
 * part is copied in already standing where it stands in the world.
 *
 * It is not a `BatchedMesh`. In three.js 0.186 on WebGPU a `BatchedMesh` is
 * drawn as one draw call per instance, after its instances are culled and
 * sorted on the processor, in every pass: the view, each shadow cascade and the
 * water's mirror. Its shader is also keyed on the batch itself, so a batch that
 * comes into view in a pass for the first time builds its shaders again, and
 * that is a stall of tens of milliseconds while driving. A plain mesh shares its
 * shader with every chunk drawn in the same material, and costs one draw.
 *
 * A batch is filled a part at a time. Copying a whole chunk of the core into
 * its batches costs more than the streaming slice of spec section 2.4, so the
 * scene runs the steps against its frame budget and stops when the budget is
 * spent. A batch half filled is drawn as far as it is filled, and not at all
 * until its first part is in. One step is indivisible, because a part is copied
 * whole, and it is the only thing that overruns the slice.
 *
 * A batch a worker packed is merged into the storage that worker allocated
 * (`PackedBatch.storage`), so a step on the frame thread is a copy and nothing
 * else. A batch that allocated its own would do it inside its first part: tens
 * of megabytes in one frame, and the piece a collection lands in.
 */
import { Box3, BufferAttribute, BufferGeometry, Matrix3, Matrix4, Mesh, Sphere, type Material } from 'three';
import { packedVertexCount, type PackedAttribute, type PackedBatch, type PackedGeometry } from './chunk-payload.ts';

/** One thing to draw: a geometry, and where it stands if not at the origin. */
export interface BatchPart {
  geometry: BufferGeometry;
  /** Its frame in the world. Geometry already in world places needs none. */
  matrix?: Matrix4;
}

/** One kind of thing in one chunk, merged into one geometry and drawn once. */
export class Batch extends Mesh<BufferGeometry, Material> {
  /** Parts copied in so far. */
  parts = 0;

  /** Release the geometry. The material belongs to the world and is left alone. */
  dispose(): void {
    this.geometry.dispose();
  }
}

/** A batch, and the steps that fill it. Run the steps in order. */
export interface BatchFill {
  mesh: Batch;
  steps: (() => void)[];
}

/**
 * Attributes that are places in a part's own frame, which move with it, and
 * attributes that are directions, which only turn with it. The room a window of
 * a generated facade looks into is a place: the facade material reads it
 * against the fragment's position, so the two have to share a frame.
 */
const PLACES = new Set(['position', 'roomCenter']);
const DIRECTIONS = new Set(['normal']);

/** A typed array an attribute holds its numbers in. */
type AttributeArray = PackedAttribute['array'];

/** What a part holds, read the same way whether it was built here or in a worker. */
interface PartArrays {
  attributes: readonly PackedAttribute[];
  index: ArrayLike<number> | undefined;
  matrix: Matrix4 | undefined;
}

/**
 * Prepare a batch of parts and the steps that copy them in. A geometry is
 * disposed once the last part standing on it is copied, so a caller hands over
 * its geometry rather than keeping it.
 *
 * These parts are built on the frame thread — the plants and the street lamps,
 * which are copies of a handful of small models — so the storage is allocated
 * here as well.
 */
export function fillOf(parts: readonly BatchPart[], material: Material): BatchFill {
  const last = new Map<BufferGeometry, number>();
  parts.forEach((part, i) => last.set(part.geometry, i));
  const arrays = parts.map((part) => arraysOf(part.geometry, part.matrix));
  return fill(arrays, storageFor(arrays), material, (i) => {
    const geometry = (parts[i] as BatchPart).geometry;
    if (last.get(geometry) === i) geometry.dispose();
  });
}

/**
 * Prepare a batch of parts a worker built (spec section 9.1). The parts are
 * merged into the storage that worker allocated, so nothing is allocated until
 * a step runs and the frame is charged for one copy at a time.
 */
export function fillOfPacked(batch: PackedBatch, material: Material): BatchFill {
  const parts = batch.parts.map((part) => ({
    attributes: part.geometry.attributes,
    index: part.geometry.index,
    matrix: part.matrix === undefined ? undefined : new Matrix4().fromArray(part.matrix),
  }));
  return fill(parts, batch.storage, material, () => {});
}

/** Pack parts into a single batch, all at once. */
export function batchOf(parts: readonly BatchPart[], material: Material): Batch {
  return filled(fillOf(parts, material));
}

/** Pack parts a worker built into a single batch, all at once. */
export function batchOfPacked(batch: PackedBatch, material: Material): Batch {
  return filled(fillOfPacked(batch, material));
}

function filled(fill: BatchFill): Batch {
  for (const step of fill.steps) step();
  return fill.mesh;
}

/**
 * Storage for parts that were not packed by a worker: every attribute of the
 * first part, at the length of all of them together, and an index as wide as
 * the vertices need. It is what `packBatch` allocates in the worker, allocated
 * here instead.
 */
function storageFor(parts: readonly PartArrays[]): PackedGeometry {
  const first = parts[0];
  if (first === undefined) return { attributes: [] };
  let vertices = 0;
  let indices = 0;
  for (const part of parts) {
    const count = vertexCount(part);
    vertices += count;
    indices += part.index?.length ?? count;
  }
  const storage: PackedGeometry = {
    attributes: first.attributes.map((attribute) => ({
      name: attribute.name,
      array: new (attribute.array.constructor as new (length: number) => AttributeArray)(vertices * attribute.itemSize),
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
    })),
  };
  if (parts.some((part) => part.index !== undefined)) {
    storage.index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  }
  return storage;
}

/**
 * The merged geometry over that storage, and a step per part. The storage
 * decides the batch's attributes; a part that lacks one of them leaves zeros
 * there. A part without an index of its own is given its vertices in order.
 */
function fill(
  parts: readonly PartArrays[],
  storage: PackedGeometry,
  material: Material,
  release: (i: number) => void,
): BatchFill {
  const geometry = new BufferGeometry();
  for (const attribute of storage.attributes) {
    geometry.setAttribute(attribute.name, new BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized));
  }
  if (storage.index !== undefined) geometry.setIndex(new BufferAttribute(storage.index, 1));
  geometry.setDrawRange(0, 0);
  const bounds = new Box3();
  const sphere = new Sphere();
  geometry.boundingBox = bounds;
  geometry.boundingSphere = sphere;

  const mesh = new Batch(geometry, material);
  // A batch with nothing in it is not drawn: it would be a draw of nothing in
  // every pass until its first part lands, and the renderer would compile a
  // shader for a geometry with no attributes at all.
  mesh.visible = false;

  let vertexAt = 0;
  let indexAt = 0;
  const steps = parts.map((part, i) => () => {
    const count = vertexCount(part);
    const turn = part.matrix === undefined ? undefined : new Matrix3().getNormalMatrix(part.matrix);
    for (const { name } of storage.attributes) {
      const into = geometry.getAttribute(name) as BufferAttribute;
      const out = into.array as AttributeArray;
      const size = into.itemSize;
      const start = vertexAt * size;
      const from = part.attributes.find((attribute) => attribute.name === name);
      if (from !== undefined) {
        if (part.matrix !== undefined && size === 3 && PLACES.has(name)) place(from.array, out, start, count, part.matrix);
        else if (turn !== undefined && size === 3 && DIRECTIONS.has(name)) direct(from.array, out, start, count, turn);
        else out.set(from.array.subarray(0, count * size), start);
      }
      into.addUpdateRange(start, count * size);
      into.needsUpdate = true;
    }
    const position = geometry.getAttribute('position') as BufferAttribute | undefined;
    if (position !== undefined) expand(bounds, position.array as AttributeArray, vertexAt, count);

    const index = geometry.getIndex();
    const drawn = part.index?.length ?? count;
    if (index !== null) {
      const out = index.array as Uint32Array | Uint16Array;
      const from = part.index;
      for (let k = 0; k < drawn; k++) out[indexAt + k] = vertexAt + (from === undefined ? k : (from[k] as number));
      index.addUpdateRange(indexAt, drawn);
      index.needsUpdate = true;
    }
    vertexAt += count;
    indexAt += drawn;
    geometry.setDrawRange(0, indexAt);
    bounds.getBoundingSphere(sphere);
    mesh.parts++;
    mesh.visible = true;
    release(i);
  });
  return { mesh, steps };
}

/** A geometry's arrays, as a worker would have packed them. */
function arraysOf(geometry: BufferGeometry, matrix: Matrix4 | undefined): PartArrays {
  const attributes: PackedAttribute[] = [];
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(name) as BufferAttribute;
    attributes.push({
      name,
      array: attribute.array as AttributeArray,
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
    });
  }
  return { attributes, index: geometry.getIndex()?.array, matrix };
}

/** Vertices a part holds, read off its positions. */
function vertexCount(part: PartArrays): number {
  return packedVertexCount({ attributes: part.attributes as PackedAttribute[] });
}

/** Copy `count` places into `out`, moved by an affine frame. */
function place(from: AttributeArray, out: AttributeArray, start: number, count: number, matrix: Matrix4): void {
  const e = matrix.elements;
  for (let v = 0; v < count; v++) {
    const x = from[v * 3] as number;
    const y = from[v * 3 + 1] as number;
    const z = from[v * 3 + 2] as number;
    const at = start + v * 3;
    out[at] = (e[0] as number) * x + (e[4] as number) * y + (e[8] as number) * z + (e[12] as number);
    out[at + 1] = (e[1] as number) * x + (e[5] as number) * y + (e[9] as number) * z + (e[13] as number);
    out[at + 2] = (e[2] as number) * x + (e[6] as number) * y + (e[10] as number) * z + (e[14] as number);
  }
}

/** Copy `count` directions into `out`, turned by a normal matrix and kept unit length. */
function direct(from: AttributeArray, out: AttributeArray, start: number, count: number, turn: Matrix3): void {
  const e = turn.elements;
  for (let v = 0; v < count; v++) {
    const x = from[v * 3] as number;
    const y = from[v * 3 + 1] as number;
    const z = from[v * 3 + 2] as number;
    const nx = (e[0] as number) * x + (e[3] as number) * y + (e[6] as number) * z;
    const ny = (e[1] as number) * x + (e[4] as number) * y + (e[7] as number) * z;
    const nz = (e[2] as number) * x + (e[5] as number) * y + (e[8] as number) * z;
    const length = Math.hypot(nx, ny, nz) || 1;
    const at = start + v * 3;
    out[at] = nx / length;
    out[at + 1] = ny / length;
    out[at + 2] = nz / length;
  }
}

/** Grow a box over `count` positions starting at vertex `first`. */
function expand(box: Box3, positions: AttributeArray, first: number, count: number): void {
  const min = box.min;
  const max = box.max;
  for (let v = first; v < first + count; v++) {
    const x = positions[v * 3] as number;
    const y = positions[v * 3 + 1] as number;
    const z = positions[v * 3 + 2] as number;
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
}
