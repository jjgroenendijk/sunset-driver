/**
 * Major roads: highways and arterials, traced as streamlines of the tensor
 * field (spec sections 6.1 and 6.2).
 *
 * Highways go down first. Two of them cross at the core, one along the field's
 * major direction and one along its minor direction, and a few more branch off
 * those at right angles. A highway is a pure streamline: it bends with the
 * terrain and runs along the shore because the field does, not because anything
 * steers it.
 *
 * Arterials come second and have somewhere to be: first the islands that carry
 * a district, then the districts themselves. They follow the field too, but
 * their heading is blended with the bearing to their target, so they arrive
 * instead of wandering off. A trace that cannot get through — a bay in the way,
 * the field turning it back — is retried as a route over land cells. That is
 * the reroute of spec section 6.1.
 *
 * Two invariants hold by construction, and the seed sweep checks them:
 *
 * - Every curve starts on an existing road, ends on one, or merges into one, so
 *   the whole network is a single connected component. A trace that reaches
 *   neither is dropped rather than left dangling.
 * - No segment passes over water unless it is a bridge, and a bridge only ever
 *   spans one of the water description's strait crossings.
 *
 * Streets, alleys and dirt roads fill the space between these curves later.
 */
import { clamp, dist, directionDelta, wrapAngle } from '../core/math.ts';
import type { Noise2D } from '../core/noise.ts';
import { layoutZones, zoneAt } from './districts.ts';
import { Heightfield } from './heightfield.ts';
import { coastNoise, islandAt } from './terrain.ts';
import type { TensorField } from './tensor.ts';
import type { Island, Point, RoadCurve, RoadTier, WorldSkeleton } from './types.ts';

/** Metres a road needs above sea level; the waterline itself is not road-worthy ground. */
const DRY_MARGIN = 0.8;
/** Metres between the wetness samples that vet one step. */
const WET_SAMPLE = 4;
/** How close to the map edge a road may run, in metres. */
const EDGE_MARGIN = 80;
/** Steps of the fan a step searches when water blocks the way, and the hardest turn water may force. */
const AVOID_STEPS = 6;
const AVOID_TURNS = 3;
/** Steps without getting closer to the target before a guided trace gives up. */
const STALL_STEPS = 12;
/** Metres of highway before it may merge into another one; both cross at the core. */
const HIGHWAY_MERGE_AFTER = 400;
/** Fractions of a highway's length where a branch highway leaves it. */
const BRANCH_AT = [0.3, 0.7];
/** A highway shorter than this fraction of the map is not worth keeping. */
const MIN_HIGHWAY = 0.25;
/** Metres from a road within which a district counts as already served. */
const SERVED = 130;
/** Spacing between arterials, as a fraction of the world side. */
const ARTERIAL_SPACING = 0.05;
/** How many arterials deep the fill grows from the highways, and how many it may lay in all. */
const FILL_GENERATIONS = 4;
const FILL_LIMIT = 400;
/** Steps an arterial must run before it may merge into a road other than its parent. */
const MIN_MERGE_STEPS = 4;
/** Metres a bridge head may be moved inland from the crossing's shore point. */
const ANCHOR_REACH = 100;

/** How each tier traces. */
interface TierParams {
  /** Metres per traced step. */
  step: number;
  /** Radians the heading may turn in one step. */
  maxTurn: number;
  /** How much of the field's deflection from the bearing a guided trace keeps, in [0, 1]. */
  fieldWeight: number;
  /** Metres within which the trace joins a road that is already there. */
  mergeRadius: number;
  /** Longest curve, as a fraction of the world side. */
  maxLength: number;
}

const HIGHWAY: TierParams = { step: 30, maxTurn: 0.09, fieldWeight: 1, mergeRadius: 110, maxLength: 1.3 };
const ARTERIAL: TierParams = { step: 22, maxTurn: 0.17, fieldWeight: 0.75, mergeRadius: 80, maxLength: 0.8 };

