/**
 * Chunked generation (spec section 9.1).
 *
 * The world is streamed as square chunks around the player rather than held
 * whole. A chunk is a window onto the whole-map skeleton: the roads that run
 * through it, the parcels that lie in it, and the heights over it. It is cut
 * from layers that are a pure function of the seed, so what a chunk holds never
 * depends on which of its neighbours were asked for, in which order, or whether
 * any of them were asked for at all. That is the isolation the gate of spec
 * section 3 checks, and it is what "seamless by construction" means: no edge is
 * stitched afterwards, because neither side was ever cut apart.
 *
 * The layers are whole-map: the road graph, the footprint, the tensor field,
 * the parcel model and the carve. A parcel can be far larger than a chunk and is
 * cut from the whole coastline, so there is no smaller thing to derive it from.
 * Building them is the cost of the first chunk of a world; every chunk after
 * that is a clip. A {@link ChunkSource} therefore builds them once and answers
 * chunk requests without writing anything back.
 */
import { regionArea, regionOf, split, type Point, type Region } from '../core/geom.ts';
import { buildBuildings, lotMiddle, type Building, type BuildingMap } from './buildings.ts';
import { buildCarve, type RoadCarve } from './carve.ts';
import { apronOf, buildFootprint, type RoadFootprint } from './footprint.ts';
import { buildRoadGraph, type RoadGraph } from './graph.ts';
import { buildJunctions, type Junction, type JunctionMap, type RoadGap } from './junctions.ts';
import { buildParcels, type Parcel, type ParcelMap, type ParcelOwner } from './parcels.ts';
import { PAVEMENT_WINDOW, pavementIn, type ChunkPavement, type PavementApron } from './pavement.ts';
import { deckPiers, type DeckPier } from './piers.ts';
import { buildTensorField } from './tensor.ts';
import { CHUNK_TERRAIN_CELL, TERRAIN_CELL } from './terrain.ts';
import { tramTrack, type TramCrossing, type TramTrack } from './tram-track.ts';
import type { HeightfieldData, RoadCurve, RoadTier, WorldDescription, Zone } from './types.ts';
import { Vegetation, type Plant } from './vegetation.ts';
import { generateWorld } from './world.ts';

/**
 * Metres each way of one chunk: 25 cells of the skeleton's grid. The chunk grid
 * is anchored on the origin, so chunk `(cx, cy)` covers
 * `[cx * CHUNK_SIZE, (cx + 1) * CHUNK_SIZE)` each way and a map 3 km to 6 km
 * across is 12 to 24 chunks a side.
 */
export const CHUNK_SIZE = 25 * TERRAIN_CELL;

/** Terrain cells each way of one chunk, on the chunk's own finer grid. */
const CHUNK_CELLS = CHUNK_SIZE / CHUNK_TERRAIN_CELL;

/** Metres of one bucket of the millimetre grid the polygon engine rounds onto. */
const MM = 1e-3;

/** The ground one chunk covers. */
export interface ChunkBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Which chunk a place on the map falls in. */
export function chunkAt(x: number, y: number): { cx: number; cy: number } {
  return { cx: Math.floor(x / CHUNK_SIZE), cy: Math.floor(y / CHUNK_SIZE) };
}

/** The ground chunk `(cx, cy)` covers. */
export function chunkBounds(cx: number, cy: number): ChunkBounds {
  const minX = cx * CHUNK_SIZE;
  const minY = cy * CHUNK_SIZE;
  return { minX, minY, maxX: minX + CHUNK_SIZE, maxY: minY + CHUNK_SIZE };
}

/** One run of a road curve inside a chunk, cut where it leaves. */
export interface ChunkRoad {
  /** Id of the whole-map road curve this run comes from. */
  curve: number;
  tier: RoadTier;
  /** Index in that curve of the segment this run starts on. */
  from: number;
  /** The centreline of the run, at least two points. */
  points: Point[];
  /** Indices of the segments of this run carried on a deck. Ascending. */
  bridges: number[];
  /** Indices of the segments of this run bored through the ground. Ascending. */
  tunnels: number[];
  /**
   * The stretches of the whole curve that junctions take (spec section 6.2),
   * ascending. They are the curve's, not the run's: a run cut short of the
   * junction it ends at still knows where the junction wants it to stop.
   */
  gaps: RoadGap[];
}

/** A pier under a deck, with the height of the carved ground its foot stands on. */
export interface ChunkPier extends DeckPier {
  /** The tier of the deck the pier carries, whose batch it is drawn in. */
  tier: RoadTier;
  ground: number;
}

