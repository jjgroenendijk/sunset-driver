/**
 * The road network: highways, arterials, streets, alleys and dirt roads, all
 * traced as streamlines of the tensor field (spec sections 6.1 and 6.2).
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
 * The boardwalks of spec section 7.3 come next, and are the one road that does
 * not follow the field at all: a resort beach hands over the line behind its
 * dune, and the street is laid on it so the roads stay off the sand.
 *
 * Streets, alleys and dirt roads come last. They are the same fill as the
 * arterials, with two differences: the spacing comes from the density of the
 * district under the seed, so a dense district gets tight blocks, and the tier
 * comes from its zone. A road that met nothing on one side is a dead end, and a
 * dead end is trimmed to a cul-de-sac rather than left running into nothing.
 *
 * No road climbs harder than its tier allows. Every candidate step is measured
 * against `TIERS[tier].maxGrade`, and a step that is too steep is refused, so
 * the trace turns along the contour instead — the reroute of spec section 6.1.
 * Where the ground under an accepted step is not the line the road drives, the
 * segment is marked: a hill above it is tunnelled, a dip below it is decked.
 *
 * A highway is the one tier that does not take a junction wherever a road
 * reaches it. Interchanges are placed along it, and only a highway or an
 * arterial ramp may join it, only there (spec section 6.2). A street, an alley
 * or a dirt road never meets one at all: it runs past, and where the two cross
 * the road graph makes it an overpass.
 *
 * Four invariants hold by construction, and the seed sweep checks them:
 *
 * - Every curve starts on an existing road, ends on one, or merges into one, so
 *   the whole network is a single connected component. A trace that reaches
 *   neither is dropped rather than left dangling.
 * - No segment passes over water unless it is a bridge, and a bridge only ever
 *   spans one of the water description's strait crossings.
 * - No segment laid on the ground exceeds its tier's maximum grade.
 * - No road shares a point with a highway away from one of its interchanges,
 *   and no street, alley or dirt road shares one with a highway at all.
 */
import { clamp, dist, directionDelta, lerp, wrapAngle } from '../core/math.ts';
import type { Noise2D } from '../core/noise.ts';
import { compareNumbers } from '../core/sort.ts';
import { BeachGround, isResort } from './beaches.ts';
import { connectCrossings, type CanRun } from './connect.ts';
import { districtAt, layoutZones, zoneAt } from './districts.ts';
import { Heightfield } from './heightfield.ts';
import { coastNoise, islandAt } from './terrain.ts';
import type { TensorField } from './tensor.ts';
import { mayJoin, TIERS } from './tiers.ts';
import type { Beach, Island, Point, RoadCurve, RoadTier, WorldSkeleton, Zone } from './types.ts';

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
/**
 * Metres between the interchanges of a highway. A highway takes a junction
 * only at one of them (spec section 6.2), so this is how far apart the ramps
 * on and off it stand.
 */
const INTERCHANGE_SPACING = 700;
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
/** How many streets deep the minor fill grows, and how many curves it may lay in all. */
const MINOR_GENERATIONS = 6;
const MINOR_LIMIT = 3000;
/** How much of a spacing a road may run past its seed without meeting another road. */
const DEAD_END_SPACINGS = 1.2;
/** Density a district needs before its blocks are cut through by alleys. */
const ALLEY_DENSITY = 0.5;
/** Steps an arterial must run before it may merge into a road other than its parent. */
const MIN_MERGE_STEPS = 4;
/** Metres a bridge head may be moved inland from the crossing's shore point. */
const ANCHOR_REACH = 100;
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
/** Metres within which two road points are the same place, and so the same junction. */
const JOIN_EPSILON = 0.01;

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
  /** Steepest grade a step may climb; the tier table owns the number. */
  maxGrade: number;
}