interface TraceOptions {
  params: TierParams;
  /** Where the trace is headed. Without one it is a pure streamline. */
  target?: Point;
  /** Follow the field's cross direction rather than its major one. */
  minor?: boolean;
  /** Heading of the first step; without one the field decides. */
  heading?: number;
  /** Metres of curve before a merge is allowed. */
  mergeAfter?: number;
  /** The road this one branched off, which it may only rejoin after `parentMergeAfter` metres. */
  parentCurve?: number;
  parentMergeAfter?: number;
  /** Ground the road may not leave: the fill stays inside the built-up zones. */
  within?: (x: number, y: number) => boolean;
}

interface TraceResult {
  points: Point[];
  /** Ended on an existing road. */
  merged: boolean;
  /** Ended at the target. */
  arrived: boolean;
}

/** Where the fill should try to lay its next arterial. */
interface FillSeed {
  x: number;
  y: number;
  /** Direction of the road that seeded this one; the new road runs parallel to it. */
  along: number;
  /** Curve the seed came from, which the new road may not immediately rejoin. */
  parent: number;
  /** How many arterials removed from the highways this one is. */
  depth: number;
  /** True when the seed sits on its parent, so the road it grows is joined to the network from its first point. */
  onParent: boolean;
}

/** A point of the network already laid, and the island it stands on. */
interface NetworkHit {
  x: number;
  y: number;
  curve: number;
}

/**
 * Every road point in a uniform grid of buckets, so "is there already a road
 * here?" costs a handful of comparisons rather than a walk over the network.
 */
class RoadIndex {
  private readonly cell: number;
  private readonly n: number;
  private readonly origin: number;
  private readonly buckets: number[][] = [];
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly curves: number[] = [];
  private readonly islands: number[] = [];
  private readonly islandOf: (x: number, y: number) => number;

  constructor(size: number, cell: number, islandOf: (x: number, y: number) => number) {
    this.cell = cell;
    this.origin = -size / 2 - 2 * cell;
    this.n = Math.ceil((size + 4 * cell) / cell) + 1;
    this.islandOf = islandOf;
    for (let i = 0; i < this.n * this.n; i++) this.buckets.push([]);
  }

  private column(v: number): number {
    return clamp(Math.floor((v - this.origin) / this.cell), 0, this.n - 1);
  }

  add(curve: number, points: readonly Point[]): void {
    for (const p of points) {
      const i = this.xs.length;
      this.xs.push(p.x);
      this.ys.push(p.y);
      this.curves.push(curve);
      this.islands.push(this.islandOf(p.x, p.y));
      (this.buckets[this.column(p.y) * this.n + this.column(p.x)] as number[]).push(i);
    }
  }

  get empty(): boolean {
    return this.xs.length === 0;
  }

  /**
   * The nearest road point within `radius`, which must not exceed the bucket
   * size. One curve can be left out, which is how a road ignores the road it
   * branched off.
   */
  nearest(x: number, y: number, radius: number, except = -1): NetworkHit | undefined {
    const cx = this.column(x);
    const cy = this.column(y);
    let best: NetworkHit | undefined;
    let bestD = radius;
    for (let iy = Math.max(0, cy - 1); iy <= Math.min(this.n - 1, cy + 1); iy++) {
      for (let ix = Math.max(0, cx - 1); ix <= Math.min(this.n - 1, cx + 1); ix++) {
        for (const i of this.buckets[iy * this.n + ix] as number[]) {
          if (this.curves[i] === except) continue;
          const d = dist(x, y, this.xs[i] as number, this.ys[i] as number);
          if (d > bestD) continue;
          bestD = d;
          best = { x: this.xs[i] as number, y: this.ys[i] as number, curve: this.curves[i] as number };
        }
      }
    }
    return best;
  }

  /** The nearest road point standing on one island, at any distance. */
  nearestOnIsland(x: number, y: number, island: number): NetworkHit | undefined {
    let best: NetworkHit | undefined;
    let bestD = Infinity;
    for (let i = 0; i < this.xs.length; i++) {
      if (this.islands[i] !== island) continue;
      const d = dist(x, y, this.xs[i] as number, this.ys[i] as number);
      if (d >= bestD) continue;
      bestD = d;
      best = { x: this.xs[i] as number, y: this.ys[i] as number, curve: this.curves[i] as number };
    }
    return best;
  }
}

/** Trace the highways and arterials of a world. Pure: same world and field, same roads. */
export function traceMajorRoads(world: WorldSkeleton, field: TensorField): RoadCurve[] {
  return new RoadTracer(world, field).build();
}

