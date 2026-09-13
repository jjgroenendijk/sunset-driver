/**
 * A chunk's geometry as plain arrays, so a worker can build it (spec section
 * 9.1).
 *
 * Everything a chunk draws — the ground, the roads over it, the buildings that
 * stand on it and the plants that grow on what is left — is built here from the
 * chunk and the whole-map lookups. Nothing in this file touches the renderer,
 * a material or the DOM, so it runs in a worker and in a test alike.
 *
 * The result is a payload: typed arrays and numbers, and no three.js object at
 * all. A payload crosses a worker boundary by transfer rather than by copy, so
 * the main thread pays for uploading the geometry and for nothing else. Even
 * the buffers each batch copies its parts into are allocated here.
 * {@link unpackGeometry} is the other half, and it is the only work the frame
 * is charged for.
 *
 * A payload is built at one of three details (spec sections 9.1, 9.2). Near is
 * the city as the game draws it. Mid is the same, with every building built as
 * a block rather than a generated facade. Far is the ground, the highways and
 * arterials over it and the outlined massing of its buildings: no markings, no
 * minor roads, no plants and no street lamps, because none of them can be told
 * apart from the far ring.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { ChunkBounds, WorldChunk, WorldLayers } from '../world/chunks.ts';
import { RoadRibbons } from '../world/ribbon.ts';
import { CHUNK_TERRAIN_CELL, TERRAIN_CELL } from '../world/terrain.ts';
import type { RoadTier, WorldDescription } from '../world/types.ts';
import { buildChunkBuildings, buildingLookup, type BuildingLookup } from './building-mesh.ts';
import { buildGroundAttributes, groundLookup, type GroundAttributes, type GroundLookup } from './ground.ts';
import { lampsIn, type Lamp } from './lamp-mesh.ts';
import { buildChunkVegetation, plantLookup, type PlantLookup } from './plant-mesh.ts';
import { buildChunkRoads, partsOf } from './road-mesh.ts';
import type { ChunkDetail } from './streaming.ts';

/** The tiers the far ring keeps. The minor fill is not read from that far off. */
const FAR_TIERS: readonly RoadTier[] = ['highway', 'arterial'];

/**
 * Samples of the chunk grid the far ring's ground reads every one of: enough
 * to land it back on the skeleton's grid, where a chunk costs a sixteenth of
 * the near ring's ground.
 */
const FAR_GROUND_STEP = TERRAIN_CELL / CHUNK_TERRAIN_CELL;

/** A typed array a packed geometry holds its numbers in. */
type GeometryArray = Float32Array | Uint32Array | Uint16Array | Uint8Array;

/** One attribute of a packed geometry. */
export interface PackedAttribute {
  name: string;
  array: GeometryArray;
  itemSize: number;
  normalized: boolean;
}

/** A `BufferGeometry` as arrays. {@link unpackGeometry} makes it one again. */
export interface PackedGeometry {
  attributes: PackedAttribute[];
  index?: Uint32Array | Uint16Array;
}

/** One thing to draw: a geometry, and where it stands if not already in world places. */
export interface PackedPart {
  geometry: PackedGeometry;
  /** Its frame in the world, sixteen numbers. */
  matrix?: Float32Array;
}

/**
 * The parts of one batch, and the storage they are copied into.
 *
 * The storage is the batch's own buffers, sized to hold every part and still
 * empty. The worker allocates it, because a batch that allocates its buffers
 * itself does it on the frame thread in the step that copies its first part,
 * and a chunk of the core allocates tens of megabytes there. That was the
 * dearest step of an upload, and the one a collection landed in.
 */
export interface PackedBatch {
  parts: PackedPart[];
  /** Every attribute of the parts, at the length of all of them together. Empty when there are no parts. */
  storage: PackedGeometry;
}

/** One tier of road inside a chunk: everything batched, and everything painted. */
export interface PackedRoads {
  tier: RoadTier;
  /** Surfaces, decks and portals, all of which go into one batch. */
  surface: PackedBatch;
  /** Marking segment ends, six numbers each. Empty at far detail. */
  markings: Float32Array;
  /** The colour of each of those ends, six numbers each. */
  markingTints: Float32Array;
}

/** The plants of a chunk. A placement names one of the world's models rather than carrying geometry. */
export interface PackedPlants {
  /** Which model each plant takes, as `modelIndex` numbers them. */
  models: Uint16Array;
  /** The frame of each plant in the world, sixteen numbers each. */
  matrices: Float32Array;
}

