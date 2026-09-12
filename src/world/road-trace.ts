/**
 * How a road is traced: one step of a streamline at a time, over ground that
 * refuses what the tier may not drive.
 *
 * This is the half of `roads.ts` that knows nothing about which road is being
 * laid. It follows the tensor field, blends the heading towards a target where
 * there is one, refuses a step that is too steep or too wet, reroutes over the
 * land cells where the field has turned the road back, and marks the segments
 * that stand off the ground as bridges or bores. `roads.ts` is the plan that
 * calls it: the highways, the island links, the fills and the boardwalks.
 *
 * The tracer holds the network it has laid so far, so a trace can end on it.
 * Every road that comes out of a trace goes in through {@link RoadTrace.addCurve}.
 */
import { clamp, dist, directionDelta, lerp, wrapAngle } from '../core/math.ts';
import { compareNumbers } from '../core/sort.ts';
import type { Noise2D } from '../core/noise.ts';
import { BeachGround, isResort } from './beaches.ts';
import type { CanRun } from './connect.ts';
import { Heightfield } from './heightfield.ts';
import { JOIN_EPSILON, RoadIndex, type NetworkHit } from './road-index.ts';
import { coastNoise, islandAt } from './terrain.ts';
import type { TensorField } from './tensor.ts';
import { TIERS } from './tiers.ts';
import type { Point, RoadCurve, RoadTier, WorldSkeleton } from './types.ts';

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
export const HIGHWAY_MERGE_AFTER = 400;
/**
 * Metres between the interchanges of a highway. A highway takes a junction
 * only at one of them (spec section 6.2), so this is how far apart the ramps
 * on and off it stand.
 */
export const INTERCHANGE_SPACING = 700;
/** Fractions of a highway's length where a branch highway leaves it. */
export const BRANCH_AT = [0.3, 0.7];
/** A highway shorter than this fraction of the map is not worth keeping. */
export const MIN_HIGHWAY = 0.25;
/** Metres from a road within which a district counts as already served. */
export const SERVED = 130;
/** Spacing between arterials, as a fraction of the world side. */
export const ARTERIAL_SPACING = 0.05;
/** How many arterials deep the fill grows from the highways, and how many it may lay in all. */
export const FILL_GENERATIONS = 4;
export const FILL_LIMIT = 400;
/** How many streets deep the minor fill grows, and how many curves it may lay in all. */
export const MINOR_GENERATIONS = 6;
export const MINOR_LIMIT = 3000;
/** How much of a spacing a road may run past its seed without meeting another road. */
export const DEAD_END_SPACINGS = 1.2;
/** Density a district needs before its blocks are cut through by alleys. */
export const ALLEY_DENSITY = 0.5;
/** Steps an arterial must run before it may merge into a road other than its parent. */
export const MIN_MERGE_STEPS = 4;
/** Metres a bridge head may be moved inland from the crossing's shore point. */
export const ANCHOR_REACH = 100;
/** Metres of boardwalk that have to survive the ground before the street is worth laying. */
export const MIN_BOARDWALK = 120;
/**
 * Metres of cut and fill a road bed absorbs. Ground that stands higher than
 * `CUT` above the line the road drives is tunnelled through; ground that falls
 * further than `FILL` below it is carried on a deck. Fill is the cheaper of the
 * two on real ground, so it is allowed the deeper of the two.
 */
const CUT = 2.5;
const FILL = 4;
/**
 * Steps a road may span in one go where no ordinary step is left, and the
 * metres of rock a bore may carry or a deck may stand above the ground. Between
 * them they bound a structure: long enough to get through a ridge or over a
 * ravine, short enough that the road never leaps a valley.
 */
const SPAN_STEPS = 8;
const MAX_COVER = 25;
/** Side of one bucket of the road index, in metres. Small enough that a bucket holds few streets. */
const INDEX_CELL = 60;

/** How each tier traces. */
export interface TierParams {
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
  /** Steepest grade a step may climb; the tier table owns the number. */
  maxGrade: number;
}