class RoadTracer {
  private readonly world: WorldSkeleton;
  private readonly field: TensorField;
  private readonly hf: Heightfield;
  private readonly seaLevel: number;
  private readonly size: number;
  /** Half the map, less the margin roads keep from the edge. */
  private readonly half: number;
  private readonly index: RoadIndex;
  /** The coastline's own noise, so a point can be told which island's land it stands on. */
  private readonly noise: Noise2D;
  private readonly curves: RoadCurve[] = [];
  /** Dry land, one flag per terrain node: the grid a rerouted road walks. */
  private readonly land: Uint8Array;
  /** Scratch for the reroute search, kept between routes so it is allocated once. */
  private readonly came: Int32Array;
  private readonly queue: Int32Array;

  constructor(world: WorldSkeleton, field: TensorField) {
    this.world = world;
    this.field = field;
    this.hf = new Heightfield(world.terrain);
    this.seaLevel = world.water.seaLevel;
    this.size = world.size;
    this.half = world.size / 2 - EDGE_MARGIN;
    this.noise = coastNoise(world.seed);
    this.index = new RoadIndex(world.size, world.size * ARTERIAL_SPACING, (x, y) => this.islandOf(x, y));
    const n = this.hf.gridSize;
    this.land = new Uint8Array(n * n);
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const inside = Math.abs(this.hf.worldX(ix)) <= this.half && Math.abs(this.hf.worldY(iy)) <= this.half;
        this.land[iy * n + ix] = inside && this.hf.at(ix, iy) >= this.seaLevel + DRY_MARGIN ? 1 : 0;
      }
    }
    this.came = new Int32Array(n * n);
    this.queue = new Int32Array(n * n);
  }

  /** Which island's land a point stands on. */
  private islandOf(x: number, y: number): number {
    return islandAt(this.world.water.islands, this.size, this.noise, x, y);
  }

  build(): RoadCurve[] {
    this.traceHighways();
    this.linkIslands();
    this.fillArterials();
    this.serveDistricts();
    return this.curves;
  }

  // ---------------------------------------------------------------- highways

  /** Two highways crossing at the core, plus a branch off each arm of them. */
  private traceHighways(): void {
    const core = this.world.core;
    const trunks = [this.streamline(core, false), this.streamline(core, true)];
    for (let i = 0; i < trunks.length; i++) {
      const trunk = trunks[i];
      if (trunk === undefined) continue;
      for (const at of branchPoints(trunk.points, BRANCH_AT)) this.streamline(at, i === 0);
    }
  }

  /** One highway: the field line through a point, followed both ways. */
  private streamline(at: Point, minor: boolean): RoadCurve | undefined {
    const line = this.fieldLine(at, minor);
    const opt: TraceOptions = { params: HIGHWAY, minor, mergeAfter: HIGHWAY_MERGE_AFTER };
    const forward = this.trace(at, { ...opt, heading: line });
    const backward = this.trace(at, { ...opt, heading: line + Math.PI });
    backward.points.reverse();
    const points = [...backward.points.slice(0, -1), ...forward.points];
    if (polylineLength(points) < MIN_HIGHWAY * this.size) return undefined;
    return this.addCurve('highway', points, []);
  }

  // ----------------------------------------------------------------- islands

  /**
   * Bridge out to every island that carries a district, over the strait
   * crossings of the water description. Islands are linked outward from the
   * main one, so each bridge lands on ground the network has already reached.
   */
  private linkIslands(): void {
    const islands = this.world.water.islands;
    const crossings = this.world.water.crossings;
    const count = islands.length;
    const indexOfId = (id: number): number => {
      for (let i = 0; i < count; i++) if ((islands[i] as Island).id === id) return i;
      return -1;
    };
    const endsOf = (ci: number): [number, number] => {
      const c = crossings[ci];
      if (c === undefined) return [-1, -1];
      return [indexOfId(c.fromIsland), indexOfId(c.toIsland)];
    };

    let mainIsland = 0;
    for (let i = 0; i < count; i++) if ((islands[i] as Island).main) mainIsland = i;

    // Breadth-first over the crossings: the parent of an island is the crossing
    // that first reached it, so following parents always leads back to the main island.
    const parent = new Int32Array(count).fill(-1);
    const seen = new Uint8Array(count);
    const order: number[] = [];
    const queue: number[] = [mainIsland];
    seen[mainIsland] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const from = queue[qi] as number;
      for (let ci = 0; ci < crossings.length; ci++) {
        const [a, b] = endsOf(ci);
        const other = a === from ? b : b === from ? a : -1;
        if (other < 0 || seen[other] === 1) continue;
        seen[other] = 1;
        parent[other] = ci;
        order.push(other);
        queue.push(other);
      }
    }

    // Only the islands a district stands on are worth a bridge, and with them
    // every island on the way there.
    const needed = new Uint8Array(count);
    for (const d of this.world.districts) {
      let i = this.islandOf(d.x, d.y);
      while (i !== mainIsland && i >= 0 && needed[i] === 0) {
        needed[i] = 1;
        const ci = parent[i] as number;
        if (ci < 0) break;
        const [a, b] = endsOf(ci);
        i = a === i ? b : a;
      }
    }

    for (const island of order) {
      if (needed[island] === 1) this.linkIsland(island, parent[island] as number);
    }
  }

  /**
   * One bridge and its approaches: network → near shore → deck → far shore →
   * the island's nearest district. Which end of the crossing is the near one is
   * decided by trying both: the near end is the one that can reach the roads
   * already laid.
   */
  private linkIsland(island: number, crossingIndex: number): void {
    const crossing = this.world.water.crossings[crossingIndex];
    if (crossing === undefined) return;
    for (const flip of [false, true]) {
      const nearShore = flip ? crossing.to : crossing.from;
      const farShore = flip ? crossing.from : crossing.to;
      const near = this.dryAnchor(nearShore, farShore);
      const far = this.dryAnchor(farShore, nearShore);
      if (near === undefined || far === undefined) continue;
      const approach = this.routeToNetwork(near, this.islandOf(near.x, near.y));
      if (approach === undefined) continue;
      approach.reverse();
      const landing = this.landOnIsland(far, island);
      this.addCurve('arterial', [...approach, ...landing], [approach.length - 1]);
      return;
    }
  }

  /** The far side of a bridge, carried on to the nearest district of the island it reached. */
  private landOnIsland(far: Point, island: number): Point[] {
    let site: Point | undefined;
    let bestD = Infinity;
    for (const d of this.world.districts) {
      if (this.islandOf(d.x, d.y) !== island) continue;
      const dd = dist(far.x, far.y, d.x, d.y);
      if (dd >= bestD) continue;
      bestD = dd;
      site = { x: d.x, y: d.y };
    }
    if (site === undefined) return [far];
    return this.routeTo(far, site, island) ?? [far];
  }

  // ------------------------------------------------------------------- fill

  /**
   * Arterials between the highways: streamlines seeded one spacing off the roads
   * already laid, running parallel to them, generation after generation until
   * the built-up zones are covered. Each one is kept only if it joins the
   * network, so the fill can never leave an arterial dangling.
   */
  private fillArterials(): void {
    const zones = layoutZones(this.size, this.world.core, this.world.water);
    const within = (x: number, y: number): boolean => zoneAt(zones, x, y) !== 'wilderness';
    const spacing = this.size * ARTERIAL_SPACING;
    const seeds: FillSeed[] = [];
    for (const curve of this.curves) seedAlong(curve, spacing, 0, seeds);
    let laid = 0;
    for (let i = 0; i < seeds.length && laid < FILL_LIMIT; i++) {
      const seed = seeds[i] as FillSeed;
      if (!within(seed.x, seed.y) || !this.isDry(seed.x, seed.y)) continue;
      // Somewhere already covered: a road within half a spacing, other than the parent.
      if (this.index.nearest(seed.x, seed.y, spacing * 0.5, seed.parent) !== undefined) continue;
      const curve = this.fillRoad(seed, spacing, within);
      if (curve === undefined) continue;
      laid++;
      if (seed.depth + 1 < FILL_GENERATIONS) seedAlong(curve, spacing, seed.depth + 1, seeds);
    }
  }

  /** One fill arterial, traced both ways along the field line it was seeded with. */
  private fillRoad(seed: FillSeed, spacing: number, within: (x: number, y: number) => boolean): RoadCurve | undefined {
    const major = this.field.majorAt(seed.x, seed.y);
    const minor = directionDelta(major, seed.along) > Math.PI / 4;
    const line = alignTo(minor ? major + Math.PI / 2 : major, seed.along);
    const opt: TraceOptions = {
      params: ARTERIAL,
      minor,
      within,
      mergeAfter: ARTERIAL.step * MIN_MERGE_STEPS,
      parentCurve: seed.parent,
      parentMergeAfter: spacing,
    };
    const forward = this.trace({ x: seed.x, y: seed.y }, { ...opt, heading: line });
    const backward = this.trace({ x: seed.x, y: seed.y }, { ...opt, heading: line + Math.PI });
    // A road that starts beside the network has to find its way back to it.
    if (!seed.onParent && !forward.merged && !backward.merged) return undefined;
    backward.points.reverse();
    const points = [...backward.points.slice(0, -1), ...forward.points];
    if (polylineLength(points) < spacing * 0.5) return undefined;
    return this.addCurve('arterial', points, []);
  }

  // --------------------------------------------------------------- districts

  /** An arterial from every built-up district to the nearest road, worked from the core outward. */
  private serveDistricts(): void {
    const core = this.world.core;
    const sites = this.world.districts
      .filter((d) => d.zone !== 'wilderness')
      .map((d) => ({ id: d.id, x: d.x, y: d.y, d: dist(core.x, core.y, d.x, d.y) }))
      .sort((a, b) => a.d - b.d || a.id - b.id);
    for (const site of sites) {
      if (!this.isDry(site.x, site.y)) continue;
      if (this.index.nearest(site.x, site.y, SERVED) !== undefined) continue;
      const island = this.islandOf(site.x, site.y);
      const route = this.routeToNetwork({ x: site.x, y: site.y }, island);
      if (route !== undefined) this.addCurve('arterial', route, []);
    }
  }

  // ------------------------------------------------------------------ routes

  /** An arterial from a point to the network on its own island: streamline first, reroute second. */
  private routeToNetwork(from: Point, island: number): Point[] | undefined {
    const target = this.index.nearestOnIsland(from.x, from.y, island);
    if (target !== undefined) {
      const traced = this.trace(from, { params: ARTERIAL, target, mergeAfter: 0 });
      if (traced.merged || traced.arrived) return traced.points;
    }
    if (this.index.empty) return undefined;
    return this.reroute(from, (x, y) => {
      const hit = this.index.nearest(x, y, ARTERIAL.mergeRadius);
      return hit !== undefined && this.isDryPath(x, y, hit.x, hit.y) ? hit : undefined;
    });
  }

  /** An arterial from a point to a place: streamline first, reroute second. */
  private routeTo(from: Point, target: Point, island: number): Point[] | undefined {
    const traced = this.trace(from, { params: ARTERIAL, target, mergeAfter: 0 });
    if (traced.merged || traced.arrived) return traced.points;
    const goalIx = this.node(target.x);
    const goalIy = this.node(target.y);
    const route = this.reroute(from, (x, y, ix, iy) =>
      ix === goalIx && iy === goalIy ? { x: target.x, y: target.y } : undefined,
    );
    if (route !== undefined) return route;
    // The island is worth reaching even when its district is not reachable: keep
    // the streamline that got furthest, as long as it stayed on this island.
    const last = traced.points[traced.points.length - 1] as Point;
    return this.islandOf(last.x, last.y) === island && traced.points.length > 1 ? traced.points : undefined;
  }

  // ------------------------------------------------------------------- trace

  /**
   * Follow the field from a point until the road merges, arrives, runs out of
   * land or runs out of length.
   */
  private trace(start: Point, opt: TraceOptions): TraceResult {
    const params = opt.params;
    const maxLength = params.maxLength * this.size;
    const mergeAfter = opt.mergeAfter ?? 0;
    const arrive = params.step * 1.5;
    const points: Point[] = [{ x: start.x, y: start.y }];
    let px = start.x;
    let py = start.y;
    let heading = opt.heading ?? this.startHeading(start, opt);
    let length = 0;
    let merged = false;
    let arrived = false;
    let closest = opt.target === undefined ? 0 : dist(px, py, opt.target.x, opt.target.y);
    let stalled = 0;

    while (length < maxLength) {
      const wanted = this.desiredHeading(px, py, heading, opt);
      const next = this.stepHeading(px, py, heading, wanted, params);
      if (next === undefined) break;
      const qx = px + Math.cos(next) * params.step;
      const qy = py + Math.sin(next) * params.step;
      if (Math.abs(qx) > this.half || Math.abs(qy) > this.half) break;
      if (opt.within !== undefined && !opt.within(qx, qy)) break;

      // A road joins any other road on close approach, but only rejoins the one
      // it branched off after it has gone somewhere.
      const parent = opt.parentCurve ?? -1;
      let hit = length >= mergeAfter ? this.index.nearest(qx, qy, params.mergeRadius, parent) : undefined;
      if (hit === undefined && parent >= 0 && length >= (opt.parentMergeAfter ?? mergeAfter)) {
        hit = this.index.nearest(qx, qy, params.mergeRadius);
      }
      if (hit !== undefined && this.isDryPath(px, py, hit.x, hit.y)) {
        points.push({ x: hit.x, y: hit.y });
        merged = true;
        break;
      }
      if (foldsBack(points, qx, qy, params.step)) break;

      points.push({ x: qx, y: qy });
      length += params.step;
      heading = next;
      px = qx;
      py = qy;

      const target = opt.target;
      if (target === undefined) continue;
      const d = dist(px, py, target.x, target.y);
      if (d <= arrive) {
        // Only an arrival that can be driven counts: a last step over water is
        // no arrival, and the caller reroutes instead.
        if (!this.isDryPath(px, py, target.x, target.y)) break;
        points.push({ x: target.x, y: target.y });
        arrived = true;
        break;
      }
      if (d < closest - 1) {
        closest = d;
        stalled = 0;
      } else if (++stalled > STALL_STEPS) {
        break;
      }
    }
    return { points, merged, arrived };
  }

  /** The field's line through a point: its major direction, or the cross street. */
  private fieldLine(p: Point, minor: boolean | undefined): number {
    const major = this.field.majorAt(p.x, p.y);
    return minor === true ? major + Math.PI / 2 : major;
  }

  private startHeading(start: Point, opt: TraceOptions): number {
    const line = this.fieldLine(start, opt.minor);
    return opt.target === undefined ? line : alignTo(line, Math.atan2(opt.target.y - start.y, opt.target.x - start.x));
  }

  /**
   * Where the road wants to go next: the field's line for a streamline, and for
   * a guided trace the bearing to the target deflected towards that line. The
   * turn is capped so curves stay driveable.
   */
  private desiredHeading(x: number, y: number, heading: number, opt: TraceOptions): number {
    const line = this.fieldLine({ x, y }, opt.minor);
    const target = opt.target;
    let wanted: number;
    if (target === undefined) {
      wanted = alignTo(line, heading);
    } else {
      const bearing = Math.atan2(target.y - y, target.x - x);
      wanted = bearing + opt.params.fieldWeight * wrapAngle(alignTo(line, bearing) - bearing);
    }
    return heading + clamp(wrapAngle(wanted - heading), -opt.params.maxTurn, opt.params.maxTurn);
  }

  /**
   * The heading of the next step: what the field asked for, or the nearest turn
   * to it that keeps the step on land. Water bends a road; it never floods it.
   */
  private stepHeading(x: number, y: number, heading: number, wanted: number, params: TierParams): number | undefined {
    const limit = params.maxTurn * AVOID_TURNS;
    for (let k = 0; k <= AVOID_STEPS; k++) {
      for (const sign of k === 0 ? [1] : [1, -1]) {
        const h = wanted + sign * k * params.maxTurn;
        if (Math.abs(wrapAngle(h - heading)) > limit) continue;
        if (this.isDryPath(x, y, x + Math.cos(h) * params.step, y + Math.sin(h) * params.step)) return h;
      }
    }
    return undefined;
  }

  // ----------------------------------------------------------------- rerouting

  /**
   * A road over dry land from a point to whatever the goal accepts, found
   * breadth-first over the terrain grid. Diagonal steps need both of their
   * neighbours dry, so the polyline never clips a wet corner.
   */
  private reroute(from: Point, goal: (x: number, y: number, ix: number, iy: number) => Point | undefined): Point[] | undefined {
    const hf = this.hf;
    const n = hf.gridSize;
    const start = this.nearestLandNode(from);
    if (start < 0) return undefined;
    const came = this.came;
    const queue = this.queue;
    came.fill(-1);
    came[start] = start;
    queue[0] = start;
    let head = 0;
    let tail = 1;
    while (head < tail) {
      const at = queue[head++] as number;
      const ix = at % n;
      const iy = (at - ix) / n;
      const hit = goal(hf.worldX(ix), hf.worldY(iy), ix, iy);
      if (hit !== undefined) return this.pathTo(at, from, hit);
      for (let k = 0; k < NEIGHBOUR_X.length; k++) {
        const dx = NEIGHBOUR_X[k] as number;
        const dy = NEIGHBOUR_Y[k] as number;
        const jx = ix + dx;
        const jy = iy + dy;
        if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
        const to = jy * n + jx;
        if (came[to] !== -1 || this.land[to] === 0) continue;
        if (dx !== 0 && dy !== 0 && (this.land[iy * n + jx] === 0 || this.land[jy * n + ix] === 0)) continue;
        came[to] = at;
        queue[tail++] = to;
      }
    }
    return undefined;
  }

  /** Walk the breadth-first tree back to the start, then straighten the staircase it left. */
  private pathTo(end: number, from: Point, hit: Point): Point[] {
    const hf = this.hf;
    const n = hf.gridSize;
    const nodes: Point[] = [];
    let at = end;
    for (;;) {
      const ix = at % n;
      const iy = (at - ix) / n;
      nodes.push({ x: hf.worldX(ix), y: hf.worldY(iy) });
      const prev = this.came[at] as number;
      if (prev === at) break;
      at = prev;
    }
    nodes.reverse();
    nodes.unshift({ x: from.x, y: from.y });
    nodes.push({ x: hit.x, y: hit.y });
    return this.straighten(nodes);
  }

  /**
   * Drop the nodes a road does not need: keep the furthest point still joined to
   * the last kept one by a dry straight line. Every kept segment is checked, so
   * the result stays on land.
   */
  private straighten(nodes: readonly Point[]): Point[] {
    const reach = ARTERIAL.step * 3;
    const out: Point[] = [nodes[0] as Point];
    let anchor = 0;
    while (anchor < nodes.length - 1) {
      const a = nodes[anchor] as Point;
      let next = anchor + 1;
      for (let i = anchor + 2; i < nodes.length; i++) {
        const b = nodes[i] as Point;
        if (dist(a.x, a.y, b.x, b.y) > reach) break;
        if (this.isDryPath(a.x, a.y, b.x, b.y)) next = i;
      }
      out.push(nodes[next] as Point);
      anchor = next;
    }
    return out;
  }

  /** Index of the terrain node nearest a point that is dry land, searched outward. */
  private nearestLandNode(p: Point): number {
    const n = this.hf.gridSize;
    const cx = this.node(p.x);
    const cy = this.node(p.y);
    for (let r = 0; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const ix = cx + dx;
          const iy = cy + dy;
          if (ix < 0 || iy < 0 || ix >= n || iy >= n) continue;
          const i = iy * n + ix;
          if (this.land[i] === 1 && this.isDryPath(p.x, p.y, this.hf.worldX(ix), this.hf.worldY(iy))) return i;
        }
      }
    }
    return -1;
  }

  private node(v: number): number {
    return clamp(Math.round((v - this.hf.originX) / this.hf.cellSize), 0, this.hf.gridSize - 1);
  }

  // ------------------------------------------------------------------- ground

  /**
   * Dry ground near a crossing's shore point, a little inland so the bridge head
   * stands on something. Walks away from the water first, then searches around.
   * Which island the ground belongs to is not asked here: the caller decides
   * which end of the crossing is which by trying to reach the network from it.
   */
  private dryAnchor(shore: Point, across: Point): Point | undefined {
    const away = Math.atan2(shore.y - across.y, shore.x - across.x);
    for (let s = 0; s <= ANCHOR_REACH; s += 5) {
      const p = { x: shore.x + Math.cos(away) * s, y: shore.y + Math.sin(away) * s };
      if (this.acceptAnchor(p)) return p;
    }
    for (let s = 10; s <= ANCHOR_REACH; s += 10) {
      for (let k = 1; k < 24; k++) {
        const a = away + (k * Math.PI) / 12;
        const p = { x: shore.x + Math.cos(a) * s, y: shore.y + Math.sin(a) * s };
        if (this.acceptAnchor(p)) return p;
      }
    }
    return undefined;
  }

  private acceptAnchor(p: Point): boolean {
    if (Math.abs(p.x) > this.half || Math.abs(p.y) > this.half) return false;
    return this.isDry(p.x, p.y);
  }

  private isDry(x: number, y: number): boolean {
    return this.hf.sample(x, y) >= this.seaLevel + DRY_MARGIN;
  }

  /** True when the whole straight line from one point to another is on dry land. */
  private isDryPath(ax: number, ay: number, bx: number, by: number): boolean {
    const steps = Math.max(1, Math.ceil(dist(ax, ay, bx, by) / WET_SAMPLE));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.isDry(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
    }
    return true;
  }

  private addCurve(tier: RoadTier, points: Point[], bridges: number[]): RoadCurve | undefined {
    if (points.length < 2) return undefined;
    const curve: RoadCurve = { id: this.curves.length, tier, points, bridges };
    this.curves.push(curve);
    this.index.add(curve.id, points);
    return curve;
  }
}