/** One piece of a parcel inside a chunk. A parcel that spans a boundary gives a piece to each side. */
export interface ChunkParcel {
  /** Id of the whole-map parcel this piece comes from. */
  parcel: number;
  /** The ground the piece covers. */
  region: Region;
  /** Square metres of that piece, not of the whole parcel. */
  area: number;
  owner: ParcelOwner;
  district: number;
  zone: Zone;
  /** The road graph edges that run along the whole parcel, ascending. */
  roads: number[];
}

/** What a chunk holds: everything inside it, and nothing that needs a neighbour. */
export interface WorldChunk {
  seed: number;
  cx: number;
  cy: number;
  /** The ground the chunk covers. */
  bounds: ChunkBounds;
  /**
   * Heights over the chunk, with the roads carved into them (spec section 7.1):
   * `CHUNK_CELLS + 1` samples each way, every `CHUNK_TERRAIN_CELL` metres, so
   * the far row and column stand on the near ones of the next chunk. The world
   * description keeps the natural ground the roads were traced on, on its own
   * coarser grid; this is the ground they leave.
   */
  terrain: HeightfieldData;
  /** Metres of the world's sea level, so the heights can be read without the world. */
  seaLevel: number;
  /** The road runs inside the chunk, in curve order. */
  roads: ChunkRoad[];
  /** The junctions whose node stands in the chunk, in node order. */
  junctions: Junction[];
  /** The parcel pieces inside the chunk, in parcel order. */
  parcels: ChunkParcel[];
  /**
   * The pavement and the verges inside the chunk (spec section 6.4): the ground
   * the roads claim less the carriageway, cut by tier, widest tier first.
   */
  pavement: ChunkPavement[];
  /**
   * The buildings of the chunk, in building order. A building is one thing and
   * is never cut in two: the chunk its lot's middle stands in owns the whole of
   * it, so a lot on a boundary reaches a little into its neighbour rather than
   * being drawn twice.
   */
  buildings: Building[];
  /**
   * The plants standing in the chunk, in grid order (spec section 10.4). Like a
   * building, a plant is one thing and is never cut: the chunk the plant stands
   * in carries the whole of it.
   */
  plants: Plant[];
  /** The piers whose foot stands in the chunk, in the order `deckPiers` lists them. */
  piers: ChunkPier[];
  /**
   * The tram track inside the chunk (spec section 13.2): runs of the curves the
   * tram drives down, cut where the track leaves the chunk. A run is never cut
   * at a junction, because the rails carry on across it.
   */
  tram: ChunkRoad[];
  /** The level crossings whose node stands in the chunk. */
  tramCrossings: TramCrossing[];
}

/**
 * The whole-map layers a chunk is cut from. Each is already built on demand
 * from the world description rather than stored in it (spec sections 6.4, 6.5).
 */
export interface WorldLayers {
  graph: RoadGraph;
  junctions: JunctionMap;
  footprint: RoadFootprint;
  parcels: ParcelMap;
  buildings: BuildingMap;
  carve: RoadCarve;
  /** The plants of the world, which a chunk asks for the ground it covers. */
  vegetation: Vegetation;
  /** Every pier under every deck. */
  piers: DeckPier[];
  tram: TramTrack;
}

/**
 * Build the layers of a world. The tensor field is built here too, because the
 * parcels are cut along it, but a chunk never reads it and it is not kept.
 */
export function buildLayers(world: WorldDescription): WorldLayers {
  const graph = buildRoadGraph(world.roads);
  const junctions = buildJunctions(world.roads, graph);
  const footprint = buildFootprint(world.roads, world.corridors, graph);
  const field = buildTensorField(world);
  const parcels = buildParcels(world, footprint, graph, field);
  const buildings = buildBuildings(world, parcels, graph);
  return {
    graph,
    junctions,
    footprint,
    parcels,
    buildings,
    carve: buildCarve(world.terrain, world.roads, junctions),
    vegetation: new Vegetation(world.seed, parcels, buildings),
    piers: deckPiers(world),
    tram: tramTrack(world, graph),
  };
}

/** The box around a piece of geometry, as the chunk overlap test wants it. */
interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * A world cut into chunks.
 *
 * The source is read-only once built: {@link ChunkSource.chunk} reads the
 * layers and never writes to them, so a chunk is a pure function of the world
 * and the chunk indices. Ask for one chunk or for all of them, in any order:
 * each comes back the same.
 *
 * A caller that already holds the layers passes them in rather than paying for
 * them twice.
 */
