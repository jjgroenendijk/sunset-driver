/**
 * The ground every road is laid on, and the network laid on it so far: the
 * state a trace runs on, the rules the ground sets, and the route over the
 * terrain grid a road takes where its streamline cannot get through.
 *
 * `road-trace.ts` extends this with the trace itself. Every road goes into the
 * network through {@link RoadRoute.addCurve}.
 */
import { clamp, dist } from '../core/math.ts';
import { compareNumbers } from '../core/sort.ts';
import { atan2, cos, sin } from '../core/libm.ts';
import { AIRFIELD_KEEP, AirfieldMask } from './airfields.ts';
import { BeachGround, isResort } from './beaches.ts';
import { layoutZones, zoneAt, type ZoneLayout } from './districts.ts';
import { Heightfield } from './heightfield.ts';
import { crossingsWith, planHighway } from './highway-plan.ts';
import { DRY_MARGIN, groundRule, spanProfile, type Profile } from './road-ground.ts';
import { ANCHOR_REACH, ARTERIAL } from './road-params.ts';
import type { Trail } from './network-clearance.ts';
import { RoadNetwork, type RoadDraft } from './road-network.ts';
import { RiverWater } from './river-decks.ts';
import { overWater } from './piers.ts';
import { raised } from './overpass.ts';
import { waterRaises } from './water-lift.ts';
import { selfOverlap, stepOverlaps, untangle } from './self-overlap.ts';
import { coastNoise, islandAt, type CoastNoise } from './terrain.ts';
import type { TensorField } from './tensor.ts';
import type { Point, RoadCurve, RoadTier, WorldSkeleton } from './types.ts';

/** How close to the map edge a road may run, in metres. */
const EDGE_MARGIN = 80;
/**
 * Metres of cut and fill a road bed absorbs. Ground that stands higher than
 * `CUT` above the line the road drives is tunnelled through; ground that falls
 * further than `FILL` below it is carried on a deck. Fill is the cheaper of the
 * two on real ground, so it is allowed the deeper of the two.
 */
const CUT = 2.5;
const FILL = 4;
/** How many times its usual reach `straighten` looks for a segment where no short one keeps clear. */
const STRAIGHTEN_REACH = 3;
/** Routes a reroute may straighten and vet before it gives up on reaching its goal. */
const ROUTE_TRIES = 40;

/** The state every trace runs on: the ground, the field and the network laid so far. */
export abstract class RoadRoute {

  protected readonly world: WorldSkeleton;
  protected readonly field: TensorField;
  protected readonly hf: Heightfield;
  protected readonly seaLevel: number;
  protected readonly size: number;
  /** Half the map, less the margin roads keep from the edge. */
  protected readonly half: number;
  /**
   * The road graph laid so far: the store every road is added to, the points a
   * trace merges on, and the ground every step keeps off.
   */
  protected readonly network: RoadNetwork;
  /** The coastline's own noise, so a point can be told which island's land it stands on. */
  protected readonly noise: CoastNoise;
  /** Dry land, one flag per terrain node: the grid a rerouted road walks. */
  protected readonly land: Uint8Array;
  /** The beaches as ground, so the minor fill can be kept off the sand. */
  protected readonly sand: BeachGround;
  /** The zone rings of spec section 8.2. */
  protected readonly zones: ZoneLayout;
  /** The rivers as water an arterial may bridge on a short deck. */
  protected readonly rivers: RiverWater;
  /** Scratch for the reroute search, kept between routes so it is allocated once. */
  protected readonly came: Int32Array;
  protected readonly queue: Int32Array;
  /**
   * How many places the last reroute found that its goal accepted, vetted or
   * not. None means no goal stands on the ground it could walk, and a search
   * over less of that ground finds none either.
   */
  protected rerouteHits = 0;
  /** The airfields and their margins, as the router asks after them. */
  private readonly airfields: AirfieldMask;