/** Everything one chunk draws, ready to cross a worker boundary. */
export interface ChunkPayload {
  cx: number;
  cy: number;
  detail: ChunkDetail;
  /** The ground the chunk covers, so the mesh can be stood at its near corner. */
  bounds: ChunkBounds;
  ground: GroundAttributes;
  /** The road tiers that run through the chunk, in tier order. */
  roads: PackedRoads[];
  /** The inverted hulls that outline the buildings. */
  outlines: PackedBatch;
  /** The generated facades. Empty unless the detail is near; elsewhere a tower is a block. */
  facades: PackedBatch;
  /** The buildings built as blocks, which past near detail is all of them. */
  blocks: PackedBatch;
  plants: PackedPlants;
  /**
   * The street lamps of the chunk (spec section 10.5), already in the places
   * the scene works in. A lamp is a handful of numbers, so it crosses as it
   * stands rather than packed. Empty at far detail: a mast is three metres
   * tall and the far ring cannot read one.
   */
  lamps: Lamp[];
  /** Draw calls the chunk costs once it is in the scene. */
  drawCalls: number;
}

/** What a chunk's geometry asks about the world around it. */
export interface ChunkLookups {
  ground: GroundLookup;
  buildings: BuildingLookup;
  plants: PlantLookup;
  ribbons: RoadRibbons;
}

/** The lookups a world answers with, built once and shared by every chunk of it. */
export function chunkLookups(world: WorldDescription, layers: WorldLayers): ChunkLookups {
  return {
    ground: groundLookup(world, layers),
    buildings: buildingLookup(world, layers),
    plants: plantLookup(layers),
    ribbons: new RoadRibbons(world.terrain, world.roads, layers.junctions),
  };
}

/** Build everything one chunk draws, at the detail asked for. */
export function buildChunkPayload(chunk: WorldChunk, lookups: ChunkLookups, detail: ChunkDetail): ChunkPayload {
  const far = detail === 'far';
  const roads: PackedRoads[] = [];
  // At far detail the minor fill is dropped before it is lofted, so the tiers
  // that are not drawn cost nothing to leave out.
  // The far ring keeps no junctions either: a junction is drawn where the
  // roads that meet there are cut back, and neither can be read from that far.
  const traced = far
    ? { ...chunk, roads: chunk.roads.filter((run) => FAR_TIERS.includes(run.tier)).map((run) => ({ ...run, gaps: [] })), junctions: [] }
    : chunk;
  for (const tier of buildChunkRoads(traced, lookups.ribbons, lookups.ground.heightAt)) {
    roads.push({
      tier: tier.tier,
      surface: packBatch(partsOf(tier).map((geometry) => ({ geometry: takeGeometry(geometry) }))),
      markings: far ? new Float32Array(0) : tier.markings,
      markingTints: far ? new Float32Array(0) : tier.markingTints,
    });
  }

  const outlines: PackedPart[] = [];
  const facades: PackedPart[] = [];
  const blocks: PackedPart[] = [];
  for (const placed of buildChunkBuildings(chunk, lookups.buildings, detail)) {
    const matrix = new Float32Array(placed.matrix.toArray());
    (placed.batch === 'facade' ? facades : blocks).push({ geometry: takeGeometry(placed.shell), matrix });
    outlines.push({ geometry: takeGeometry(placed.hull), matrix });
  }

  const plants = far ? noPlants() : packPlants(chunk, lookups.plants);

  const payload: ChunkPayload = {
    cx: chunk.cx,
    cy: chunk.cy,
    detail,
    bounds: chunk.bounds,
    ground: buildGroundAttributes(chunk, lookups.ground, far ? FAR_GROUND_STEP : 1),
    roads,
    outlines: packBatch(outlines),
    facades: packBatch(facades),
    blocks: packBatch(blocks),
    plants,
    lamps: far ? [] : lampsIn(chunk, lookups.ribbons),
    drawCalls: 0,
  };
  payload.drawCalls = payloadDrawCalls(payload);
  return payload;
}

/** Draw calls a payload costs: one per batch it fills, and one for its ground. */
export function payloadDrawCalls(payload: ChunkPayload): number {
  let calls = 1;
  for (const tier of payload.roads) {
    if (tier.surface.parts.length > 0) calls++;
    if (tier.markings.length > 0) calls++;
  }
  if (payload.outlines.parts.length > 0) calls++;
  if (payload.facades.parts.length > 0) calls++;
  if (payload.blocks.parts.length > 0) calls++;
  if (payload.plants.models.length > 0) calls++;
  if (payload.lamps.length > 0) calls++;
  return calls;
}