export class ChunkSource {
  readonly world: WorldDescription;
  readonly layers: WorldLayers;
  /** The box around each road curve and each parcel, so a chunk tests a handful of them closely. */
  private readonly roadBoxes: Box[];
  private readonly parcelBoxes: Box[];
  /** The box around each junction's outline, in junction order. */
  private readonly junctionBoxes: Box[];
  /** The apron over each junction of three roads or more, and the box around each. */
  private readonly aprons: { apron: PavementApron; box: Box }[] = [];
  /**
   * The buildings of each chunk, filed under the chunk their lot's middle
   * stands in. A building belongs to one chunk and is never cut, so this is
   * settled once rather than searched for per chunk.
   */
  private readonly buildingsByChunk = new Map<string, Building[]>();

  constructor(world: WorldDescription, layers: WorldLayers = buildLayers(world)) {
    this.world = world;
    this.layers = layers;
    this.roadBoxes = world.roads.map((road) => boxOf(road.points));
    this.parcelBoxes = layers.parcels.parcels.map((parcel) => boxOf(parcel.region.outer));
    this.junctionBoxes = layers.junctions.junctions.map((junction) => boxOf(junction.outline));
    for (const node of layers.graph.nodes) {
      const apron = apronOf(layers.graph, node);
      if (apron !== undefined) this.aprons.push({ apron, box: boxOf(apron.ring) });
    }
    for (const building of layers.buildings.buildings) {
      const middle = lotMiddle(building.lot);
      const at = chunkAt(middle.x, middle.y);
      const key = `${at.cx}:${at.cy}`;
      const here = this.buildingsByChunk.get(key);
      if (here === undefined) this.buildingsByChunk.set(key, [building]);
      else here.push(building);
    }
  }

  /** Cut chunk `(cx, cy)` out of the world. */
  chunk(cx: number, cy: number): WorldChunk {
    const bounds = chunkBounds(cx, cy);
    // The parcel pieces are cut first, because the plants are scattered over
    // them: a point that asks which parcel it stands on then walks the piece
    // the chunk holds rather than the whole coastline it was cut from.
    const parcels = this.parcelsIn(bounds);
    return {
      seed: this.world.seed,
      cx,
      cy,
      bounds,
      terrain: this.terrainOf(bounds),
      seaLevel: this.world.water.seaLevel,
      roads: this.roadsIn(bounds),
      junctions: this.junctionsIn(bounds),
      parcels,
      pavement: this.pavementOf(bounds),
      buildings: [...(this.buildingsByChunk.get(`${cx}:${cy}`) ?? [])],
      plants: this.layers.vegetation.plantsIn(bounds, parcels),
      piers: this.piersIn(bounds),
      tram: this.tramIn(bounds),
      tramCrossings: this.layers.tram.crossings.filter((crossing) => inside(crossing, bounds)),
    };
  }

  /** The piers whose foot stands in a chunk, each with the carved ground under it. */
  private piersIn(bounds: ChunkBounds): ChunkPier[] {
    const carve = this.layers.carve;
    return this.layers.piers
      .filter((pier) => inside(pier, bounds))
      .map((pier) => ({
        ...pier,
        tier: (this.world.roads[pier.curve] as RoadCurve).tier,
        ground: carve.heightAt(pier.x, pier.y),
      }));
  }

  /** The runs of tram track inside a chunk, in curve order. */
  private tramIn(bounds: ChunkBounds): ChunkRoad[] {
    const out: ChunkRoad[] = [];
    const segments = this.layers.tram.segments;
    for (let i = 0; i < this.world.roads.length; i++) {
      const mask = segments[i];
      if (mask === undefined || !boxesMeet(this.roadBoxes[i] as Box, bounds)) continue;
      clipRoad(this.world.roads[i] as RoadCurve, bounds, [], out, mask);
    }
    return out;
  }

  /**
   * The heights over a chunk, with the roads carved into them (spec section
   * 7.1). They are read off the carve rather than copied out of the world
   * heightfield: the map's grid is centred on the origin and the chunk grid is
   * anchored on it, so the two need not line up. Two neighbours agree along the
   * edge they share because both ask the carve the same question at the same
   * place, and it answers one place at a time.
   */
  private terrainOf(bounds: ChunkBounds): HeightfieldData {
    const gridSize = CHUNK_CELLS + 1;
    const heights = new Float32Array(gridSize * gridSize);
    const carve = this.layers.carve;
    for (let iy = 0; iy < gridSize; iy++) {
      const y = bounds.minY + iy * CHUNK_TERRAIN_CELL;
      for (let ix = 0; ix < gridSize; ix++) {
        heights[iy * gridSize + ix] = carve.heightAt(bounds.minX + ix * CHUNK_TERRAIN_CELL, y);
      }
    }
    return { gridSize, cellSize: CHUNK_TERRAIN_CELL, originX: bounds.minX, originY: bounds.minY, heights };
  }

