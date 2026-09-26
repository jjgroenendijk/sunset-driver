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
 * That state, the ground rules and the reroute are `road-route.ts`, which this
 * extends. Every road goes in through {@link RoadRoute.addCurve}.
 */
import { clamp, dist, wrapAngle } from '../../core/math.ts';
import { atan2, cos, hypot, sin } from '../../core/libm.ts';
import { ARTERIAL, STREET, type TierParams } from './road-params.ts';
import type { Trail } from './network-clearance.ts';
import type { NetworkHit } from './road-network.ts';
import { RIVER_DECK } from '../decks/river-decks.ts';
import { RoadRoute } from './road-route.ts';
import { stepOverlaps } from './self-overlap.ts';
import type { Point, RoadTier } from '../types.ts';

// The numbers a trace runs on and the rule it asks the ground are next door;
// callers read them through here, as they did while the three were one file.
export * from './road-params.ts';

/** Steps of the fan a step searches when water blocks the way, and the hardest turn water may force. */
const AVOID_STEPS = 6;
const AVOID_TURNS = 3;
/** Turns off the wanted heading a trace tries a river deck at before it turns along the bank. */
const RIVER_TURNS = 1;
/** Steps without getting closer to the target before a guided trace gives up. */
const STALL_STEPS = 12;
/**
 * Steps a road may span in one go where no ordinary step is left, and the
 * metres of rock a bore may carry or a deck may stand above the ground. Between
 * them they bound a structure: long enough to get through a ridge or over a
 * ravine, short enough that the road never leaps a valley.
 */
const SPAN_STEPS = 8;
const MAX_COVER = 25;
/** Points of the network near a step that a merge tries, nearest first. */
const MERGE_TRIES = 4;
/** Radians the last step of a merge may turn from the road's heading. */
const MAX_MERGE_TURN = Math.PI / 2;
/** Metres off its circle at which a ring trace turns back towards it as hard as it may. */
const RING_PULL = 120;
/** Radians off the tangent a ring trace heads at most, to get back onto its circle. */
const RING_TURN = Math.PI / 4;

/** Share of a square ring's half-side its corners are rounded over. */
const SQUARE_CORNER = 0.5;

/** A circle, or a square with rounded corners, that a trace runs round instead of following the field. */
export interface Ring {
  x: number;
  y: number;
  /** The circle's radius, or the square's half-side. */
  radius: number;
  /** Radians of the ring the trace may sweep, measured round its middle, before it stops. */
  sweep: number;
  /** The heading of one pair of the square's sides, or undefined for a circle. */
  square?: number;
}

/** What a trace is asked to do. */
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
  /** Run round this circle rather than along the field: the ring highway of `highways.ts`. */
  around?: Ring;
  /** The road the trace carries on from, ending at its start, which it may not turn back over. */
  before?: readonly Point[];
  /**
   * The junction a trace that starts one step off the network leaves from.
   * The steps may pass the ends of the roads there, as a trace that starts
   * on the junction may.
   */
  junction?: Point;
}

/** One step of a trace: which way it goes, and how far it reaches. */
interface Step {
  heading: number;
  /** Metres to the next point. A step that spans a structure reaches further. */
  reach: number;
}

/** The answer of a search for a step when a climb too hard for the tier turned one away. Compared by identity. */
const STEEP: Step = { heading: 0, reach: 0 };

interface TraceResult {
  points: Point[];
  /** Ended on an existing road. */
  merged: boolean;
  /** Ended at the target. */
  arrived: boolean;
  /**
   * One flag per point: whether the road may end there, with its footprint on
   * no other road's. The first point is where the trace was asked to start, so
   * it always may.
   */
  clear: boolean[];
  /** Radians the trace swept round its ring; 0 for a trace with none. */
  swept: number;
}

/** A trace as it is laid, step by step: see {@link RoadTrace.trace}. */
interface TraceState {
  points: Point[];
  clear: boolean[];
  trail: Trail;
  /** The last point laid, and the heading of the step that reached it. */
  px: number;
  py: number;
  heading: number;
  /** Metres laid so far. */
  length: number;
  merged: boolean;
  arrived: boolean;
  /** The nearest the trace has come to its target, and the steps since it came nearer. */
  closest: number;
  stalled: number;
  /** The heading out from the ring's middle to the last point, and the radians swept round it. */
  bearing: number;
  swept: number;
}

