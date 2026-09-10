/**
 * Chunked generation (spec sections 3 and 9.1).
 *
 * The world is streamed in chunks around the player, so nothing a chunk holds
 * may depend on which of its neighbours are loaded. Everything in one is cut
 * from the whole-map skeleton: the roads the tracer laid, the parcels cut from
 * the land they leave, and a slice of the heightfield. A chunk is therefore a
 * pure function of its seed and its coordinates, and the sweep confirms it.
 *
 * The lattice is fixed. Chunk `(cx, cy)` covers {@link CHUNK_SIZE} metres each
 * way from `(cx · CHUNK_SIZE, cy · CHUNK_SIZE)`, whatever size the map turns out
 * to be. The map is centred on the origin, so the chunks around `(0, 0)` carry
 * the core and the far ones the wilderness. A chunk past the edge of the map is
 * not an error: it comes back with no roads and no parcels, over the clamped
 * edge of the heightfield.
 *
 * What goes in which chunk:
 *
 * - A road is cut into runs. Each segment belongs to the chunk its midpoint
 *   stands in, so consecutive segments make a run, and the runs of one curve
 *   meet at the points they share. Every segment of the map is in exactly one
 *   chunk, so the runs of every chunk together are the network, drawn once.
 * - A parcel belongs to the chunk its centre stands in, whole. Cutting one at a
 *   boundary would give a single piece of ground two owners, which spec section
 *   1.1 forbids, so a parcel wider than a chunk reaches into its neighbours.
 * - The terrain slice is copied out of the whole-map heightfield with a cell of
 *   margin past each side. Sampling it anywhere inside the chunk gives the same
 *   height as sampling the whole map, to the bit.
 *
 * {@link ChunkSource} holds the whole-map work, which is what "without needing
 * neighbours" means in practice; cutting a chunk from it copies the slice and
 * walks the segments inside it. {@link generateChunk} keeps the source of the
 * seed it was last asked about, so a session that streams one world builds that
 * world once.
 */
import { buildFootprint } from './footprint.ts';
import { buildRoadGraph } from './graph.ts';
import { Heightfield } from './heightfield.ts';
import { buildParcels, type Parcel } from './parcels.ts';
import { buildTensorField } from './tensor.ts';
import { TERRAIN_CELL } from './terrain.ts';
import type { HeightfieldData, Point, RoadCurve, RoadTier, WorldDescription } from './types.ts';
import { generateWorld } from './world.ts';

/** Terrain cells along one side of a chunk. */
export const CHUNK_CELLS = 25;

/** Metres along one side of a chunk. */
export const CHUNK_SIZE = CHUNK_CELLS * TERRAIN_CELL;

/**
 * Cells of the whole-map heightfield a slice keeps past each side of its chunk.
 * One is enough to close the seam with the neighbouring slice and to take a
 * central-difference normal on the boundary.
 */
const TERRAIN_MARGIN = 1;

/**
 * Height samples along one side of a terrain slice. A chunk boundary need not
 * fall on a sample — the map's grid is centred on the origin and its side is an
 * odd number of cells on half the seeds — so a slice keeps the whole cell the
 * boundary falls inside, and the margin outside that.
 */
export const CHUNK_GRID = CHUNK_CELLS + 2 + 2 * TERRAIN_MARGIN;

/**
 * Half the span of the chunk keys. Chunk coordinates reach about 12 on the
 * largest map, so this leaves the keys exact integers many maps past that.
 */
const KEY_BIAS = 0x8000;
const KEY_SPAN = 0x10000;

/** One run of a road curve inside a chunk. */
export interface ChunkRoadRun {
  /** The curve in {@link WorldDescription.roads} this run is part of. */
  curve: number;
  tier: RoadTier;
  /** Index in the curve of the first point of the run. */
  start: number;
  /** Index in the curve of the last point; the run is `end - start` segments long. */
  end: number;
  /** The points of the run, copied from the curve. */
  points: Point[];
  /** Segments of the run carried on a deck, as indices into {@link ChunkRoadRun.points}. Ascending. */
  bridges: number[];
  /** Segments of the run bored through the ground, likewise. Ascending. */
  tunnels: number[];
}

