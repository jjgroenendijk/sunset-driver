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
 *
 * Each batch is cut into the cells of `cells.ts`, so the renderer culls a
 * quarter of a chunk rather than the whole of it. A payload holds one batch per
 * cell that has anything of that kind in it.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { ChunkBounds, WorldChunk, WorldLayers } from '../world/chunks.ts';
import type { RoadRibbons } from '../world/ribbon.ts';
import { buildShops, type Shop } from '../world/shops.ts';
import { CHUNK_TERRAIN_CELL, TERRAIN_CELL } from '../world/terrain.ts';
import type { RoadTier, WorldDescription } from '../world/types.ts';
import { buildChunkBuildings, buildingLookup, type BuildingLookup } from './building-mesh.ts';
import { byCell, cellGrid, cellOfPart, cellsHolding, type CellGrid } from './cells.ts';
import { packFacade } from './facade-pack.ts';
import { buildGroundAttributes, groundLookup, type GroundAttributes, type GroundLookup } from './ground.ts';
import { lampsIn, type Lamp } from './lamp-mesh.ts';
import { postersIn, type Poster } from './poster-mesh.ts';
import { ROOF_STRIDE, writeRoof } from './roofs.ts';
import { buildChunkVegetation, plantLookup, type PlantLookup } from './plant-mesh.ts';
import type { SurfaceAt } from './pavement-mesh.ts';
import { buildChunkRoads, partsOf, raisedPartsOf } from './road-mesh.ts';
import { shopTrades, signsIn, type Sign, type TradeLookup } from './sign-mesh.ts';
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
export type GeometryArray = Float32Array | Float16Array | Uint32Array | Uint16Array | Uint8Array | Int8Array;

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
  /** Whether it stands off the ground. Only the road parts say. */
  raised?: boolean;
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
  /** Whether any of the parts stands off the ground. Only the road batches say. */
  raised?: boolean;
}

/** One tier of road inside a chunk: everything batched, and everything painted. */
export interface PackedRoads {
  tier: RoadTier;
  /** Surfaces, decks and portals, all of which go into one batch per cell. */
  surface: PackedBatch[];
  /** The painted lines as flat triangles, three numbers per vertex. Empty at far detail. */
  markings: Float32Array;
  /** Which way each of those vertices faces, three numbers each. */
  markingNormals: Float32Array;
  /** The colour of each of those vertices, three numbers each. */
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
  /** The inverted hulls that outline the buildings, a batch per cell. */
  outlines: PackedBatch[];
  /** The generated facades, a batch per cell. Empty unless the detail is near; elsewhere a tower is a block. */
  facades: PackedBatch[];
  /** The buildings built as blocks, which past near detail is all of them, a batch per cell. */
  blocks: PackedBatch[];
  /** One box per building, as `roofs.ts` packs them, so the camera knows what it stands in. */
  roofs: Float32Array;
  plants: PackedPlants;
  /**
   * The street lamps of the chunk (spec section 10.5), already in the places
   * the scene works in. A lamp is a handful of numbers, so it crosses as it
   * stands rather than packed. Empty at far detail: a mast is three metres
   * tall and the far ring cannot read one.
   */
  lamps: Lamp[];
  /**
   * The harm-reduction posters fly-posted on the chunk's buildings (spec
   * section 19), in the places the scene works in. Empty unless the detail is
   * near: a sheet is a metre across and nothing past the near ring can read
   * one.
   */
  posters: Poster[];
  /**
   * The shop signage and the billboards of spec section 13.1, in the places the
   * scene works in. Empty unless the detail is near: a fascia is lettering a few
   * metres across and nothing past the near ring can read one.
   */
  signs: Sign[];
  /** Draw calls the chunk costs once it is in the scene. */
  drawCalls: number;
}

/** What a chunk's geometry asks about the world around it. */
export interface ChunkLookups {
  ground: GroundLookup;
  buildings: BuildingLookup;
  plants: PlantLookup;
  ribbons: RoadRibbons;
  /** The surface drawn at a place beside a road, which the pavement stands on. */
  surfaceAt: SurfaceAt;
  /** What a building sells, so its fascia names the trade really behind it. */
  tradeOf: TradeLookup;
}

/**
 * The lookups a world answers with, built once and shared by every chunk of it.
 * The shops are passed in where the caller has already dealt them — the chunk
 * worker has, on the reply it answers the main thread with — because dealing
 * them walks every building of the map.
 */
export function chunkLookups(
  world: WorldDescription,
  layers: WorldLayers,
  shops: readonly Shop[] = buildShops(world, layers.buildings),
): ChunkLookups {
  return {
    ground: groundLookup(world, layers),
    buildings: buildingLookup(world, layers),
    plants: plantLookup(layers),
    ribbons: layers.carve.ribbons,
    surfaceAt: (x, y, tier) => layers.carve.surfaceAt(x, y, tier),
    tradeOf: shopTrades(shops),
  };
}