/** Eight-way steps of the reroute search, straight ones first. */
const NEIGHBOUR_X = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBOUR_Y = [0, 0, 1, -1, 1, -1, 1, -1];

/** The one of `line` and `line + π` that points the same way as `reference`. */
function alignTo(line: number, reference: number): number {
  return Math.abs(wrapAngle(line - reference)) <= Math.PI / 2 ? line : line + Math.PI;
}

function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    total += dist(a.x, a.y, b.x, b.y);
  }
  return total;
}

/**
 * Points of a polyline at the given fractions of its length. Always one of the
 * polyline's own points, never a place along a segment, so a road that branches
 * here shares a point with its parent rather than merely touching it.
 */
function branchPoints(points: readonly Point[], fractions: readonly number[]): Point[] {
  const total = polylineLength(points);
  const out: Point[] = [];
  for (const f of fractions) {
    const wanted = total * f;
    let run = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i] as Point;
      const b = points[i + 1] as Point;
      const seg = dist(a.x, a.y, b.x, b.y);
      if (run + seg >= wanted) {
        out.push(wanted - run < seg / 2 ? a : b);
        break;
      }
      run += seg;
    }
  }
  return out;
}

/**
 * Seeds for the next generation of the fill. Every `spacing` along a curve: one
 * seed to each side, that far out and pointing the same way, and one on the
 * curve itself pointing across it. The first two lay the parallel arterials that
 * carry the traffic, the third the cross streets that tie them together.
 */
function seedAlong(curve: RoadCurve, spacing: number, depth: number, out: FillSeed[]): void {
  const points = curve.points;
  let run = spacing / 2;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const seg = dist(a.x, a.y, b.x, b.y);
    if (seg === 0) continue;
    // A bridge deck seeds nothing: there is no land beside it.
    const deck = curve.bridges.includes(i);
    run += seg;
    if (run < spacing || deck) continue;
    run -= spacing;
    const along = Math.atan2(b.y - a.y, b.x - a.x);
    const nx = -Math.sin(along) * spacing;
    const ny = Math.cos(along) * spacing;
    for (const side of [1, -1]) {
      out.push({ x: b.x + nx * side, y: b.y + ny * side, along, parent: curve.id, depth, onParent: false });
    }
    out.push({ x: b.x, y: b.y, along: along + Math.PI / 2, parent: curve.id, depth, onParent: true });
  }
}

/** True when a streamline has curled back onto ground it already covered. */
function foldsBack(points: readonly Point[], x: number, y: number, step: number): boolean {
  for (let i = 0; i + 8 < points.length; i++) {
    const p = points[i] as Point;
    if (dist(p.x, p.y, x, y) < step * 1.2) return true;
  }
  return false;
}
