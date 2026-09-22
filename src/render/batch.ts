/**
 * Packing a chunk's geometry into as few draw calls as it can be (spec sections
 * 9.1, 9.2).
 *
 * Everything of one kind in a cell of a chunk — every run of road, every
 * tower, every outline, every tree — is merged into one geometry and drawn as
 * one mesh. Each part is copied in already standing where it stands in the
 * world. The cells are `cells.ts`: a batch that spanned its whole chunk was
 * drawn whole wherever any corner of the chunk was seen.
 *
 * It is not a `BatchedMesh`. In three.js 0.186 on WebGPU a `BatchedMesh` is
 * drawn as one draw call per instance, after its instances are culled and
 * sorted on the processor, in every pass: the view, each shadow cascade and the
 * water's mirror. Its shader is also keyed on the batch itself, so a batch that
 * comes into view in a pass for the first time builds its shaders again, and
 * that is a stall of tens of milliseconds while driving. A plain mesh shares its
 * shader with every chunk drawn in the same material, and costs one draw.
 *
 * A batch is filled a step at a time. Copying a whole chunk of the core into
 * its batches costs more than the streaming slice of spec section 2.4, so the
 * scene runs the steps against its frame budget and stops when the budget is
 * spent. A batch half filled is drawn as far as it is filled, and not at all
 * until its first part is in. A step is indivisible and is the only thing that
 * overruns the slice, so a step copies at most {@link MAX_STEP_VERTICES}: a
 * part larger than that is copied over several steps, and a part is drawn only
 * once its last step is in.
 *
 * A batch a worker packed is merged into the storage that worker allocated
 * (`PackedBatch.storage`), so a step on the frame thread is a copy and nothing
 * else. A batch that allocated its own would do it inside its first part: tens
 * of megabytes in one frame, and the piece a collection lands in.
 */
import { Box3, BufferAttribute, BufferGeometry, Matrix3, Matrix4, Mesh, Sphere, type Material } from 'three';
import { byCell, cellOfPart, type CellGrid } from './cells.ts';
import { packedVertexCount, type PackedAttribute, type PackedBatch, type PackedGeometry } from './chunk-payload.ts';
import type { TilePart } from './streaming.ts';

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
  /** The renderer's record of uploads, where the steps upload the batch themselves. */
  uploads: UploadRecords | undefined;

  /**
   * Release the geometry. The material belongs to the world and is left alone.
   * The renderer frees the buffers of a geometry it drew when the geometry is
   * disposed, but not those the steps uploaded, so a batch never drawn frees
   * its own.
   */
  override dispose(): void {
    this.geometry.dispose();
    const records = this.uploads;
    if (records === undefined) return;
    for (const attribute of attributesOf(this.geometry)) records.delete(attribute);
  }

  /**
   * Let go of the arrays the renderer has uploaded, and answer whether any are
   * left.
   *
   * The GPU holds an attribute from its upload on, and nothing reads the array
   * again: the bounds are kept apart, and nothing casts a ray at a batch. Kept,
   * the arrays were the city a second time in the page's memory, and iOS
   * Safari kills a page that holds too much (`docs/streaming.md`).
   *
   * Each array is swapped for an empty one of its own type: the renderer still
   * reads the type when it builds a pipeline for another pass, and an
   * attribute keeps the count it was made with.
   */
  letGo(renderer: unknown): boolean {
    let left = false;
    for (const attribute of attributesOf(this.geometry)) {
      if (attribute.array.length === 0) continue;
      if (!uploaded(renderer, attribute)) {
        left = true;
        continue;
      }
      const array = attribute.array;
      attribute.array = new (array.constructor as new (length: number) => BufferAttribute['array'])(0);
    }
    return left;
  }
}

/** The renderer's record of the attributes it has uploaded (three.js 0.186). */
interface UploadRecords {
  has(attribute: BufferAttribute): boolean;
  get(attribute: BufferAttribute): { version?: number };
  /** Upload an attribute, or the ranges of it written since the last upload. */
  update(attribute: BufferAttribute, type: number): void;
  /** Free the buffer an attribute was uploaded to. */
  delete(attribute: BufferAttribute): unknown;
}