export const HIGHWAY: TierParams = { step: 30, maxTurn: 0.09, fieldWeight: 1, mergeRadius: 110, maxLength: 1.3, maxGrade: TIERS.highway.maxGrade };
export const ARTERIAL: TierParams = { step: 22, maxTurn: 0.17, fieldWeight: 0.75, mergeRadius: 80, maxLength: 0.8, maxGrade: TIERS.arterial.maxGrade };
export const STREET: TierParams = { step: 14, maxTurn: 0.22, fieldWeight: 0.8, mergeRadius: 26, maxLength: 0.35, maxGrade: TIERS.street.maxGrade };
export const ALLEY: TierParams = { step: 10, maxTurn: 0.3, fieldWeight: 0.8, mergeRadius: 18, maxLength: 0.06, maxGrade: TIERS.alley.maxGrade };
export const DIRT: TierParams = { step: 26, maxTurn: 0.2, fieldWeight: 0.9, mergeRadius: 55, maxLength: 0.5, maxGrade: TIERS.dirt.maxGrade };

export interface TraceOptions {
  params: TierParams;
  /** The tier being laid, which decides the roads this one may junction with. */
  joiner: RoadTier;
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

/** One step of a trace: which way it goes, and how far it reaches. */
interface Step {
  heading: number;
  /** Metres to the next point. A step that spans a structure reaches further. */
  reach: number;
}

interface TraceResult {
  points: Point[];
  /** Ended on an existing road. */
  merged: boolean;
  /** Ended at the target. */
  arrived: boolean;
}

/** The state every trace runs on: the ground, the field and the network laid so far. */
export abstract class RoadTrace {

  protected readonly world: WorldSkeleton;
  protected readonly field: TensorField;
  protected readonly hf: Heightfield;
  protected readonly seaLevel: number;
  protected readonly size: number;
  /** Half the map, less the margin roads keep from the edge. */
  protected readonly half: number;
  protected readonly index: RoadIndex;
  /** The coastline's own noise, so a point can be told which island's land it stands on. */
  protected readonly noise: Noise2D;
  protected readonly curves: RoadCurve[] = [];
  /** Dry land, one flag per terrain node: the grid a rerouted road walks. */
  protected readonly land: Uint8Array;
  /** The beaches as ground, so the minor fill can be kept off the sand. */
  protected readonly sand: BeachGround;
  /** Scratch for the reroute search, kept between routes so it is allocated once. */
  protected readonly came: Int32Array;
  protected readonly queue: Int32Array;