  /** The road runs inside a chunk, in curve order. */
  private roadsIn(bounds: ChunkBounds): ChunkRoad[] {
    const out: ChunkRoad[] = [];
    for (let i = 0; i < this.world.roads.length; i++) {
      if (!boxesMeet(this.roadBoxes[i] as Box, bounds)) continue;
      const road = this.world.roads[i] as RoadCurve;
      clipRoad(road, bounds, this.layers.junctions.gaps[road.id] ?? [], out);
    }
    return out;
  }

  /**
   * The junctions inside a chunk. A chunk owns its near edges and not its far
   * ones, as it does for the roads, so a node on a boundary is drawn once.
   */
  private junctionsIn(bounds: ChunkBounds): Junction[] {
    return this.layers.junctions.junctions.filter((junction) => inside(junction, bounds));
  }

  /**
   * The pavement of a chunk, cut from every road, junction and apron that
   * reaches a window {@link PAVEMENT_WINDOW} wider than the chunk each way.
   */
  private pavementOf(bounds: ChunkBounds): ChunkPavement[] {
    const window: ChunkBounds = {
      minX: bounds.minX - PAVEMENT_WINDOW,
      minY: bounds.minY - PAVEMENT_WINDOW,
      maxX: bounds.maxX + PAVEMENT_WINDOW,
      maxY: bounds.maxY + PAVEMENT_WINDOW,
    };
    const junctions = this.layers.junctions.junctions.filter((_, j) => boxesMeet(this.junctionBoxes[j] as Box, window));
    const aprons = this.aprons.filter((entry) => boxesMeet(entry.box, window)).map((entry) => entry.apron);
    return pavementIn(bounds, { roads: this.roadsIn(window), junctions, aprons }, this.layers.carve.ribbons);
  }

  /** The parcel pieces inside a chunk, in parcel order. */
  private parcelsIn(bounds: ChunkBounds): ChunkParcel[] {
    const clip = [regionOf(boxRing(bounds))];
    const out: ChunkParcel[] = [];
    const parcels = this.layers.parcels.parcels;
    for (let i = 0; i < parcels.length; i++) {
      const box = this.parcelBoxes[i] as Box;
      if (!boxesMeet(box, bounds)) continue;
      const parcel = parcels[i] as Parcel;
      // A parcel the chunk holds whole is kept as it is: cutting it would only
      // round its corners onto the millimetre grid a second time.
      if (boxInside(box, bounds)) {
        out.push(pieceOf(parcel, parcel.region, parcel.area));
        continue;
      }
      for (const piece of split([parcel.region], clip).inside) {
        out.push(pieceOf(parcel, piece, regionArea(piece)));
      }
    }
    return out;
  }
}

/**
 * Generate one chunk of a seed on its own, with nothing else to hand.
 *
 * This builds the whole-map skeleton and its layers, which is what a chunk is
 * cut from, so it costs a world per call. A caller that wants more than one
 * chunk of a seed builds a {@link ChunkSource} once instead.
 */
export function generateChunk(seed: number, cx: number, cy: number): WorldChunk {
  return new ChunkSource(generateWorld(seed)).chunk(cx, cy);
}

/** One piece of a parcel as the chunk carries it. */
function pieceOf(parcel: Parcel, region: Region, area: number): ChunkParcel {
  return {
    parcel: parcel.id,
    region,
    area,
    owner: parcel.owner,
    district: parcel.district,
    zone: parcel.zone,
    roads: [...parcel.roads],
  };
}

/**
 * Cut a road curve to a chunk and add the runs inside it to `out`.
 *
 * A run ends where the curve leaves the chunk and a new one starts where it
 * comes back, so a road that wanders across a boundary twice gives two runs.
 * The point a run is cut at is solved from the two ends of the segment and the
 * edge it crosses, so the chunk on the other side cuts at the same place.
 * Given `only`, a mask of the curve's segments, a segment the mask leaves out
 * is cut as if it lay outside the chunk.
 */