/** Add the last step's sweep round the ring the trace runs round. True where the trace has swept all it may. */
function sweptRound(st: TraceState, ring: Ring | undefined): boolean {
  if (ring === undefined) return false;
  const now = atan2(st.py - ring.y, st.px - ring.x);
  st.swept += Math.abs(wrapAngle(now - st.bearing));
  st.bearing = now;
  return st.swept >= ring.sweep;
}

/** A trace over the ground and the network {@link RoadRoute} holds. */
export abstract class RoadTrace extends RoadRoute {

  /**
   * The longest run of a polyline a street may drive: dry ground the whole way,
   * inside the map, no step steeper than the tier allows, no step along
   * another road's carriageway, and none back over the run's own. A run ends
   * where the street may end.
   */
  protected longestRunnable(line: readonly Point[], maxGrade: number): Point[] {
    return this.runnableRuns(line, maxGrade)[0] ?? [];
  }

  /**
   * Every run of a polyline a street may drive, longest first. The ground cuts
   * a line into runs, and the longest of them is the one road worth laying —
   * unless it turns out to reach nothing, which is only known once a way on to
   * the network is looked for. So the caller is handed all of them in turn.
   */
  protected runnableRuns(line: readonly Point[], maxGrade: number): Point[][] {
    const inside = (p: Point): boolean => Math.abs(p.x) <= this.half && Math.abs(p.y) <= this.half;
    const ends = (p: Point): boolean => inside(p) && this.network.clearAt(p.x, p.y, 'street');
    const found: Point[][] = [];
    let run: Point[] = [];
    const close = (): void => {
      while (run.length > 0 && !ends(run[run.length - 1] as Point)) run.pop();
      if (run.length > 1) found.push(run);
    };
    for (const p of line) {
      const last = run[run.length - 1];
      const runs = (from: Point): boolean => inside(p) && this.canRun(from.x, from.y, p.x, p.y, maxGrade) && this.network.stepOk(from, p, 'street');
      // A line that turns back over itself at one point is a spike, and the
      // point is dropped rather than the line cut there.
      const spike = run[run.length - 2];
      if (last !== undefined && spike !== undefined && runs(last) && stepOverlaps(run, p, 'street') && runs(spike) && !stepOverlaps(run.slice(0, -1), p, 'street')) {
        run[run.length - 1] = p;
        continue;
      }
      if (last === undefined ? !ends(p) : !runs(last) || stepOverlaps(run, p, 'street')) {
        close();
        run = ends(p) ? [p] : [];
        continue;
      }
      run.push(p);
    }
    close();
    // A stable sort, so two runs of the same length stay in the order the line
    // laid them down.
    return found.sort((a, b) => b.length - a.length);
  }

  /**
   * A street from one end of a boardwalk to the network, without its first
   * point, so the boardwalk itself carries the join. Empty where the network is
   * out of reach.
   *
   * `boardwalk` is the line the way on carries on from, ending at `from`. The
   * road behind a beach runs along it, so a route that read nothing of the
   * boardwalk comes back beside it and the two are one folded street. The fold
   * would then be cut out of the boardwalk itself, a point at a time, until
   * there was no boardwalk left to lay.
   */
  protected reachNetwork(from: Point, boardwalk: readonly Point[] = []): Point[] {
    const island = this.islandOf(from.x, from.y);
    const route =
      this.routeToNetwork(from, island, 'street', STREET, undefined, false, boardwalk) ??
      this.routeToNetwork(from, island, 'street', STREET);
    return route === undefined ? [] : route.slice(1);
  }

  // ------------------------------------------------------------------ routes