  constructor(world: WorldSkeleton, field: TensorField) {
    this.world = world;
    this.field = field;
    this.hf = new Heightfield(world.terrain);
    this.seaLevel = world.water.seaLevel;
    this.size = world.size;
    this.half = world.size / 2 - EDGE_MARGIN;
    this.noise = coastNoise(world.seed);
    this.index = new RoadIndex(world.size, INDEX_CELL, (x, y) => this.islandOf(x, y));
    const n = this.hf.gridSize;
    this.land = new Uint8Array(n * n);
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const inside = Math.abs(this.hf.worldX(ix)) <= this.half && Math.abs(this.hf.worldY(iy)) <= this.half;
        this.land[iy * n + ix] = inside && this.hf.at(ix, iy) >= this.seaLevel + DRY_MARGIN ? 1 : 0;
      }
    }
    // Only a resort is kept clear. A resort has a boardwalk to reach it by, so
    // a road turned away from its sand loses nothing. Every other beach is
    // reached by whatever road happens to run behind it, and a road kept off
    // that sand would leave it ground no road reaches — which `parcels.ts`
    // drops, so the beach would not be a parcel at all.
    this.sand = new BeachGround(world.beaches.filter(isResort), world.size, this.hf.cellSize);
    this.came = new Int32Array(n * n);
    this.queue = new Int32Array(n * n);
  }

  /** Ground that is not the sand of a beach (spec section 7.3). */
  protected readonly offSand = (x: number, y: number): boolean => this.sand.sandAt(x, y) < 0;

  /** Which island's land a point stands on. */
  protected islandOf(x: number, y: number): number {
    return islandAt(this.world.water.islands, this.size, this.noise, x, y);
  }

  /**
   * The longest run of a polyline a street may drive: dry ground the whole way,
   * inside the map, and no step steeper than the tier allows.
   */
  protected longestRunnable(line: readonly Point[], maxGrade: number): Point[] {
    const inside = (p: Point): boolean => Math.abs(p.x) <= this.half && Math.abs(p.y) <= this.half;
    let best: Point[] = [];
    let run: Point[] = [];
    for (const p of line) {
      const last = run[run.length - 1];
      if (!inside(p) || (last !== undefined && !this.canRun(last.x, last.y, p.x, p.y, maxGrade))) {
        if (run.length > best.length) best = run;
        run = inside(p) ? [p] : [];
        continue;
      }
      run.push(p);
    }
    return run.length > best.length ? run : best;
  }

  /**
   * A street from one end of a boardwalk to the network, without its first
   * point, so the boardwalk itself carries the join. Empty where the network is
   * out of reach.
   */
  protected reachNetwork(from: Point): Point[] {
    const route = this.routeToNetwork(from, this.islandOf(from.x, from.y), 'street', STREET);
    return route === undefined ? [] : route.slice(1);
  }

  // ------------------------------------------------------------------ routes

  /**
   * A road from a point to the network on its own island: streamline first,
   * reroute second. `within` is ground the road would rather keep to; a route
   * that cannot be found inside it is looked for again without it, because
   * reaching the network matters more than any ground does.
   */
  protected routeToNetwork(
    from: Point,
    island: number,
    joiner: RoadTier = 'arterial',
    params: TierParams = ARTERIAL,
    within?: (x: number, y: number) => boolean,
  ): Point[] | undefined {
    const target = this.index.nearestOnIsland(from.x, from.y, island, joiner);
    if (target !== undefined) {
      const traced = this.trace(from, { params, joiner, target, mergeAfter: 0, within });
      if (traced.merged || traced.arrived) return traced.points;
    }
    if (this.index.empty) return undefined;
    const route = this.reroute(
      from,
      params.maxGrade,
      (x, y) => {
        const hit = this.index.nearest(x, y, params.mergeRadius, -1, joiner);
        if (hit === undefined || this.index.refuses(hit.x, hit.y, joiner)) return undefined;
        return this.canRun(x, y, hit.x, hit.y, params.maxGrade) ? hit : undefined;
      },
      within,
    );
    if (route !== undefined || within === undefined) return route;
    return this.routeToNetwork(from, island, joiner, params);
  }

  /** An arterial from a point to a place: streamline first, reroute second. */
  protected routeTo(from: Point, target: Point, island: number): Point[] | undefined {
    const traced = this.trace(from, { params: ARTERIAL, joiner: 'arterial', target, mergeAfter: 0 });
    if (traced.merged || traced.arrived) return traced.points;
    const goalIx = this.node(target.x);
    const goalIy = this.node(target.y);
    const route = this.reroute(from, ARTERIAL.maxGrade, (x, y, ix, iy) =>
      ix === goalIx && iy === goalIy && this.canRun(x, y, target.x, target.y, ARTERIAL.maxGrade)
        ? { x: target.x, y: target.y }
        : undefined,
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
  protected trace(start: Point, opt: TraceOptions): TraceResult {
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
      const qx = px + Math.cos(next.heading) * next.reach;
      const qy = py + Math.sin(next.heading) * next.reach;
      if (Math.abs(qx) > this.half || Math.abs(qy) > this.half) break;
      if (opt.within !== undefined && !opt.within(qx, qy)) break;

      // A road joins any other road on close approach, but only rejoins the one
      // it branched off after it has gone somewhere.
      const parent = opt.parentCurve ?? -1;
      let hit = length >= mergeAfter ? this.index.nearest(qx, qy, params.mergeRadius, parent, opt.joiner) : undefined;
      if (hit === undefined && parent >= 0 && length >= (opt.parentMergeAfter ?? mergeAfter)) {
        hit = this.index.nearest(qx, qy, params.mergeRadius, -1, opt.joiner);
      }
      // Roads that meet share their point, so a road merging where two others
      // already meet joins both. A street merging into an arterial ramp on its
      // last point would junction with the highway under it, which spec section
      // 6.2 refuses.
      if (hit !== undefined && this.index.refuses(hit.x, hit.y, opt.joiner)) hit = undefined;
      if (hit !== undefined && this.canRun(px, py, hit.x, hit.y, params.maxGrade)) {
        points.push({ x: hit.x, y: hit.y });
        merged = true;
        break;
      }
      if (foldsBack(points, qx, qy, params.step)) break;

      points.push({ x: qx, y: qy });
      length += next.reach;
      heading = next.heading;
      px = qx;
      py = qy;

      const target = opt.target;
      if (target === undefined) continue;
      const d = dist(px, py, target.x, target.y);
      if (d <= arrive) {
        // Only an arrival that can be driven counts: a last step over water or
        // up a wall is no arrival, and the caller reroutes instead.
        if (!this.canRun(px, py, target.x, target.y, params.maxGrade)) break;
        if (this.index.refuses(target.x, target.y, opt.joiner)) break;
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
  protected fieldLine(p: Point, minor: boolean | undefined): number {
    const major = this.field.majorAt(p.x, p.y);
    return minor === true ? major + Math.PI / 2 : major;
  }

  protected startHeading(start: Point, opt: TraceOptions): number {
    const line = this.fieldLine(start, opt.minor);
    return opt.target === undefined ? line : alignTo(line, Math.atan2(opt.target.y - start.y, opt.target.x - start.x));
  }

  /**
   * Where the road wants to go next: the field's line for a streamline, and for
   * a guided trace the bearing to the target deflected towards that line. The
   * turn is capped so curves stay driveable.
   */
  protected desiredHeading(x: number, y: number, heading: number, opt: TraceOptions): number {
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
   * The next step of a trace: how far it reaches and which way. The field's
   * heading is tried first, then the turns to either side of it, and a step is
   * taken only where the ground is dry and the climb is one the tier accepts.
   * Water bends a road and never floods it; a hillside bends it and is never
   * climbed. This is the reroute of spec section 6.1.
   *
   * When no ordinary step is left, the road holds its line and spans further:
   * the ground it may not climb is bored through or carried over, which is what
   * gets a highway past a ridge or a ravine instead of ending it there. The
   * shortest span that works wins, so the structure is never longer than the
   * ground demands.
   */
  protected stepHeading(x: number, y: number, heading: number, wanted: number, params: TierParams): Step | undefined {
    const limit = params.maxTurn * AVOID_TURNS;
    const here = this.hf.sample(x, y);
    for (let span = 1; span <= SPAN_STEPS; span++) {
      const reach = params.step * span;
      let steep = false;
      for (let k = 0; k <= AVOID_STEPS; k++) {
        for (const sign of k === 0 ? [1] : [1, -1]) {
          const h = wanted + sign * k * params.maxTurn;
          if (Math.abs(wrapAngle(h - heading)) > limit) continue;
          const qx = x + Math.cos(h) * reach;
          const qy = y + Math.sin(h) * reach;
          // The climb between the two ends costs two samples and turns most
          // candidates away; only what survives it is worth walking over.
          if (Math.abs(this.hf.sample(qx, qy) - here) / reach > params.maxGrade) {
            steep = true;
            continue;
          }
          const profile = this.probe(x, y, qx, qy);
          if (!profile.dry) continue;
          if (profile.above > MAX_COVER || profile.below > MAX_COVER) continue;
          return { heading: h, reach };
        }
      }
      // Spanning further is for ground the road may not climb. Where water was
      // what stopped it, the road stops too: a deck belongs at a strait
      // crossing of the water description, not wherever a trace ran out.
      if (!steep) return undefined;
    }
    return undefined;
  }

  // ----------------------------------------------------------------- rerouting

  /**
   * A road over dry, gentle land from a point to whatever the goal accepts,
   * found breadth-first over the terrain grid. Diagonal steps need both of
   * their neighbours dry, so the polyline never clips a wet corner, and no step
   * climbs harder than the tier allows, so the route walks around a hill it may
   * not go over.
   */
  protected reroute(
    from: Point,
    maxGrade: number,
    goal: (x: number, y: number, ix: number, iy: number) => Point | undefined,
    within?: (x: number, y: number) => boolean,
  ): Point[] | undefined {
    const hf = this.hf;
    const n = hf.gridSize;
    const straight = maxGrade * hf.cellSize;
    const diagonal = straight * Math.SQRT2;
    const start = this.nearestLandNode(from, maxGrade);
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
      if (hit !== undefined) return this.pathTo(at, from, hit, maxGrade);
      for (let k = 0; k < NEIGHBOUR_X.length; k++) {
        const dx = NEIGHBOUR_X[k] as number;
        const dy = NEIGHBOUR_Y[k] as number;
        const jx = ix + dx;
        const jy = iy + dy;
        if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
        const to = jy * n + jx;
        if (came[to] !== -1 || this.land[to] === 0) continue;
        if (dx !== 0 && dy !== 0 && (this.land[iy * n + jx] === 0 || this.land[jy * n + ix] === 0)) continue;
        if (within !== undefined && !within(hf.worldX(jx), hf.worldY(jy))) continue;
        const rise = Math.abs(hf.at(jx, jy) - hf.at(ix, iy));
        if (rise > (dx !== 0 && dy !== 0 ? diagonal : straight)) continue;
        came[to] = at;
        queue[tail++] = to;
      }
    }
    return undefined;
  }

  /** Walk the breadth-first tree back to the start, then straighten the staircase it left. */
  protected pathTo(end: number, from: Point, hit: Point, maxGrade: number): Point[] {
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
    return this.straighten(nodes, maxGrade);
  }

  /**
   * Drop the nodes a road does not need: keep the furthest point still joined to
   * the last kept one by a straight line the tier can drive. Every kept segment
   * is checked, so the result stays on land and inside the grade.
   */
  protected straighten(nodes: readonly Point[], maxGrade: number): Point[] {
    const reach = ARTERIAL.step * 3;
    const out: Point[] = [nodes[0] as Point];
    let anchor = 0;
    while (anchor < nodes.length - 1) {
      const a = nodes[anchor] as Point;
      let next = anchor + 1;
      for (let i = anchor + 2; i < nodes.length; i++) {
        const b = nodes[i] as Point;
        if (dist(a.x, a.y, b.x, b.y) > reach) break;
        if (this.canRun(a.x, a.y, b.x, b.y, maxGrade)) next = i;
      }
      out.push(nodes[next] as Point);
      anchor = next;
    }
    return out;
  }

  /** Index of the terrain node nearest a point that the road can reach, searched outward. */
  protected nearestLandNode(p: Point, maxGrade: number): number {
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
          if (this.land[i] === 1 && this.canRun(p.x, p.y, this.hf.worldX(ix), this.hf.worldY(iy), maxGrade)) return i;
        }
      }
    }
    return -1;
  }

  protected node(v: number): number {
    return clamp(Math.round((v - this.hf.originX) / this.hf.cellSize), 0, this.hf.gridSize - 1);
  }

  // ------------------------------------------------------------------- ground

  /**
   * Dry ground near a crossing's shore point, a little inland so the bridge head
   * stands on something. Walks away from the water first, then searches around.
   * Which island the ground belongs to is not asked here: the caller decides
   * which end of the crossing is which by trying to reach the network from it.
   */
  protected dryAnchor(shore: Point, across: Point): Point | undefined {
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

  protected acceptAnchor(p: Point): boolean {
    if (Math.abs(p.x) > this.half || Math.abs(p.y) > this.half) return false;
    return this.isDry(p.x, p.y);
  }

  protected isDry(x: number, y: number): boolean {
    return this.hf.sample(x, y) >= this.seaLevel + DRY_MARGIN;
  }

  /** What the ground does under a straight span. {@link spanProfile} is the rule. */
  protected probe(ax: number, ay: number, bx: number, by: number): Profile {
    return spanProfile(this.hf, this.seaLevel, ax, ay, bx, by);
  }

  /**
   * True when a road of this tier may run straight from one point to another:
   * dry ground all the way, and a climb the tier accepts. A span that is too
   * steep is refused here, which is what makes the caller look for another line.
   */
  protected canRun(ax: number, ay: number, bx: number, by: number, maxGrade: number): boolean {
    const profile = this.probe(ax, ay, bx, by);
    return profile.dry && profile.grade <= maxGrade;
  }

  /**
   * Mark the segments that do not lie on the ground. A hill standing more than
   * {@link CUT} above the line the road drives is bored through; a dip falling
   * more than {@link FILL} below it is carried on a deck. The decks already in
   * `bridges` span water and are left alone; the new ones are added to it, and
   * it is left ascending. The bores are returned.
   */
  protected markStructures(points: readonly Point[], bridges: number[]): number[] {
    const tunnels: number[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      if (bridges.includes(i)) continue;
      const a = points[i] as Point;
      const b = points[i + 1] as Point;
      const profile = this.probe(a.x, a.y, b.x, b.y);
      if (profile.above <= CUT && profile.below <= FILL) continue;
      // Whichever the ground overruns by more decides which structure it takes.
      if (profile.above - CUT >= profile.below - FILL) tunnels.push(i);
      else bridges.push(i);
    }
    bridges.sort(compareNumbers);
    return tunnels;
  }

  protected addCurve(tier: RoadTier, points: Point[], bridges: number[], interchanges: number[] = []): RoadCurve | undefined {
    if (points.length < 2) return undefined;
    const tunnels = this.markStructures(points, bridges);
    const curve: RoadCurve = { id: this.curves.length, tier, points, bridges, tunnels, interchanges };
    this.curves.push(curve);
    this.index.add(curve);
    return curve;
  }
}

/**
 * What the ground does under a straight span: whether it stays dry, how hard the
 * span climbs, and how far the ground leaves the line the road drives. One walk
 * answers all three, because every caller wants at least two of them.
 */
export function spanProfile(hf: Heightfield, seaLevel: number, ax: number, ay: number, bx: number, by: number): Profile {
  const run = dist(ax, ay, bx, by);
  const start = hf.sample(ax, ay);
  const end = hf.sample(bx, by);
  const steps = Math.max(1, Math.ceil(run / WET_SAMPLE));
  const dryAt = (x: number, y: number): boolean => hf.sample(x, y) >= seaLevel + DRY_MARGIN;
  let dry = dryAt(ax, ay) && dryAt(bx, by);
  let above = 0;
  let below = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const h = hf.sample(ax + (bx - ax) * t, ay + (by - ay) * t);
    if (h < seaLevel + DRY_MARGIN) dry = false;
    const line = start + (end - start) * t;
    if (h - line > above) above = h - line;
    if (line - h > below) below = line - h;
  }
  return { dry, grade: run > 0 ? Math.abs(end - start) / run : 0, above, below };
}