  constructor(world: WorldSkeleton, field: TensorField) {
    this.world = world;
    this.field = field;
    this.hf = new Heightfield(world.terrain);
    this.seaLevel = world.water.seaLevel;
    this.size = world.size;
    this.half = world.size / 2 - EDGE_MARGIN;
    this.noise = coastNoise(world.seed);
    this.airfields = new AirfieldMask(world.airfields, AIRFIELD_KEEP, world.size);
    // The network decides each crossing on the ground the trace runs on.
    const ground = { canRun: groundRule(this.hf, this.seaLevel, this.keepOut), heightAt: (x: number, y: number) => this.hf.sample(x, y) };
    this.network = new RoadNetwork(world.size, (x, y) => this.islandOf(x, y), undefined, ground);
    const n = this.hf.gridSize;
    this.land = new Uint8Array(n * n);
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const x = this.hf.worldX(ix);
        const y = this.hf.worldY(iy);
        const inside = Math.abs(x) <= this.half && Math.abs(y) <= this.half && !this.keepOut(x, y);
        this.land[iy * n + ix] = inside && this.hf.at(ix, iy) >= this.seaLevel + DRY_MARGIN ? 1 : 0;
      }
    }
    // Only a resort is kept clear. A resort has a boardwalk to reach it by, so
    // a road turned away from its sand loses nothing. Every other beach is
    // reached by whatever road happens to run behind it, and a road kept off
    // that sand would leave it ground no road reaches — which `parcels.ts`
    // drops, so the beach would not be a parcel at all.
    this.sand = new BeachGround(world.beaches.filter(isResort), world.size, this.hf.cellSize);
    this.zones = layoutZones(world.size, world.core, world.water);
    this.rivers = new RiverWater(world.water.rivers, this.hf, this.seaLevel);
    this.came = new Int32Array(n * n);
    this.queue = new Int32Array(n * n);
  }

  /** Ground in a zone that builds a city: where a highway runs on a deck (`highway-plan.ts`). */
  protected readonly builtUp = (x: number, y: number): boolean => {
    const zone = zoneAt(this.zones, x, y);
    return zone !== 'outskirts' && zone !== 'wilderness';
  };

  /**
   * Ground inside an airfield or its margin (spec section 8.4). The roads keep
   * off it as they keep off the sea; the one road that serves an airfield starts
   * at its gate, outside the margin.
   */
  protected readonly keepOut = (x: number, y: number): boolean => this.airfields.has(x, y);

  /** Ground that is not the sand of a beach (spec section 7.3). */
  protected readonly offSand = (x: number, y: number): boolean => this.sand.sandAt(x, y) < 0;

  /** Which island's land a point stands on. */
  protected islandOf(x: number, y: number): number {
    return islandAt(this.world.water.islands, this.size, this.noise, x, y);
  }

  /**
   * A road over dry, gentle land from a point to whatever the goal accepts,
   * found breadth-first over the terrain grid. Diagonal steps need both of
   * their neighbours dry, so the polyline never clips a wet corner, and no step
   * climbs harder than the tier allows, so the route walks around a hill it may
   * not go over.
   *
   * The grid knows nothing of the roads on it, so the straightened route is
   * vetted as a trace is: a route that runs along another road, or meets one
   * at an angle no junction can be built at, is no route.
   */
  protected reroute(
    from: Point,
    maxGrade: number,
    tier: RoadTier,
    goal: (x: number, y: number, ix: number, iy: number) => Point | undefined,
    within?: (x: number, y: number) => boolean,
    vetSteps = false,
    before: readonly Point[] = [],
  ): Point[] | undefined {
    const hf = this.hf;
    const n = hf.gridSize;
    const straight = maxGrade * hf.cellSize;
    const diagonal = straight * Math.SQRT2;
    this.rerouteHits = 0;
    const start = this.nearestLandNode(from, maxGrade);
    if (start < 0) return undefined;
    const came = this.came;
    const queue = this.queue;
    came.fill(-1);
    came[start] = start;
    queue[0] = start;
    let head = 0;
    let tail = 1;
    let tries = 0;
    while (head < tail) {
      const at = queue[head++] as number;
      const ix = at % n;
      const iy = (at - ix) / n;
      const hit = goal(hf.worldX(ix), hf.worldY(iy), ix, iy);
      if (hit !== undefined) this.rerouteHits++;
      if (hit !== undefined && tries++ < ROUTE_TRIES) {
        const path = this.untangled(this.pathTo(at, from, hit, maxGrade, tier, before), tier, maxGrade);
        if (path !== undefined && this.keepsClear(path, tier, before)) return path;
        // Every try is spent, so nothing the search reaches from here is tried.
        if (tries === ROUTE_TRIES) return undefined;
      }
      // The step that reached this node. A road that turns more than a right
      // angle within one cell of the grid folds over its own carriageway.
      const back = came[at] as number;
      const inX = ix - (back % n);
      const inY = iy - (back - (back % n)) / n;
      for (let k = 0; k < NEIGHBOUR_X.length; k++) {
        const dx = NEIGHBOUR_X[k] as number;
        const dy = NEIGHBOUR_Y[k] as number;
        if (dx * inX + dy * inY < 0) continue;
        const jx = ix + dx;
        const jy = iy + dy;
        if (jx < 0 || jy < 0 || jx >= n || jy >= n) continue;
        const to = jy * n + jx;
        if (came[to] !== -1 || this.land[to] === 0) continue;
        if (dx !== 0 && dy !== 0 && (this.land[iy * n + jx] === 0 || this.land[jy * n + ix] === 0)) continue;
        if (within !== undefined && !within(hf.worldX(jx), hf.worldY(jy))) continue;
        const rise = Math.abs(hf.at(jx, jy) - hf.at(ix, iy));
        if (rise > (dx !== 0 && dy !== 0 ? diagonal : straight)) continue;
        if (vetSteps && !this.network.stepOk({ x: hf.worldX(ix), y: hf.worldY(iy) }, { x: hf.worldX(jx), y: hf.worldY(jy) }, tier)) continue;
        came[to] = at;
        queue[tail++] = to;
      }
    }
    return undefined;
  }

  /**
   * A proposed road with the stretches that turn back over its own carriageway
   * cut out, each cut a straight run the tier can drive and that keeps off the
   * roads it passes; undefined where a cut cannot be made (`self-overlap.ts`).
   */
  protected untangled(points: readonly Point[], tier: RoadTier, maxGrade: number): Point[] | undefined {
    return untangle(points, tier, (a, b) => this.canRun(a.x, a.y, b.x, b.y, maxGrade) && this.network.stepOk(a, b, tier));
  }

  /** Walk the breadth-first tree back to the start, then straighten the staircase it left. */
  protected pathTo(end: number, from: Point, hit: Point, maxGrade: number, tier: RoadTier, before: readonly Point[] = []): Point[] {
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
    return this.straighten(nodes, maxGrade, tier, before);
  }

  /**
   * True when every step of a route keeps off the roads it passes and off the
   * route's own carriageway, and its last point meets the one it ends on.
   * `before` is the road the route carries on from, ending where it starts.
   */
  protected keepsClear(route: readonly Point[], tier: RoadTier, before: readonly Point[] = []): boolean {
    if (selfOverlap([...before.slice(0, -1), ...route], tier) !== undefined) return false;
    const trail: Trail = { crossed: [], start: route[0] };
    for (let i = 0; i + 2 < route.length; i++) {
      if (!this.network.stepOk(route[i] as Point, route[i + 1] as Point, tier, trail)) return false;
    }
    if (route.length < 2) return true;
    return this.network.meets(route[route.length - 1] as Point, route[route.length - 2] as Point, tier, trail);
  }

  /**
   * Drop the nodes a road does not need: keep the furthest point still joined to
   * the last kept one by a straight line the tier can drive, that keeps off the
   * roads it passes, and that does not turn back over the points kept before
   * it. Every kept segment is checked, so the result stays on land and inside
   * the grade.
   */
  protected straighten(nodes: readonly Point[], maxGrade: number, tier: RoadTier, before: readonly Point[] = []): Point[] {
    const reach = ARTERIAL.step * 3;
    const out: Point[] = [nodes[0] as Point];
    let anchor = 0;
    while (anchor < nodes.length - 1) {
      const a = nodes[anchor] as Point;
      let next = -1;
      const fits: number[] = [];
      for (let i = anchor + 1; i < nodes.length; i++) {
        const b = nodes[i] as Point;
        // The grid only steps along its axes and diagonals, so a road it meets
        // at a shallow angle can refuse every short segment. Then the search
        // reaches further for one that crosses it cleanly.
        const far = dist(a.x, a.y, b.x, b.y);
        if (far > reach * (next < 0 ? STRAIGHTEN_REACH : 1)) break;
        const last = i === nodes.length - 1;
        if (i > anchor + 1 && !this.canRun(a.x, a.y, b.x, b.y, maxGrade)) continue;
        if (last ? this.network.meets(b, a, tier) : this.network.stepOk(a, b, tier)) {
          next = i;
          fits.push(i);
        } else if (i === anchor + 1) continue;
        if (next >= 0 && far > reach) break;
      }
      // The furthest node that fits is kept, unless it turns back over the
      // points kept before it; then the next furthest is.
      next = fits.reverse().find((i) => !stepOverlaps(out, nodes[i] as Point, tier, before)) ?? anchor + 1;
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
   * stands on something: every place that will do, best first. Walks away from
   * the water first, then searches around. Which island the ground belongs to
   * is not asked here: the caller decides which end of the crossing is which by
   * trying to reach the network from it.
   */
  protected dryAnchors(shore: Point, across: Point): Point[] {
    const away = atan2(shore.y - across.y, shore.x - across.x);
    const out: Point[] = [];
    for (let s = 0; s <= ANCHOR_REACH; s += 5) {
      const p = { x: shore.x + cos(away) * s, y: shore.y + sin(away) * s };
      if (this.acceptAnchor(p)) out.push(p);
    }
    for (let s = 10; s <= ANCHOR_REACH; s += 10) {
      for (let k = 1; k < 24; k++) {
        const a = away + (k * Math.PI) / 12;
        const p = { x: shore.x + cos(a) * s, y: shore.y + sin(a) * s };
        if (this.acceptAnchor(p)) out.push(p);
      }
    }
    return out;
  }

  /** A bridge head stands on dry ground inside the map, clear of every road it does not meet. */
  protected acceptAnchor(p: Point): boolean {
    if (Math.abs(p.x) > this.half || Math.abs(p.y) > this.half) return false;
    return this.isDry(p.x, p.y) && this.network.clearAt(p.x, p.y, 'arterial');
  }

  protected isDry(x: number, y: number): boolean {
    return this.hf.sample(x, y) >= this.seaLevel + DRY_MARGIN && !this.keepOut(x, y);
  }

  /** What the ground does under a straight span. {@link spanProfile} is the rule. */
  protected probe(ax: number, ay: number, bx: number, by: number): Profile {
    return spanProfile(this.hf, this.seaLevel, ax, ay, bx, by, 0, 0, this.keepOut);
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
   * more than {@link FILL} below it is carried on a deck, and so is a span a
   * trace laid across a river (`river-decks.ts`). The decks already in
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
      if (!profile.dry && this.rivers.spans(a, b)) {
        bridges.push(i);
        continue;
      }
      if (profile.above <= CUT && profile.below <= FILL) continue;
      // Whichever the ground overruns by more decides which structure it takes.
      if (profile.above - CUT >= profile.below - FILL) tunnels.push(i);
      else bridges.push(i);
    }
    bridges.sort(compareNumbers);
    return tunnels;
  }

  /**
   * A highway's interchanges, with one more at each strait crossing whose shore
   * it runs past. A highway along the shore takes the ground a bridge head
   * would stand on, and a bridge may cross it only under a slot; the ramps of
   * a deck can stand just there. An interchange there lets the bridge join the
   * highway instead.
   */
  private withBridgeHeads(points: readonly Point[], bridges: readonly number[], tunnels: readonly number[], interchanges: readonly number[]): number[] {
    const out = interchanges.slice();
    const last = points.length - 1;
    for (const crossing of this.world.water.crossings) {
      for (const shore of [crossing.from, crossing.to]) {
        let best = -1;
        let bestD = ANCHOR_REACH / 2;
        for (let i = 1; i < last; i++) {
          const p = points[i] as Point;
          const d = dist(p.x, p.y, shore.x, shore.y);
          if (d >= bestD) continue;
          bestD = d;
          best = i;
        }
        if (best < 0) continue;
        // The junction stands on the ground, so neither segment beside it is a structure.
        if ([...bridges, ...tunnels].some((i) => i === best || i === best - 1)) continue;
        if (out.some((i) => dist((points[i] as Point).x, (points[i] as Point).y, shore.x, shore.y) < ANCHOR_REACH)) continue;
        out.push(best);
      }
    }
    return out.sort(compareNumbers);
  }

  /** Every road laid so far, by id. */
  protected get curves(): readonly RoadCurve[] {
    return this.network.curves;
  }

  /**
   * Propose a road to the network, which joins it to the roads it meets or
   * refuses it (`road-network.ts`). A highway's decks and slots are planned
   * here, before the road goes in, so every road laid after it is traced
   * against them.
   */
  protected addCurve(tier: RoadTier, points: Point[], bridges: number[], interchanges: number[] = [], whole = false): RoadCurve | undefined {
    if (points.length < 2) return undefined;
    const tunnels = this.markStructures(points, bridges);
    const draft: RoadDraft = { tier, points, bridges, tunnels, interchanges };
    let under: readonly number[] | undefined;
    if (tier === 'highway') {
      draft.interchanges = this.withBridgeHeads(points, bridges, tunnels, interchanges);
      // A highway passes under one laid before it on the ground, since the one
      // before it is on its deck there.
      under = crossingsWith(points, this.curves.filter((c) => c.tier === 'highway'));
      const plan = planHighway(points, bridges, tunnels, draft.interchanges, under, this.builtUp);
      draft.bridges = plan.bridges;
      draft.slots = plan.slots;
      if (plan.lift !== undefined) draft.lift = plan.lift;
    }
    return this.network.add(this.liftOverWater(draft, under), whole);
  }

  /**
   * The draft with its decks over water raised clear of the sea
   * (`water-lift.ts`). Every raise is laid in on its own, so one the crossing
   * plan would then refuse does not cost the road the others. The knots of a
   * raise are the two ends of a deck the line already has, so no raise moves a
   * point and the distances the next one was measured at still hold.
   *
   * A road with no deck at all has nothing over water, which is most of them,
   * so the crossings with the highways are only looked for once a deck says
   * they might be needed. Where the line passes under a highway it stays on
   * the ground: the highway is on its deck there, and a road is never raised
   * over one.
   */
  private liftOverWater(draft: RoadDraft, highways: readonly number[] | undefined): RoadDraft {
    if (draft.bridges.length === 0) return draft;
    const ground = (x: number, y: number): number => this.hf.sample(x, y);
    const wet = (a: Point, b: Point): boolean => overWater(this.hf, this.seaLevel, a, b);
    const onNetwork = (p: Point): boolean => this.network.nodeAt(p).length > 0;
    const under = highways ?? crossingsWith(draft.points, this.curves.filter((c) => c.tier === 'highway'));
    let out = draft;
    for (const raise of waterRaises(draft, ground, this.seaLevel, wet, under, onNetwork)) {
      const lifted = this.onFill(raised(out, [raise]));
      if (this.decksAtSlots(lifted)) out = lifted;
    }
    return out;
  }

  /**
   * The line with the ramps of a raise given back to the ground they stand on.
   *
   * `raised` lists every segment it lifts as a deck, which is what the level
   * top of an overpass is. A bridge approach is not: it climbs from the ground
   * to the abutment, and a road standing no more than {@link FILL} over the
   * ground is carried on fill the carve makes up, exactly as
   * {@link RoadRoute.markStructures} reads it. That matters far past the
   * drawing. A road on fill is on the ground, so a street laid later crosses it
   * and meets it at a junction; a road on a deck is not, so the street is
   * refused and the block it would have cut is lost (issue #593).
   *
   * Only a segment the raise itself lifted is reconsidered, and one over water
   * or over a dip deeper than the fill stays the deck it was: the ground under
   * a raised line falls further below it than it did before, never less, so
   * this can only ever give back a deck the raise added.
   */
  private onFill(line: RoadDraft): RoadDraft {
    const bridges = line.bridges.filter((at) => this.standsOff(line, at));
    return bridges.length === line.bridges.length ? line : { ...line, bridges };
  }

  /** True where a segment of a raised line has to be a deck: over water, over a river, or over a dip the fill cannot make up. */
  private standsOff(line: RoadDraft, at: number): boolean {
    const liftA = line.lift?.[at] ?? 0;
    const liftB = line.lift?.[at + 1] ?? 0;
    if (liftA <= 0 && liftB <= 0) return true;
    const a = line.points[at] as Point;
    const b = line.points[at + 1] as Point;
    const profile = spanProfile(this.hf, this.seaLevel, a.x, a.y, b.x, b.y, liftA, liftB, this.keepOut);
    if (!profile.dry) return true;
    if (this.rivers.spans(a, b)) return true;
    return profile.below > FILL;
  }

  /**
   * True where every raised deck of a line crosses a highway only at one of its
   * slots. A ramp turns ground into deck, and a deck is held to the rule the
   * trace held the ground to (`island-links.ts`).
   */
  private decksAtSlots(line: RoadDraft): boolean {
    for (const at of line.bridges) {
      if ((line.lift?.[at] ?? 0) <= 0 && (line.lift?.[at + 1] ?? 0) <= 0) continue;
      const a = line.points[at] as Point;
      const b = line.points[at + 1] as Point;
      if (!this.network.crossesAtSlots(a, b, line.tier)) return false;
    }
    return true;
  }
}

/** Eight-way steps of the reroute search, straight ones first. */
const NEIGHBOUR_X = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBOUR_Y = [0, 0, 1, -1, 1, -1, 1, -1];