  /**
   * A road from a point to the network on its own island: streamline first,
   * reroute second. `within` is ground the road would rather keep to; a route
   * that cannot be found inside it is looked for again without it, because
   * reaching the network matters more than any ground does. Last, it is looked
   * for once more with every grid step kept off the roads it passes. `before`
   * is the road the route carries on from, ending at `from`.
   */
  protected routeToNetwork(
    from: Point,
    island: number,
    joiner: RoadTier = 'arterial',
    params: TierParams = ARTERIAL,
    within?: (x: number, y: number) => boolean,
    vetSteps = false,
    before: readonly Point[] = [],
  ): Point[] | undefined {
    const target = this.network.nearestOnIsland(from.x, from.y, island, joiner);
    if (target !== undefined) {
      const traced = this.trace(from, { params, joiner, target, mergeAfter: 0, within, before });
      if (traced.merged || traced.arrived) return traced.points;
    }
    if (this.network.empty) return undefined;
    const route = this.reroute(
      from,
      params.maxGrade,
      joiner,
      (x, y) => {
        const hit = this.network.nearest(x, y, params.mergeRadius, -1, joiner);
        if (hit === undefined || this.network.refuses(hit.x, hit.y, joiner)) return undefined;
        if (!this.network.meets(hit, { x, y }, joiner)) return undefined;
        return this.canRun(x, y, hit.x, hit.y, params.maxGrade) ? hit : undefined;
      },
      within,
      vetSteps,
      before,
    );
    if (route !== undefined || vetSteps) return route;
    if (within !== undefined) return this.routeToNetwork(from, island, joiner, params, undefined, false, before);
    // Vetting the steps only takes ground away, so where the goal was nowhere
    // on the ground the search walked, it is nowhere on less of it.
    if (this.rerouteHits === 0) return undefined;
    // The grid steps along its axes and diagonals only, so where it has to
    // cross a road that runs a few degrees off them, the shortest route runs
    // along that road for a while and is refused. Vetting every grid step as
    // well finds the route that crosses it cleanly.
    return this.routeToNetwork(from, island, joiner, params, undefined, true, before);
  }

