/**
 * The ramps of a diamond interchange (spec section 6.2): where an arterial
 * meets a highway, the two roads exchange traffic through four one-way curves
 * and never through a shared point.
 *
 * The highway holds its line and stays on the ground at an interchange
 * (`highway-plan.ts`). The arterial is carried over it on the overpass
 * `crossing-plan.ts` plans, so the two cross without meeting. The turns between
 * them are the ramps: one off and one on for each direction of the highway,
 * each laid in one quadrant of the crossing.
 *
 * A ramp leaves the arterial at the foot of its overpass, where the arterial is
 * back on the ground, and reaches the highway at a point of it far enough from
 * the crossing to be clear of the overpass and still on the ground. It runs as
 * a cubic curve that leaves the highway along the highway — the shallow merge a
 * gore is — and meets the arterial across it, which is the junction a diamond
 * puts at each end. Both ends stand on a point the other road already has, so
 * the network joins them to its nodes without moving anything.
 *
 * All four are planned before any is laid: an interchange is four ramps or it
 * is no interchange, and a crossing that cannot carry four is refused while the
 * arterial is still a draft (spec section 1.2 — nothing is repaired
 * afterwards).
 *
 * Pure: the same roads and ground give the same ramps.
 */
import { hypot, sin } from '../core/libm.ts';
import { toSegment } from './crossing-line.ts';
import type { CrossingNetwork } from './crossing-rules.ts';
import { crossPoint, MIN_MEET } from './network-clearance.ts';
import { CLEARANCE, PLATEAU_MARGIN } from './overpass.ts';
import { curveDistances } from './ribbon.ts';
import { selfOverlap } from './self-overlap.ts';
import { footprintHalfWidth, TIERS } from './tiers.ts';
import type { Interchange, Point, RoadCurve } from './types.ts';

/** The tier a ramp is laid as: it carries arterial traffic and climbs at the arterial's grade. */
export const RAMP_TIER = 'arterial';

/** Ramps in a diamond: one off and one on for each direction of the highway. */
export const DIAMOND_RAMPS = 4;

/**
 * Least metres along the highway between the crossing and the point a ramp
 * meets it: the two carriageways plus the margin the overpass deck reaches
 * past them, so a gore never stands under the deck.
 */
const RAMP_GAP = footprintHalfWidth('highway') + footprintHalfWidth(RAMP_TIER) + PLATEAU_MARGIN;

/** The widest footprint any tier claims, which is how far a free end reaches. */
const WIDEST = footprintHalfWidth('highway');

/** Most metres along the highway a ramp may reach for its point of it. */
const RAMP_REACH = 200;

/**
 * Metres of road an overpass over a highway takes: the deck each side of the
 * widest carriageway at the shallowest angle a crossing is built at, and the
 * ramps down to the ground at the arterial's own grade. A road that crosses a
 * highway is kept at least this long past the crossing, or it cannot be carried
 * over and the interchange is lost (`roads.ts`).
 */
export const OVERPASS_REACH =
  footprintHalfWidth('highway') / sin(MIN_MEET) + PLATEAU_MARGIN + CLEARANCE / TIERS[RAMP_TIER].maxGrade;

/** Metres between the points of a ramp curve. */
const RAMP_STEP = 14;

/** Least metres of either tangent a ramp is built on. Shorter than this the curve doubles back. */
const MIN_TANGENT = 12;

/** Where a ramp stands on the network: a point of a laid curve, or of the road being added. */
export interface RampEnd {
  /** The curve, or -1 for the road the interchange is being built for. */
  curve: number;
  index: number;
}

/** One ramp, in its direction of travel. */
export interface RampPlan {
  points: Point[];
  from: RampEnd;
  to: RampEnd;
}

/** A diamond interchange as it is planned, before any of it is laid. */
export interface DiamondPlan {
  /** The highway the ramps meet. */
  highway: number;
  /** Index into that highway's {@link RoadCurve.interchanges}. */
  interchange: number;
  /** The four ramps, in the order they are laid. */
  ramps: RampPlan[];
}

