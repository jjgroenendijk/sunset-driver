import { Vector3, type BufferAttribute, type BufferGeometry } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildChunkBuildings, buildingLookup } from '../src/render/building-mesh.ts';
import { CHUNK_DRAW_CALL_CAP, chunkDrawCalls } from '../src/render/chunk-cost.ts';
import { LAMP_BY_TIER, lampsIn } from '../src/render/lamp-mesh.ts';
import { buildChunkRoads, partsOf, roadSection, type SectionPoint } from '../src/render/road-mesh.ts';
import { buildWaterAttributes } from '../src/render/water.ts';
import { hashInts } from '../src/core/hash.ts';
import { compareNumbers } from '../src/core/sort.ts';
import { pointInRegion, pointInRegions, regionArea, type Region } from '../src/core/geom.ts';
import {
  ChunkSource,
  chunkBounds,
  CHUNK_SIZE,
  type ChunkParcel,
  type ChunkRoad,
  type WorldChunk,
} from '../src/world/chunks.ts';
import {
  benchHalfWidth,
  buildCarve,
  CARVE_BLEND,
  CARVE_CUT,
  CARVE_FILL,
  type RoadCarve,
} from '../src/world/carve.ts';
import { BEACH_REACH, BEACH_RISE, isResort, MAX_SAND, MIN_BEACH, MIN_PIER, MIN_SAND, SHORE_STEP } from '../src/world/beaches.ts';
import {
  FRONT_REACH,
  MIN_LOT_AREA,
  ZONE_BUILDINGS,
  ZONE_LOTS,
  type Building,
  type BuildingKind,
  type BuildingMap,
} from '../src/world/buildings.ts';
import { MIN_BOARDWALK } from '../src/world/roads.ts';
import { layoutZones, zoneAt } from '../src/world/districts.ts';
import type { RoadFootprint } from '../src/world/footprint.ts';
import { buildRoadGraph, type GradeCrossing, type RoadEdge, type RoadGraph, type RoadNode } from '../src/world/graph.ts';
import { buildJunctions, type JunctionMap } from '../src/world/junctions.ts';
import { RoadBeds } from '../src/world/bed.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { LandMasses } from '../src/world/landmass.ts';
import { ownerMaxArea, type Parcel, type ParcelMap, type ParcelOwner } from '../src/world/parcels.ts';
import { MITRE_SHIFT, RoadRibbons } from '../src/world/ribbon.ts';
import { MAX_WORLD_SIZE, MIN_WORLD_SIZE } from '../src/world/size.ts';
import { CHUNK_TERRAIN_CELL, coastNoise, islandAt, TERRAIN_CELL } from '../src/world/terrain.ts';
import { nearestRoadPlace, SurfaceIndex } from '../src/world/surface.ts';
import { footprintHalfWidth, TIERS } from '../src/world/tiers.ts';
import type { Beach, Corridor, Point, RoadCurve, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';
import {
  mixFor,
  MAX_PLANT_RADIUS,
  PLANT_CELL,
  PLANT_JITTER,
  PLANT_RADIUS,
  STREET_REACH,
  Vegetation,
  type Plant,
} from '../src/world/vegetation.ts';
import { landPoints, pointInRing, ringArea, ringsOverlap, stableJson, sweepSeeds } from './helpers.ts';
import { buildWorlds, type PooledWorld, type WorldParts } from './world-pool.ts';

/** Metres between the samples that ask whether a road segment is over water. */
const WET_SAMPLE = 5;
/** Metres a bridge head may stand from the crossing's own shore point. */
const BRIDGE_TOLERANCE = 150;

/**
 * Metres of the line a beach laid for its boardwalk that the road really
 * covers: the run of it standing on the road, give or take
 * {@link BOARDWALK_DRIFT}. The road is longer than the line at its ends,
 * because each of them reaches on to the network.
 */
function coverOf(road: readonly Point[], line: readonly Point[]): number {
  let covered = 0;
  for (let k = 0; k + 1 < line.length; k++) {
    const a = line[k] as Point;
    const b = line[k + 1] as Point;
    if (onRoad(road, a) && onRoad(road, b)) covered += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return covered;
}

function onRoad(road: readonly Point[], p: Point): boolean {
  for (let i = 0; i + 1 < road.length; i++) {
    if (distanceToSegment(p, road[i] as Point, road[i + 1] as Point) <= BOARDWALK_DRIFT) return true;
  }
  return false;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSquared = vx * vx + vy * vy;
  let t = lengthSquared > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / lengthSquared : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

/**
 * The carved ground at a place as a chunk draws it: the chunk grid is anchored
 * on the origin and samples the carve every CHUNK_TERRAIN_CELL metres, and the
 * ground between four samples is bilinear between them, as `Heightfield.sample`
 * reads it. Reading the four samples here costs four carve lookups rather than
 * a whole map of them.
 */
function chunkGroundAt(carve: RoadCarve, x: number, y: number): number {
  const cell = CHUNK_TERRAIN_CELL;
  const fx = Math.floor(x / cell);
  const fy = Math.floor(y / cell);
  const tx = x / cell - fx;
  const ty = y / cell - fy;
  const x0 = fx * cell;
  const y0 = fy * cell;
  const h00 = carve.heightAt(x0, y0);
  const h10 = carve.heightAt(x0 + cell, y0);
  const h01 = carve.heightAt(x0, y0 + cell);
  const h11 = carve.heightAt(x0 + cell, y0 + cell);
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}

/** How far a place stands from a line. */
function distanceToLine(p: Point, line: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    best = Math.min(best, distanceToSegment(p, line[i] as Point, line[i + 1] as Point));
  }
  return best;
}

/** The middle of a ring's corners. */
function middleOf(ring: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ring.length, y: y / ring.length };
}

/**
 * True when another run of the same road stands on the ground within reach of a
 * place, so the carve there is that run's and not the structure's. A switchback
 * that doubles back under its own deck does exactly this.
 */
function passesUnder(road: RoadCurve, segment: number, at: Point, reach: number): boolean {
  for (let i = 0; i + 1 < road.points.length; i++) {
    if (i === segment || road.bridges.includes(i) || road.tunnels.includes(i)) continue;
    const a = road.points[i] as Point;
    const b = road.points[i + 1] as Point;
    if (distanceToSegment(at, a, b) <= reach) return true;
  }
  return false;
}

/** A road point as a key, so two curves that share a point share a string. */
/**
 * A point as one number, to the millimetre, so the maps keyed on it hold
 * numbers rather than strings. A sweep keys every road point of every seed, and
 * a string key there is a million allocations a test. The map is at most 6 km
 * across (`size.ts`), so each coordinate fits in the 24 bits it is given and no
 * two points share a key.
 */
const KEY_SPAN = 1 << 23;

function pointKey(p: Point): number {
  return (Math.round(p.x * 1000) + KEY_SPAN) * (KEY_SPAN * 2) + (Math.round(p.y * 1000) + KEY_SPAN);
}

/**
 * Metres the ground has to leave the line a road drives before the road counts
 * as standing off it. The tracer allows itself more cut and fill than this, so
 * anything it marks as a structure clears this comfortably.
 */
const CLEARANCE = 1;

/** Metres along a polyline. */
function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** How hard a road segment climbs between its ends: rise over run. */
function gradeOf(hf: Heightfield, a: Point, b: Point): number {
  const run = Math.hypot(b.x - a.x, b.y - a.y);
  return run > 0 ? Math.abs(hf.sample(b.x, b.y) - hf.sample(a.x, a.y)) / run : 0;
}

/**
 * How far the ground leaves the line a road segment drives: metres above it at
 * its highest, and metres below it at its lowest.
 */
function profileUnder(hf: Heightfield, a: Point, b: Point): { above: number; below: number } {
  const start = hf.sample(a.x, a.y);
  const end = hf.sample(b.x, b.y);
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / WET_SAMPLE));
  let above = 0;
  let below = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const h = hf.sample(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    above = Math.max(above, h - (start + (end - start) * t));
    below = Math.max(below, start + (end - start) * t - h);
  }
  return { above, below };
}

/** How much of a straight span stands over water, in [0, 1]. */
function wetFraction(hf: Heightfield, a: Point, b: Point, seaLevel: number): number {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / WET_SAMPLE));
  let wet = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (hf.sample(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < seaLevel) wet++;
  }
  return wet / (steps + 1);
}

/**
 * True where the ground is dry for two cells of the water sheet each way, which
 * is further than the sheet reaches inland past a shore.
 */
function standsClearOfWater(hf: Heightfield, x: number, y: number, seaLevel: number, cell: number): boolean {
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) if (hf.sample(x + i * cell, y + j * cell) < seaLevel) return false;
  }
  return true;
}

/** True when the segment spans the crossing, either way round. */
function spansCrossing(a: Point, b: Point, from: Point, to: Point): boolean {
  const near = Math.max(Math.hypot(a.x - from.x, a.y - from.y), Math.hypot(b.x - to.x, b.y - to.y));
  const flipped = Math.max(Math.hypot(a.x - to.x, a.y - to.y), Math.hypot(b.x - from.x, b.y - from.y));
  return Math.min(near, flipped) <= BRIDGE_TOLERANCE;
}

/**
 * Quick tier by default; CI and `npm run test:full` set SWEEP_SEEDS=200 (spec
 * section 3). The quick tier takes the seeds that fit in its 15 s, and the
 * full tier is the coverage. Every count below reads this one, so the quick
 * tier is a sample of the same checks and never a shorter list of them.
 */
const SEED_COUNT = Number(process.env.SWEEP_SEEDS ?? 6);
/**
 * Seeds the byte-identical check generates a second time. Generating a world is
 * the most expensive thing this file does, so the quick tier repeats only a few.
 */
const REPEAT_COUNT = SEED_COUNT > 20 ? 20 : 3;
/**
 * Seeds the road footprint is laid, the parcels are cut and the buildings are
 * laid for. A job that carries them costs about three times a bare world, so
 * both tiers do a few seeds rather than all of them. The pool does that work,
 * next to the world it belongs to.
 */
const FOOTPRINT_COUNT = SEED_COUNT > 20 ? 16 : 3;
/**
 * The share of the dry land the roads may claim (spec section 6.4). A city
 * gives about a seventh of its ground to the carriageway, the verge and the
 * pavement together, and the wilderness beyond it gives almost none. The bounds
 * are wide: they are here to catch a footprint that has collapsed or run away,
 * not to pin a number down.
 */
const MIN_FOOTPRINT_SHARE = 0.04;
const MAX_FOOTPRINT_SHARE = 0.3;
/** Metres from every road that ground has to stand before the footprint may not claim it. */
const CLEAR_OF_ROADS = 80;
/**
 * Metres a dirt road has to stand from every paved road before the ground under
 * it is asked to read as dirt. Where the two meet, the wider road claims the
 * ground they share, so a made-up junction reads as tarmac.
 */
const PAVED_CLEAR = 40;
/**
 * The share of the places sampled on a beach's sand that have to read as sand.
 * The rest is road: a boardwalk, an island link or a seafront road may cross a
 * beach, and the road claims the ground where it does. Three seeds in four read
 * above 0.8; this is a floor, not a measurement.
 */
const MIN_SAND_READ = 0.5;
/** One road segment in this many is asked whether the footprint covers it. */
const SAMPLE_STRIDE = 40;
/** Places a seed is asked about that stand clear of every road. */
const CLEAR_SAMPLES = 200;
/** Places a seed is asked which parcels claim them. */
const PARCEL_SAMPLES = 250;
/** Parcels a world has to be cut into; a map that comes back with fewer has collapsed. */
const MIN_PARCELS = 40;
/**
 * How much of the dry land may be neither road nor parcel. What is left over is
 * land the road network never reaches — an outer island with no road laid on it
 * — and nothing can be placed there, so it is no parcel. A seed with much more
 * than this has lost ground the roads do reach.
 */
const MAX_UNREACHED_SHARE = 0.15;
/**
 * The owners spec section 6.4 step 4 names that are handed out today. A body of
 * water inside the land and the ground under an elevated deck come later; until
 * then no parcel carries them.
 */
const ASSIGNED_OWNERS = new Set<ParcelOwner>(['building', 'park', 'car-park', 'plaza', 'beach', 'ground']);
/** Buildings a world has to be given; a map that comes back with fewer has collapsed. */
const MIN_BUILDINGS = 200;
/**
 * The kind spec section 8.2 gives each zone its character from. The sweep asks
 * that it is the commonest one the zone builds, so the core reads as towers and
 * the suburbs as houses however the district weights fall.
 */
const SIGNATURE_KIND: Record<Zone, BuildingKind> = {
  core: 'tower',
  inner: 'mid-rise',
  industrial: 'warehouse',
  suburban: 'house',
  outskirts: 'house',
  wilderness: 'house',
};
/**
 * The least share of a zone's buildings the signature kind may be, over all the
 * seeds the test reads together. The figures are what the generator gives today
 * with room for a seed whose districts are poor or thin: the pooled shares are
 * about 48 % in the core, 50 % inner, 100 % industrial, 83 % suburban, 64 %
 * outskirts and 64 % wilderness.
 */
const MIN_SIGNATURE_SHARE: Record<Zone, number> = {
  core: 0.3,
  inner: 0.35,
  industrial: 0.95,
  suburban: 0.6,
  outskirts: 0.4,
  wilderness: 0.4,
};
/** Buildings a zone needs before its distribution is asked about at all. */
const MIN_KIND_SAMPLES = 60;
/**
 * Metres past the ground its road claims, the slack `buildings.ts` allows a
 * frontage and the setback its zone lays it at, that the nearer corner of a
 * building's front edge may stand. The metre is for the parcel boundary being
 * sampled rather than followed; over 200 seeds the worst is 1.5 m inside it.
 */
