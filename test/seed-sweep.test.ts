import { describe, expect, it } from 'vitest';
import { hashInts } from '../src/core/hash.ts';
import { layoutZones, zoneAt } from '../src/world/districts.ts';
import { buildRoadGraph, type GradeCrossing, type RoadEdge, type RoadGraph, type RoadNode } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { MAX_WORLD_SIZE, MIN_WORLD_SIZE } from '../src/world/size.ts';
import { coastNoise, islandAt, TERRAIN_CELL } from '../src/world/terrain.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Point, RoadCurve, RoadTier, WorldDescription, Zone } from '../src/world/types.ts';
import { generateWorld } from '../src/world/world.ts';
import { BUDGET_MS } from './budgets.ts';
import { stableJson, sweepSeeds } from './helpers.ts';

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

/** Quick tier by default; CI and `npm run test:full` set SWEEP_SEEDS=200 (spec section 3). */
const SEED_COUNT = Number(process.env.SWEEP_SEEDS ?? 20);
/**
 * Seeds the byte-identical check generates a second time. Generating a world is
 * the most expensive thing this file does, so the quick tier repeats only a few.
 */
const REPEAT_COUNT = SEED_COUNT > 20 ? 20 : 6;

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

function seaFraction(world: WorldDescription): number {
  const h = world.terrain.heights;
  let wet = 0;
  for (let i = 0; i < h.length; i++) if ((h[i] as number) < world.water.seaLevel) wet++;
  return wet / h.length;
}

describe(`seed sweep (${SEED_COUNT} seeds)`, () => {
  const seeds = sweepSeeds(SEED_COUNT);
  const worlds = new Map<number, WorldDescription>();
  const timings: number[] = [];
  /** The graph of a seed, built once however many tests ask about it. */
  const graphs = new Map<number, RoadGraph>();
  const graphOf = (seed: number): RoadGraph => {
    const known = graphs.get(seed);
    if (known !== undefined) return known;
    const built = buildRoadGraph((worlds.get(seed) as WorldDescription).roads);
    graphs.set(seed, built);
    return built;
  };

  it('generates every seed within budget', () => {
    for (const seed of seeds) {
      const t0 = performance.now();
      worlds.set(seed, generateWorld(seed));
      timings.push(performance.now() - t0);
    }
    const worst = Math.max(...timings);
    expect(worst, `${worst.toFixed(0)} ms worst`).toBeLessThan(BUDGET_MS.worldGenWorst);
  });

  it('is byte-identical across runs', () => {
    for (const seed of seeds.slice(0, REPEAT_COUNT)) {
      const a = worlds.get(seed) as WorldDescription;
      const b = generateWorld(seed);
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
      for (const isl of w.water.islands) expect(hf.sample(isl.x, isl.y), `island ${isl.id} seed ${seed}`).toBeGreaterThan(w.water.seaLevel);
      // Union-find over crossings: one connected archipelago.
      const parent = w.water.islands.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)));
      for (const c of w.water.crossings) {
        const { from, to } = c;
        expect(hf.sample(from.x, from.y)).toBeGreaterThanOrEqual(w.water.seaLevel);
        expect(hf.sample(to.x, to.y)).toBeGreaterThanOrEqual(w.water.seaLevel);
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

  it('places every district on land in its own zone with the named neighbourhoods present', () => {
    const required = ['Little Italy', 'Chinatown', 'The Blocks', 'The Barrio', 'The Docks', 'Freight Yards', 'Gull Island', 'The Boardwalk', 'Roadhouse Strip'];
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const zones = layoutZones(w.size, w.core, w.water);
      const names = new Set(w.districts.map((d) => d.name));
      for (const r of required) expect(names.has(r), `${r} in seed ${seed}`).toBe(true);
      expect(names.size, `duplicate district name in seed ${seed}`).toBe(w.districts.length);
      for (const d of w.districts) {
        expect(hf.sample(d.x, d.y)).toBeGreaterThanOrEqual(w.water.seaLevel);
        if (d.name !== 'Gull Island') expect(zoneAt(zones, d.x, d.y)).toBe(d.zone);
        expect(d.density).toBeGreaterThanOrEqual(0);
        expect(d.density).toBeLessThanOrEqual(1);
        expect(d.wealth).toBeGreaterThanOrEqual(0);
        expect(d.wealth).toBeLessThanOrEqual(1);
      }
    }
  });
});