const HIGHWAY: TierParams = { step: 30, maxTurn: 0.09, fieldWeight: 1, mergeRadius: 110, maxLength: 1.3, maxGrade: TIERS.highway.maxGrade };
const ARTERIAL: TierParams = { step: 22, maxTurn: 0.17, fieldWeight: 0.75, mergeRadius: 80, maxLength: 0.8, maxGrade: TIERS.arterial.maxGrade };
const STREET: TierParams = { step: 14, maxTurn: 0.22, fieldWeight: 0.8, mergeRadius: 26, maxLength: 0.35, maxGrade: TIERS.street.maxGrade };
const ALLEY: TierParams = { step: 10, maxTurn: 0.3, fieldWeight: 0.8, mergeRadius: 18, maxLength: 0.06, maxGrade: TIERS.alley.maxGrade };
const DIRT: TierParams = { step: 26, maxTurn: 0.2, fieldWeight: 0.9, mergeRadius: 55, maxLength: 0.5, maxGrade: TIERS.dirt.maxGrade };

/**
 * What the minor fill lays in each zone: the tier, and the metres between
 * neighbouring roads of it. A district holds the tight spacing when its density
 * is 1 and the loose one when it is 0, so blocks shrink toward downtown.
 */
const MINOR_BY_ZONE: Record<Zone, { tier: RoadTier; tight: number; loose: number }> = {
  core: { tier: 'street', tight: 70, loose: 95 },
  inner: { tier: 'street', tight: 80, loose: 115 },
  industrial: { tier: 'street', tight: 115, loose: 155 },
  suburban: { tier: 'street', tight: 90, loose: 135 },
  outskirts: { tier: 'dirt', tight: 190, loose: 270 },
  wilderness: { tier: 'dirt', tight: 300, loose: 430 },
};

interface TraceOptions {
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

/** What the fill lays where it is seeded. */
interface FillPlan {
  tier: RoadTier;
  params: TierParams;
  /** Metres between neighbouring roads of this tier here. */
  spacing: number;
  /** Metres a road may run past its seed without meeting another road. */
  deadEnd: number;
  /** Ground this tier may stand on. */
  within: (x: number, y: number) => boolean;
}

/** Where the fill should try to lay its next road. */
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
  /** The tier of the curve each point belongs to, and whether a road may join it there. */
  private readonly tiers: RoadTier[] = [];
  private readonly interchanges: boolean[] = [];
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

  add(curve: RoadCurve): void {
    const points = curve.points;
    for (let k = 0; k < points.length; k++) {
      const p = points[k] as Point;
      const i = this.xs.length;
      this.xs.push(p.x);
      this.ys.push(p.y);
      this.curves.push(curve.id);
      this.tiers.push(curve.tier);
      this.interchanges.push(curve.interchanges.includes(k));
      this.islands.push(this.islandOf(p.x, p.y));
      (this.buckets[this.column(p.y) * this.n + this.column(p.x)] as number[]).push(i);
    }
  }

  /** True when a road of `joiner` may end on the point at `i`. */
  private joinable(i: number, joiner: RoadTier | undefined): boolean {
    if (joiner === undefined) return true;
    return mayJoin(joiner, this.tiers[i] as RoadTier, this.interchanges[i] === true);
  }

  get empty(): boolean {
    return this.xs.length === 0;
  }

  /**
   * The nearest road point within `radius`. One curve can be left out, which is
   * how a road ignores the road it branched off. With a `joiner` tier only
   * points that tier may junction at are returned; without one every point
   * counts, which is the question the fill asks about ground already covered.
   */
  nearest(x: number, y: number, radius: number, except = -1, joiner?: RoadTier): NetworkHit | undefined {
    const cx = this.column(x);
    const cy = this.column(y);
    const reach = Math.ceil(radius / this.cell);
    let best: NetworkHit | undefined;
    let bestD = radius;
    for (let iy = Math.max(0, cy - reach); iy <= Math.min(this.n - 1, cy + reach); iy++) {
      for (let ix = Math.max(0, cx - reach); ix <= Math.min(this.n - 1, cx + reach); ix++) {
        for (const i of this.buckets[iy * this.n + ix] as number[]) {
          if (this.curves[i] === except) continue;
          if (!this.joinable(i, joiner)) continue;
          const d = dist(x, y, this.xs[i] as number, this.ys[i] as number);
          if (d > bestD) continue;
          bestD = d;
          best = { x: this.xs[i] as number, y: this.ys[i] as number, curve: this.curves[i] as number };
        }
      }
    }
    return best;
  }