const FRONT_SLACK = 1;
/** Metres a building's front may stand from the middle of its own front edge. */
const FRONT_DRIFT = 0.01;
/** Radians a building may face away from the line out of its lot. Both come off the same corners. */
const FACING_DRIFT = 1e-3;
/**
 * Metres of beach outside the core that every seed has to carry, with a
 * boardwalk along it and a pier off it (spec section 7.3). The rule is that the
 * best beaches outside the core are developed however long they are, so this is
 * what the coastlines give today with room for a seed that gives less — not a
 * target the generator aims at. Over 200 seeds the worst is 311 m and the
 * median is about 970 m.
 */
const GUARANTEED_BEACH = 250;
/**
 * How much of that beach's free sand — the sand no road took — has to come back
 * as a parcel the beach owns, and how many places along it at the least. The
 * ends of a beach are cut off by the road that reaches its boardwalk, so it is
 * never the whole of it.
 */
const MIN_SAND_OWNED = 0.8;
const MIN_SAND_PLACES = 4;
/** Shore samples between the places along a beach the tests ask about. */
const BEACH_STRIDE = 3;
/**
 * Metres a boardwalk may stand off the line the beach laid for it. The road
 * covers only as much of that line as the ground allows a street, so what it
 * has to cover is the metres `roads.ts` insists on and not the whole of it.
 */
const BOARDWALK_DRIFT = 3;
/**
 * Metres a road point may stand off the carved ground (spec section 7.1). The
 * ground the game draws is a grid of {@link CHUNK_TERRAIN_CELL} cells, so a
 * bench a few cells wide comes back a little rounded; this is the room that
 * rounding needs.
 */
const CARVE_CLEARANCE = 0.5;
/**
 * The share of a seed's road points that may stand further off than that: one
 * in twenty. Two roads within a bench of each other at different heights — a
 * street beside a highway embankment, two hairpins on a cliff — ask for two beds
 * in one grid cell, and only one of them can have it. A seed of steep ground
 * carries a few per cent of those; the worst of 200 seeds carries 3 %.
 */
const CARVE_STAND_OFF_SHARE = 0.05;
/**
 * Metres no road point may stand off the carved ground, however crowded the
 * ground under it. The carve moves no sample of the ground further than its own
 * cut and fill limit, and the ground between two samples is the line between
 * them, so this holds by construction: a point further off than this is a carve
 * that has gone wrong, not a grid that ran out of room.
 */
const CARVE_STAND_OFF = Math.max(CARVE_CUT, CARVE_FILL);
/**
 * Metres each side of a road centreline that the carriageway is asked to be
 * level at. Only a tier whose bench reaches that far, with a chunk cell to
 * spare for the grid to sample it, is asked: an alley's bench is narrower than
 * this, and the ground beside it is the hillside blending back.
 */
const LEVEL_AT = 6;
/** One road segment in this many is asked how level the ground beside it is. */
const LEVEL_STRIDE = 4;
/**
 * Where in the spread of those places the levelness is read, and what it has to
 * come to. The median says nothing — most roads run over gentle ground, which
 * was near enough level already — so this reads the tail, where the carve does
 * its work.
 */
const LEVEL_PERCENTILE = 0.9;
const LEVEL_WITHIN = 0.5;
/** How much closer to the road bed the carve has to bring that ground. */
const LEVEL_GAIN = 4;
/** Chunks each way of the origin in the block every seed is cut into (spec section 3). */
const CHUNK_BLOCK = 1;
/**
 * The chunks whose roads are lofted into real geometry. Building one is far
 * dearer than cutting one, so this is a corner of the core, where every tier,
 * the bends and the structures all appear.
 */
const ROAD_MESH_CHUNKS: [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
];
/**
 * The far offsets every seed is cut at, in chunks. All four stand inside a 3 km
 * map, which is the smallest a seed draws.
 */
const FAR_CHUNKS: readonly (readonly [number, number])[] = [
  [5, 0],
  [0, -5],
  [-4, 4],
  [3, -5],
];
/** A chunk past the edge of every map, which holds nothing at all. */
const BEYOND_MAP: readonly [number, number] = [40, 40];
/**
 * Seeds whose chunks are cut a second time, from a world generated
 * independently, to check a chunk in isolation. Each one builds its own layers
 * — the footprint and the parcels of a whole map — so both tiers take a few.
 */
const ISOLATED_COUNT = SEED_COUNT > 20 ? 2 : 1;
/**
 * Seeds whose buildings are built into real geometry. A tower costs more to
 * generate than the chunk it stands in costs to cut, so the quick tier builds
 * one seed and the full tier spreads the check.
 */
const BUILDING_MESH_COUNT = SEED_COUNT > 20 ? 4 : 1;
/** Places in the block of chunks each way that are asked which parcel claims them. */
const CHUNK_SAMPLES = 18;
/**
 * The chunks each seed is planted in: one on the core, where the trees stand
 * along the pavement, and one far out, where the woods are. Cutting one is
 * cheap next to the layers behind it, but not free, so two is the sample.
 */
const VEGETATION_CHUNKS: readonly (readonly [number, number])[] = [[0, 0], FAR_CHUNKS[0] as readonly [number, number]];
/** Plants of a chunk whose whole canopy is walked, rather than only the point they stand on. */
const VEGETATION_SAMPLES = 24;
/** Points round the rim of a canopy that are asked which parcel they stand on. */
const CANOPY_POINTS = 8;
/** Plants the two chunks of a seed carry between them, at least. A map with none is a fault. */
const MIN_PLANTS = 20;
/**
 * Seeds whose plants are checked. Walking the rim of a canopy asks the parcels
 * of a whole map which of them claims a place, so the quick tier takes a few
 * and the full tier spreads the check.
 */
const VEGETATION_COUNT = SEED_COUNT > 20 ? 8 : 3;
/**
 * Metres a corner may move when a parcel is cut to a chunk. The polygon engine
 * rounds every corner onto its millimetre grid and snaps one that lands beside
 * an edge onto it, so a piece is bounded within about a millimetre of the
 * ground it was cut from, and a long boundary gains or loses a little area.
 */
const CUT_SLACK = 2e-3;
/**
 * Metres from the edge of a parcel that a place is too close to the edge to ask
 * about. The cut moves that edge by up to {@link CUT_SLACK}, so a place any
 * nearer than this may fall on either side of it and proves nothing.
 */
const BOUNDARY_SLACK = 0.01;

/**
 * The parcels of a world by the ground they cover, so asking which of them
 * claims a place costs a few tests rather than one per parcel.
 */
class ParcelIndex {
  private readonly parcels: readonly Parcel[];
  private readonly minX: number[] = [];
  private readonly minY: number[] = [];
  private readonly maxX: number[] = [];
  private readonly maxY: number[] = [];

  constructor(parcels: readonly Parcel[]) {
    this.parcels = parcels;
    for (const parcel of parcels) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of parcel.region.outer) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      this.minX.push(minX);
      this.minY.push(minY);
      this.maxX.push(maxX);
      this.maxY.push(maxY);
    }
  }

  /** The parcels that claim a place, by id. More than one of them is a fault. */
  at(p: Point): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.parcels.length; i++) {
      if (p.x < (this.minX[i] as number) || p.x > (this.maxX[i] as number)) continue;
      if (p.y < (this.minY[i] as number) || p.y > (this.maxY[i] as number)) continue;
      const parcel = this.parcels[i] as Parcel;
      if (pointInRegions(p, [parcel.region])) out.push(parcel.id);
    }
    return out;
  }
}

/**
 * Every road point in buckets, so "how far is this ground from a road?" costs a
 * few comparisons. `cell` is the bucket side in metres.
 */
class PointGrid {
  private readonly cell: number;
  private readonly n: number;
  private readonly half: number;
  private readonly buckets = new Map<number, { p: Point; curve: number }[]>();

  constructor(size: number, cell: number, roads: readonly RoadCurve[]) {
    this.cell = cell;
    this.half = size / 2;
    this.n = Math.ceil(size / cell) + 4;
    for (const road of roads) {
      for (const p of road.points) {
        const key = this.column(p.y) * this.n + this.column(p.x);
        const bucket = this.buckets.get(key);
        if (bucket === undefined) this.buckets.set(key, [{ p, curve: road.id }]);
        else bucket.push({ p, curve: road.id });
      }
    }
  }

  private column(v: number): number {
    return Math.max(0, Math.min(this.n - 1, Math.floor((v + this.half) / this.cell) + 1));
  }

  /**
   * Metres to the nearest road point, ignoring one curve. Infinity when there
   * is none.
   *
   * Each ring adds only its own square of cells, and the best so far is carried
   * from one ring to the next. Scanning the whole square again at every ring
   * costs the cube of the rings searched, and the wilderness, where the nearest
   * road can be twenty cells away, is most of what this grid is asked.
   */
  nearest(x: number, y: number, except = -1): number {
    const cx = this.column(x);
    const cy = this.column(y);
    const last = this.n - 1;
    let best = Infinity; // Squared, so the search does one square root and no more.
    for (let ring = 0; ring <= this.n; ring++) {
      const loY = cy - ring;
      const hiY = cy + ring;
      const loX = cx - ring;
      const hiX = cx + ring;
      for (let iy = Math.max(0, loY); iy <= Math.min(last, hiY); iy++) {
        if (iy === loY || iy === hiY) {
          // A full row of the ring: its top and its bottom.
          for (let ix = Math.max(0, loX); ix <= Math.min(last, hiX); ix++) {
            best = this.closest(iy * this.n + ix, x, y, except, best);
          }
        } else {
          // A row between them: only the two cells on the sides.
          if (loX >= 0) best = this.closest(iy * this.n + loX, x, y, except, best);
          if (hiX <= last) best = this.closest(iy * this.n + hiX, x, y, except, best);
        }
      }
      // Only trust the answer once the rings searched cover it.
      const covered = (ring - 1) * this.cell;
      if (ring >= 1 && best < covered * covered) return Math.sqrt(best);
    }
    return Math.sqrt(best);
  }

  /** The squared distance to the nearest point in one cell, or `best` if it is nearer. */
  private closest(key: number, x: number, y: number, except: number, best: number): number {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return best;
    let near = best;
    for (const e of bucket) {
      if (e.curve === except) continue;
      const dx = e.p.x - x;
      const dy = e.p.y - y;
      const d = dx * dx + dy * dy;
      if (d < near) near = d;
    }
    return near;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

/** The value `share` of the way up a spread; 0.5 is the median. */
function percentile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * share));
  return at < 0 ? 0 : (sorted[at] as number);
}

function heightsHash(h: Float32Array): number {
  let acc = 0;
  const u = new Uint32Array(h.buffer, h.byteOffset, h.length);
  for (let i = 0; i < u.length; i++) acc = hashInts(acc, u[i] as number);
  return acc;
}

/** Square metres of dry land in a world, counted over the heightfield. */
function landArea(world: WorldDescription): number {
  const hf = new Heightfield(world.terrain);
  const cell = hf.cellSize * hf.cellSize;
  let land = 0;
  for (let iy = 0; iy < hf.gridSize; iy++) {
    for (let ix = 0; ix < hf.gridSize; ix++) if (hf.at(ix, iy) > world.water.seaLevel) land += cell;
  }
  return land;
}

function seaFraction(world: WorldDescription): number {
  const h = world.terrain.heights;
  let wet = 0;
  for (let i = 0; i < h.length; i++) if ((h[i] as number) < world.water.seaLevel) wet++;
  return wet / h.length;
}

/**
 * The chunks every seed is cut into: the block around the origin, then the far
 * offsets, in a fixed order (spec section 3).
 */
function chunkKeys(): [number, number][] {
  const keys: [number, number][] = [];
  for (let cx = -CHUNK_BLOCK; cx <= CHUNK_BLOCK; cx++) {
    for (let cy = -CHUNK_BLOCK; cy <= CHUNK_BLOCK; cy++) keys.push([cx, cy]);
  }
  for (const [cx, cy] of FAR_CHUNKS) keys.push([cx, cy]);
  keys.push([BEYOND_MAP[0], BEYOND_MAP[1]]);
  return keys;
}

/**
 * Where the runs of a chunk meet the line the chunk shares with a neighbour, as
 * sorted keys. Two chunks that hand a road over to each other meet it at the
 * same places, so their keys are the same list.
 *
 * Two ends are left out. A run that stops there because the whole curve stops
 * there hands nothing over. So does one that stops on a corner of the chunk
 * grid, where the road passes through four chunks at a point and belongs to
 * none of them.
 */
function handovers(chunk: WorldChunk, roads: readonly RoadCurve[], axis: 'x' | 'y', at: number): string[] {
  const keys: string[] = [];
  for (const run of chunk.roads) {
    const road = roads[run.curve] as RoadCurve;
    for (const p of [run.points[0] as Point, run.points[run.points.length - 1] as Point]) {
      const along = axis === 'x' ? p.y : p.x;
      if (Math.abs((axis === 'x' ? p.x : p.y) - at) > 1e-9) continue;
      if (along % CHUNK_SIZE === 0) continue;
      if (isCurveEnd(road, p)) continue;
      keys.push(`${run.curve}:${along.toFixed(3)}`);
    }
  }
  return keys.sort();
}