/** Build everything one chunk draws, at the detail asked for. */
export function buildChunkPayload(chunk: WorldChunk, lookups: ChunkLookups, detail: ChunkDetail): ChunkPayload {
  const far = detail === 'far';
  const grid = cellGrid(chunk.bounds, detail);
  const roads: PackedRoads[] = [];
  // At far detail the minor fill is dropped before it is lofted, so the tiers
  // that are not drawn cost nothing to leave out.
  // The far ring keeps no junctions either: a junction is drawn where the
  // roads that meet there are cut back, and neither can be read from that far.
  const traced = far
    ? {
        ...chunk,
        roads: chunk.roads.filter((run) => FAR_TIERS.includes(run.tier)).map((run) => ({ ...run, gaps: [] })),
        junctions: [],
        pavement: chunk.pavement.filter((piece) => FAR_TIERS.includes(piece.tier)),
        // A pier holds a deck up from as far off as the deck is seen; the rails
        // of the tram are paint at that distance, and the far ring has no paint.
        piers: chunk.piers.filter((pier) => FAR_TIERS.includes(pier.tier)),
        tram: [],
        tramCrossings: [],
      }
    : chunk;
  for (const tier of buildChunkRoads(traced, lookups.ribbons, lookups.surfaceAt)) {
    const raised = new Set(raisedPartsOf(tier));
    roads.push({
      tier: tier.tier,
      surface: packCells(
        grid,
        partsOf(tier).map((geometry) => ({ geometry: takeGeometry(geometry), raised: raised.has(geometry) })),
      ),
      markings: far ? new Float32Array(0) : tier.markings,
      markingNormals: far ? new Float32Array(0) : tier.markingNormals,
      markingTints: far ? new Float32Array(0) : tier.markingTints,
    });
  }

  const outlines: PackedPart[] = [];
  const facades: PackedPart[] = [];
  const blocks: PackedPart[] = [];
  const placements = buildChunkBuildings(chunk, lookups.buildings, detail);
  // Asked before the shells are packed away, because a board is hung on the
  // wall that was really built rather than on the one the massing asked for.
  const near = detail === 'near';
  const posters = near ? postersIn(placements, lookups.buildings) : [];
  const signs = near ? signsIn(placements, lookups.buildings, lookups.tradeOf) : [];
  const roofs = new Float32Array(placements.length * ROOF_STRIDE);
  for (const [i, placed] of placements.entries()) {
    writeRoof(roofs, i * ROOF_STRIDE, placed.hull, placed.matrix);
    const matrix = new Float32Array(placed.matrix.toArray());
    if (placed.batch === 'facade') facades.push({ geometry: packFacade(takeGeometry(placed.shell)), matrix });
    else blocks.push({ geometry: takeGeometry(placed.shell), matrix });
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
    outlines: packCells(grid, outlines),
    facades: packCells(grid, facades),
    blocks: packCells(grid, blocks),
    roofs,
    plants,
    lamps: far ? [] : lampsIn(chunk, lookups.ribbons),
    posters,
    signs,
    drawCalls: 0,
  };
  payload.drawCalls = payloadDrawCalls(payload);
  return payload;
}

/**
 * Draw calls a payload costs with nothing thinned: one per cell of each batch,
 * one per tier of markings, and one for its ground. The plants, the lamps and
 * the posters and the signs are cut into cells on the frame thread, so their cells are
 * counted here off where each one stands.
 */
export function payloadDrawCalls(payload: ChunkPayload): number {
  const grid = cellGrid(payload.bounds, payload.detail);
  let calls = 1;
  for (const tier of payload.roads) {
    calls += tier.surface.length;
    if (tier.markings.length > 0) calls++;
  }
  calls += payload.outlines.length + payload.facades.length + payload.blocks.length;
  const matrices = payload.plants.matrices;
  const plantAt = (i: number): { x: number; y: number } => ({
    x: matrices[i * 16 + 12] as number,
    y: matrices[i * 16 + 14] as number,
  });
  calls += cellsHolding(grid, payload.plants.models.length, plantAt);
  calls += cellsHolding(grid, payload.lamps.length, (i) => payload.lamps[i] as Lamp);
  calls += cellsHolding(grid, payload.posters.length, (i) => payload.posters[i] as Poster);
  calls += cellsHolding(grid, payload.signs.length, (i) => payload.signs[i] as Sign);
  return calls;
}

/** Parts in a batch cut into cells, over every cell of it. */
export function partsIn(cells: readonly PackedBatch[]): number {
  return cells.reduce((sum, cell) => sum + cell.parts.length, 0);
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
    tier.surface.forEach(takeBatch);
    take(tier.markings);
    take(tier.markingNormals);
    take(tier.markingTints);
  }
  payload.outlines.forEach(takeBatch);
  payload.facades.forEach(takeBatch);
  payload.blocks.forEach(takeBatch);
  take(payload.roofs);
  take(payload.plants.models);
  take(payload.plants.matrices);
  return [...buffers];
}

/** Turn a packed geometry back into one the renderer can draw. */
export function unpackGeometry(packed: PackedGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const attribute of packed.attributes) {
    geometry.setAttribute(attribute.name, new BufferAttribute(attribute.array as BufferAttribute['array'], attribute.itemSize, attribute.normalized));
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

/** Parts sorted into the cells they stand in, and packed as a batch per cell. */
function packCells(grid: CellGrid, parts: PackedPart[]): PackedBatch[] {
  const positionsOf = (part: PackedPart): ArrayLike<number> =>
    part.geometry.attributes.find((attribute) => attribute.name === 'position')?.array ?? [];
  return byCell(grid, parts, (part) => cellOfPart(grid, positionsOf(part), part.matrix)).map(packBatch);
}

/**
 * A batch of parts with its storage allocated. The storage takes the array
 * types of the first part, as `BatchedMesh` does when it allocates its own,
 * so every copy into it is one `set` rather than a loop over components.
 */
function packBatch(parts: PackedPart[]): PackedBatch {
  const first = parts[0]?.geometry;
  const raised = parts.some((part) => part.raised === true);
  if (first === undefined) return { parts, storage: { attributes: [] }, raised };
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
  return { parts, storage, raised };
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