  /**
   * True when a road of `joiner` may not begin where it stands, because a road
   * it is not allowed to junction with already has a point there. A fill road
   * starts at its seed, so a seed on such a point would junction there.
   */
  refuses(x: number, y: number, joiner: RoadTier): boolean {
    const cx = this.column(x);
    const cy = this.column(y);
    for (let iy = Math.max(0, cy - 1); iy <= Math.min(this.n - 1, cy + 1); iy++) {
      for (let ix = Math.max(0, cx - 1); ix <= Math.min(this.n - 1, cx + 1); ix++) {
        for (const i of this.buckets[iy * this.n + ix] as number[]) {
          if (this.joinable(i, joiner)) continue;
          if (dist(x, y, this.xs[i] as number, this.ys[i] as number) <= JOIN_EPSILON) return true;
        }
      }
    }
    return false;
  }

  /** The nearest road point standing on one island that `joiner` may junction at, at any distance. */
  nearestOnIsland(x: number, y: number, island: number, joiner: RoadTier): NetworkHit | undefined {
    let best: NetworkHit | undefined;
    let bestD = Infinity;
    for (let i = 0; i < this.xs.length; i++) {
      if (this.islands[i] !== island) continue;
      if (!this.joinable(i, joiner)) continue;
      const d = dist(x, y, this.xs[i] as number, this.ys[i] as number);
      if (d >= bestD) continue;
      bestD = d;
      best = { x: this.xs[i] as number, y: this.ys[i] as number, curve: this.curves[i] as number };
    }
    return best;
  }
}

/** The roads of a world, and the boardwalk each beach was given. */
export interface TracedRoads {
  roads: RoadCurve[];
  /**
   * The curve that runs along each beach's boardwalk line, indexed like
   * `world.beaches`. -1 where the beach carries no boardwalk, or where the
   * ground refused the one it asked for.
   */
  boardwalks: number[];
}