  /**
   * An arterial from a point to a place: streamline first, reroute second.
   * `before` is the road it carries on from, ending at `from`.
   */
  protected routeTo(from: Point, target: Point, island: number, before: readonly Point[] = []): Point[] | undefined {
    const traced = this.trace(from, { params: ARTERIAL, joiner: 'arterial', target, mergeAfter: 0, before });
    if (traced.merged || traced.arrived) return traced.points;
    const goalIx = this.node(target.x);
    const goalIy = this.node(target.y);
    const route = this.reroute(from, ARTERIAL.maxGrade, 'arterial', (x, y, ix, iy) =>
      ix === goalIx && iy === goalIy && this.canRun(x, y, target.x, target.y, ARTERIAL.maxGrade)
        ? { x: target.x, y: target.y }
        : undefined,
      undefined,
      false,
      before,
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
   *
   * No step runs along another road, and a road meets another only at an angle
   * a junction can be built at (`network-clearance.ts`). A trace that stops for
   * any other reason is walked back to the last point clear of every other
   * road, so it never ends inside another road's carriageway.
   */
  protected trace(start: Point, opt: TraceOptions): TraceResult {
    const maxLength = opt.params.maxLength * this.size;
    const ring = opt.around;
    const st: TraceState = {
      points: [{ x: start.x, y: start.y }],
      clear: [true],
      trail: { crossed: [], start: opt.junction ?? start },
      px: start.x,
      py: start.y,
      heading: opt.heading ?? this.startHeading(start, opt),
      length: 0,
      merged: false,
      arrived: false,
      closest: opt.target === undefined ? 0 : dist(start.x, start.y, opt.target.x, opt.target.y),
      stalled: 0,
      bearing: ring === undefined ? 0 : atan2(start.y - ring.y, start.x - ring.x),
      swept: 0,
    };
    while (st.length < maxLength) {
      if (!this.traceStep(st, opt)) break;
    }
    const { points, clear } = st;
    if (!st.merged && !st.arrived) {
      while (points.length > 1 && clear[clear.length - 1] !== true) {
        points.pop();
        clear.pop();
      }
    }
    return { points, merged: st.merged, arrived: st.arrived, clear, swept: st.swept };
  }

  /** Take one step of a trace. False where the trace ends here. */
  private traceStep(st: TraceState, opt: TraceOptions): boolean {
    const params = opt.params;
    const wanted = this.desiredHeading(st.px, st.py, st.heading, opt);
    let next = this.stepHeading(st.px, st.py, st.heading, wanted, params);
    if (next === undefined) return false;
    let qx = st.px + cos(next.heading) * next.reach;
    let qy = st.py + sin(next.heading) * next.reach;
    if (Math.abs(qx) > this.half || Math.abs(qy) > this.half) return false;
    if (opt.within !== undefined && !opt.within(qx, qy)) return false;
    const here = { x: st.px, y: st.py };
    if (this.mergeStep(st, opt, qx, qy, here)) return false;
    // Whether this road may junction with the one it comes near or not, it
    // crosses it or leaves it; it never runs along it. A road coming in too
    // shallow turns until it does, and stops where no turn is left.
    if (!this.network.stepOk(here, { x: qx, y: qy }, opt.joiner, st.trail)) {
      next = this.turnClear(here, st.heading, next, opt, st.trail);
      if (next === undefined) return false;
      qx = st.px + cos(next.heading) * next.reach;
      qy = st.py + sin(next.heading) * next.reach;
    }
    // A road never comes back onto its own carriageway: it ends where the
    // next step would, as it ends where the field curls it back.
    if (foldsBack(st.points, qx, qy, params.step) || stepOverlaps(st.points, { x: qx, y: qy }, opt.joiner, opt.before)) return false;

    st.points.push({ x: qx, y: qy });
    st.clear.push(this.network.clearAt(qx, qy, opt.joiner));
    st.length += next.reach;
    st.heading = next.heading;
    st.px = qx;
    st.py = qy;
    if (sweptRound(st, opt.around)) return false;
    return this.approach(st, opt);
  }

  /**
   * End the trace on a road near the step to `(qx, qy)`, where it may merge
   * into one. A road joins any other road on close approach, but only rejoins
   * the one it branched off after it has gone somewhere. True where it merged.
   */
  private mergeStep(st: TraceState, opt: TraceOptions, qx: number, qy: number, here: Point): boolean {
    const params = opt.params;
    const mergeAfter = opt.mergeAfter ?? 0;
    const parent = opt.parentCurve ?? -1;
    const candidates = st.length >= mergeAfter ? this.network.within(qx, qy, params.mergeRadius, parent, opt.joiner) : [];
    if (candidates.length === 0 && parent >= 0 && st.length >= (opt.parentMergeAfter ?? mergeAfter)) {
      candidates.push(...this.network.within(qx, qy, params.mergeRadius, -1, opt.joiner));
    }
    const turnsBack = (p: Point): boolean => stepOverlaps(st.points, p, opt.joiner, opt.before);
    const hit = this.mergeAt(candidates, here, st.heading, opt.joiner, params, st.trail, turnsBack);
    if (hit === undefined) return false;
    st.points.push({ x: hit.x, y: hit.y });
    st.clear.push(true);
    st.merged = true;
    return true;
  }

  /**
   * Close on the target of a guided trace, ending the trace where it arrives
   * or stalls. False where the trace ends here.
   */
  private approach(st: TraceState, opt: TraceOptions): boolean {
    const target = opt.target;
    if (target === undefined) return true;
    const d = dist(st.px, st.py, target.x, target.y);
    if (d <= opt.params.step * 1.5) {
      this.arrive(st, opt, target);
      return false;
    }
    if (d < st.closest - 1) {
      st.closest = d;
      st.stalled = 0;
      return true;
    }
    return ++st.stalled <= STALL_STEPS;
  }

  /**
   * End the trace on its target. Only an arrival that can be driven counts: a
   * last step over water or up a wall is no arrival, and the caller reroutes
   * instead.
   */
  private arrive(st: TraceState, opt: TraceOptions, target: Point): void {
    if (!this.canRun(st.px, st.py, target.x, target.y, opt.params.maxGrade)) return;
    if (this.network.refuses(target.x, target.y, opt.joiner)) return;
    if (!this.network.meets(target, { x: st.px, y: st.py }, opt.joiner, st.trail)) return;
    if (stepOverlaps(st.points, target, opt.joiner, opt.before)) return;
    st.points.push({ x: target.x, y: target.y });
    st.clear.push(true);
    st.arrived = true;
  }

  /**
   * The first of the network's points near a step, nearest first, that the
   * road may end on from `from`. Roads that meet share their point, so a road
   * merging where two others already meet joins both, and a street merging
   * into an arterial ramp on its last point would junction with the highway
   * under it, which spec section 6.2 refuses. A road that meets another along
   * its line lies in its carriageway, so a merge is taken only at an angle a
   * junction can be built at, and never by turning back onto a road the trace
   * has just stepped across, nor over the road's own carriageway (`turnsBack`).
   * The nearest point can fail where the one beside it does not, so a few are
   * tried.
   */
  protected mergeAt(
    candidates: readonly NetworkHit[],
    from: Point,
    heading: number,
    joiner: RoadTier,
    params: TierParams,
    trail: Trail,
    turnsBack: (p: Point) => boolean = () => false,
  ): NetworkHit | undefined {
    for (const hit of candidates.slice(0, MERGE_TRIES)) {
      if (this.network.refuses(hit.x, hit.y, joiner)) continue;
      if (Math.abs(wrapAngle(atan2(hit.y - from.y, hit.x - from.x) - heading)) > MAX_MERGE_TURN) continue;
      if (!this.network.meets(hit, from, joiner, trail)) continue;
      if (this.canRun(from.x, from.y, hit.x, hit.y, params.maxGrade) && !turnsBack(hit)) return hit;
    }
    return undefined;
  }

  /**
   * A step turned off `step` by as little as the tier's turns allow, onto one
   * that keeps clear of the roads it passes, over ground the step may take.
   * Nothing where no turn is left. The same fan {@link stepHeading} searches
   * where water blocks the way.
   */
  protected turnClear(from: Point, heading: number, step: Step, opt: TraceOptions, trail: Trail): Step | undefined {
    const params = opt.params;
    const limit = params.maxTurn * AVOID_TURNS;
    const here = this.hf.sample(from.x, from.y);
    for (let k = 1; k <= AVOID_TURNS; k++) {
      for (const sign of [1, -1]) {
        const h = step.heading + sign * k * params.maxTurn;
        if (Math.abs(wrapAngle(h - heading)) > limit) continue;
        const to = { x: from.x + cos(h) * step.reach, y: from.y + sin(h) * step.reach };
        if (this.turnFits(from, to, here, step.reach, opt, trail)) return { heading: h, reach: step.reach };
      }
    }
    return undefined;
  }

  /** True where the turned step of {@link turnClear} from `from` to `to` stays on the map and on ground it may take, clear of the roads. */
  private turnFits(from: Point, to: Point, here: number, reach: number, opt: TraceOptions, trail: Trail): boolean {
    if (Math.abs(to.x) > this.half || Math.abs(to.y) > this.half) return false;
    if (opt.within !== undefined && !opt.within(to.x, to.y)) return false;
    if (Math.abs(this.hf.sample(to.x, to.y) - here) / reach > opt.params.maxGrade) return false;
    const profile = this.probe(from.x, from.y, to.x, to.y);
    if (!profile.dry || profile.above > MAX_COVER || profile.below > MAX_COVER) return false;
    return this.network.stepOk(from, to, opt.joiner, trail);
  }

  /** The field's line through a point: its major direction, or the cross street. */
  protected fieldLine(p: Point, minor: boolean | undefined): number {
    const major = this.field.majorAt(p.x, p.y);
    return minor === true ? major + Math.PI / 2 : major;
  }

  protected startHeading(start: Point, opt: TraceOptions): number {
    const line = this.fieldLine(start, opt.minor);
    return opt.target === undefined ? line : alignTo(line, atan2(opt.target.y - start.y, opt.target.x - start.x));
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
    const ring = opt.around;
    if (ring !== undefined) {
      // Along the ring the way the road is already going, turned in towards
      // it when the road has drifted out and out when it has drifted in.
      const { out, off } = ringOffset(ring, x, y);
      const tangent = alignTo(out + Math.PI / 2, heading);
      const inward = wrapAngle(out + Math.PI - tangent) > 0 ? 1 : -1;
      wanted = tangent + inward * clamp(off / RING_PULL, -1, 1) * RING_TURN;
    } else if (target === undefined) {
      wanted = alignTo(line, heading);
    } else {
      const bearing = atan2(target.y - y, target.x - x);
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
      const found = this.fanAt(x, y, heading, wanted, params, span, here, limit);
      // Spanning further is for ground the road may not climb. Where water was
      // what stopped it, the road stops too: a deck belongs at a strait
      // crossing of the water description or across a river met nearly
      // head on, not wherever a trace ran out.
      if (found !== STEEP) return found;
    }
    return undefined;
  }

  /**
   * The first step of {@link stepHeading}'s fan at one span that the ground
   * takes; else {@link STEEP} where a climb turned one away, and undefined
   * where only water did.
   */
  private fanAt(x: number, y: number, heading: number, wanted: number, params: TierParams, span: number, here: number, limit: number): Step | undefined {
    const reach = params.step * span;
    let steep = false;
    for (let k = 0; k <= AVOID_STEPS; k++) {
      for (const sign of k === 0 ? [1] : [1, -1]) {
        const h = wanted + sign * k * params.maxTurn;
        if (Math.abs(wrapAngle(h - heading)) > limit) continue;
        const found = this.stepAlong(x, y, h, reach, span === 1 && k <= RIVER_TURNS, params, here);
        if (found === STEEP) steep = true;
        else if (found !== undefined) return found;
      }
    }
    return steep ? STEEP : undefined;
  }

  /**
   * One step of `reach` metres along heading `h`, where the ground takes it;
   * {@link STEEP} where the climb is too hard, and undefined where it is wet
   * or too far over or under the ground. `river` says whether a river met
   * here may be decked.
   */
  private stepAlong(x: number, y: number, h: number, reach: number, river: boolean, params: TierParams, here: number): Step | undefined {
    const qx = x + cos(h) * reach;
    const qy = y + sin(h) * reach;
    // A river met nearly head on is crossed rather than followed, by a
    // tier that bridges rivers, so its two banks are one network (issue #276).
    if (river && params.bridgesRivers === true && !this.probe(x, y, qx, qy).dry) {
      const deck = this.riverDeck(x, y, h, params);
      if (deck !== undefined) return deck;
    }
    // The climb between the two ends costs two samples and turns most
    // candidates away; only what survives it is worth walking over.
    if (Math.abs(this.hf.sample(qx, qy) - here) / reach > params.maxGrade) return STEEP;
    const profile = this.probe(x, y, qx, qy);
    if (!profile.dry) return undefined;
    if (profile.above > MAX_COVER || profile.below > MAX_COVER) return undefined;
    return { heading: h, reach };
  }

  /**
   * A deck straight across a river, from a point along a heading: the shortest
   * reach whose far end stands dry past the water, where the span is one
   * `river-decks.ts` accepts and no steeper end to end than the tier climbs.
   */
  private riverDeck(x: number, y: number, h: number, params: TierParams): Step | undefined {
    const here = this.hf.sample(x, y);
    for (let reach = params.step; reach <= RIVER_DECK; reach += params.step / 2) {
      const qx = x + cos(h) * reach;
      const qy = y + sin(h) * reach;
      if (Math.abs(qx) > this.half || Math.abs(qy) > this.half) return undefined;
      if (!this.isDry(qx, qy)) continue;
      if (Math.abs(this.hf.sample(qx, qy) - here) / reach > params.maxGrade) return undefined;
      if (this.probe(x, y, qx, qy).above > MAX_COVER) return undefined;
      return this.rivers.spans({ x, y }, { x: qx, y: qy }) ? { heading: h, reach } : undefined;
    }
    return undefined;
  }

}

/**
 * How far a point is off a ring, outward positive, and the heading straight
 * out from the ring there. A square ring is measured as a rounded box in the
 * frame of its sides.
 */
export function ringOffset(ring: Ring, x: number, y: number): { out: number; off: number } {
  const dx = x - ring.x;
  const dy = y - ring.y;
  if (ring.square === undefined) return { out: atan2(dy, dx), off: hypot(dx, dy) - ring.radius };
  const c = cos(ring.square);
  const s = sin(ring.square);
  const u = dx * c + dy * s;
  const v = dy * c - dx * s;
  const corner = ring.radius * SQUARE_CORNER;
  const qu = Math.abs(u) - (ring.radius - corner);
  const qv = Math.abs(v) - (ring.radius - corner);
  let nu: number;
  let nv: number;
  let off: number;
  if (qu > 0 && qv > 0) {
    off = hypot(qu, qv) - corner;
    nu = qu;
    nv = qv;
  } else {
    off = Math.max(qu, qv) - corner;
    nu = qu >= qv ? 1 : 0;
    nv = qu >= qv ? 0 : 1;
  }
  nu *= Math.sign(u) || 1;
  nv *= Math.sign(v) || 1;
  return { out: ring.square + atan2(nv, nu), off };
}

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