/**
 * Every buffer a payload holds, so `postMessage` can hand them over rather than
 * copy them. Each buffer is listed once, however many attributes read from it.
 */
export function payloadTransfers(payload: ChunkPayload): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  // An empty array is not handed over: it holds nothing to move, and a payload
  // that shared one with another payload would detach a buffer twice.
  const take = (array: ArrayBufferView): void => {
    if (array.byteLength > 0) buffers.add(array.buffer as ArrayBuffer);
  };
  const takeGeometryBuffers = (geometry: PackedGeometry): void => {
    for (const attribute of geometry.attributes) take(attribute.array);
    if (geometry.index !== undefined) take(geometry.index);
  };
  const ground = payload.ground;
  for (const array of [ground.positions, ground.normals, ground.tints, ground.covers, ground.coverTints, ground.indices]) {
    take(array);
  }
  const takeBatch = (batch: PackedBatch): void => {
    takeGeometryBuffers(batch.storage);
    for (const part of batch.parts) {
      takeGeometryBuffers(part.geometry);
      if (part.matrix !== undefined) take(part.matrix);
    }
  };
  for (const tier of payload.roads) {
    takeBatch(tier.surface);
    take(tier.markings);
    take(tier.markingTints);
  }
  takeBatch(payload.outlines);
  takeBatch(payload.facades);
  takeBatch(payload.blocks);
  take(payload.plants.models);
  take(payload.plants.matrices);
  return [...buffers];
}

/** Turn a packed geometry back into one the renderer can draw. */
export function unpackGeometry(packed: PackedGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const attribute of packed.attributes) {
    geometry.setAttribute(attribute.name, new BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized));
  }
  if (packed.index !== undefined) geometry.setIndex(new BufferAttribute(packed.index, 1));
  return geometry;
}

/**
 * Pack a geometry and let go of it. The arrays are handed over rather than
 * copied, so the geometry must not be drawn or read again; every caller here
 * built it a line earlier and wants only the numbers.
 */
function takeGeometry(geometry: BufferGeometry): PackedGeometry {
  const attributes: PackedAttribute[] = [];
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(name) as BufferAttribute;
    attributes.push({
      name,
      array: attribute.array as GeometryArray,
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
    });
  }
  const index = geometry.getIndex();
  const packed: PackedGeometry = { attributes };
  if (index !== null) packed.index = index.array as Uint32Array | Uint16Array;
  geometry.dispose();
  return packed;
}

/**
 * A batch of parts with its storage allocated. The storage takes the array
 * types of the first part, as `BatchedMesh` does when it allocates its own,
 * so every copy into it is one `set` rather than a loop over components.
 */
function packBatch(parts: PackedPart[]): PackedBatch {
  const first = parts[0]?.geometry;
  if (first === undefined) return { parts, storage: { attributes: [] } };
  let vertices = 0;
  let indices = 0;
  for (const part of parts) {
    vertices += packedVertexCount(part.geometry);
    indices += part.geometry.index?.length ?? 0;
  }
  const storage: PackedGeometry = {
    attributes: first.attributes.map((attribute) => ({
      name: attribute.name,
      array: new (attribute.array.constructor as new (length: number) => GeometryArray)(vertices * attribute.itemSize),
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
    })),
  };
  // The width `BatchedMesh` picks for an index it allocates itself.
  if (first.index !== undefined) storage.index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  return { parts, storage };
}

/** Vertices a packed geometry holds, read off its positions. */
export function packedVertexCount(geometry: PackedGeometry): number {
  const position = geometry.attributes.find((attribute) => attribute.name === 'position');
  return position === undefined ? 0 : position.array.length / position.itemSize;
}

/** The plants of a chunk, as the model each takes and the frame it stands in. */
function packPlants(chunk: WorldChunk, lookup: PlantLookup): PackedPlants {
  const placements = buildChunkVegetation(chunk, lookup);
  const models = new Uint16Array(placements.length);
  const matrices = new Float32Array(placements.length * 16);
  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i] as (typeof placements)[number];
    models[i] = placement.model;
    matrices.set(placement.matrix.toArray(), i * 16);
  }
  return { models, matrices };
}

function noPlants(): PackedPlants {
  return { models: new Uint16Array(0), matrices: new Float32Array(0) };
}