/**
 * The diamond an arterial crossing a highway takes, or undefined where the
 * ground, the highway or the arterial cannot carry one.
 *
 * `segment` is the segment of the highway the arterial crosses, `at` where the
 * two centrelines cross, and `foot` the two points of the arterial the overpass
 * comes back down on — the ramps leave the arterial there.
 */
export function planDiamond(
  network: CrossingNetwork,
  highway: RoadCurve,
  interchange: number,
  segment: number,
  at: Point,
  road: readonly Point[],
  foot: readonly [number, number],
  planned: readonly RampPlan[] = [],
): DiamondPlan | undefined {
  const along = curveDistances(highway.points);
  const start = highway.points[segment] as Point;
  const crossed = (along[segment] as number) + hypot(at.x - start.x, at.y - start.y);
  // A ramp end on a place another road already meets would leave that road at
  // whatever angle the quadrant happens to give, which is no junction to build.
  for (const i of foot) if (network.curvesAt(road[i] as Point).length > 0) return undefined;
  const befores = headIndices(network, highway, along, crossed, segment, -1);
  const afters = headIndices(network, highway, along, crossed, segment, 1);
  if (befores.length === 0 || afters.length === 0) return undefined;
  // The furthest pair first: the longer the ramp, the gentler its turn and its
  // climb. A pair whose quadrants the ground or the roads refuse gives way to
  // a shorter one.
  for (const before of befores) {
    for (const after of afters) {
      // The four quadrants only exist where the two points of the highway lie
      // either side of the arterial and the two feet either side of the
      // highway. A crossing too shallow for that would put two ramps in one
      // quadrant, leaving the arterial along its own line.
      if (!opposed(road[foot[0]] as Point, road[foot[1]] as Point, highway.points[before] as Point, highway.points[after] as Point)) continue;
      if (!opposed(highway.points[before] as Point, highway.points[after] as Point, road[foot[0]] as Point, road[foot[1]] as Point)) continue;
      const ramps = quadrants(network, highway, road, foot, before, after, planned);
      if (ramps !== undefined) return { highway: highway.id, interchange, ramps };
    }
  }
  return undefined;
}

/** True where `p` and `q` stand on opposite sides of the line from `a` to `b`. */
function opposed(a: Point, b: Point, p: Point, q: Point): boolean {
  const side = (r: Point): number => (b.x - a.x) * (r.y - a.y) - (b.y - a.y) * (r.x - a.x);
  return side(p) * side(q) < 0;
}

/** The four ramps of one choice of highway points, or undefined where any of them is refused. */
function quadrants(
  network: CrossingNetwork,
  highway: RoadCurve,
  road: readonly Point[],
  foot: readonly [number, number],
  before: number,
  after: number,
  planned: readonly RampPlan[],
): RampPlan[] | undefined {
  const feet: [RampEnd, RampEnd] = [
    { curve: -1, index: foot[0] as number },
    { curve: -1, index: foot[1] as number },
  ];
  const heads: [RampEnd, RampEnd] = [
    { curve: highway.id, index: before },
    { curve: highway.id, index: after },
  ];
  // The four quadrants, in the order a driver meets them: off the highway
  // before the overpass and back on after it, then the same for the other
  // direction of travel.
  const pairs: [RampEnd, RampEnd][] = [
    [heads[0], feet[0]],
    [feet[0], heads[1]],
    [heads[1], feet[1]],
    [feet[1], heads[0]],
  ];
  const ramps: RampPlan[] = [];
  for (const [from, to] of pairs) {
    // The arterial is still a draft and the ramps beside this one are not laid
    // either, so the network cannot answer for them: each is kept off the road
    // it serves and off every ramp planned before it by hand.
    const clear = [road, ...planned.map((r) => r.points), ...ramps.map((r) => r.points)];
    const ramp = planRamp(network, highway, road, from, to, clear);
    if (ramp === undefined) return undefined;
    ramps.push(ramp);
  }
  return ramps;
}

