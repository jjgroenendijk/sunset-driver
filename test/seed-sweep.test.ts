import { beforeAll, describe, expect, it } from 'vitest';
import { hashInts } from '../src/core/hash.ts';
import { compareNumbers } from '../src/core/sort.ts';
import { pointInRegions, regionArea, type Region } from '../src/core/geom.ts';
import { CHUNK_GRID, CHUNK_SIZE, chunkBounds, chunkOf, ChunkSource } from '../src/world/chunk.ts';
import { layoutZones, zoneAt } from '../src/world/districts.ts';
import type { RoadFootprint } from '../src/world/footprint.ts';
import { buildRoadGraph, type GradeCrossing, type RoadEdge, type RoadGraph, type RoadNode } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { LandMasses } from '../src/world/landmass.ts';
import type { Parcel, ParcelMap, ParcelOwner } from '../src/world/parcels.ts';
import { MAX_WORLD_SIZE, MIN_WORLD_SIZE } from '../src/world/size.ts';
import { coastNoise, islandAt, TERRAIN_CELL } from '../src/world/terrain.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Corridor, Point, RoadCurve, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';
import { landPoints, pointInRing, ringArea, ringsOverlap, stableJson, sweepSeeds } from './helpers.ts';
import { buildWorlds, type PooledWorld, type WorldJob } from './world-pool.ts';

/** Metres between the samples that ask whether a road segment is over water. */
const WET_SAMPLE = 5;
/** Metres a bridge head may stand from the crossing's own shore point. */
const BRIDGE_TOLERANCE = 150;