/**
 * The rule the connection pass asks the ground: may a road of this tier be
 * driven straight from one place to another? It is the rule the tracer traces
 * by, so a junction is only cut into a road where the trace would have laid one.
 */
export function groundRule(hf: Heightfield, seaLevel: number): CanRun {
  return (a, b, tier) => {
    const profile = spanProfile(hf, seaLevel, a.x, a.y, b.x, b.y);
    return profile.dry && profile.grade <= TIERS[tier].maxGrade;
  };
}

/** What the ground does under a straight span, from one walk along it. */
export interface Profile {
  /** True when no part of the span stands over water. */
  dry: boolean;
  /** Rise over run between the two ends. */
  grade: number;
  /** Metres the ground stands above the line between the ends, at its highest. */
  above: number;
  /** Metres the ground falls below that line, at its lowest. */
  below: number;
}

/** Eight-way steps of the reroute search, straight ones first. */

/** Eight-way steps of the reroute search, straight ones first. */
const NEIGHBOUR_X = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBOUR_Y = [0, 0, 1, -1, 1, -1, 1, -1];

/** The one of `line` and `line + π` that points the same way as `reference`. */
export function alignTo(line: number, reference: number): number {
  return Math.abs(wrapAngle(line - reference)) <= Math.PI / 2 ? line : line + Math.PI;
}

export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    total += dist(a.x, a.y, b.x, b.y);
  }
  return total;
}

/** True when a streamline has curled back onto ground it already covered. */
function foldsBack(points: readonly Point[], x: number, y: number, step: number): boolean {
  for (let i = 0; i + 8 < points.length; i++) {
    const p = points[i] as Point;
    if (dist(p.x, p.y, x, y) < step * 1.2) return true;
  }
  return false;
}