/** Trace every road of a world, widest tier first. Pure: same world and field, same roads. */
export function traceRoads(world: WorldSkeleton, field: TensorField): TracedRoads {
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
  /** The beaches as ground, so the minor fill can be kept off the sand. */
  private readonly sand: BeachGround;
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
  private readonly offSand = (x: number, y: number): boolean => this.sand.sandAt(x, y) < 0;

  /** Which island's land a point stands on. */
  private islandOf(x: number, y: number): number {
    return islandAt(this.world.water.islands, this.size, this.noise, x, y);
  }

  build(): TracedRoads {
    this.traceHighways();
    this.linkIslands();
    this.fillArterials();
    this.serveDistricts();
    // Before the minor fill, so the fill grows around the boardwalk instead of
    // laying its own streets over the same ground.
    const boardwalks = this.world.beaches.map((beach) => this.traceBoardwalk(beach));
    this.fillMinor();
    // The trace only ever ends a road on a point of another one, so two roads
    // that cross between their points have met nothing yet.
    const connected = connectCrossings(this.curves, groundRule(this.hf, this.seaLevel));
    return { roads: connected, boardwalks };
  }

  // ---------------------------------------------------------------- highways

  /**
   * Two highways crossing at the core, plus a branch off each arm of them. A
   * branch leaves its trunk at one of the trunk's interchanges, because that is
   * the only place a highway takes a junction (spec section 6.2).
   */
  private traceHighways(): void {
    const core = this.world.core;
    const trunks = [this.streamline(core, false), this.streamline(core, true)];
    for (let i = 0; i < trunks.length; i++) {
      const trunk = trunks[i];
      if (trunk === undefined) continue;
      for (const at of this.branchPoints(trunk, BRANCH_AT)) this.streamline(at, i === 0);
    }
  }

  /**
   * Where a branch highway leaves its trunk: the free interchange nearest each
   * of the given fractions of the trunk's length. An interchange another road
   * already stands on is not free — a branch seeded there would retrace that
   * road — and neither is an end of the trunk.
   */
  private branchPoints(trunk: RoadCurve, fractions: readonly number[]): Point[] {
    const points = trunk.points;
    const last = points.length - 1;
    const free = trunk.interchanges.filter((i) => {
      if (i === 0 || i === last) return false;
      const p = points[i] as Point;
      return this.index.nearest(p.x, p.y, JOIN_EPSILON, trunk.id) === undefined;
    });
    return atFractions(points, free, fractions);
  }

  /** One highway: the field line through a point, followed both ways. */
  private streamline(at: Point, minor: boolean): RoadCurve | undefined {
    const line = this.fieldLine(at, minor);
    const opt: TraceOptions = { params: HIGHWAY, joiner: 'highway', minor, mergeAfter: HIGHWAY_MERGE_AFTER };
    const forward = this.trace(at, { ...opt, heading: line });
    const backward = this.trace(at, { ...opt, heading: line + Math.PI });
    backward.points.reverse();
    const points = [...backward.points.slice(0, -1), ...forward.points];
    if (polylineLength(points) < MIN_HIGHWAY * this.size) return undefined;
    // The point it was seeded at is an interchange, so the road it grew out of
    // and this one meet at a junction both of them allow.
    return this.addCurve('highway', points, [], interchangesOf(points, backward.points.length - 1));
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
   * the built-up zones are covered.
   */
  private fillArterials(): void {
    const zones = layoutZones(this.size, this.world.core, this.world.water);
    const spacing = this.size * ARTERIAL_SPACING;
    const plan: FillPlan = {
      tier: 'arterial',
      params: ARTERIAL,
      spacing,
      deadEnd: Infinity,
      // Off the sand, like the minor fill: a beach is served from the boardwalk
      // behind its dune, never paved across (spec section 7.3).
      within: (x, y) => zoneAt(zones, x, y) !== 'wilderness' && this.offSand(x, y),
    };
    const seeds: FillSeed[] = [];
    for (const curve of this.curves) seedAlong(curve, () => spacing, 0, seeds, true, true);
    this.grow(seeds, () => plan, FILL_GENERATIONS, FILL_LIMIT);
  }

  // ------------------------------------------------------------ minor roads

  /**
   * Streets, alleys and dirt roads between the arterials (spec section 6.2).
   * The zone under a seed decides the tier and the block size it aims for, and
   * the density of the district under it decides where in that range the
   * spacing lands. Alleys come last, seeded half a block off the streets, so
   * they cut through the inside of a dense block rather than doubling a street.
   */
  private fillMinor(): void {
    const zones = layoutZones(this.size, this.world.core, this.world.water);
    const districts = this.world.districts;
    const spacingAt = (x: number, y: number): number => {
      const spec = MINOR_BY_ZONE[zoneAt(zones, x, y)];
      return lerp(spec.loose, spec.tight, clamp(districtAt(districts, zones, x, y).density, 0, 1));
    };
    const tierAt = (x: number, y: number): RoadTier => MINOR_BY_ZONE[zoneAt(zones, x, y)].tier;
    // The fill is what covers the map, so it is what would otherwise pave the
    // beaches. It stops at the sand; the boardwalk behind the dune is the road
    // that serves them (spec section 7.3).
    const paved = (x: number, y: number): boolean => tierAt(x, y) === 'street' && this.offSand(x, y);
    const unpaved = (x: number, y: number): boolean => tierAt(x, y) === 'dirt' && this.offSand(x, y);

    // Streets in the built-up zones, dirt roads in the outskirts and the
    // wilderness. Each stays on its own ground, so a street never fades into a
    // track and a track never becomes a street halfway along.
    const streetPlan = (x: number, y: number): FillPlan => {
      const tier = tierAt(x, y);
      const spacing = spacingAt(x, y);
      return {
        tier,
        params: tier === 'dirt' ? DIRT : STREET,
        spacing,
        deadEnd: spacing * DEAD_END_SPACINGS,
        within: tier === 'dirt' ? unpaved : paved,
      };
    };
    const seeds: FillSeed[] = [];
    for (const curve of [...this.curves]) seedAlong(curve, spacingAt, 0, seeds);
    const streets = this.grow(seeds, streetPlan, MINOR_GENERATIONS, MINOR_LIMIT);

    const dense = (x: number, y: number): boolean =>
      paved(x, y) && districtAt(districts, zones, x, y).density >= ALLEY_DENSITY;
    const alleyPlan = (x: number, y: number): FillPlan => {
      const spacing = spacingAt(x, y) / 2;
      return { tier: 'alley', params: ALLEY, spacing, deadEnd: spacing * DEAD_END_SPACINGS, within: dense };
    };
    const alleySeeds: FillSeed[] = [];
    for (const curve of streets) {
      if (curve.tier === 'street') seedAlong(curve, (x, y) => spacingAt(x, y) / 2, 0, alleySeeds, false);
    }
    this.grow(alleySeeds, alleyPlan, 1, MINOR_LIMIT);
  }

  // -------------------------------------------------------------------- fill

  /**
   * Grow one tier out of the roads already laid, seed by seed. A seed on ground
   * another road already covers is skipped, which is what keeps blocks near
   * their spacing, and a road is kept only if it joins the network, so the fill
   * can never leave one dangling. Roads laid here seed the next generation.
   */
  private grow(seeds: FillSeed[], planAt: (x: number, y: number) => FillPlan, generations: number, limit: number): RoadCurve[] {
    const laid: RoadCurve[] = [];
    for (let i = 0; i < seeds.length && laid.length < limit; i++) {
      const seed = seeds[i] as FillSeed;
      if (!this.isDry(seed.x, seed.y)) continue;
      const plan = planAt(seed.x, seed.y);
      if (!plan.within(seed.x, seed.y)) continue;
      // A road begins at its seed, so a seed standing on a road this tier may
      // not junction with would make the junction anyway. A street seeded where
      // an arterial ramp meets a highway is that case (spec section 6.2).
      if (this.index.refuses(seed.x, seed.y, plan.tier)) continue;
      // Somewhere already covered: a road within half a spacing, other than the parent.
      if (this.index.nearest(seed.x, seed.y, plan.spacing * 0.5, seed.parent) !== undefined) continue;
      const curve = this.fillRoad(seed, plan);
      if (curve === undefined) continue;
      laid.push(curve);
      if (seed.depth + 1 < generations) seedAlong(curve, (x, y) => planAt(x, y).spacing, seed.depth + 1, seeds);
    }
    return laid;
  }

  /** One fill road, traced both ways along the field line it was seeded with. */
  private fillRoad(seed: FillSeed, plan: FillPlan): RoadCurve | undefined {
    const params = plan.params;
    const major = this.field.majorAt(seed.x, seed.y);
    const minor = directionDelta(major, seed.along) > Math.PI / 4;
    const line = alignTo(minor ? major + Math.PI / 2 : major, seed.along);
    const opt: TraceOptions = {
      params,
      joiner: plan.tier,
      minor,
      within: plan.within,
      mergeAfter: params.step * MIN_MERGE_STEPS,
      parentCurve: seed.parent,
      parentMergeAfter: plan.spacing,
    };
    const forward = this.trace({ x: seed.x, y: seed.y }, { ...opt, heading: line });
    const backward = this.trace({ x: seed.x, y: seed.y }, { ...opt, heading: line + Math.PI });
    // A road that starts beside the network has to find its way back to it.
    if (!seed.onParent && !forward.merged && !backward.merged) return undefined;
    // A side that met no other road is a dead end, kept only as far as a cul-de-sac runs.
    const ahead = forward.merged ? forward.points : trimTo(forward.points, plan.deadEnd);
    const behind = backward.merged ? backward.points : trimTo(backward.points, plan.deadEnd);
    behind.reverse();
    const points = [...behind.slice(0, -1), ...ahead];
    if (polylineLength(points) < plan.spacing * 0.5) return undefined;
    return this.addCurve(plan.tier, points, []);
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
      // Round the beaches where it can, over them where it must: a district
      // that can only be reached across the sand is still reached.
      const route = this.routeToNetwork({ x: site.x, y: site.y }, island, 'arterial', ARTERIAL, this.offSand);
      if (route !== undefined) this.addCurve('arterial', route, []);
    }
  }

  // --------------------------------------------------------------- boardwalks

  /**
   * The boardwalk of one beach (spec section 7.3): a street along the line the
   * beach plan laid behind its dune. Its id, or -1.
   *
   * The line is taken as it stands rather than traced, because a boardwalk
   * follows the coast and not the field. What the ground refuses is dropped —
   * a stretch too steep for a street, or one that has gone wet — and the
   * longest run left is kept. Each end then reaches for the network: a curve
   * that shares a point with no other is not part of the network at all, so a
   * boardwalk neither end can reach is not laid.
   */
  private traceBoardwalk(beach: Beach): number {
    const line = this.longestRunnable(beach.boardwalk, STREET.maxGrade);
    if (polylineLength(line) < MIN_BOARDWALK) return -1;
    const head = this.reachNetwork(line[0] as Point);
    const tail = this.reachNetwork(line[line.length - 1] as Point);
    if (head.length === 0 && tail.length === 0) return -1;
    const points = [...[...head].reverse(), ...line, ...tail];
    return this.addCurve('street', points, [])?.id ?? -1;
  }

  /**
   * The longest run of a polyline a street may drive: dry ground the whole way,
   * inside the map, and no step steeper than the tier allows.
   */
  private longestRunnable(line: readonly Point[], maxGrade: number): Point[] {
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
  private reachNetwork(from: Point): Point[] {
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
  private routeToNetwork(
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
  private routeTo(from: Point, target: Point, island: number): Point[] | undefined {
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
  private stepHeading(x: number, y: number, heading: number, wanted: number, params: TierParams): Step | undefined {
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
  private reroute(
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
  private pathTo(end: number, from: Point, hit: Point, maxGrade: number): Point[] {
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
  private straighten(nodes: readonly Point[], maxGrade: number): Point[] {
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
  private nearestLandNode(p: Point, maxGrade: number): number {
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

  /** What the ground does under a straight span. {@link spanProfile} is the rule. */
  private probe(ax: number, ay: number, bx: number, by: number): Profile {
    return spanProfile(this.hf, this.seaLevel, ax, ay, bx, by);
  }

  /**
   * True when a road of this tier may run straight from one point to another:
   * dry ground all the way, and a climb the tier accepts. A span that is too
   * steep is refused here, which is what makes the caller look for another line.
   */
  private canRun(ax: number, ay: number, bx: number, by: number, maxGrade: number): boolean {
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
  private markStructures(points: readonly Point[], bridges: number[]): number[] {
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

  private addCurve(tier: RoadTier, points: Point[], bridges: number[], interchanges: number[] = []): RoadCurve | undefined {
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

/** The head of a polyline: its first point, and as much of it as `metres` covers. */
function trimTo(points: readonly Point[], metres: number): Point[] {
  const out: Point[] = [points[0] as Point];
  let run = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    run += dist(a.x, a.y, b.x, b.y);
    if (run > metres) break;
    out.push(b);
  }
  return out;
}

/**
 * The points of a highway a junction may stand at: its two ends, the point it
 * was seeded at, and one every {@link INTERCHANGE_SPACING} along it. Ascending.
 * Every other point of a highway takes no junction at all (spec section 6.2).
 */
function interchangesOf(points: readonly Point[], seedIndex: number): number[] {
  const at = new Array<boolean>(points.length).fill(false);
  at[0] = true;
  at[points.length - 1] = true;
  if (seedIndex > 0 && seedIndex < points.length) at[seedIndex] = true;
  let run = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    run += dist(a.x, a.y, b.x, b.y);
    if (run < INTERCHANGE_SPACING) continue;
    run = 0;
    at[i + 1] = true;
  }
  const out: number[] = [];
  for (let i = 0; i < at.length; i++) if (at[i] === true) out.push(i);
  return out;
}

/**
 * Of the points a polyline offers as `choices`, the one nearest each fraction
 * of its length. Each choice is taken at most once, so two fractions never
 * return the same place, and a fraction returns nothing once the choices run
 * out.
 */
function atFractions(points: readonly Point[], choices: readonly number[], fractions: readonly number[]): Point[] {
  const total = polylineLength(points);
  const taken: number[] = [];
  // Distance along the curve of every point, so an interchange can be measured.
  const run: number[] = [0];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    run.push((run[i] as number) + dist(a.x, a.y, b.x, b.y));
  }
  const out: Point[] = [];
  for (const f of fractions) {
    const wanted = total * f;
    let best = -1;
    let bestD = Infinity;
    for (const i of choices) {
      if (taken.includes(i)) continue;
      const d = Math.abs((run[i] as number) - wanted);
      if (d >= bestD) continue;
      bestD = d;
      best = i;
    }
    if (best < 0) continue;
    taken.push(best);
    out.push(points[best] as Point);
  }
  return out;
}

/**
 * Seeds for the next generation of the fill. Every `spacing` along a curve: one
 * seed to each side, that far out and pointing the same way, and, when `across`
 * is set, one on the curve itself pointing across it. The first two lay the
 * parallel roads that carry the traffic, the third the cross streets that tie
 * them together. An alley wants only the first two: it runs down the middle of
 * a block, and a block cross-hatched with alleys is no longer a block. The
 * spacing is asked for at each point, so it can follow the district under it.
 *
 * `ramps` says the tier being seeded may junction with a highway. Only the
 * arterial fill sets it, and even then a seed stands on a highway only at one
 * of its interchanges (spec section 6.2).
 */
function seedAlong(
  curve: RoadCurve,
  spacingAt: (x: number, y: number) => number,
  depth: number,
  out: FillSeed[],
  across = true,
  ramps = false,
): void {
  const points = curve.points;
  const head = points[0] as Point;
  let run = spacingAt(head.x, head.y) / 2;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const seg = dist(a.x, a.y, b.x, b.y);
    if (seg === 0) continue;
    // A deck or a bore seeds nothing: there is no ground beside the road there.
    const structure = curve.bridges.includes(i) || curve.tunnels.includes(i);
    run += seg;
    const spacing = spacingAt(b.x, b.y);
    if (run < spacing || structure) continue;
    run -= spacing;
    const along = Math.atan2(b.y - a.y, b.x - a.x);
    const nx = -Math.sin(along) * spacing;
    const ny = Math.cos(along) * spacing;
    for (const side of [1, -1]) {
      out.push({ x: b.x + nx * side, y: b.y + ny * side, along, parent: curve.id, depth, onParent: false });
    }
    // A seed on the curve itself grows a road out of a junction with it. A
    // highway takes one only at an interchange, and only from an arterial ramp
    // (spec section 6.2), so the minor fill seeds nothing on one.
    const junctionable = curve.tier !== 'highway' || (ramps && curve.interchanges.includes(i + 1));
    if (across && junctionable) out.push({ x: b.x, y: b.y, along: along + Math.PI / 2, parent: curve.id, depth, onParent: true });
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