/** Metres round the boundary of a region: its outer ring and its holes. */
function perimeterOf(region: Region): number {
  let total = 0;
  for (const ring of [region.outer, ...region.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Point;
      const b = ring[(i + 1) % ring.length] as Point;
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return total;
}

/** True when every point stands on the ground a chunk covers, give or take `slack` metres. */
function insideBounds(points: readonly Point[], chunk: WorldChunk, slack: number): boolean {
  const { minX, minY, maxX, maxY } = chunk.bounds;
  for (const p of points) {
    if (p.x < minX - slack || p.x > maxX + slack || p.y < minY - slack || p.y > maxY + slack) return false;
  }
  return true;
}

/** Metres from a place to the nearest edge of a region, inside it or outside it. */
function distanceToBoundary(p: Point, region: Region): number {
  let best = Infinity;
  for (const ring of [region.outer, ...region.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Point;
      const b = ring[(i + 1) % ring.length] as Point;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const squared = vx * vx + vy * vy;
      let t = squared > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / squared : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      best = Math.min(best, Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t)));
    }
  }
  return best;
}

/**
 * How the quad of a lofted road surface between section columns `column` and
 * `column + 1`, at row `row` of the loft, is wound and how long it is.
 *
 * A loft lays its rows in order along the run and its columns across the
 * section, so the quad's corners are the two points at `row` and the two at the
 * row after it. The camera looks down on a road, so a quad wound the other way
 * would leave the carriageway invisible from above.
 */
function quadOf(surface: BufferGeometry, columns: number, row: number, column: number): { up: boolean; along: number } {
  const position = surface.getAttribute('position');
  const a = row * columns + column;
  const b = a + 1;
  const d = (row + 1) * columns + column;
  const abx = position.getX(b) - position.getX(a);
  const abz = position.getZ(b) - position.getZ(a);
  const adx = position.getX(d) - position.getX(a);
  const adz = position.getZ(d) - position.getZ(a);
  return { up: abz * adx - abx * adz > 0, along: Math.hypot(adx, adz) };
}

/** True when a place is one of the two ends of a curve. */
function isCurveEnd(road: RoadCurve, p: Point): boolean {
  const head = road.points[0] as Point;
  const tail = road.points[road.points.length - 1] as Point;
  return (head.x === p.x && head.y === p.y) || (tail.x === p.x && tail.y === p.y);
}