/** One chunk of the world: what a streaming worker builds and the renderer reads. */
export interface ChunkDescription {
  seed: number;
  cx: number;
  cy: number;
  /** The chunk covers {@link CHUNK_SIZE} metres each way from this corner. */
  minX: number;
  minY: number;
  /**
   * Heights over the chunk and a cell past each side, cut from the whole-map
   * field. Sampling it inside the chunk gives what the whole map gives.
   */
  terrain: HeightfieldData;
  /** The runs of road inside the chunk, by curve and then by position along it. */
  roads: ChunkRoadRun[];
  /** The parcels whose centre stands in the chunk, by parcel id. */
  parcels: Parcel[];
}

/**
 * The whole-map skeleton, indexed by chunk. Building one is the price of the
 * first chunk of a seed; every chunk after it is cut from this.
 *
 * Cutting is a pure function of the source and the coordinates: nothing is
 * remembered between chunks, so a chunk asked for on its own is the chunk it
 * would have been after all of its neighbours.
 */
export class ChunkSource {
  readonly world: WorldDescription;
  /** Every parcel of the map, by id, whichever chunk each stands in. */
  readonly parcels: readonly Parcel[];
  private readonly field: Heightfield;
  /** Chunk key to the segments inside it, as `curve, segment` pairs in curve order. */
  private readonly segments = new Map<number, number[]>();
  /** Chunk key to the ids of the parcels whose centre stands in it, ascending. */
  private readonly owners = new Map<number, number[]>();

  /**
   * Index a world by chunk. The parcels are passed in because cutting them is
   * dear and a caller that already has them should not pay twice;
   * {@link buildChunkSource} cuts them for a caller that does not.
   */
  constructor(world: WorldDescription, parcels: readonly Parcel[]) {
    this.world = world;
    this.parcels = parcels;
    this.field = new Heightfield(world.terrain);
    for (const road of world.roads) {
      for (let i = 0; i + 1 < road.points.length; i++) {
        const a = road.points[i] as Point;
        const b = road.points[i + 1] as Point;
        const key = keyOf(chunkIndex((a.x + b.x) / 2), chunkIndex((a.y + b.y) / 2));
        push(this.segments, key, road.id);
        push(this.segments, key, i);
      }
    }
    for (const parcel of parcels) {
      push(this.owners, keyOf(chunkIndex(parcel.at.x), chunkIndex(parcel.at.y)), parcel.id);
    }
  }

  /** Cut one chunk out of the map. */
  chunk(cx: number, cy: number): ChunkDescription {
    const key = keyOf(cx, cy);
    const minX = cx * CHUNK_SIZE;
    const minY = cy * CHUNK_SIZE;
    return {
      seed: this.world.seed,
      cx,
      cy,
      minX,
      minY,
      terrain: this.slice(minX, minY),
      roads: this.runs(this.segments.get(key) ?? []),
      parcels: (this.owners.get(key) ?? []).map((id) => this.parcels[id] as Parcel),
    };
  }

  /**
   * The heights over a chunk. The first sample kept is the one below the corner
   * of the chunk, less the margin, so the slice covers the chunk whether or not
   * the boundary falls on a sample of the map's own grid. An index past the edge
   * of the map is clamped, exactly as the whole field clamps it.
   */
  private slice(minX: number, minY: number): HeightfieldData {
    const field = this.field;
    const cell = field.cellSize;
    const ix0 = Math.floor((minX - field.originX) / cell) - TERRAIN_MARGIN;
    const iy0 = Math.floor((minY - field.originY) / cell) - TERRAIN_MARGIN;
    const heights = new Float32Array(CHUNK_GRID * CHUNK_GRID);
    for (let iy = 0; iy < CHUNK_GRID; iy++) {
      for (let ix = 0; ix < CHUNK_GRID; ix++) {
        heights[iy * CHUNK_GRID + ix] = field.at(ix0 + ix, iy0 + iy);
      }
    }
    return {
      gridSize: CHUNK_GRID,
      cellSize: cell,
      originX: field.worldX(ix0),
      originY: field.worldY(iy0),
      heights,
    };
  }