/** three.js's `AttributeType`, which `three/webgpu` does not export. */
const VERTEX = 1;
const INDEX = 2;

/** The upload record of a renderer, or undefined if three.js has moved it. */
function recordsOf(renderer: unknown): UploadRecords | undefined {
  return (renderer as { _attributes?: UploadRecords | null } | undefined)?._attributes ?? undefined;
}

/**
 * True when the GPU holds this version of an attribute. three.js keeps the
 * record privately; a renderer without it is never answered yes, so an update
 * of three.js that moves it keeps the arrays rather than breaking the draw.
 */
function uploaded(renderer: unknown, attribute: BufferAttribute): boolean {
  const records = recordsOf(renderer);
  if (records === undefined || !records.has(attribute)) return false;
  return records.get(attribute).version === attribute.version;
}

/** Every attribute of a geometry and its index. */
function attributesOf(geometry: BufferGeometry): BufferAttribute[] {
  const all: BufferAttribute[] = [];
  for (const attribute of [...Object.values(geometry.attributes), geometry.getIndex()]) {
    if (attribute instanceof BufferAttribute) all.push(attribute);
  }
  return all;
}

/** The renderer the batches made from now on upload into as they fill. */
let uploader: unknown;

/**
 * Upload each batch made from now on as its steps fill it, into this renderer,
 * and let go of its arrays after its last step (spec section 9.1).
 *
 * A batch that waits for its first draw to be uploaded keeps its arrays until
 * then, and a batch the camera has not looked at yet is most of the city: half
 * the batches of a settled scene had never been drawn. The first step of a
 * batch creates its buffers, and each step after it uploads only the ranges it
 * wrote, so the upload is spent a step at a time with the copy.
 */
export function uploadBatchesWith(renderer: unknown): void {
  uploader = renderer;
}

/**
 * Stop uploading into a renderer that is being disposed. Left in place, the
 * next batch uploads into the dead renderer's record, lets go of its arrays,
 * and the renderer that draws it next uploads buffers of no bytes: every chunk
 * built between the two renderers draws nothing, with a WebGPU validation
 * error for each.
 */