describe(`seed sweep (${SEED_COUNT} seeds)`, () => {
  const seeds = sweepSeeds(SEED_COUNT);
  const worlds = new Map<number, WorldDescription>();
  /** The second generation of the repeated seeds, for the byte-identical check. */
  const repeats = new Map<number, WorldDescription>();
  /** The footprint of a seed, laid by the pool for the first FOOTPRINT_COUNT seeds. */
  const footprints = new Map<number, RoadFootprint>();
  const footprintOf = (seed: number): RoadFootprint => {
    const known = footprints.get(seed);
    if (known === undefined) throw new Error(`no footprint for seed ${seed}: the pool lays the first ${FOOTPRINT_COUNT}`);
    return known;
  };
  /** The parcels of a seed, cut by the pool for the same seeds. */
  const parcelMaps = new Map<number, ParcelMap>();
  const parcelsOf = (seed: number): ParcelMap => {
    const known = parcelMaps.get(seed);
    if (known === undefined) throw new Error(`no parcels for seed ${seed}: the pool cuts the first ${FOOTPRINT_COUNT}`);
    return known;
  };
  /** The second generation of the isolated seeds, with the layers of that generation. */
  const repeatParts = new Map<number, WorldParts>();
  /**
   * The chunk source of a seed, over the layers the pool has already built. A
   * source built from the world alone would lay the footprint and cut the
   * parcels a second time.
   */
  const sources = new Map<number, ChunkSource>();
  const sourceOf = (seed: number): ChunkSource => {
    const known = sources.get(seed);
    if (known !== undefined) return known;
    const world = worlds.get(seed) as WorldDescription;
    const built = new ChunkSource(world, {
      graph: graphOf(seed),
      junctions: junctionsOf(seed),
      footprint: footprintOf(seed),
      parcels: parcelsOf(seed),
      buildings: buildingsOf(seed),
      carve: carveOf(seed),
      vegetation: vegetationOf(seed),
    });
    sources.set(seed, built);
    return built;
  };
  /** The junctions of a seed, built once however many tests ask about them. */
  const junctionMaps = new Map<number, JunctionMap>();
  const junctionsOf = (seed: number): JunctionMap => {
    const known = junctionMaps.get(seed);
    if (known !== undefined) return known;
    const world = worlds.get(seed) as WorldDescription;
    const built = buildJunctions(world.roads, graphOf(seed));
    junctionMaps.set(seed, built);
    return built;
  };
  /** The carve of a seed, built once however many tests ask about it. */
  const carves = new Map<number, RoadCarve>();
  const carveOf = (seed: number): RoadCarve => {
    const known = carves.get(seed);
    if (known !== undefined) return known;
    const world = worlds.get(seed) as WorldDescription;
    const built = buildCarve(world.terrain, world.roads, junctionsOf(seed));
    carves.set(seed, built);
    return built;
  };
  /** The beds of a seed's roads: the line each is lofted onto and carved to. */
  const bedMaps = new Map<number, RoadBeds>();
  const bedsOf = (seed: number): RoadBeds => {
    const known = bedMaps.get(seed);
    if (known !== undefined) return known;
    const world = worlds.get(seed) as WorldDescription;
    const built = new RoadBeds(world.terrain, world.roads, junctionsOf(seed));
    bedMaps.set(seed, built);
    return built;
  };
  /** The buildings of a seed, laid by the pool for the same seeds. */
  const buildingMaps = new Map<number, BuildingMap>();
  const buildingsOf = (seed: number): BuildingMap => {
    const known = buildingMaps.get(seed);
    if (known === undefined) throw new Error(`no buildings for seed ${seed}: the pool lays the first ${FOOTPRINT_COUNT}`);
    return known;
  };
  /** The vegetation of a seed, which stands on its parcels and off its lots. */
  const vegetations = new Map<number, Vegetation>();
  const vegetationOf = (seed: number): Vegetation => {
    const known = vegetations.get(seed);
    if (known !== undefined) return known;
    const built = new Vegetation(seed, parcelsOf(seed), buildingsOf(seed));
    vegetations.set(seed, built);
    return built;
  };
  /** The graph of a seed, built once however many tests ask about it. */
  const graphs = new Map<number, RoadGraph>();
  const graphOf = (seed: number): RoadGraph => {
    const known = graphs.get(seed);
    if (known !== undefined) return known;
    const built = buildRoadGraph((worlds.get(seed) as WorldDescription).roads);
    graphs.set(seed, built);
    return built;
  };

  beforeAll(async () => {
    // Every seed once, then the repeated seeds a second time: the pool runs the
    // two rounds back to back so the byte-identical check costs no extra wait.
    // The pool itself starts the jobs that ask for layers first, so they are
    // listed here in the order the tests read them.
    // What a seed costs is measured in `budget.test.ts`, on a quiet machine.
    const repeated = seeds.slice(0, REPEAT_COUNT);
    const jobs = [
      ...seeds.map((seed, i) => ({ seed, parts: i < FOOTPRINT_COUNT })),
      // The repeated seeds the chunk gate cuts in isolation carry their layers
      // too, so that side of the check is built from end to end in a worker,
      // away from the layers the tests on this thread read.
      ...repeated.map((seed, i) => ({ seed, parts: i < ISOLATED_COUNT })),
    ];
    const generated = await buildWorlds(jobs);
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i] as number;
      const built = generated[i] as PooledWorld;
      worlds.set(seed, built.world);
      if (built.parts !== undefined) {
        footprints.set(seed, built.parts.footprint);
        parcelMaps.set(seed, built.parts.parcels);
        buildingMaps.set(seed, built.parts.buildings);
      }
    }
    for (let i = 0; i < repeated.length; i++) {
      const seed = repeated[i] as number;
      const built = generated[seeds.length + i] as PooledWorld;
      repeats.set(seed, built.world);
      if (built.parts !== undefined) repeatParts.set(seed, built.parts);
    }
  });

  it('is byte-identical across runs', () => {
    for (const seed of seeds.slice(0, REPEAT_COUNT)) {
      const a = worlds.get(seed) as WorldDescription;
      const b = repeats.get(seed) as WorldDescription;
      expect(heightsHash(b.terrain.heights)).toBe(heightsHash(a.terrain.heights));
      expect(stableJson({ ...b, terrain: null })).toBe(stableJson({ ...a, terrain: null }));
    }
  });

  it('draws a square world between 3 km and 6 km', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      expect(w.size).toBeGreaterThanOrEqual(MIN_WORLD_SIZE);
      expect(w.size).toBeLessThanOrEqual(MAX_WORLD_SIZE);
      expect(w.size % TERRAIN_CELL).toBe(0);
      expect(new Heightfield(w.terrain).extent).toBe(w.size);
    }
  });

  it('keeps every height finite and bounded', () => {
    for (const seed of seeds) {
      const h = (worlds.get(seed) as WorldDescription).terrain.heights;
      let min = Infinity;
      let max = -Infinity;
      let finite = true;
      for (let i = 0; i < h.length; i++) {
        const v = h[i] as number;
        if (!Number.isFinite(v)) finite = false;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      expect(finite, `seed ${seed}`).toBe(true);
      expect(min).toBeGreaterThan(-40);
      expect(max).toBeLessThan(260);
    }
  });

  it('is mostly land: a few large islands close together', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const f = seaFraction(w);
      expect(f, `seed ${seed}`).toBeGreaterThan(0.12);
      expect(f, `seed ${seed}`).toBeLessThan(0.4);
      expect(w.water.islands.length).toBeGreaterThanOrEqual(3);
      expect(w.water.islands.length).toBeLessThanOrEqual(5);
    }
  });

  it('puts the core on dry, gentle ground', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      expect(hf.sample(w.core.x, w.core.y)).toBeGreaterThan(w.water.seaLevel);
      expect(hf.slope(w.core.x, w.core.y)).toBeLessThan(0.15);
    }
  });

  it('carves the river below sea level from source to harbour', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      for (const p of w.water.river.path) expect(hf.sample(p.x, p.y)).toBeLessThan(w.water.seaLevel);
      expect(hf.sample(w.water.harbour.x, w.water.harbour.y)).toBeLessThan(-5);
    }
  });

  it('lays one water surface over the sea, the straits, the river and the harbour', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const water = buildWaterAttributes(w);
      // The cells the sheet drew, one flag per cell of its grid. A sheet holds
      // tens of thousands of them, so the flags are a byte each rather than a
      // key in a set.
      const drawn = new Uint8Array(water.gridSize * water.gridSize);
      for (let t = 0; t < water.indices.length; t += 6) drawn[water.indices[t] as number] = 1;
      const covers = (p: Point): boolean => {
        const column = Math.floor((p.x - water.minX) / water.cell);
        const row = Math.floor((p.y - water.minY) / water.cell);
        if (column < 0 || row < 0 || column >= water.gridSize || row >= water.gridSize) return false;
        return drawn[row * water.gridSize + column] === 1;
      };

      expect(covers(w.water.harbour), `seed ${seed}: the harbour is dry`).toBe(true);
      // The river is the narrowest water on the map, so it is what says whether
      // the sheet is cut finely enough to hold a channel.
      for (const p of w.water.river.path) {
        expect(covers(p), `seed ${seed}: the river at ${p.x.toFixed(0)}, ${p.y.toFixed(0)} is dry`).toBe(true);
      }
      for (const c of w.water.crossings) {
        const mid = { x: (c.from.x + c.to.x) / 2, y: (c.from.y + c.to.y) / 2 };
        if (hf.sample(mid.x, mid.y) >= w.water.seaLevel) continue;
        expect(covers(mid), `seed ${seed}: the strait between ${c.fromIsland} and ${c.toIsland} is dry`).toBe(true);
      }
      // Dry ground carries no water: a district that stands clear of the shore
      // has none of the sheet over it.
      for (const d of w.districts) {
        if (!standsClearOfWater(hf, d.x, d.y, w.water.seaLevel, water.cell)) continue;
        expect(covers(d), `seed ${seed}: water stands over ${d.name}`).toBe(false);
      }
    }
  });

  it('links every island to the rest by short shore-to-shore crossings', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const noise = coastNoise(w.seed);
      const landOf = (p: Point): number => islandAt(w.water.islands, w.size, noise, p.x, p.y);
      const idOf = (i: number): number => (w.water.islands[i] as { id: number }).id;
      for (const isl of w.water.islands) expect(hf.sample(isl.x, isl.y), `island ${isl.id} seed ${seed}`).toBeGreaterThan(w.water.seaLevel);
      // Union-find over crossings: one connected archipelago.
      const parent = w.water.islands.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)));
      for (const c of w.water.crossings) {
        const { from, to } = c;
        expect(hf.sample(from.x, from.y)).toBeGreaterThanOrEqual(w.water.seaLevel);
        expect(hf.sample(to.x, to.y)).toBeGreaterThanOrEqual(w.water.seaLevel);
        // Both bridge heads stand on the island the crossing claims, so the
        // union-find above joins the land the roads will actually reach. A
        // chord that lands on one island twice, or on a rock in the strait,
        // bridges nothing (spec section 7.2).
        expect(c.fromIsland, `seed ${seed}: a crossing joins island ${c.fromIsland} to itself`).not.toBe(c.toIsland);
        const ends = [idOf(landOf(from)), idOf(landOf(to))].sort(compareNumbers);
        const claimed = [c.fromIsland, c.toIsland].sort(compareNumbers);
        expect(ends, `seed ${seed}: a crossing claims islands ${claimed.join(' and ')} but lands on ${ends.join(' and ')}`).toEqual(claimed);
        // Water under most of the span. Not all of it: a crossing may step over
        // a rock in the strait to reach ground a bridge head can stand on.
        expect(wetFraction(hf, from, to, w.water.seaLevel), `seed ${seed}`).toBeGreaterThan(0.5);
        const span = Math.hypot(from.x - to.x, from.y - to.y);
        expect(span).toBeGreaterThan(20);
        expect(span, `seed ${seed}`).toBeLessThan(w.size * 0.12);
        parent[find(c.fromIsland)] = find(c.toIsland);
      }
      const roots = new Set(w.water.islands.map((_, i) => find(i)));
      expect(roots.size, `seed ${seed}`).toBe(1);
    }
  });

  it('joins every road of every tier into one network', () => {
    // Dirt roads are not in this list: on the smallest maps the outskirts ring
    // falls almost entirely in the water, and there is no wilderness to thread.
    // Where that ground does exist, the block sizes below ask for dirt roads.
    const tiers: RoadTier[] = ['highway', 'arterial', 'street', 'alley'];
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      expect(w.roads.length, `seed ${seed}`).toBeGreaterThan(0);
      for (const tier of tiers) {
        expect(w.roads.some((r) => r.tier === tier), `seed ${seed} has no ${tier}`).toBe(true);
      }

      // Curves that share a point are one road network. Every curve is traced
      // from a road already laid or into one, so there is only ever one.
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      const parent = w.roads.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)));
      const owner = new Map<number, number>();
      for (let i = 0; i < w.roads.length; i++) {
        const road = w.roads[i] as RoadCurve;
        if (road.id !== i) fault(`curve ${i} carries id ${road.id}`);
        if (road.points.length < 2) fault(`curve ${i} has ${road.points.length} points`);
        for (const at of road.bridges) {
          if (at >= road.points.length - 1) fault(`curve ${i} bridges segment ${at}, past its end`);
        }
        for (const p of road.points) {
          const key = pointKey(p);
          const met = owner.get(key);
          if (met === undefined) owner.set(key, i);
          else parent[find(met)] = find(i);
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
      const roots = new Set(w.roads.map((_, i) => find(i)));
      expect(roots.size, `seed ${seed}: ${roots.size} road networks`).toBe(1);
    }
  });

  it('builds one road graph that holds the whole curve network', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      expect(graph.nodes.length, `seed ${seed}`).toBeGreaterThan(0);

      // Every curve is on the graph, and every node has a road leaving it.
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      const covered = new Uint8Array(w.roads.length);
      for (const edge of graph.edges) covered[edge.curve] = 1;
      for (const road of w.roads) if (covered[road.id] !== 1) fault(`curve ${road.id} has no edge`);
      for (const node of graph.nodes) if (graph.degree(node.id) <= 0) fault(`node ${node.id} has no road leaving it`);
      expect(complaint, `seed ${seed}`).toBeUndefined();

      // The curves are one network, so the graph is one component too.
      const seen = new Uint8Array(graph.nodes.length);
      const queue = [0];
      seen[0] = 1;
      for (let i = 0; i < queue.length; i++) {
        for (const e of graph.edgesFrom(queue[i] as number)) {
          const to = (graph.edges[e] as RoadEdge).to;
          if (seen[to] === 1) continue;
          seen[to] = 1;
          queue.push(to);
        }
      }
      expect(queue.length, `seed ${seed}: the graph is not one network`).toBe(graph.nodes.length);

      // Pathfinding crosses that network: the core to the node furthest from it.
      const start = graph.nearestNode(w.core.x, w.core.y) as number;
      let far = 0;
      let farD = -1;
      for (const node of graph.nodes) {
        const d = Math.hypot(node.x - w.core.x, node.y - w.core.y);
        if (d <= farD) continue;
        farD = d;
        far = node.id;
      }
      const route = graph.shortestPath(start, far);
      expect(route, `seed ${seed}: no route from the core to node ${far}`).toBeDefined();
      const taken = route as NonNullable<typeof route>;
      expect(taken.nodes[0]).toBe(start);
      expect(taken.nodes[taken.nodes.length - 1]).toBe(far);
      // A drive is never shorter than the straight line it covers.
      const head = graph.nodes[start] as RoadNode;
      const tail = graph.nodes[far] as RoadNode;
      expect(taken.length, `seed ${seed}`).toBeGreaterThanOrEqual(Math.hypot(head.x - tail.x, head.y - tail.y) - 1e-6);
      for (let i = 0; i < taken.edges.length; i++) {
        const edge = graph.edges[taken.edges[i] as number] as RoadEdge;
        if (edge.from !== taken.nodes[i] || edge.to !== taken.nodes[i + 1]) fault(`route breaks at edge ${edge.id}`);
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();

      // The nearest point of the network to a node is that node's own ground.
      const probe = graph.nodes[graph.nodes.length >> 1] as RoadNode;
      const hit = graph.nearestEdge(probe.x, probe.y);
      expect(hit?.distance, `seed ${seed}`).toBeLessThan(1);
    }
  });

  it('makes no junction where one road is carried over another', () => {
    // Spec section 6.2: an overpass is not a junction. Both runs know about the
    // crossing, and no node stands on it, so no car can turn there.
    for (const seed of seeds) {
      const graph = graphOf(seed);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (let k = 0; k < graph.crossings.length; k++) {
        const crossing = graph.crossings[k] as GradeCrossing;
        const where = `crossing ${k} at ${crossing.x.toFixed(0)},${crossing.y.toFixed(0)}`;
        const node = graph.nodes[graph.nearestNode(crossing.x, crossing.y) as number] as RoadNode;
        if (Math.hypot(node.x - crossing.x, node.y - crossing.y) <= 0.001) fault(`${where} is a junction`);
        const over = graph.edges[crossing.over] as RoadEdge;
        const under = graph.edges[crossing.under] as RoadEdge;
        if (over.curve === under.curve) fault(`${where} joins a road to itself`);
        if (!over.crossings.includes(k)) fault(`${where} is not marked on the road above`);
        if (!under.crossings.includes(k)) fault(`${where} is not marked on the road below`);
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('junctions a highway only at an interchange, and never with a minor road', () => {
    // Spec section 6.2: a highway has junctions only at interchanges and no
    // pedestrians on it. So a street, an alley or a dirt road never shares a
    // point with one — where they cross, the graph makes it an overpass — and a
    // highway or an arterial ramp meets one only at a point it lists.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      // Every curve that owns each point, with the index the point sits at.
      const met = new Map<number, { road: RoadCurve; at: number }[]>();
      for (const road of w.roads) {
        for (let i = 0; i < road.points.length; i++) {
          const key = pointKey(road.points[i] as Point);
          const here = met.get(key);
          if (here === undefined) met.set(key, [{ road, at: i }]);
          else here.push({ road, at: i });
        }
      }
      for (const road of w.roads) {
        if (road.tier !== 'highway') {
          if (road.interchanges.length > 0) fault(`${road.tier} ${road.id} lists interchanges`);
          continue;
        }
        if (road.interchanges.length === 0) fault(`highway ${road.id} has no interchange`);
        for (let k = 1; k < road.interchanges.length; k++) {
          if ((road.interchanges[k] as number) <= (road.interchanges[k - 1] as number)) fault(`highway ${road.id} lists its interchanges out of order`);
        }
        for (const at of road.interchanges) {
          if (at < 0 || at >= road.points.length) fault(`highway ${road.id} puts an interchange past its end at ${at}`);
        }
        for (let i = 0; i < road.points.length; i++) {
          const here = met.get(pointKey(road.points[i] as Point)) ?? [];
          for (const other of here) {
            if (other.road.id === road.id) continue;
            const where = `highway ${road.id} meets ${other.road.tier} ${other.road.id} at point ${i}`;
            if (other.road.tier !== 'highway' && other.road.tier !== 'arterial') fault(where);
            else if (!road.interchanges.includes(i)) fault(`${where}, away from any interchange`);
          }
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('cuts each zone into blocks of about the size it asks for', () => {
    // Half the width of a block, near enough: the median distance from the
    // ground of a zone to the nearest road. Blocks tighten toward downtown
    // because the fill spaces its roads by the density of the district. The
    // wilderness range is wide because an island no district stands on is
    // reached by no bridge, so its ground is far from every road.
    //
    // The three zones on the fringe are looser than the built-up ones because
    // ground too steep for a road now goes without one (spec section 6.1). The
    // city itself sits on gentle ground and did not move.
    const RANGE: Record<Zone, [number, number]> = {
      core: [3, 20],
      inner: [5, 20],
      industrial: [7, 40],
      suburban: [10, 36],
      outskirts: [14, 140],
      wilderness: [35, 800],
    };
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const zones = layoutZones(w.size, w.core, w.water);
      const grid = new PointGrid(w.size, 40, w.roads);
      const samples: Partial<Record<Zone, number[]>> = {};
      for (let iy = 0; iy < hf.gridSize; iy += 8) {
        for (let ix = 0; ix < hf.gridSize; ix += 8) {
          const x = hf.worldX(ix);
          const y = hf.worldY(iy);
          // Dry ground only, and not the strip along the edge that roads keep off.
          if (hf.at(ix, iy) < w.water.seaLevel + 1) continue;
          if (Math.abs(x) > w.size / 2 - 120 || Math.abs(y) > w.size / 2 - 120) continue;
          const zone = zoneAt(zones, x, y);
          (samples[zone] ??= []).push(grid.nearest(x, y));
        }
      }
      for (const zone of Object.keys(RANGE) as Zone[]) {
        const found = samples[zone] ?? [];
        // A zone can be a sliver on one seed; too few samples say nothing.
        if (found.length < 20) continue;
        const [lo, hi] = RANGE[zone];
        const half = median(found);
        expect(half, `seed ${seed}: ${zone} blocks`).toBeGreaterThanOrEqual(lo);
        expect(half, `seed ${seed}: ${zone} blocks`).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('caps the dead ends of streets, alleys and dirt roads', () => {
    // A minor road that met no other road on one side is trimmed to a
    // cul-de-sac, so a free end always stands near the network it hangs off:
    // within the trim, plus the spacing its seed stood off its parent. The caps
    // are in metres, and the loosest spacing of the tier's zones sets them. A
    // road that has to work around steep ground reaches further before it ends,
    // so the street and dirt caps are looser than the trim alone would ask for.
    const CAP: Partial<Record<RoadTier, number>> = { street: 260, alley: 120, dirt: 900 };
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const grid = new PointGrid(w.size, 100, w.roads);
      const shared = new Map<number, number>();
      for (const road of w.roads) {
        for (const p of road.points) {
          const key = pointKey(p);
          shared.set(key, (shared.get(key) ?? 0) + 1);
        }
      }
      let complaint: string | undefined;
      for (const road of w.roads) {
        const cap = CAP[road.tier];
        if (cap === undefined) continue;
        for (const end of [road.points[0] as Point, road.points[road.points.length - 1] as Point]) {
          if ((shared.get(pointKey(end)) ?? 0) > 1) continue;
          const away = grid.nearest(end.x, end.y, road.id);
          if (away > cap) complaint ??= `${road.tier} ${road.id} dead-ends ${away.toFixed(0)} m from any road`;
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('reaches every island that carries a district with an arterial', () => {
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const noise = coastNoise(w.seed);
      const island = (p: Point): number => islandAt(w.water.islands, w.size, noise, p.x, p.y);
      const inhabited = new Set(w.districts.map((d) => island(d)));
      const served = new Set<number>();
      for (const road of w.roads) {
        if (road.tier !== 'arterial') continue;
        for (const p of road.points) if (hf.sample(p.x, p.y) >= w.water.seaLevel) served.add(island(p));
      }
      inhabited.forEach((i) => expect(served.has(i), `island ${i} of seed ${seed} has a district but no arterial`).toBe(true));
    }
  });

  it('keeps roads out of the water except on a bridge over a strait crossing', () => {
    // As in the grade test below: one assertion a seed, so a hundred thousand
    // segments do not each pay for one.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (const road of w.roads) {
        for (let i = 0; i + 1 < road.points.length; i++) {
          const a = road.points[i] as Point;
          const b = road.points[i + 1] as Point;
          const where = `${road.tier} ${road.id} segment ${i}`;
          if (road.bridges.includes(i)) {
            // A deck lands on dry ground at both ends. One over water spans a
            // strait crossing; one over land carries the road over a dip, and
            // the grade test below is what vets that one.
            if (hf.sample(a.x, a.y) < w.water.seaLevel) fault(`${where} starts in the water`);
            if (hf.sample(b.x, b.y) < w.water.seaLevel) fault(`${where} ends in the water`);
            if (wetFraction(hf, a, b, w.water.seaLevel) > 0) {
              const spans = w.water.crossings.some((c) => spansCrossing(a, b, c.from, c.to));
              if (!spans) fault(`${where} is a bridge at no crossing`);
            }
            continue;
          }
          const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / WET_SAMPLE));
          let lowest = Infinity;
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            lowest = Math.min(lowest, hf.sample(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
          }
          if (lowest < w.water.seaLevel) fault(`${where} runs through water`);
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('never lays a road over ground its tier may not climb', () => {
    // Spec section 6.1: a segment steeper than its tier's maximum is rerouted,
    // bridged or tunnelled. So every segment on the ground is inside the limit,
    // and every segment outside it stands off the ground on a deck or in a bore.
    // There are a hundred thousand segments here, so the loop collects the first
    // complaint of each seed and asserts once rather than a hundred thousand times.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (const road of w.roads) {
        const limit = TIERS[road.tier].maxGrade;
        for (const at of road.tunnels) {
          if (at >= road.points.length - 1) fault(`${road.tier} ${road.id} bores past its end at ${at}`);
          if (road.bridges.includes(at)) fault(`${road.tier} ${road.id} segment ${at} is deck and bore at once`);
        }
        for (let i = 0; i + 1 < road.points.length; i++) {
          const a = road.points[i] as Point;
          const b = road.points[i + 1] as Point;
          const where = `${road.tier} ${road.id} segment ${i}`;
          if (road.tunnels.includes(i)) {
            if (profileUnder(hf, a, b).above <= CLEARANCE) fault(`${where} is a bore through nothing`);
            continue;
          }
          if (road.bridges.includes(i)) {
            // A deck over dry land is only worth building over a dip.
            const dry = wetFraction(hf, a, b, w.water.seaLevel) === 0;
            if (dry && profileUnder(hf, a, b).below <= CLEARANCE) fault(`${where} is a deck over nothing`);
            continue;
          }
          const grade = gradeOf(hf, a, b);
          if (grade > limit) fault(`${where} climbs ${(grade * 100).toFixed(0)}%, over the ${(limit * 100).toFixed(0)}% of its tier`);
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('carves every road into the ground it stands on and leaves the rest of the hillside alone', () => {
    // Spec section 7.1: the ground under the network is cut to the line the road
    // drives, the cut and fill blend back into the hillside, and a deck or a
    // bore leaves the terrain alone. A road is never draped over the hill.
    //
    // Every point of a curve stands on the line that curve drives — its bed,
    // which is the natural ground under it away from a junction and the
    // junction's plane at one — so the carved ground there should be the same
    // height: nothing floats, nothing sinks. Two things stop that from being
    // exact. The ground the game draws is the grid a chunk samples, of cells
    // CHUNK_TERRAIN_CELL metres across, so a bench comes back rounded at its
    // edges; and where two roads run within a bench of each other at different
    // heights — a street beside a highway embankment, two hairpins on a cliff —
    // one grid cannot hold both beds at once. So this asks for two things:
    // almost every point is within CARVE_CLEARANCE of the ground, and none of
    // them stands further off it than CARVE_STAND_OFF. The ground is read as a
    // chunk reads it, off the grid anchored on the origin, without cutting
    // every chunk of the map.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const carve = carveOf(seed);
      const beds = bedsOf(seed);
      const natural = new Heightfield(w.terrain);
      const carved = { sample: (x: number, y: number): number => chunkGroundAt(carve, x, y) };
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };

      let points = 0;
      let standingOff = 0;
      // How far the ground beside a road stands off the road bed, before the
      // carve and after it, at every place the pair is measured.
      const wasLevel: number[] = [];
      const isLevel: number[] = [];
      for (const road of w.roads) {
        const structures = new Set([...road.bridges, ...road.tunnels]);
        for (let i = 0; i + 1 < road.points.length; i++) {
          const a = road.points[i] as Point;
          const b = road.points[i + 1] as Point;
          const where = `${road.tier} ${road.id} segment ${i}`;
          if (structures.has(i)) {
            // Nothing under a deck or over a bore is this road's to carve. Only
            // a long one is asked: the ground beside a short one is within reach
            // of the abutment or the portal at either end, which is on the
            // ground and does carve. The ground may still belong to another
            // road, one the deck flies over — or to another run of this same
            // road, where a hairpin brings it back under its own deck, and then
            // the ground under it really is a road bed.
            const reach = benchHalfWidth(road.tier) + CARVE_BLEND;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            if (
              Math.hypot(b.x - a.x, b.y - a.y) > 2 * reach &&
              carve.roadAt(mid.x, mid.y) === road.id &&
              !passesUnder(road, i, mid, reach)
            ) {
              fault(`${where} stands off the ground but carves it`);
            }
            continue;
          }
          // A point between two segments on the ground stands on the carved
          // ground. One beside a deck or a bore does not: the ground there is
          // the ground the road leaves, which is why it leaves it.
          if (i > 0 && !structures.has(i - 1)) {
            const stand = Math.abs(beds.pointHeight(road.id, i) - carved.sample(a.x, a.y));
            points++;
            if (stand > CARVE_CLEARANCE) standingOff++;
            if (stand > CARVE_STAND_OFF) fault(`${road.tier} ${road.id} point ${i} stands ${stand.toFixed(1)} m off the ground`);
          }
          // Level across the carriageway: the bed at the middle of the segment,
          // against the ground a few metres either side of it.
          const length = Math.hypot(b.x - a.x, b.y - a.y);
          if (length === 0 || i % LEVEL_STRIDE !== 0) continue;
          if (benchHalfWidth(road.tier) < LEVEL_AT + CHUNK_TERRAIN_CELL) continue;
          const bed = beds.heightAt(road.id, i, 0.5);
          const nx = (-(b.y - a.y) / length) * LEVEL_AT;
          const ny = ((b.x - a.x) / length) * LEVEL_AT;
          for (const side of [1, -1]) {
            const x = (a.x + b.x) / 2 + nx * side;
            const y = (a.y + b.y) / 2 + ny * side;
            wasLevel.push(Math.abs(natural.sample(x, y) - bed));
            isLevel.push(Math.abs(carved.sample(x, y) - bed));
          }
        }
      }

      if (points === 0) fault('has no road on the ground at all');
      if (standingOff > points * CARVE_STAND_OFF_SHARE) {
        fault(`leaves ${((standingOff / points) * 100).toFixed(1)} % of its road points more than ${CARVE_CLEARANCE} m off the ground`);
      }
      // The ground a few metres off a road is level with the road bed, and it
      // was not before: a road that took the hillside as it found it would come
      // back with the two numbers about equal.
      const before = percentile(wasLevel, LEVEL_PERCENTILE);
      const after = percentile(isLevel, LEVEL_PERCENTILE);
      if (after > LEVEL_WITHIN) fault(`leaves the ground ${LEVEL_AT} m off a road ${after.toFixed(2)} m off the road bed`);
      if (after * LEVEL_GAIN > before) fault(`levels the ground ${LEVEL_AT} m off a road from ${before.toFixed(2)} m to only ${after.toFixed(2)} m`);

      // Ground well clear of every road is the ground the world was given.
      const grid = new PointGrid(w.size, 40, w.roads);
      for (const p of landPoints(w, CLEAR_SAMPLES, 0xca4e)) {
        if (grid.nearest(p.x, p.y) < CLEAR_OF_ROADS) continue;
        if (carve.roadAt(p.x, p.y) !== -1) fault(`carves ground ${CLEAR_OF_ROADS} m clear of every road`);
        // The chunk grid samples the natural ground between the skeleton's own
        // samples, so the two agree to rounding rather than to the last bit.
        if (Math.abs(carved.sample(p.x, p.y) - natural.sample(p.x, p.y)) > 1e-6) {
          fault(`moves ground ${CLEAR_OF_ROADS} m clear of every road`);
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('gives every corridor a strip of ground that no other corridor stands on', () => {
    // Spec sections 1.1 and 6.3: a corridor claims its ground at the moment it
    // is laid, so two of them cannot share any. The claim makes that true; this
    // is what confirms it.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (let i = 0; i < w.corridors.length; i++) {
        const corridor = w.corridors[i] as Corridor;
        const where = `${corridor.kind} corridor ${i}`;
        if (corridor.id !== i) fault(`${where} is numbered ${corridor.id}`);
        if (corridor.points.length < 2) fault(`${where} has no centreline`);
        if (corridor.polygon.length < 4) fault(`${where} has no strip`);
        if (corridor.roads.length === 0) fault(`${where} runs along no road`);
        for (const road of corridor.roads) {
          if (w.roads[road] === undefined) fault(`${where} runs along road ${road}, which does not exist`);
        }
        // A ring wound anticlockwise, about as wide as the corridor says it is.
        const area = ringArea(corridor.polygon);
        if (area <= 0) fault(`${where} is wound the wrong way`);
        const length = polylineLength(corridor.points);
        if (Math.abs(area - 2 * corridor.halfWidth * length) > 0.2 * area) {
          fault(`${where} claims ${area.toFixed(0)} m², not the ${(2 * corridor.halfWidth * length).toFixed(0)} m² of its strip`);
        }
        // Nothing carries a deck from outside the ground under it.
        for (const foot of corridor.pillars) {
          if (!pointInRing(foot, corridor.polygon)) fault(`${where} stands a pillar outside its own ground`);
        }
        if (corridor.kind === 'tram' && corridor.pillars.length > 0) fault(`${where} stands on pillars`);
        for (let j = 0; j < i; j++) {
          const other = w.corridors[j] as Corridor;
          if (ringsOverlap(corridor.polygon, other.polygon)) fault(`${where} overlaps ${other.kind} corridor ${j}`);
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('claims a sane share of the land under the roads, with the blocks between them as holes', () => {
    // Spec section 6.4 steps 1 and 2: the footprint is every road offset by half
    // the width of its tier, the aprons over the junctions, and the corridor
    // strips. What it does not claim are the parcels, so its holes are the city
    // blocks and its share of the land is the share a city gives to its streets.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const footprint = footprintOf(seed);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      if (footprint.regions.length === 0) fault('claims no ground at all');
      let holes = 0;
      for (let i = 0; i < footprint.regions.length; i++) {
        const region = footprint.regions[i] as Region;
        const where = `piece ${i}`;
        if (region.outer.length < 3) fault(`${where} has no outline`);
        if (ringArea(region.outer) <= 0) fault(`${where} is wound the wrong way`);
        for (const hole of region.holes) {
          if (hole.length < 3) fault(`${where} has a hole with no outline`);
          if (ringArea(hole) >= 0) fault(`${where} has a hole wound the wrong way`);
          if (!pointInRing(hole[0] as Point, region.outer)) fault(`${where} has a hole outside it`);
          holes++;
        }
      }
      // The network is one connected thing (see the test above), so it encloses
      // every block of the city between its roads.
      if (holes < 20) fault(`encloses only ${holes} blocks`);
      const share = footprint.area / landArea(w);
      if (share <= MIN_FOOTPRINT_SHARE || share >= MAX_FOOTPRINT_SHARE) {
        fault(`claims ${(share * 100).toFixed(1)} % of the dry land`);
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('lays the footprint under every road on the ground, and nowhere a road does not run', () => {
    // Ground the roads stand on is claimed; water a deck spans is not, because
    // there is no ground under a deck over water; and ground well clear of every
    // road is left to the parcels.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const regions = footprintOf(seed).regions;
      const hf = new Heightfield(w.terrain);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      // Point in polygon costs a walk of the whole outline, so this samples the
      // network rather than walking every one of its hundred thousand segments.
      let step = 0;
      for (const road of w.roads) {
        for (let i = 0; i + 1 < road.points.length; i++) {
          if (step++ % SAMPLE_STRIDE !== 0) continue;
          const a = road.points[i] as Point;
          const b = road.points[i + 1] as Point;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const where = `${road.tier} ${road.id} segment ${i}`;
          if (road.tunnels.includes(i)) continue;
          if (road.bridges.includes(i)) {
            // A deck over land has the corridor under it, which is claimed; a
            // deck over water stands over no ground at all.
            if (wetFraction(hf, a, b, w.water.seaLevel) > 0.5 && pointInRegions(mid, regions)) {
              fault(`${where} claims the water it bridges`);
            }
            continue;
          }
          if (!pointInRegions(mid, regions)) fault(`${where} is on the ground but claims none`);
        }
      }
      const grid = new PointGrid(w.size, 40, w.roads);
      for (const p of landPoints(w, CLEAR_SAMPLES, 0xf007)) {
        if (grid.nearest(p.x, p.y) < CLEAR_OF_ROADS) continue;
        if (pointInRegions(p, regions)) fault(`claims ground ${CLEAR_OF_ROADS} m clear of every road`);
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('says what the ground under a car is made of, and where the nearest road is', () => {
    // Driving reads the ground through this and nothing else (spec section
    // 11.3): tarmac under a paved road, dirt under a dirt road, sand on a
    // beach and open ground everywhere else.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const surfaces = new SurfaceIndex(w);
      const paved = new PointGrid(
        w.size,
        40,
        w.roads.filter((road) => road.tier !== 'dirt'),
      );
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };

      let step = 0;
      for (const road of w.roads) {
        for (let i = 0; i + 1 < road.points.length; i++) {
          if (step++ % SAMPLE_STRIDE !== 0) continue;
          if (road.tunnels.includes(i) || road.bridges.includes(i)) continue;
          const a = road.points[i] as Point;
          const b = road.points[i + 1] as Point;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const surface = surfaces.at(mid.x, mid.y);
          const where = `${road.tier} ${road.id} segment ${i}`;
          if (surface !== 'asphalt' && surface !== 'dirt') fault(`${where} is ${surface}, not a road`);
          // A dirt road reads as dirt unless a paved road runs close enough to
          // claim the same ground, which is what a made-up junction is.
          if (road.tier === 'dirt' && surface !== 'dirt' && paved.nearest(mid.x, mid.y) > PAVED_CLEAR) {
            fault(`${where} is ${surface} with no paved road within ${PAVED_CLEAR} m`);
          }
        }
      }

      // Ground well clear of every road is open ground, unless it is a beach.
      const grid = new PointGrid(w.size, 40, w.roads);
      for (const p of landPoints(w, CLEAR_SAMPLES, 0x5a4d)) {
        if (grid.nearest(p.x, p.y) < CLEAR_OF_ROADS) continue;
        const surface = surfaces.at(p.x, p.y);
        if (surface === 'ground' || surface === 'sand') continue;
        fault(`ground ${CLEAR_OF_ROADS} m clear of every road reads as ${surface}`);
      }

      // The sand of a beach is sand, or the road that crosses it: a resort's
      // boardwalk, an island link and a seafront road all may, and the road
      // claims the ground where they do. What it is never is open ground.
      let sand = 0;
      let sampled = 0;
      for (const beach of w.beaches) {
        const points = Math.min(beach.shore.length, beach.back.length);
        for (let i = 0; i < points; i += BEACH_STRIDE) {
          const shore = beach.shore[i] as Point;
          const back = beach.back[i] as Point;
          const mid = { x: (shore.x + back.x) / 2, y: (shore.y + back.y) / 2 };
          // The dune line is offset off the waterline, so on a tight bend the
          // middle of the two can fall outside the sand they bound.
          if (!pointInRing(mid, beach.sand)) continue;
          sampled++;
          const surface = surfaces.at(mid.x, mid.y);
          if (surface === 'sand') sand++;
          else if (surface === 'ground') fault(`the sand of beach ${beach.id} reads as open ground`);
        }
      }
      if (sampled > 0 && sand < sampled * MIN_SAND_READ) {
        fault(`only ${sand} of ${sampled} places on the sand read as sand`);
      }

      // A session starts on the nearest road to the core, and every world has one.
      const place = nearestRoadPlace(w, w.core.x, w.core.y);
      if (place === undefined) fault('no road for a car to start on');
      else if (surfaces.at(place.x, place.y) === 'ground') fault('the nearest road place is not on a road');

      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('cuts the land the footprint leaves into parcels, each owned by one thing and each on a road', () => {
    // Spec section 6.4 steps 3 to 5: the parcels are the land less the roads,
    // the corridors and the water. Nothing is nudged apart afterwards, so no
    // parcel may stand on another one, on a road or on a corridor, and every
    // parcel has exactly one owner and a road to reach it by.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      const footprint = footprintOf(seed);
      const { parcels, area, land } = parcelsOf(seed);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };

      if (parcels.length < MIN_PARCELS) fault(`cuts only ${parcels.length} parcels`);
      for (let i = 0; i < parcels.length; i++) {
        const parcel = parcels[i] as Parcel;
        const where = `parcel ${i}`;
        if (parcel.id !== i) fault(`${where} is numbered ${parcel.id}`);
        if (!ASSIGNED_OWNERS.has(parcel.owner)) fault(`${where} is owned by a ${parcel.owner}`);
        // An owner comes in a size: a car park is the size of a car park in
        // every zone, however much ground the roads there leave.
        const most = ownerMaxArea(parcel.zone, parcel.owner);
        if (most !== undefined && parcel.area > most) {
          fault(`${where} is a ${parcel.owner} of ${parcel.area.toFixed(0)} m² in the ${parcel.zone}, over its ${most} m²`);
        }
        if (Math.abs(parcel.area - regionArea(parcel.region)) > 1e-6) fault(`${where} misreports its ground`);
        if (parcel.area <= 0) fault(`${where} owns no ground`);
        if (ringArea(parcel.region.outer) <= 0) fault(`${where} is wound the wrong way`);
        for (const hole of parcel.region.holes) {
          if (ringArea(hole) >= 0) fault(`${where} has a hole wound the wrong way`);
          if (!pointInRing(hole[0] as Point, parcel.region.outer)) fault(`${where} has a hole outside it`);
        }
        if (w.districts[parcel.district] === undefined) fault(`${where} is in district ${parcel.district}, which does not exist`);
        // Every parcel has a road along it: ground no road reaches is not a parcel.
        if (parcel.roads.length === 0) fault(`${where} stands on no road`);
        for (let k = 0; k < parcel.roads.length; k++) {
          const edge = parcel.roads[k] as number;
          if (graph.edges[edge] === undefined) fault(`${where} names edge ${edge}, which does not exist`);
          if (k > 0 && edge <= (parcel.roads[k - 1] as number)) fault(`${where} lists its roads out of order`);
        }
      }

      // The parcels are the land less the footprint. What is neither of the two
      // is land no road reaches, and there is never much of it.
      if (area > land) fault('the parcels cover more ground than there is land');
      const unreached = (land - area - footprint.area) / land;
      if (unreached > MAX_UNREACHED_SHARE) fault(`leaves ${(unreached * 100).toFixed(1)} % of the land neither road nor parcel`);

      // Nothing stands on anything else. Point in polygon over every parcel is
      // too dear to run over the whole map, so this asks about a spread of
      // places: on the roads, on the corridors, and out on the open ground.
      const index = new ParcelIndex(parcels);
      for (const p of landPoints(w, PARCEL_SAMPLES, 0x9a4c)) {
        const owners = index.at(p);
        if (owners.length > 1) fault(`parcels ${owners.join(' and ')} both claim the same ground`);
        if (owners.length === 1 && pointInRegions(p, footprint.regions)) {
          fault(`parcel ${owners[0] as number} stands on the ground the roads claim`);
        }
      }
      let step = 0;
      for (const road of w.roads) {
        for (let i = 0; i + 1 < road.points.length; i++) {
          if (step++ % SAMPLE_STRIDE !== 0) continue;
          if (road.bridges.includes(i) || road.tunnels.includes(i)) continue;
          const a = road.points[i] as Point;
          const b = road.points[i + 1] as Point;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const owners = index.at(mid);
          if (owners.length > 0) fault(`parcel ${owners[0] as number} stands on ${road.tier} ${road.id}`);
        }
      }
      for (const corridor of w.corridors) {
        // The middle of each run, not its ends: the end of a centreline stands
        // on the edge of its own strip, where inside and outside are the same
        // place and neither answer means anything.
        for (let i = 0; i + 1 < corridor.points.length; i++) {
          const a = corridor.points[i] as Point;
          const b = corridor.points[i + 1] as Point;
          const owners = index.at({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
          if (owners.length > 0) fault(`parcel ${owners[0] as number} stands on ${corridor.kind} corridor ${corridor.id}`);
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('lays every building on a lot inside its parcel, fronting a road that reaches it', () => {
    // Spec section 10.3: a parcel the zone gave to a building group carries a
    // row of buildings along its road frontage. A lot stands wholly inside its
    // parcel and no two lots of one parcel meet, so nothing is nudged apart
    // afterwards here either. Every lot fronts a road its parcel already lists,
    // and those are graph edges, so every building stands on the one road
    // network and can be driven to.
    const tally: Record<Zone, Partial<Record<BuildingKind, number>>> = {
      core: {},
      inner: {},
      industrial: {},
      suburban: {},
      outskirts: {},
      wilderness: {},
    };
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      const { parcels } = parcelsOf(seed);
      const { buildings } = buildingsOf(seed);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };

      if (buildings.length < MIN_BUILDINGS) fault(`lays only ${buildings.length} buildings`);
      /** The lots of each parcel, so the pairs of one parcel are checked and no others. */
      const lotsOn = new Map<number, Building[]>();
      for (let i = 0; i < buildings.length; i++) {
        const building = buildings[i] as Building;
        const where = `building ${i}`;
        if (building.id !== i) fault(`${where} is numbered ${building.id}`);
        const parcel = parcels[building.parcel];
        if (parcel === undefined) {
          fault(`${where} stands on parcel ${building.parcel}, which does not exist`);
          continue;
        }
        if (parcel.owner !== 'building') fault(`${where} stands on a ${parcel.owner} parcel`);
        if (building.district !== parcel.district || building.zone !== parcel.zone) {
          fault(`${where} disagrees with its parcel about where it stands`);
        }
        if (w.districts[building.district] === undefined) fault(`${where} is in district ${building.district}, which does not exist`);

        const spec = ZONE_LOTS[building.zone];
        if (building.lot.length !== 4) fault(`${where} has a lot of ${building.lot.length} corners`);
        if (ringArea(building.lot) <= 0) fault(`${where} has a lot wound the wrong way`);
        if (Math.abs(ringArea(building.lot) - building.area) > 1e-6) fault(`${where} misreports its lot`);
        if (building.width + 1e-6 < spec.minWidth || building.depth + 1e-6 < spec.minDepth) {
          fault(`${where} has a lot ${building.width.toFixed(1)} m by ${building.depth.toFixed(1)} m, under what its zone lays`);
        }
        // The kind fits the zone and the lot: a suburban parcel has no tower on
        // its table at all, and no lot carries a kind it is too small for.
        if (!ZONE_BUILDINGS[building.zone].some((entry) => entry.kind === building.kind)) {
          fault(`${where} is a ${building.kind}, which the ${building.zone} does not build`);
        }
        if (building.area + 1e-6 < MIN_LOT_AREA[building.kind]) {
          fault(`${where} is a ${building.kind} on ${building.area.toFixed(0)} m²`);
        }
        // The lot never leaves the parcel.
        for (const corner of building.lot) {
          if (!pointInRegion(corner, parcel.region)) fault(`${where} has a lot corner outside its parcel`);
        }
        // It fronts one of the roads the parcel runs along, and stands on the
        // ground that road claims, plus the setback its zone lays it at.
        if (!parcel.roads.includes(building.road)) {
          fault(`${where} fronts edge ${building.road}, which does not run along its parcel`);
        } else {
          const edge = graph.edges[building.road] as RoadEdge;
          const line = graph.edgePoints(building.road);
          const front = [building.lot[0] as Point, building.lot[1] as Point];
          const gap = Math.min(distanceToLine(front[0] as Point, line), distanceToLine(front[1] as Point, line));
          const reach = footprintHalfWidth(edge.tier) + FRONT_REACH + spec.setback + FRONT_SLACK;
          if (gap > reach) fault(`${where} stands ${gap.toFixed(1)} m from the ${edge.tier} it fronts`);
        }
        // The front is the middle of the lot's first edge, and it looks out of
        // the lot, across the frontage: the way it faces is the way from the
        // back of the lot to that edge.
        const front = middleOf([building.lot[0] as Point, building.lot[1] as Point]);
        const back = middleOf([building.lot[2] as Point, building.lot[3] as Point]);
        if (Math.hypot(front.x - building.front.x, front.y - building.front.y) > FRONT_DRIFT) {
          fault(`${where} puts its front somewhere other than the middle of its front edge`);
        }
        const facing = Math.atan2(front.y - back.y, front.x - back.x);
        const turned = Math.abs(Math.atan2(Math.sin(building.facing - facing), Math.cos(building.facing - facing)));
        if (turned > FACING_DRIFT) fault(`${where} faces ${turned.toFixed(2)} rad away from its own frontage`);

        const zoneTally = tally[building.zone];
        zoneTally[building.kind] = (zoneTally[building.kind] ?? 0) + 1;
        const known = lotsOn.get(building.parcel);
        if (known === undefined) lotsOn.set(building.parcel, [building]);
        else known.push(building);
      }

      for (const parcel of parcels) {
        const lots = lotsOn.get(parcel.id) ?? [];
        for (let i = 0; i < lots.length; i++) {
          for (let k = i + 1; k < lots.length; k++) {
            const a = lots[i] as Building;
            const b = lots[k] as Building;
            if (ringsOverlap(a.lot, b.lot)) fault(`buildings ${a.id} and ${b.id} share the ground of parcel ${parcel.id}`);
          }
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }

    // Spec section 8.2: the zone's character shows in what it builds. Pooled
    // over the seeds, because a zone of one seed can be a handful of buildings.
    for (const zone of ['core', 'inner', 'industrial', 'suburban', 'outskirts', 'wilderness'] as Zone[]) {
      const row = tally[zone];
      const kinds = ZONE_BUILDINGS[zone];
      let total = 0;
      for (const entry of kinds) total += row[entry.kind] ?? 0;
      if (total < MIN_KIND_SAMPLES) continue;
      const signature = SIGNATURE_KIND[zone];
      const share = (row[signature] ?? 0) / total;
      const spread = kinds.map((entry) => `${entry.kind} ${(((row[entry.kind] ?? 0) / total) * 100).toFixed(0)} %`).join(', ');
      expect(share, `${zone} of ${total} buildings: ${spread}`).toBeGreaterThanOrEqual(MIN_SIGNATURE_SHARE[zone]);
    }
  });

  it('cuts a block of chunks around the origin and a handful far from it', () => {
    // Spec section 9.1: a chunk holds the roads, the parcels and the heights
    // inside it, cut from the whole-map skeleton. Every metre of a curve and
    // every square metre of a parcel belongs to exactly one chunk, and two
    // neighbours meet on the same heights and hand a road over at one place.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const source = sourceOf(seed);
      const parcels = parcelsOf(seed).parcels;
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };

      const cut = new Map<string, WorldChunk>();
      for (const [cx, cy] of chunkKeys()) {
        const chunk = source.chunk(cx, cy);
        cut.set(`${cx}:${cy}`, chunk);
        const where = `chunk ${cx}, ${cy}`;
        if (chunk.seed !== seed) fault(`${where} carries seed ${chunk.seed}`);
        if (stableJson(chunk.bounds) !== stableJson(chunkBounds(cx, cy))) fault(`${where} covers the wrong ground`);
        if (chunk.terrain.heights.length !== chunk.terrain.gridSize ** 2) fault(`${where} is missing heights`);
        if (chunk.terrain.originX !== chunk.bounds.minX) fault(`${where} samples its heights from elsewhere`);

        for (const run of chunk.roads) {
          const road = w.roads[run.curve] as RoadCurve;
          const name = `${where}: run of ${road.tier} ${road.id}`;
          if (run.points.length < 2) fault(`${name} is a single point`);
          if (run.tier !== road.tier) fault(`${name} changes tier`);
          if (!insideBounds(run.points, chunk, CUT_SLACK)) fault(`${name} leaves the chunk`);
          // The run is the curve where it stands inside the chunk: only the
          // ends of it are cut, and the points between them are the curve's own.
          for (let k = 1; k + 1 < run.points.length; k++) {
            const mine = run.points[k] as Point;
            const theirs = road.points[run.from + k] as Point;
            if (theirs === undefined || mine.x !== theirs.x || mine.y !== theirs.y) fault(`${name} strays off it`);
          }
          for (let k = 0; k + 1 < run.points.length; k++) {
            const segment = run.from + k;
            if (run.bridges.includes(k) !== road.bridges.includes(segment)) fault(`${name} disagrees about its decks`);
            if (run.tunnels.includes(k) !== road.tunnels.includes(segment)) fault(`${name} disagrees about its bores`);
          }
        }

        for (const piece of chunk.parcels) {
          const parcel = parcels[piece.parcel] as Parcel | undefined;
          const name = `${where}: piece of parcel ${piece.parcel}`;
          if (parcel === undefined) {
            fault(`${name}, which does not exist`);
            continue;
          }
          if (piece.owner !== parcel.owner || piece.zone !== parcel.zone) fault(`${name} disowns it`);
          if (piece.district !== parcel.district) fault(`${name} stands in another district`);
          if (Math.abs(piece.area - regionArea(piece.region)) > 1e-6) fault(`${name} misreports its ground`);
          if (piece.area > parcel.area + CUT_SLACK * perimeterOf(piece.region)) fault(`${name} is bigger than the parcel`);
          if (ringArea(piece.region.outer) <= 0) fault(`${name} is wound the wrong way`);
          if (!insideBounds(piece.region.outer, chunk, CUT_SLACK)) fault(`${name} leaves the chunk`);
        }
      }

      const home = cut.get('0:0') as WorldChunk;
      if (home.roads.length === 0) fault('cuts no road into the chunk on the core');
      const far = cut.get(`${BEYOND_MAP[0]}:${BEYOND_MAP[1]}`) as WorldChunk;
      if (far.roads.length > 0 || far.parcels.length > 0) fault('finds a city past the edge of the map');

      // Two neighbours share an edge: the same heights along it, and the same
      // places where a road crosses it.
      for (let cx = -CHUNK_BLOCK; cx <= CHUNK_BLOCK; cx++) {
        for (let cy = -CHUNK_BLOCK; cy <= CHUNK_BLOCK; cy++) {
          const here = cut.get(`${cx}:${cy}`) as WorldChunk;
          const east = cut.get(`${cx + 1}:${cy}`);
          if (east === undefined) continue;
          const mine = new Heightfield(here.terrain);
          const theirs = new Heightfield(east.terrain);
          for (let iy = 0; iy < mine.gridSize; iy++) {
            if (theirs.at(0, iy) !== mine.at(mine.gridSize - 1, iy)) fault(`chunks ${cx} and ${cx + 1} disagree about the ground between them`);
          }
          const handed = handovers(here, w.roads, 'x', here.bounds.maxX);
          const taken = handovers(east, w.roads, 'x', east.bounds.minX);
          if (handed.join('|') !== taken.join('|')) fault(`chunk ${cx}, ${cy} hands a road over to ${cx + 1}, ${cy} nowhere it is taken`);
        }
      }

      // A place in the block belongs to the parcel the whole map gives it, cut
      // to the chunk that covers it and to no other.
      const index = new ParcelIndex(parcels);
      const step = ((2 * CHUNK_BLOCK + 1) * CHUNK_SIZE) / CHUNK_SAMPLES;
      const corner = -CHUNK_BLOCK * CHUNK_SIZE;
      for (let ix = 0; ix < CHUNK_SAMPLES; ix++) {
        for (let iy = 0; iy < CHUNK_SAMPLES; iy++) {
          const p = { x: corner + (ix + 0.5) * step, y: corner + (iy + 0.5) * step };
          const chunk = cut.get(`${Math.floor(p.x / CHUNK_SIZE)}:${Math.floor(p.y / CHUNK_SIZE)}`) as WorldChunk;
          const claims = chunk.parcels.filter((piece: ChunkParcel) => pointInRegions(p, [piece.region]));
          if (claims.length > 1) fault(`two pieces of chunk ${chunk.cx}, ${chunk.cy} claim the same ground`);
          const whole = index.at(p);
          if (claims.map((piece) => piece.parcel).join(',') === whole.join(',')) continue;
          // A place beside the edge of a parcel may fall on either side of it,
          // because the cut moves that edge by a fraction of a millimetre. Only
          // a place well inside or well outside the parcel says anything.
          const edge = Math.min(
            ...claims.map((piece) => distanceToBoundary(p, piece.region)),
            ...whole.map((id) => distanceToBoundary(p, (parcels[id] as Parcel).region)),
          );
          if (edge > BOUNDARY_SLACK) {
            fault(`chunk ${chunk.cx}, ${chunk.cy} gives ground the map gives to parcel ${whole.join(' and ') || 'nothing'}`);
          }
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('lofts the roads of a chunk inside the draw-call cap', () => {
    // Spec sections 9.2 and 10.2: a chunk's roads are batched by tier, so a
    // chunk costs a small fixed number of draws however many roads run through
    // it. The geometry itself is built on the chunks around the core, where the
    // tiers, the bends and the structures all appear, because a loft that comes
    // out inside out or full of NaN only shows on real ground.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const source = sourceOf(seed);
      const ribbons = new RoadRibbons(w.terrain, w.roads, junctionsOf(seed));
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };

      for (const [cx, cy] of chunkKeys()) {
        const calls = chunkDrawCalls(source.chunk(cx, cy));
        if (calls > CHUNK_DRAW_CALL_CAP) fault(`chunk ${cx}, ${cy} costs ${calls} draw calls`);
      }

      let carriageways = 0;
      for (const [cx, cy] of ROAD_MESH_CHUNKS) {
        const chunk = source.chunk(cx, cy);
        for (const tier of buildChunkRoads(chunk, ribbons, (x, y) => carveOf(seed).heightAt(x, y))) {
          const where = `chunk ${cx}, ${cy}: ${tier.tier}`;
          const section = roadSection(tier.tier);
          for (const part of partsOf(tier)) {
            const position = part.getAttribute('position');
            const normal = part.getAttribute('normal');
            for (let v = 0; v < position.count; v++) {
              if (!Number.isFinite(position.getX(v) + position.getY(v) + position.getZ(v))) {
                fault(`${where} places a vertex nowhere`);
              }
              const length = Math.hypot(normal.getX(v), normal.getY(v), normal.getZ(v));
              // A vertex two faces that cancel meet at has no normal at all;
              // everywhere else the normal is a unit vector.
              if (length > 1e-3 && Math.abs(length - 1) > 1e-3) fault(`${where} leaves a normal of ${length}`);
            }
          }
          // The carriageway is the span between the two kerbs, and it is lofted
          // face up: the camera looks down on a road, never through it. The
          // column it starts at is the last one at the left kerb, because a
          // tier with a pavement stands a kerb face there first.
          const half = -TIERS[tier.tier].width / 2;
          let kerb = 0;
          for (let i = 0; i < section.length; i++) if ((section[i] as SectionPoint).across === half) kerb = i;
          for (const { surfaces } of tier.runs) {
            for (const surface of surfaces) {
              const rows = surface.getAttribute('position').count / section.length;
              for (let row = 0; row + 1 < rows; row++) {
                const quad = quadOf(surface, section.length, row, kerb);
                // A mitre moves a corner along the road by up to MITRE_SHIFT,
                // so a quad shorter than that can reach past itself. A chunk
                // boundary leaves one wherever it cuts a segment just short of
                // a bend, and a sliver that size is below anything the camera
                // resolves.
                if (quad.along <= MITRE_SHIFT) continue;
                if (quad.up) carriageways++;
                else fault(`${where} lofts a carriageway the camera looks through`);
              }
            }
          }
          for (let i = 0; i < tier.markings.length; i++) {
            if (!Number.isFinite(tier.markings[i] as number)) fault(`${where} paints a line nowhere`);
          }
          for (const part of partsOf(tier)) part.dispose();
        }
      }
      if (carriageways === 0) fault('carries no carriageway at all');
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('lights the streets of a chunk once each, on the verge of the road they stand beside', () => {
    // Spec sections 10.5 and 13.4: a lamp is placed from the curve alone, at a
    // whole multiple of its tier's spacing from the start of it. So two chunks
    // that share a road place the same lamps and neither places one twice,
    // whichever of them the run was cut into.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const source = sourceOf(seed);
      const ribbons = new RoadRibbons(w.terrain, w.roads, junctionsOf(seed));
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };

      const seen = new Set<string>();
      let lit = 0;
      for (const [cx, cy] of chunkKeys()) {
        const chunk = source.chunk(cx, cy);
        for (const lamp of lampsIn(chunk, ribbons)) {
          lit++;
          const where = `${lamp.tier} lamp at ${lamp.x.toFixed(1)}, ${lamp.y.toFixed(1)}`;
          if (LAMP_BY_TIER[lamp.tier] === undefined) fault(`${where} stands on an unlit tier`);
          if (!Number.isFinite(lamp.height + lamp.headHeight + lamp.roadHeight)) {
            fault(`${where} stands nowhere`);
          }
          // The mast stands on the verge of its own road: off the carriageway,
          // and inside the ground that road claims.
          const across = Math.hypot(lamp.x - lamp.roadX, lamp.y - lamp.roadY);
          if (across <= TIERS[lamp.tier].width / 2) fault(`${where} stands on the carriageway`);
          if (across > footprintHalfWidth(lamp.tier)) fault(`${where} stands off the ground the road claims`);
          // The arm reaches toward the road, so the lantern hangs nearer its
          // middle than the mast stands.
          const head = Math.hypot(lamp.headX - lamp.roadX, lamp.headY - lamp.roadY);
          if (head >= across) fault(`${where} reaches its arm away from the road`);
          if (lamp.headHeight <= lamp.height) fault(`${where} hangs its lantern below its own foot`);

          const key = `${lamp.x.toFixed(3)},${lamp.y.toFixed(3)}`;
          if (seen.has(key)) fault(`${where} is placed twice`);
          seen.add(key);
          if (complaint !== undefined) break;
        }
        if (complaint !== undefined) break;
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
      expect(lit, `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it('builds every building of a chunk on its own lot', () => {
    // Spec section 10.3: a building stands on the ground its lot claims and
    // never on the road beside it. The lot is already inside the parcel and the
    // parcel is what the road footprint left, so this is the last link of the
    // chain — and the one that is fitted rather than laid out, because a
    // generated facade overhangs whatever footprint it is given.
    for (const seed of seeds.slice(0, BUILDING_MESH_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const source = sourceOf(seed);
      const lookup = buildingLookup(w, source.layers);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      let built = 0;
      // One chunk of the core is enough: it is where the towers stand, and
      // building the geometry of a whole map would cost more than the world.
      const [cx, cy] = ROAD_MESH_CHUNKS[0] as [number, number];
      for (const one of buildChunkBuildings(source.chunk(cx, cy), lookup)) {
        built++;
        const where = `${one.building.kind} ${one.building.id}`;
        const position = one.shell.getAttribute('position');
        const at = new Vector3();
        for (let v = 0; v < position.count; v++) {
          at.fromBufferAttribute(position as BufferAttribute, v).applyMatrix4(one.matrix);
          if (!Number.isFinite(at.x + at.y + at.z)) fault(`${where} places a vertex nowhere`);
          else if (!pointInRing({ x: at.x, y: at.z }, one.building.lot)) fault(`${where} stands off its lot`);
          if (complaint !== undefined) break;
        }
        one.shell.dispose();
        one.hull?.dispose();
        if (complaint !== undefined) break;
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
      expect(built, `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it('plants every chunk on the ground its parcels leave, off the roads and off the lots', () => {
    // Spec section 10.4: placement is by parcel polygon, so no plant reaches
    // over a road or over a building. The whole rim of a canopy is checked, not
    // just the point the plant stands on, because it is the canopy that
    // overhangs and the trunk never does.
    for (const seed of seeds.slice(0, VEGETATION_COUNT)) {
      const parcels = parcelsOf(seed).parcels;
      const index = new ParcelIndex(parcels);
      const lots = new Map<number, Point[][]>();
      for (const building of buildingsOf(seed).buildings) {
        const here = lots.get(building.parcel);
        if (here === undefined) lots.set(building.parcel, [building.lot]);
        else here.push(building.lot);
      }
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      let planted = 0;
      for (const [cx, cy] of VEGETATION_CHUNKS) {
        const chunk = sourceOf(seed).chunk(cx, cy);
        planted += chunk.plants.length;
        for (const plant of chunk.plants) {
          const where = `${plant.species} at ${plant.at.x.toFixed(1)}, ${plant.at.y.toFixed(1)}`;
          const bounds = chunk.bounds;
          if (plant.at.x < bounds.minX || plant.at.x >= bounds.maxX || plant.at.y < bounds.minY || plant.at.y >= bounds.maxY) {
            fault(`${where} stands outside the chunk that carries it`);
          }
          if (plant.radius !== PLANT_RADIUS[plant.species]) fault(`${where} claims ${plant.radius} m of canopy`);
          if (plant.radius > MAX_PLANT_RADIUS) fault(`${where} claims more canopy than a cell has room for`);
          const parcel = parcels[plant.parcel];
          if (parcel === undefined) {
            fault(`${where} stands on parcel ${plant.parcel}, which does not exist`);
            break;
          }
          const mix = mixFor(parcel.owner, parcel.zone);
          if (mix === undefined) fault(`${where} stands on a ${parcel.owner} parcel, which plants nothing`);
          else if (!mix.species.some((entry) => entry.kind === plant.species)) {
            fault(`${where} is not planted in the ${parcel.zone} on a ${parcel.owner} parcel`);
          }
          if (complaint !== undefined) break;
        }

        // The whole canopy of a sample of them: every point of the rim stands
        // on the same parcel, and none of it over a lot of that parcel.
        const step = Math.max(1, Math.floor(chunk.plants.length / VEGETATION_SAMPLES));
        for (let i = 0; i < chunk.plants.length && complaint === undefined; i += step) {
          const plant = chunk.plants[i] as Plant;
          const where = `${plant.species} at ${plant.at.x.toFixed(1)}, ${plant.at.y.toFixed(1)}`;
          // The rim is pulled in by the slack the cut allows, so a canopy that
          // ends exactly on the boundary is not read as crossing it.
          const reach = plant.radius - BOUNDARY_SLACK;
          for (let k = 0; k < CANOPY_POINTS; k++) {
            const angle = (k / CANOPY_POINTS) * Math.PI * 2;
            const at = { x: plant.at.x + Math.cos(angle) * reach, y: plant.at.y + Math.sin(angle) * reach };
            if (!index.at(at).includes(plant.parcel)) fault(`${where} reaches off its own parcel`);
            for (const lot of lots.get(plant.parcel) ?? []) {
              if (pointInRing(at, lot)) fault(`${where} reaches over a building on its parcel`);
            }
            if (complaint !== undefined) break;
          }
        }

        // No two canopies share any ground. `vegetation.ts` makes that
        // unrepresentable; this is the check on a whole map of it.
        for (let i = 0; i < chunk.plants.length && complaint === undefined; i++) {
          for (let j = i + 1; j < chunk.plants.length; j++) {
            const a = chunk.plants[i] as Plant;
            const b = chunk.plants[j] as Plant;
            const apart = Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y);
            if (apart + 1e-9 < a.radius + b.radius) {
              fault(`two canopies overlap at ${a.at.x.toFixed(1)}, ${a.at.y.toFixed(1)}`);
              break;
            }
          }
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
      expect(planted, `seed ${seed}`).toBeGreaterThan(MIN_PLANTS);
    }
  });

  it('cuts a chunk in isolation exactly as it cuts it with every neighbour loaded', () => {
    // Spec section 3 and section 9.1: a chunk is the same whether it is cut on
    // its own or after the whole block around it. The isolated side stands on a
    // world the pool generated a second time and on the layers that worker
    // built for it, so this is the byte-identical check of a chunk as well.
    for (const seed of seeds.slice(0, ISOLATED_COUNT)) {
      const loaded = sourceOf(seed);
      for (const [cx, cy] of chunkKeys()) loaded.chunk(cx, cy);
      const world = repeats.get(seed) as WorldDescription;
      const parts = repeatParts.get(seed) as WorldParts;
      const aloneGraph = buildRoadGraph(world.roads);
      const aloneJunctions = buildJunctions(world.roads, aloneGraph);
      const aloneBuildings = parts.buildings;
      const alone = new ChunkSource(world, {
        graph: aloneGraph,
        junctions: aloneJunctions,
        footprint: parts.footprint,
        parcels: parts.parcels,
        buildings: aloneBuildings,
        carve: buildCarve(world.terrain, world.roads, aloneJunctions),
        vegetation: new Vegetation(world.seed, parts.parcels, aloneBuildings),
      });
      // The far chunk first, before this source has cut anything at all.
      for (const [cx, cy] of [...chunkKeys()].reverse()) {
        expect(stableJson(alone.chunk(cx, cy)), `seed ${seed}: chunk ${cx}, ${cy}`).toBe(
          stableJson(loaded.chunk(cx, cy)),
        );
      }
    }
  });

  it('runs the tram round one loop of arterials, calling at the core and inner districts', () => {
    // Spec section 13.2: a fixed loop with stops and level crossings. Every
    // stop is a district of the core or the inner ring, the line only uses
    // roads that allow trams, and it comes back to where it started.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const tram = w.tram;
      expect(tram.stops.length, `seed ${seed}: the tram calls nowhere`).toBeGreaterThanOrEqual(3);
      expect(tram.route.length, `seed ${seed}`).toBeGreaterThan(1);
      expect(tram.length, `seed ${seed}`).toBeGreaterThan(0);

      const head = tram.route[0] as Point;
      const tail = tram.route[tram.route.length - 1] as Point;
      expect(Math.hypot(head.x - tail.x, head.y - tail.y), `seed ${seed}: the loop does not close`).toBeLessThan(1e-6);

      const zones = new Set(['core', 'inner']);
      for (const stop of tram.stops) {
        const district = w.districts[stop.district] as (typeof w.districts)[number];
        expect(zones.has(district.zone), `seed ${seed}: stop ${stop.id} serves the ${district.zone}`).toBe(true);
      }
      // No district waits at two stops, and no stop stands on top of another.
      expect(new Set(tram.stops.map((s) => s.district)).size).toBe(tram.stops.length);

      for (const id of tram.corridors) {
        const corridor = w.corridors[id] as Corridor;
        expect(corridor.kind, `seed ${seed}: corridor ${id}`).toBe('tram');
        for (const road of corridor.roads) {
          expect(TIERS[(w.roads[road] as RoadCurve).tier].traffic.trams, `seed ${seed}: road ${road}`).toBe(true);
        }
      }
      for (const crossing of tram.crossings) {
        expect(crossing.roads.length, `seed ${seed}: a level crossing with no road`).toBeGreaterThan(0);
        for (const road of crossing.roads) expect(w.roads[road], `seed ${seed}`).toBeDefined();
      }
    }
  });

  it('gives every seed a beach outside the core with a boardwalk, a pier and car parks', () => {
    // Spec section 7.3: gentle coast becomes beach, steep coast stays cliff and
    // the harbour stays quay. At least one long beach lies outside the core,
    // with a boardwalk street along its back and a pier out over the water.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const zones = layoutZones(w.size, w.core, w.water);
      const sea = w.water.seaLevel;
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };

      for (let i = 0; i < w.beaches.length; i++) {
        const beach = w.beaches[i] as Beach;
        const where = `beach ${i}`;
        if (beach.id !== i) fault(`${where} is numbered ${beach.id}`);
        if (beach.shore.length < 2) fault(`${where} has no waterline`);
        if (beach.back.length !== beach.shore.length) fault(`${where} has a dune line of a different length`);
        if (beach.length < MIN_BEACH) fault(`${where} is only ${beach.length.toFixed(0)} m of coast`);
        if (Math.abs(beach.length - polylineLength(beach.shore)) > 1e-6) fault(`${where} misreports its length`);
        if (ringArea(beach.sand) <= 0) fault(`${where} has its sand wound the wrong way`);
        if (ringArea(beach.shallows) <= 0) fault(`${where} has its shallows wound the wrong way`);

        for (let k = 0; k < beach.shore.length; k += BEACH_STRIDE) {
          const p = beach.shore[k] as Point;
          const back = beach.back[k] as Point;
          const at = `${where} at ${k}`;
          // The dune line stands inland of the waterline, on dry ground: that
          // is the whole of what says which way is inland here.
          const sand = Math.hypot(back.x - p.x, back.y - p.y);
          if (sand < MIN_SAND - 1e-6) fault(`${at} has only ${sand.toFixed(1)} m of sand`);
          if (hf.sample(back.x, back.y) <= sea) fault(`${at} has its dune line under water`);
          // The coast is gentle, which is what made it a beach: the ground
          // stands above the sea a beach's reach inland, but not far above it.
          const nx = (back.x - p.x) / sand;
          const ny = (back.y - p.y) / sand;
          const rise = hf.sample(p.x + nx * BEACH_REACH, p.y + ny * BEACH_REACH) - sea;
          if (rise <= 0) fault(`${at} has water behind it`);
          if (rise > BEACH_RISE) fault(`${at} stands below a cliff`);
          // The harbour is quay and the river mouth is bank, never beach.
          const harbour = Math.hypot(p.x - w.water.harbour.x, p.y - w.water.harbour.y);
          if (harbour < w.water.harbour.radius) fault(`${at} is inside the harbour`);
        }

        if (isResort(beach)) {
          if (beach.boardwalk.length !== beach.shore.length) fault(`${where} has a boardwalk line of a different length`);
          if (beach.carParks.length === 0) fault(`${where} is a resort with nowhere to park`);
        } else {
          if (beach.boardwalk.length > 0) fault(`${where} is no resort but carries a boardwalk line`);
          if (beach.pier !== undefined) fault(`${where} is no resort but carries a pier`);
          if (beach.carParks.length > 0) fault(`${where} is no resort but carries a car park`);
          if (beach.boardwalkRoad >= 0) fault(`${where} is no resort but names a boardwalk road`);
        }
        if (beach.boardwalkRoad >= 0) {
          const road = w.roads[beach.boardwalkRoad];
          if (road === undefined) fault(`${where} names a boardwalk road that does not exist`);
          else if (road.tier !== 'street') fault(`${where} has a boardwalk that is a ${road.tier}`);
          else {
            const cover = coverOf(road.points, beach.boardwalk);
            if (cover < MIN_BOARDWALK) fault(`${where} has a boardwalk along only ${cover.toFixed(0)} m of its back`);
          }
        }
        const pier = beach.pier;
        if (pier !== undefined) {
          if (hf.sample(pier.head.x, pier.head.y) >= sea) fault(`${where} has a pier that ends on dry land`);
          if (Math.hypot(pier.head.x - pier.root.x, pier.head.y - pier.root.y) < MIN_PIER) {
            fault(`${where} has a pier that hardly leaves the shore`);
          }
          if (ringArea(pier.polygon) <= 0) fault(`${where} has its pier wound the wrong way`);
        }
      }

      // The one spec section 7.3 asks for: a long beach outside the core, with
      // the boardwalk laid and the pier built.
      const served = w.beaches.filter(
        (b) => isResort(b) && b.boardwalkRoad >= 0 && b.pier !== undefined && zoneAt(zones, (b.shore[0] as Point).x, (b.shore[0] as Point).y) !== 'core',
      );
      const longest = Math.max(0, ...served.map((b) => b.length));
      if (longest < GUARANTEED_BEACH) {
        fault(`has no beach outside the core with a boardwalk and a pier longer than ${longest.toFixed(0)} m`);
      }
      // The districts along it are the beach neighbourhood of spec section 8.3.
      if (!w.districts.some((d) => d.culture === 'beach')) fault('has no beach neighbourhood');
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('keeps the roads off the sand and cuts the sand into parcels the beach owns', () => {
    // Spec section 7.3 with spec section 6.4: the sand is claimed once, as
    // parcels. The boardwalk runs behind the dune line, so the ground between
    // it and the sea belongs to the beach and to no road.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const footprint = footprintOf(seed);
      const parcels = parcelsOf(seed).parcels;
      const index = new ParcelIndex(parcels);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };

      // A beach parcel is a piece of one beach's sand, so every corner of it
      // stands within a beach's width of a waterline. Asking whether its middle
      // is inside the sand would not do: a strip that follows a bay is a
      // crescent, and the middle of a crescent is outside it.
      const waterline: Point[] = w.beaches.flatMap((b) => b.shore);
      for (const parcel of parcels) {
        if (parcel.owner !== 'beach') continue;
        for (let k = 0; k < parcel.region.outer.length; k += SAMPLE_STRIDE) {
          const p = parcel.region.outer[k] as Point;
          let near = Infinity;
          for (const q of waterline) near = Math.min(near, Math.hypot(q.x - p.x, q.y - p.y));
          if (near > MAX_SAND + SHORE_STEP) fault(`parcel ${parcel.id} is a beach ${near.toFixed(0)} m from any waterline`);
        }
      }

      // The guaranteed beach: what the roads left of its sand is the beach's
      // own parcels, and there is enough of it left to be a beach. A through
      // route may still cross a beach — an island link has to reach its bridge
      // head, and a seafront boulevard is a real road — so the sand a road took
      // is not counted against the rest.
      const beach = [...w.beaches].filter((b) => isResort(b) && b.boardwalkRoad >= 0).sort((a, b) => b.length - a.length)[0];
      if (beach === undefined) {
        fault('has no resort with a boardwalk');
      } else {
        let free = 0;
        let owned = 0;
        for (let k = 0; k < beach.shore.length; k += BEACH_STRIDE) {
          const p = beach.shore[k] as Point;
          const back = beach.back[k] as Point;
          // Halfway between the waterline and the dune line, which is sand
          // wherever the beach has any width at all.
          const at = { x: (p.x + back.x) / 2, y: (p.y + back.y) / 2 };
          if (pointInRegions(at, footprint.regions)) continue;
          free++;
          const owners = index.at(at);
          if (owners.length === 1 && (parcels[owners[0] as number] as Parcel).owner === 'beach') owned++;
        }
        if (owned < free * MIN_SAND_OWNED) fault(`leaves ${free - owned} of ${free} free places on its beach unclaimed`);
        if (owned < MIN_SAND_PLACES) fault(`has only ${owned} places of beach parcel on its longest beach`);
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('places every district on land in its own zone with the named neighbourhoods present', () => {
    const required = ['Little Italy', 'Chinatown', 'The Blocks', 'The Barrio', 'The Docks', 'Freight Yards', 'Gull Island', 'The Boardwalk', 'Roadhouse Strip'];
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const zones = layoutZones(w.size, w.core, w.water);
      const land = new LandMasses(hf, w.water.islands, w.water.seaLevel + 1);
      const names = new Set(w.districts.map((d) => d.name));
      for (const r of required) expect(names.has(r), `${r} in seed ${seed}`).toBe(true);
      expect(names.size, `duplicate district name in seed ${seed}`).toBe(w.districts.length);
      for (const d of w.districts) {
        expect(hf.sample(d.x, d.y)).toBeGreaterThanOrEqual(w.water.seaLevel);
        // The land it stands on carries an island of the water description, so
        // a crossing leads there and the roads can arrive. A rock in the sea
        // would take a district that could never be reached or built.
        expect(land.carriesIsland(d.x, d.y), `seed ${seed}: ${d.name} stands on land no island site is on`).toBe(true);
        if (d.name !== 'Gull Island') expect(zoneAt(zones, d.x, d.y)).toBe(d.zone);
        expect(d.density).toBeGreaterThanOrEqual(0);
        expect(d.density).toBeLessThanOrEqual(1);
        expect(d.wealth).toBeGreaterThanOrEqual(0);
        expect(d.wealth).toBeLessThanOrEqual(1);
      }
    }
  });
});