  /**
   * The segments of a chunk gathered into runs. They arrive in curve order, and
   * within a curve in the order they are driven, so a run ends wherever the next
   * segment is not the one after it.
   */
  private runs(pairs: readonly number[]): ChunkRoadRun[] {
    const out: ChunkRoadRun[] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const curve = pairs[i] as number;
      const start = pairs[i + 1] as number;
      let end = start + 1;
      while (i + 2 < pairs.length && pairs[i + 2] === curve && pairs[i + 3] === end) {
        end++;
        i += 2;
      }
      const road = this.world.roads[curve] as RoadCurve;
      out.push({
        curve,
        tier: road.tier,
        start,
        end,
        points: road.points.slice(start, end + 1),
        bridges: markedWithin(road.bridges, start, end),
        tunnels: markedWithin(road.tunnels, start, end),
      });
    }
    return out;
  }
}

/**
 * Index a world by chunk, cutting its parcels first. A caller that already holds
 * the parcels builds a {@link ChunkSource} directly instead.
 */
export function buildChunkSource(world: WorldDescription): ChunkSource {
  const graph = buildRoadGraph(world.roads);
  const footprint = buildFootprint(world.roads, world.corridors, graph);
  const parcels = buildParcels(world, footprint, graph, buildTensorField(world)).parcels;
  return new ChunkSource(world, parcels);
}

/** The source of the seed last asked for, so streaming one world generates it once. */
let lastSource: ChunkSource | undefined;

/**
 * One chunk of a seed's world. The whole-map skeleton it is cut from is kept, so
 * asking for chunk after chunk of one seed costs one world; asking about a
 * different seed builds that seed's world and lets the last one go.
 */
export function generateChunk(seed: number, cx: number, cy: number): ChunkDescription {
  const source = lastSource !== undefined && lastSource.world.seed === seed ? lastSource : buildChunkSource(generateWorld(seed));
  lastSource = source;
  return source.chunk(cx, cy);
}

/** Which chunk a place on the map falls in. */
export function chunkOf(x: number, y: number): { cx: number; cy: number } {
  return { cx: chunkIndex(x), cy: chunkIndex(y) };
}

/** The ground a chunk covers: `[minX, maxX)` by `[minY, maxY)`. */
export function chunkBounds(cx: number, cy: number): { minX: number; minY: number; maxX: number; maxY: number } {
  const minX = cx * CHUNK_SIZE;
  const minY = cy * CHUNK_SIZE;
  return { minX, minY, maxX: minX + CHUNK_SIZE, maxY: minY + CHUNK_SIZE };
}

/** Which chunk column or row a coordinate falls in. */
function chunkIndex(v: number): number {
  return Math.floor(v / CHUNK_SIZE);
}

/** One chunk as a single number. Two chunks never share a key. */
function keyOf(cx: number, cy: number): number {
  return (cx + KEY_BIAS) * KEY_SPAN + (cy + KEY_BIAS);
}

function push(index: Map<number, number[]>, key: number, value: number): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [value]);
  else bucket.push(value);
}

/**
 * The marks of a curve that fall in a run, moved to the run's own numbering.
 * `marks` ascends, so the answer does too.
 */
function markedWithin(marks: readonly number[], start: number, end: number): number[] {
  const out: number[] = [];
  for (const at of marks) if (at >= start && at < end) out.push(at - start);
  return out;
}