/**
 * The points of the highway a ramp may meet it at, walking away from the
 * crossing: every point still on the ground and met by no other road, at least
 * {@link RAMP_GAP} along and no further than {@link RAMP_REACH}, the furthest
 * first. Empty where the highway leaves the ground or runs out before the gap
 * is reached.
 */
function headIndices(
  network: CrossingNetwork,
  highway: RoadCurve,
  along: Float32Array,
  crossed: number,
  segment: number,
  step: number,
): number[] {
  const last = highway.points.length - 1;
  const out: number[] = [];
  for (let i = step > 0 ? segment + 1 : segment; i >= 0 && i <= last; i += step) {
    const gap = ((along[i] as number) - crossed) * step;
    if (gap > RAMP_REACH || (highway.lift?.[i] ?? 0) > 0) break;
    if (gap < RAMP_GAP) continue;
    // A point another road already meets is a junction of its own; a gore
    // there would leave that road along the highway.
    if (network.curvesAt(highway.points[i] as Point).some((id) => id !== highway.id)) continue;
    out.unshift(i);
  }
  return out;
}

/** One ramp between a point of the highway and a point of the arterial, in its direction of travel. */
function planRamp(
  network: CrossingNetwork,
  highway: RoadCurve,
  road: readonly Point[],
  from: RampEnd,
  to: RampEnd,
  clear: readonly (readonly Point[])[],
): RampPlan | undefined {
  const onHighway = from.curve >= 0 ? from : to;
  const onRoad = from.curve >= 0 ? to : from;
  const head = highway.points[onHighway.index] as Point;
  const toe = road[onRoad.index] as Point;
  // The highway end leaves along the highway, towards the crossing: that is
  // the merge a gore makes, whichever way the ramp is driven.
  const lane = towards(highway.points, onHighway.index, toe);
  // The arterial end comes in across the arterial, from the side the highway
  // point stands on, so the ramp meets it as a junction and not as a merge.
  const side = across(road, onRoad.index, head);
  if (lane === undefined || side === undefined) return undefined;
  // Half the corner the ramp turns: how far the toe lies along the highway
  // from the head, and how far the head lies across the arterial from the toe.
  const reach = ((toe.x - head.x) * lane.x + (toe.y - head.y) * lane.y) / 2;
  const off = ((head.x - toe.x) * side.x + (head.y - toe.y) * side.y) / 2;
  if (reach < MIN_TANGENT || off < MIN_TANGENT) return undefined;
  const curve = bezier(
    head,
    { x: head.x + lane.x * reach, y: head.y + lane.y * reach },
    { x: toe.x + side.x * off, y: toe.y + side.y * off },
    toe,
  );
  const points = from.curve >= 0 ? curve : curve.reverse();
  if (!runnable(network, points, clear)) return undefined;
  return { points, from, to };
}

/**
 * The unit direction of a curve at one of its points, pointing along the curve
 * towards `target`. Undefined where the point has no segment of any length.
 */
function towards(points: readonly Point[], index: number, target: Point): Point | undefined {
  const before = points[index - 1];
  const after = points[index + 1];
  const here = points[index] as Point;
  const pick = before === undefined ? after : after === undefined ? before : nearer(here, before, after, target);
  if (pick === undefined) return undefined;
  return normalise(pick.x - here.x, pick.y - here.y);
}

/** Whichever of two neighbours lies on the side of a point the target does. */
function nearer(here: Point, before: Point, after: Point, target: Point): Point {
  const dx = target.x - here.x;
  const dy = target.y - here.y;
  return (before.x - here.x) * dx + (before.y - here.y) * dy > (after.x - here.x) * dx + (after.y - here.y) * dy ? before : after;
}

/**
 * The unit normal of a curve at one of its points, pointing at the side
 * `target` stands on. Undefined where the point has no segment of any length.
 */