export function stopUploadingWith(renderer: unknown): void {
  if (uploader === renderer) uploader = undefined;
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

/**
 * Vertices one step copies at most.
 *
 * A step is what overruns the streaming slice of spec section 2.4, because the
 * queue cannot stop inside one. Left whole, a part is whatever the generator
 * built: a chunk of the core carries towers of 33 000 vertices, so the overrun
 * was a property of the city rather than a number this file chose, and it grew
 * with every tower the generator learned to build.
 *
 * A facade copies at about 180 ns a vertex on an Apple M1 laptop — seven
 * attributes, of which the places are moved by the part's frame and the normals
 * turned by it — so this is about 0.4 ms there and about 1.5 ms on the runners
 * that are four times slower. Cutting a part costs nothing: a chunk of the core
 * spends the same 60 ms on its facades whether they go in whole or in 2048s.
 * Those numbers are from before facades were packed (`facade-pack.ts`), when a
 * vertex was three times the bytes and a quad six vertices rather than four.
 */
export const MAX_STEP_VERTICES = 2048;

/** A typed array an attribute holds its numbers in. */
type AttributeArray = PackedAttribute['array'];

/** What a part holds, read the same way whether it was built here or in a worker. */
interface PartArrays {
  attributes: readonly PackedAttribute[];
  index: ArrayLike<number> | undefined;
  matrix: Matrix4 | undefined;
}

/**
 * Prepare a batch per cell of parts, and the steps that copy them in. Run the
 * fills in the order they come, because a geometry is disposed once the last
 * part standing on it is copied, whichever cell that part is in. A caller hands
 * over its geometry rather than keeping it.
 *
 * These parts are built on the frame thread — the plants and the street lamps,
 * which are copies of a handful of small models — so the storage is allocated
 * here as well.
 */
export function fillsOf(grid: CellGrid, parts: readonly BatchPart[], material: Material): BatchFill[] {
  const cells = byCell(grid, parts, (part) => {
    const position = part.geometry.getAttribute('position') as BufferAttribute | undefined;
    return cellOfPart(grid, position?.array ?? [], part.matrix?.elements);
  });
  const last = new Map<BufferGeometry, BatchPart>();
  for (const cell of cells) for (const part of cell) last.set(part.geometry, part);
  return cells.map((cell) => {
    const arrays = cell.map((part) => arraysOf(part.geometry, part.matrix));
    return fill(arrays, storageFor(arrays), material, (i) => {
      const part = cell[i] as BatchPart;
      if (last.get(part.geometry) === part) part.geometry.dispose();
    });
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

/** Pack parts a worker built into a single batch, all at once. */
export function batchOfPacked(batch: PackedBatch, material: Material): Batch {
  return filled(fillOfPacked(batch, material));
}

function filled(fill: BatchFill): Batch {
  for (const step of fill.steps) step();
  return fill.mesh;
}

/**
 * The fills of one kind of a chunk as one piece of the chunk: a mesh and a
 * draw per cell, and the steps of every cell in the order the fills came.
 *
 * `castsShadow` and `mirrored` are the piece's answers to the two passes
 * besides the view, which `WorldScene` reads when it puts the piece into the
 * scene. A kind that stands over the kind beside it casts no shadow rather than
 * shading it; a kind that lies flat along the ground is left out of the water's
 * mirror (`mirror.ts`).
 */
export function tilePartOf(
  fills: readonly BatchFill[],
  passes: { castsShadow?: boolean; mirrored?: boolean } = {},
): TilePart {
  const meshes = fills.map((fill) => fill.mesh);
  return {
    objects: meshes,
    drawCalls: meshes.length,
    steps: fills.flatMap((fill) => fill.steps),
    castsShadow: passes.castsShadow ?? true,
    mirrored: passes.mirrored ?? false,
    dispose(): void {
      for (const mesh of meshes) mesh.dispose();
    },
  };
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
    geometry.setAttribute(attribute.name, new BufferAttribute(attribute.array as BufferAttribute['array'], attribute.itemSize, attribute.normalized));
  }
  if (storage.index !== undefined) geometry.setIndex(new BufferAttribute(storage.index, 1));
  geometry.setDrawRange(0, 0);
  const bounds = new Box3();
  const sphere = new Sphere();
  geometry.boundingBox = bounds;
  geometry.boundingSphere = sphere;

  const mesh = new Batch(geometry, material);
  const renderer = uploader;
  const records = recordsOf(renderer);
  mesh.uploads = records;
  // A batch with nothing in it is not drawn: it would be a draw of nothing in
  // every pass until its first part lands, and the renderer would compile a
  // shader for a geometry with no attributes at all.
  mesh.visible = false;

  const steps: (() => void)[] = [];
  // Read out here, so no step keeps the parts themselves once it has run.
  const total = parts.length;
  let vertexAt = 0;
  let indexAt = 0;
  parts.forEach((part, i) => {
    const count = vertexCount(part);
    const drawn = part.index?.length ?? count;
    const base = vertexAt;
    const indexBase = indexAt;
    const turn = part.matrix === undefined ? undefined : new Matrix3().getNormalMatrix(part.matrix);
    // A part larger than a step is copied over several of them, so what a
    // frame overruns its slice by is this many vertices and not the biggest
    // tower in the city.
    const cuts = Math.max(1, Math.ceil(count / MAX_STEP_VERTICES));
    for (let cut = 0; cut < cuts; cut++) {
      const from = Math.round((count * cut) / cuts);
      const to = Math.round((count * (cut + 1)) / cuts);
      // Only the last cut of a part draws it. The index is what the renderer
      // reads vertices through, so writing it before every vertex of the part
      // is in would draw the ones still to come.
      const last = cut === cuts - 1;
      steps.push(() => {
        for (const { name } of storage.attributes) {
          const into = geometry.getAttribute(name) as BufferAttribute;
          const out = into.array as AttributeArray;
          const size = into.itemSize;
          const start = (base + from) * size;
          const source = part.attributes.find((attribute) => attribute.name === name);
          if (source !== undefined) {
            if (part.matrix !== undefined && size === 3 && PLACES.has(name)) place(source.array, out, start, from, to, part.matrix);
            else if (turn !== undefined && size >= 3 && DIRECTIONS.has(name)) direct(source.array, out, start, from, to, turn, size);
            else out.set(source.array.subarray(from * size, to * size), start);
          }
          into.addUpdateRange(start, (to - from) * size);
          into.needsUpdate = true;
          records?.update(into, VERTEX);
        }
        const position = geometry.getAttribute('position') as BufferAttribute | undefined;
        if (position !== undefined) expand(bounds, position.array as AttributeArray, base + from, to - from);
        if (!last) return;

        const index = geometry.getIndex();
        if (index !== null) {
          const out = index.array as Uint32Array | Uint16Array;
          const own = part.index;
          for (let k = 0; k < drawn; k++) out[indexBase + k] = base + (own === undefined ? k : (own[k] as number));
          index.addUpdateRange(indexBase, drawn);
          index.needsUpdate = true;
          records?.update(index, INDEX);
        }
        geometry.setDrawRange(0, indexBase + drawn);
        bounds.getBoundingSphere(sphere);
        mesh.parts++;
        mesh.visible = true;
        release(i);
        if (mesh.parts < total) return;
        // A batch the steps uploaded is on the GPU now. One that was not is
        // uploaded by the next draw that takes it, in whichever pass that is,
        // and the arrays can go after it.
        if (records === undefined || mesh.letGo(renderer)) mesh.onAfterRender = letGoAfterDraw;
      });
    }
    vertexAt += count;
    indexAt += drawn;
  });
  return { mesh, steps };
}

/** A batch's `onAfterRender` once it is full, which stops being called when every array is gone. */
function letGoAfterDraw(this: Batch, renderer: unknown): void {
  if (!this.letGo(renderer)) this.onAfterRender = () => {};
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

/** Copy the places `first` up to `last` into `out`, moved by an affine frame. */
function place(from: AttributeArray, out: AttributeArray, start: number, first: number, last: number, matrix: Matrix4): void {
  const e = matrix.elements;
  for (let v = first, at = start; v < last; v++, at += 3) {
    const x = from[v * 3] as number;
    const y = from[v * 3 + 1] as number;
    const z = from[v * 3 + 2] as number;
    out[at] = (e[0] as number) * x + (e[4] as number) * y + (e[8] as number) * z + (e[12] as number);
    out[at + 1] = (e[1] as number) * x + (e[5] as number) * y + (e[9] as number) * z + (e[13] as number);
    out[at + 2] = (e[2] as number) * x + (e[6] as number) * y + (e[10] as number) * z + (e[14] as number);
  }
}

/**
 * Copy the directions `first` up to `last` into `out`, turned by a normal
 * matrix and kept unit length. A direction may be packed four to a vertex in
 * signed bytes (`facade-pack.ts`): it is turned the same way, since its length
 * is thrown away, and written back at the bytes' scale with its padding kept.
 */
function direct(
  from: AttributeArray,
  out: AttributeArray,
  start: number,
  first: number,
  last: number,
  turn: Matrix3,
  size: number,
): void {
  const e = turn.elements;
  const scale = out instanceof Int8Array ? 127 : 1;
  for (let v = first, at = start; v < last; v++, at += size) {
    const x = from[v * size] as number;
    const y = from[v * size + 1] as number;
    const z = from[v * size + 2] as number;
    const nx = (e[0] as number) * x + (e[3] as number) * y + (e[6] as number) * z;
    const ny = (e[1] as number) * x + (e[4] as number) * y + (e[7] as number) * z;
    const nz = (e[2] as number) * x + (e[5] as number) * y + (e[8] as number) * z;
    const length = (Math.hypot(nx, ny, nz) || 1) / scale;
    out[at] = scale === 1 ? nx / length : Math.round(nx / length);
    out[at + 1] = scale === 1 ? ny / length : Math.round(ny / length);
    out[at + 2] = scale === 1 ? nz / length : Math.round(nz / length);
    for (let k = 3; k < size; k++) out[at + k] = from[v * size + k] as number;
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