function clipRoad(road: RoadCurve, bounds: ChunkBounds, gaps: RoadGap[], out: ChunkRoad[], only?: Uint8Array): void {
  const segments = Math.max(0, road.points.length - 1);
  const bridges = maskOf(road.bridges, segments);
  const tunnels = maskOf(road.tunnels, segments);
  let run: ChunkRoad | undefined;
  const flush = (): void => {
    if (run !== undefined && runLength(run.points) > 0) out.push(run);
    run = undefined;
  };
  for (let i = 0; i < segments; i++) {
    const a = road.points[i] as Point;
    const b = road.points[i + 1] as Point;
    const span = only === undefined || only[i] === 1 ? clipSegment(a, b, bounds) : undefined;
    // A segment that misses the chunk, or only touches a corner of it, ends the
    // run before it and carries nothing of its own.
    if (span === undefined || span.t0 === span.t1) {
      flush();
      continue;
    }
    // A segment that starts inside the chunk carries on the run before it; one
    // cut open at its start begins a new run.
    if (run === undefined || span.t0 > 0) {
      flush();
      run = { curve: road.id, tier: road.tier, from: i, points: [along(a, b, span.t0)], bridges: [], tunnels: [], gaps };
    }
    const segment = run.points.length - 1;
    if ((bridges[i] as number) === 1) run.bridges.push(segment);
    else if ((tunnels[i] as number) === 1) run.tunnels.push(segment);
    run.points.push(along(a, b, span.t1));
    if (span.t1 < 1) flush();
  }
  flush();
}

/** A mask of `length` segments, 1 at every index listed. */
function maskOf(indices: readonly number[], length: number): Uint8Array {
  const mask = new Uint8Array(length);
  for (const i of indices) if (i >= 0 && i < length) mask[i] = 1;
  return mask;
}

/**
 * How much of a segment lies inside a box, as the two ends of a stretch of it.
 * Nothing when the segment misses the box altogether.
 *
 * A chunk covers the ground up to its far edges but not the edges themselves:
 * a segment that runs along one of them is left to the chunk beyond it, so a
 * road laid on a boundary is cut into one chunk rather than into both.
 */
function clipSegment(a: Point, b: Point, box: ChunkBounds): { t0: number; t1: number } | undefined {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  /** Each edge as the rate the segment approaches it, how far it starts inside it, and whether it is a far edge. */
  const edges: [number, number, boolean][] = [
    [-dx, a.x - box.minX, false],
    [dx, box.maxX - a.x, true],
    [-dy, a.y - box.minY, false],
    [dy, box.maxY - a.y, true],
  ];
  for (const [denominator, distance, far] of edges) {
    if (denominator === 0) {
      // Parallel to this edge: either wholly on the inside of it or wholly out.
      if (distance < 0 || (far && distance === 0)) return undefined;
      continue;
    }
    const t = distance / denominator;
    if (denominator < 0) {
      if (t > t1) return undefined;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return undefined;
      if (t < t1) t1 = t;
    }
  }
  return { t0, t1 };
}

/** A point along a segment, on the millimetre grid the polygon arithmetic rounds to. */
function along(a: Point, b: Point, t: number): Point {
  if (t === 0) return { x: a.x, y: a.y };
  if (t === 1) return { x: b.x, y: b.y };
  return { x: Math.round((a.x + (b.x - a.x) * t) / MM) * MM, y: Math.round((a.y + (b.y - a.y) * t) / MM) * MM };
}

/** Metres along a run. A run cut at a corner of a chunk has none, and is no run at all. */
function runLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** The ring of a box, wound anticlockwise. */
function boxRing(box: ChunkBounds): Point[] {
  return [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
}

/** The box around a set of points. */
function boxOf(points: readonly Point[]): Box {
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of points) {
    box.minX = Math.min(box.minX, p.x);
    box.minY = Math.min(box.minY, p.y);
    box.maxX = Math.max(box.maxX, p.x);
    box.maxY = Math.max(box.maxY, p.y);
  }
  return box;
}

/** True when two boxes share any ground, edges included. */
function boxesMeet(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/** True when a place stands in a chunk. A chunk owns its near edges and not its far ones. */
function inside(p: { x: number; y: number }, bounds: ChunkBounds): boolean {
  return p.x >= bounds.minX && p.x < bounds.maxX && p.y >= bounds.minY && p.y < bounds.maxY;
}

/** True when the first box stands wholly inside the second. */
function boxInside(a: Box, b: Box): boolean {
  return a.minX >= b.minX && a.maxX <= b.maxX && a.minY >= b.minY && a.maxY <= b.maxY;
}