function across(points: readonly Point[], index: number, target: Point): Point | undefined {
  const here = points[index] as Point;
  const other = points[index + 1] ?? points[index - 1];
  if (other === undefined) return undefined;
  const line = normalise(other.x - here.x, other.y - here.y);
  if (line === undefined) return undefined;
  const normal = { x: -line.y, y: line.x };
  const hand = (target.x - here.x) * normal.x + (target.y - here.y) * normal.y;
  return hand < 0 ? { x: -normal.x, y: -normal.y } : normal;
}

function normalise(x: number, y: number): Point | undefined {
  const length = hypot(x, y);
  return length === 0 ? undefined : { x: x / length, y: y / length };
}

/**
 * A cubic curve through its four control points, sampled every
 * {@link RAMP_STEP} metres or so.
 *
 * The step either side of an end is set on the curve's tangent there. A
 * polyline sampled off a curve leaves its end a few degrees off the tangent,
 * and where the curve turns hard those few degrees are tens: the angle a ramp
 * leaves the arterial at is the angle its junction is built at, and the angle
 * it leaves the highway at is the gore. Both are read off that one step, so
 * the step is put where the tangent says and not where the sample fell.
 */
function bezier(p0: Point, p1: Point, p2: Point, p3: Point): Point[] {
  const hull = hypot(p1.x - p0.x, p1.y - p0.y) + hypot(p2.x - p1.x, p2.y - p1.y) + hypot(p3.x - p2.x, p3.y - p2.y);
  const steps = Math.max(4, Math.ceil(hull / RAMP_STEP));
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    });
  }
  out[1] = onTangent(p0, p1, out[1] as Point);
  out[steps - 1] = onTangent(p3, p2, out[steps - 1] as Point);
  return out;
}

/** The point as far from `end` as `sample` is, on the line from `end` towards `control`. */
function onTangent(end: Point, control: Point, sample: Point): Point {
  const unit = normalise(control.x - end.x, control.y - end.y);
  if (unit === undefined) return sample;
  const reach = hypot(sample.x - end.x, sample.y - end.y);
  return { x: end.x + unit.x * reach, y: end.y + unit.y * reach };
}

/**
 * True where a ramp may be laid as it stands: no part of it over ground the
 * tier refuses or steeper than the tier climbs, no road crossed between its two
 * ends, no free end of a laid road buried under it, and no stretch of it over
 * its own carriageway. `clear` holds the lines the network cannot answer for
 * yet — the road the interchange is built for, and the ramps beside this one.
 */
function runnable(network: CrossingNetwork, points: readonly Point[], clear: readonly (readonly Point[])[]): boolean {
  if (selfOverlap(points, RAMP_TIER) !== undefined) return false;
  const half = footprintHalfWidth(RAMP_TIER);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    if (!network.canRun(a, b, RAMP_TIER)) return false;
    if (network.crossingsAlong(a, b).length > 0) return false;
    for (const line of clear) {
      for (let k = 0; k + 1 < line.length; k++) {
        if (crossPoint(a, b, line[k] as Point, line[k + 1] as Point) !== undefined) return false;
      }
    }
    // A free end stands on whatever passes within reach of it, so a ramp laid
    // over one would bury a road it never meets.
    for (const end of network.freeEnds((a.x + b.x) / 2, (a.y + b.y) / 2, half + WIDEST + hypot(b.x - a.x, b.y - a.y) / 2)) {
      const other = network.curves[end.curve] as RoadCurve;
      if (toSegment(end.at, a, b) < half + footprintHalfWidth(other.tier)) return false;
    }
  }
  return true;
}

/** The interchange of a highway a place stands at, or undefined where none does. */
export function interchangeAt(highway: RoadCurve, along: Float32Array, crossed: number, reach: number): number | undefined {
  for (let i = 0; i < highway.interchanges.length; i++) {
    const point = (highway.interchanges[i] as Interchange).at;
    if (Math.abs((along[point] as number) - crossed) <= reach) return i;
  }
  return undefined;
}