/** A road point as a key, so two curves that share a point share a string. */
function pointKey(p: Point): string {
  return `${Math.round(p.x * 1000)}:${Math.round(p.y * 1000)}`;
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

/** True when the segment spans the crossing, either way round. */
function spansCrossing(a: Point, b: Point, from: Point, to: Point): boolean {
  const near = Math.max(Math.hypot(a.x - from.x, a.y - from.y), Math.hypot(b.x - to.x, b.y - to.y));
  const flipped = Math.max(Math.hypot(a.x - to.x, a.y - to.y), Math.hypot(b.x - from.x, b.y - from.y));
  return Math.min(near, flipped) <= BRIDGE_TOLERANCE;
}

/**
 * Quick tier by default; CI and `npm run test:full` set SWEEP_SEEDS=200 (spec
 * section 3). The quick tier takes the seeds that fit in its 15 s, and the
 * full tier is the coverage.
 */
const SEED_COUNT = Number(process.env.SWEEP_SEEDS ?? 8);
/**
 * Seeds the byte-identical check generates a second time. Generating a world is
 * the most expensive thing this file does, so the quick tier repeats only a few.
 */
const REPEAT_COUNT = SEED_COUNT > 20 ? 20 : 3;
/**
 * Seeds the road footprint is laid and the parcels are cut for. Laying one
 * unions the polygons of a whole network, so both tiers do a few seeds rather
 * than all of them. The pool does that work, next to the world it belongs to.
 */
const FOOTPRINT_COUNT = SEED_COUNT > 20 ? 16 : 4;
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
 * The owners spec section 6.4 step 4 names that are handed out today. The beach
 * rules of spec section 7.3, a body of water inside the land, and the ground
 * under an elevated deck all come later; until then no parcel carries them.
 */
const ASSIGNED_OWNERS = new Set<ParcelOwner>(['building', 'park', 'car-park', 'plaza', 'ground']);

/**
 * The chunks every seed is asked for (spec section 3): the block of nine around
 * the origin, where the core stands, and four at fixed far offsets. The smallest
 * map a seed may draw is 3 km, so it reaches six chunks from the origin, and the
 * far offsets stay inside that.
 */
const CHUNK_BLOCK: { cx: number; cy: number }[] = [];
for (let cy = -1; cy <= 1; cy++) for (let cx = -1; cx <= 1; cx++) CHUNK_BLOCK.push({ cx, cy });
for (const far of [{ cx: 5, cy: 0 }, { cx: 0, cy: -5 }, { cx: -5, cy: 4 }, { cx: 4, cy: -5 }]) CHUNK_BLOCK.push(far);

/** Probes across one side of a chunk that ask the terrain slice for a height. */
const SLICE_PROBES = 4;
/**
 * Seeds whose chunks are cut a second time from a second generation of the same
 * world. That second world needs its own footprint and its own parcels, so the
 * pool cuts them for these seeds as well; the quick tier repeats one.
 */
const CHUNK_REPEAT_COUNT = SEED_COUNT > 20 ? 4 : 1;

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

  /** Metres to the nearest road point, ignoring one curve. Infinity when there is none. */
  nearest(x: number, y: number, except = -1): number {
    const cx = this.column(x);
    const cy = this.column(y);
    for (let ring = 1; ring <= this.n; ring++) {
      let best = Infinity;
      for (let iy = Math.max(0, cy - ring); iy <= Math.min(this.n - 1, cy + ring); iy++) {
        for (let ix = Math.max(0, cx - ring); ix <= Math.min(this.n - 1, cx + ring); ix++) {
          for (const e of this.buckets.get(iy * this.n + ix) ?? []) {
            if (e.curve === except) continue;
            best = Math.min(best, Math.hypot(e.p.x - x, e.p.y - y));
          }
        }
      }
      // Only trust the answer once the rings searched cover it.
      if (best < (ring - 1) * this.cell) return best;
    }
    return Infinity;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
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
  /** The parcels of the second generation of a seed, cut by the pool likewise. */
  const repeatParcels = new Map<number, ParcelMap>();
  /** The whole-map skeleton of a seed indexed by chunk, over the parcels already cut. */
  const sourceOf = (seed: number): ChunkSource =>
    new ChunkSource(worlds.get(seed) as WorldDescription, parcelsOf(seed).parcels);
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
    // Every seed once, and the repeated seeds a second time: the pool runs the
    // two rounds together so the byte-identical checks cost no extra wait. The
    // jobs that ask for parts are three times the work of a plain world, so all
    // of them are handed out first, whichever round they belong to: a worker
    // that starts one late holds up the rest. What a seed costs is measured in
    // `budget.test.ts`, on a quiet machine.
    const repeated = seeds.slice(0, REPEAT_COUNT);
    const jobs: WorldJob[] = [];
    /** Where in the pool's answers each seed's world landed, by round. */
    const firstAt: number[] = [];
    const againAt: number[] = [];
    const ask = (seed: number, parts: boolean): number => {
      jobs.push({ seed, parts });
      return jobs.length - 1;
    };
    for (let i = 0; i < FOOTPRINT_COUNT; i++) firstAt[i] = ask(seeds[i] as number, true);
    for (let i = 0; i < CHUNK_REPEAT_COUNT; i++) againAt[i] = ask(repeated[i] as number, true);
    for (let i = FOOTPRINT_COUNT; i < seeds.length; i++) firstAt[i] = ask(seeds[i] as number, false);
    for (let i = CHUNK_REPEAT_COUNT; i < repeated.length; i++) againAt[i] = ask(repeated[i] as number, false);

    const generated = await buildWorlds(jobs);
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i] as number;
      const built = generated[firstAt[i] as number] as PooledWorld;
      worlds.set(seed, built.world);
      if (built.parts !== undefined) {
        footprints.set(seed, built.parts.footprint);
        parcelMaps.set(seed, built.parts.parcels);
      }
    }
    for (let i = 0; i < repeated.length; i++) {
      const seed = repeated[i] as number;
      const built = generated[againAt[i] as number] as PooledWorld;
      repeats.set(seed, built.world);
      if (built.parts !== undefined) repeatParcels.set(seed, built.parts.parcels);
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
      const parent = w.roads.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)));
      const owner = new Map<string, number>();
      for (let i = 0; i < w.roads.length; i++) {
        const road = w.roads[i] as RoadCurve;
        expect(road.id).toBe(i);
        expect(road.points.length).toBeGreaterThanOrEqual(2);
        for (const at of road.bridges) expect(at).toBeLessThan(road.points.length - 1);
        for (const p of road.points) {
          const key = pointKey(p);
          const met = owner.get(key);
          if (met === undefined) owner.set(key, i);
          else parent[find(met)] = find(i);
        }
      }
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
      const covered = new Uint8Array(w.roads.length);
      for (const edge of graph.edges) covered[edge.curve] = 1;
      for (const road of w.roads) expect(covered[road.id], `seed ${seed}: curve ${road.id} has no edge`).toBe(1);
      for (const node of graph.nodes) expect(graph.degree(node.id), `seed ${seed}: node ${node.id}`).toBeGreaterThan(0);

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
        expect(edge.from, `seed ${seed}: route breaks at edge ${edge.id}`).toBe(taken.nodes[i]);
        expect(edge.to).toBe(taken.nodes[i + 1]);
      }

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
      const met = new Map<string, { road: RoadCurve; at: number }[]>();
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
      const shared = new Map<string, number>();
      for (const road of w.roads) {
        for (const p of road.points) {
          const key = pointKey(p);
          shared.set(key, (shared.get(key) ?? 0) + 1);
        }
      }
      for (const road of w.roads) {
        const cap = CAP[road.tier];
        if (cap === undefined) continue;
        for (const end of [road.points[0] as Point, road.points[road.points.length - 1] as Point]) {
          if ((shared.get(pointKey(end)) ?? 0) > 1) continue;
          const away = grid.nearest(end.x, end.y, road.id);
          expect(away, `seed ${seed}: ${road.tier} ${road.id} dead-ends ${away.toFixed(0)} m from any road`).toBeLessThanOrEqual(cap);
        }
      }
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

  it('cuts a block of chunks around the origin and a few at far offsets', () => {
    // Spec sections 3 and 9.1. A chunk holds the roads, the parcels and the
    // heights inside it, all cut from the whole-map skeleton. The slice of the
    // heightfield answers what the whole map answers, so the ground of two
    // neighbouring chunks meets on the boundary they share.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const source = sourceOf(seed);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (const at of CHUNK_BLOCK) {
        const chunk = source.chunk(at.cx, at.cy);
        const bounds = chunkBounds(at.cx, at.cy);
        const where = `chunk ${at.cx},${at.cy}`;
        if (chunk.seed !== seed) fault(`${where} says it is of seed ${chunk.seed}`);
        if (chunk.cx !== at.cx || chunk.cy !== at.cy) fault(`${where} says it is chunk ${chunk.cx},${chunk.cy}`);
        if (chunk.minX !== bounds.minX || chunk.minY !== bounds.minY) fault(`${where} puts its corner elsewhere`);

        // The slice reaches a cell past the chunk on every side, and inside the
        // chunk it gives the height the whole map gives, to the bit.
        const slice = new Heightfield(chunk.terrain);
        if (slice.gridSize !== CHUNK_GRID) fault(`${where} slices a ${slice.gridSize}-sample grid`);
        if (slice.cellSize !== hf.cellSize) fault(`${where} slices the ground at another spacing`);
        if (slice.originX > bounds.minX - slice.cellSize) fault(`${where} slices no margin west of itself`);
        if (slice.originY > bounds.minY - slice.cellSize) fault(`${where} slices no margin south of itself`);
        if (slice.worldX(slice.gridSize - 1) < bounds.maxX + slice.cellSize) fault(`${where} slices no margin east of itself`);
        if (slice.worldY(slice.gridSize - 1) < bounds.maxY + slice.cellSize) fault(`${where} slices no margin north of itself`);
        for (let iy = 0; iy <= SLICE_PROBES; iy++) {
          for (let ix = 0; ix <= SLICE_PROBES; ix++) {
            const x = bounds.minX + (CHUNK_SIZE * ix) / SLICE_PROBES;
            const y = bounds.minY + (CHUNK_SIZE * iy) / SLICE_PROBES;
            if (slice.sample(x, y) !== hf.sample(x, y)) fault(`${where} slices another height at ${x},${y}`);
          }
        }

        // Every run is a piece of its curve, and every segment of it stands in
        // this chunk and nowhere else.
        let last = { curve: -1, end: -1 };
        for (const run of chunk.roads) {
          const road = w.roads[run.curve];
          if (road === undefined) {
            fault(`${where} holds a run of curve ${run.curve}, which does not exist`);
            continue;
          }
          const label = `${where}: run ${run.start}..${run.end} of ${road.tier} ${run.curve}`;
          if (run.curve < last.curve || (run.curve === last.curve && run.start <= last.end)) {
            fault(`${label} is listed after the run of curve ${last.curve} that ends at ${last.end}`);
          }
          last = { curve: run.curve, end: run.end };
          if (run.tier !== road.tier) fault(`${label} calls itself a ${run.tier}`);
          if (run.start < 0 || run.end <= run.start || run.end >= road.points.length) fault(`${label} is not a run of the curve`);
          if (run.points.length !== run.end - run.start + 1) fault(`${label} carries ${run.points.length} points`);
          for (let i = 0; i < run.points.length; i++) {
            const mine = run.points[i] as Point;
            const theirs = road.points[run.start + i] as Point;
            if (mine.x !== theirs.x || mine.y !== theirs.y) fault(`${label} moved point ${i}`);
          }
          for (let i = 0; i + 1 < run.points.length; i++) {
            const a = run.points[i] as Point;
            const b = run.points[i + 1] as Point;
            const holder = chunkOf((a.x + b.x) / 2, (a.y + b.y) / 2);
            if (holder.cx !== at.cx || holder.cy !== at.cy) fault(`${label} holds segment ${i}, which stands in chunk ${holder.cx},${holder.cy}`);
          }
          for (const marks of [
            { name: 'deck', run: run.bridges, curve: road.bridges },
            { name: 'bore', run: run.tunnels, curve: road.tunnels },
          ]) {
            for (let k = 0; k < marks.run.length; k++) {
              const i = marks.run[k] as number;
              if (k > 0 && i <= (marks.run[k - 1] as number)) fault(`${label} lists its ${marks.name}s out of order`);
              if (i < 0 || i + 1 >= run.points.length) fault(`${label} puts a ${marks.name} past its end at ${i}`);
              if (!marks.curve.includes(run.start + i)) fault(`${label} marks a ${marks.name} the curve does not`);
            }
          }
        }

        // A parcel belongs to the chunk its centre stands in, whole.
        for (const parcel of chunk.parcels) {
          const holder = chunkOf(parcel.at.x, parcel.at.y);
          if (holder.cx !== at.cx || holder.cy !== at.cy) fault(`${where} holds parcel ${parcel.id}, centred in chunk ${holder.cx},${holder.cy}`);
          if (source.parcels[parcel.id] !== parcel) fault(`${where} holds a parcel that is not parcel ${parcel.id} of the map`);
        }
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('puts every road segment and every parcel of a map in exactly one chunk', () => {
    // The chunks tile the map, so the runs of all of them together are the road
    // network drawn once, and every parcel is generated by one chunk and no other.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const source = sourceOf(seed);
      // One chunk past the map each way, so a segment or a centre that has
      // strayed outside it is counted rather than quietly missed. The map is
      // square, so one edge is every edge.
      const edge = chunkOf(w.size / 2, w.size / 2).cx + 1;
      let segments = 0;
      const held = new Uint8Array(parcelsOf(seed).parcels.length);
      let twice = 0;
      for (let cy = -edge; cy <= edge; cy++) {
        for (let cx = -edge; cx <= edge; cx++) {
          const chunk = source.chunk(cx, cy);
          for (const run of chunk.roads) segments += run.end - run.start;
          for (const parcel of chunk.parcels) {
            if (held[parcel.id] === 1) twice++;
            held[parcel.id] = 1;
          }
        }
      }
      let laid = 0;
      for (const road of w.roads) laid += road.points.length - 1;
      expect(segments, `seed ${seed}: the chunks hold ${segments} of the map's ${laid} road segments`).toBe(laid);
      expect(twice, `seed ${seed}: ${twice} parcels are held by two chunks`).toBe(0);
      let missing = 0;
      for (let i = 0; i < held.length; i++) if (held[i] === 0) missing++;
      expect(missing, `seed ${seed}: ${missing} parcels are held by no chunk`).toBe(0);
    }
  });

  it('cuts a chunk on its own identical to the same chunk cut after its neighbours', () => {
    // Spec sections 3 and 9.1: a chunk's contents do not depend on which of its
    // neighbours are loaded. Cutting is a pure function of the map and the
    // coordinates, so the order the chunks are asked for cannot matter — one
    // index is asked for the block forwards, another backwards, and a third for
    // the middle chunk and nothing else at all.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const forwards = sourceOf(seed);
      const backwards = sourceOf(seed);
      const cut = new Map<string, string>();
      for (const at of CHUNK_BLOCK) cut.set(`${at.cx},${at.cy}`, stableJson(forwards.chunk(at.cx, at.cy)));
      for (let i = CHUNK_BLOCK.length - 1; i >= 0; i--) {
        const at = CHUNK_BLOCK[i] as { cx: number; cy: number };
        const where = `seed ${seed}: chunk ${at.cx},${at.cy}`;
        expect(stableJson(backwards.chunk(at.cx, at.cy)), `${where} cut in the other order`).toBe(cut.get(`${at.cx},${at.cy}`));
      }
      // The middle of the block, from an index that has been asked nothing else.
      expect(stableJson(sourceOf(seed).chunk(0, 0)), `seed ${seed}: chunk 0,0 cut alone`).toBe(cut.get('0,0'));
    }
  });

  it('cuts identical chunks from two generations of the same seed', () => {
    // The world is byte-identical across runs (see the first test), and so is
    // everything cut from it: the second generation gets its own footprint and
    // its own parcels from the pool, and its chunks match the first to the byte.
    for (const seed of seeds.slice(0, CHUNK_REPEAT_COUNT)) {
      const again = repeats.get(seed) as WorldDescription;
      const source = new ChunkSource(again, (repeatParcels.get(seed) as ParcelMap).parcels);
      const first = sourceOf(seed);
      for (const at of CHUNK_BLOCK) {
        expect(stableJson(source.chunk(at.cx, at.cy)), `seed ${seed}: chunk ${at.cx},${at.cy} of the second run`).toBe(
          stableJson(first.chunk(at.cx, at.cy)),
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
