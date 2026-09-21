/**
 * Every crossing of a road is decided when the road is added to the network
 * (spec section 6.2), never afterwards. For each place the new road crosses a
 * road already laid, in this order:
 *
 * 1. Both are on the ground there and the tiers may join: the crossing is a
 *    junction. Both roads take a point there, and the network makes it a node.
 * 2. The surface of one of them already stands a {@link CLEARANCE} over the
 *    surface of the other there — the slot of a highway, the level top of an
 *    earlier raise, a deck or a bore: the crossing is left as it is.
 * 3. The new road can be carried over the other one: its whole reach, deck and
 *    ramps, is laid into it now, so no later road can junction inside it.
 * 4. None of these: the road is shortened back from the crossing, or refused.
 *
 * A junction goes where `connect.ts` used to put it: on the nearest point
 * either road already has within {@link CROSSING_SNAP}, else on the crossing
 * itself. A place is refused where a road standing on it may not be joined,
 * where the ground refuses a half the point cuts a segment into, where the
 * point bends a road back over itself, over the free end of a third road or
 * across a road it did not cross before, and where any two roads would leave
 * the place at less than `MIN_MEET` (`crossing-rules.ts`).
 *
 * Nothing is written until the whole plan holds: {@link settleCrossings}
 * returns the road to add, and the points each road already laid takes.
 */
import { hypot, sin } from '../core/libm.ts';
import { lerp } from '../core/math.ts';
import { CLEARANCE, PLATEAU_MARGIN, raiseAt, raised, type Raise } from './overpass.ts';
import type { Ground } from './bed.ts';
import { alongSegment, PlannedLine, toSegment } from './crossing-line.ts';
import { junctionAt, type CrossingNetwork } from './crossing-rules.ts';
import { MIN_MEET } from './network-clearance.ts';
import { PLANE_REACH, seedsOn, spanOf, surfaceSpan, type PlaneLine, type PlaneNode } from './plane-lift.ts';
import type { MouthSeed } from './junctions.ts';
import { curveDistances } from './ribbon.ts';
import { footprintHalfWidth, mayCross, mayJoin, TIERS } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/** Metres a junction may be moved onto a point a road already has. Two junctions this close would stand inside each other. */
export const CROSSING_SNAP = 4;

/** Times a road is shortened and planned again before it is refused. */
const ROUNDS = 4;

/** Metres apart two places are the same node, and millimetres off a line a place stands on it. */
const SAME_NODE = 1e-6;
const ON_CURVE = 1e-3;

/**
 * Metres of headroom a crossing may be short of the clearance and still count
 * as apart. A raise is planned to the full clearance, so this is only ever
 * spent on a deck already standing — a highway's slot, an earlier raise, a
 * bridge: the two roads read the ground under their own points, so their
 * surfaces stand a few centimetres off what the ground at the crossing says.
 * Refusing those centimetres costs the road below, and with it the odd island
 * link, for headroom nothing on the roster can tell apart: the tallest vehicle
 * of spec section 11.3 stands 3 m.
 */
export const HEADROOM_SLACK = 0.25;

/** A road as it is proposed to the network. */
export interface DraftLine {
  tier: RoadTier;
  points: Point[];
  bridges: number[];
  tunnels: number[];
  interchanges: number[];
  slots?: number[];
  lift?: number[];
}

/** A point a road already laid takes: where, and in which of its segments. */
export interface PointEdit {
  curve: number;
  segment: number;
  at: number;
  x: number;
  y: number;
}

/** Where the new road crosses a laid one. */
interface Crossing {
  segment: number;
  at: number;
  curve: number;
  other: number;
  x: number;
  y: number;
}

/** A crossing the plan could not decide, and the road it crosses. */
interface Failure {
  segment: number;
  x: number;
  y: number;
  tier: RoadTier;
}

/** A place the new road passes under or over a laid one, and the crossing it stands on. */
interface Apart extends Failure {
  curve: number;
  /** The segment of the laid road the place stands on. */
  other: number;
}

interface Plan {
  draft: PlannedLine;
  edits: PointEdit[];
  /** The places the new road meets a laid one, and which. */
  junctions: { x: number; y: number; curve: number; segment: number }[];
  /** The places the new road passes under a laid one, and the segment of the draft each is on. */
  under: Apart[];
  /** The places it passes over one on a deck or a bore of its own. */
  over: Apart[];
  candidates: Crossing[];
  failures: Failure[];
}

/**
 * The road to add, with every crossing decided, and the points the roads
 * already laid take for it. Undefined where the road is refused. A road asked
 * for `whole` is refused rather than shortened.
 */
export function settleCrossings(network: CrossingNetwork, proposed: DraftLine, whole = false): { road: DraftLine; edits: PointEdit[] } | undefined {
  let draft = proposed;
  for (let round = 0; round < ROUNDS; round++) {
    const plan = planJunctions(network, draft);
    const road = lineOf(draft, plan.draft);
    const raises: Raise[] = [];
    const apart: Apart[] = [...plan.under, ...plan.over];
    for (const crossing of plan.candidates) {
      const raise = raiseFor(network, draft, road, plan, crossing);
      const tier = (network.curves[crossing.curve] as RoadCurve).tier;
      const place = { segment: crossing.segment, x: crossing.x, y: crossing.y, tier, curve: crossing.curve, other: crossing.other };
      if (raise === undefined) plan.failures.push(place);
      else {
        raises.push(raise);
        apart.push(place);
      }
    }
    if (plan.failures.length === 0) {
      const lifted = raised(road, raises);
      for (const place of planedApart(network, lifted, plan, apart)) plan.failures.push(place);
      if (plan.failures.length === 0) {
        return joinsPlanedCrossing(network, lifted, plan) ? undefined : { road: lifted, edits: plan.edits };
      }
    }
    if (whole) return undefined;
    const shorter = shorten(network, draft, plan);
    if (shorter === undefined) return undefined;
    draft = shorter;
  }
  return undefined;
}

/**
 * True where a deck from `a` to `b` stands apart from every laid road it
 * crosses. A deck is not on the ground, so it meets nothing on the way and is
 * raised over nothing: a road under it has to be a clearance below already.
 */
export function deckApart(network: CrossingNetwork, a: Point, b: Point, tier: RoadTier): boolean {
  const deck: DraftLine = { tier, points: [a, b], bridges: [0], tunnels: [], interchanges: [] };
  return crossingsOf(network, deck).every((crossing) => separation(network, deck, crossing, network.curves[crossing.curve] as RoadCurve) !== undefined);
}

/** Decide the junctions of a road, and sort the rest of its crossings into what they are. */
function planJunctions(network: CrossingNetwork, draft: DraftLine): Plan {
  const plan: Plan = { draft: new PlannedLine(draft.points, draft.tier), edits: [], junctions: [], under: [], over: [], candidates: [], failures: [] };
  const lines = new Map<number, PlannedLine>();
  const lineFor = (curve: RoadCurve): PlannedLine => {
    const known = lines.get(curve.id);
    if (known !== undefined) return known;
    const line = new PlannedLine(curve.points, curve.tier);
    lines.set(curve.id, line);
    return line;
  };
  for (const crossing of crossingsOf(network, draft)) {
    const other = network.curves[crossing.curve] as RoadCurve;
    // The crossing policy comes first: a pair the tiers may not cross is no
    // crossing at all, on the ground, on a deck or in a bore (issue #269).
    // Only a junction is exempt, and `mayCross` refuses no pair `mayJoin`
    // allows, so a junction is never lost to it.
    if (!mayCross(draft.tier, other.tier)) {
      plan.failures.push({ segment: crossing.segment, x: crossing.x, y: crossing.y, tier: other.tier });
      continue;
    }
    const ground = onGround(draft, crossing.segment) && onGround(other, crossing.other);
    const join = mayJoin(draft.tier, other.tier, false) && mayJoin(other.tier, draft.tier, false);
    if (ground && join && !meetsNear(network, draft, plan, other, crossing)) {
      const junction = junctionAt(network, plan.draft, lineFor(other), draft, other, crossing, CROSSING_SNAP);
      if (junction !== undefined && !planeOverCrossing(network, other, crossing.other, junction)) {
        if (junction.draft !== undefined) plan.draft.given.push(junction.draft);
        if (junction.edit !== undefined) {
          lineFor(other).given.push({ x: junction.edit.x, y: junction.edit.y, segment: junction.edit.segment, at: junction.edit.at, index: -1 });
          plan.edits.push(junction.edit);
        }
        plan.junctions.push({ x: junction.x, y: junction.y, curve: other.id, segment: crossing.segment });
        continue;
      }
    }
    const apart = separation(network, draft, crossing, other);
    if (apart !== undefined) {
      const place = { segment: crossing.segment, x: crossing.x, y: crossing.y, tier: other.tier, curve: crossing.curve, other: crossing.other };
      if (apart < 0) plan.under.push(place);
      else plan.over.push(place);
      continue;
    }
    // A highway holds its line, and is crossed at a slot or nowhere.
    if (ground && draft.tier !== 'highway' && other.tier !== 'highway') plan.candidates.push(crossing);
    else plan.failures.push({ segment: crossing.segment, x: crossing.x, y: crossing.y, tier: other.tier });
  }
  return plan;
}

/**
 * The places the finished road passes under or over a laid one where the two no
 * longer stand a clearance apart, once the junctions the plan gives the road
 * have laid its own line on their planes (issue #533). `separation` decided
 * each of these on the bed the road drives with no junction on it; this asks
 * the same question of the line it will really drive. A road is shortened back
 * from such a crossing, as it is from one it cannot be carried over.
 *
 * The junctions a laid road takes near a crossing already in the world are
 * refused instead ({@link planeOverCrossing}): there the crossing is the one
 * that was there first.
 */
function planedApart(network: CrossingNetwork, road: DraftLine, plan: Plan, apart: readonly Apart[]): Failure[] {
  if (apart.length === 0) return [];
  const nodes = planNodes(network, road, plan);
  if (nodes.length === 0) return [];
  const ground: Ground = (x, y) => network.heightAt(x, y);
  const line: PlaneLine = { id: network.curves.length, points: road.points, lift: road.lift };
  const out: Failure[] = [];
  for (const place of apart) {
    const segment = segmentAt(road.points, place, ON_CURVE);
    if (segment === undefined) continue;
    const here = spanOf(ground, line, nodes, segment, place);
    const there = surfaceSpan(network, place.curve, place.other, place);
    const gap = Math.max(here.low - there.high, there.low - here.high);
    if (gap < CLEARANCE - HEADROOM_SLACK) out.push({ segment: place.segment, x: place.x, y: place.y, tier: place.tier });
  }
  return out;
}

/**
 * The nodes the finished road will stand on, each with every road that leaves
 * it: the points it shares with a laid road, and the points a laid road takes
 * for it. These are the junctions `junctions.ts` will build there, which is
 * what says where the road's own line is laid on a plane.
 */
function planNodes(network: CrossingNetwork, road: DraftLine, plan: Plan): PlaneNode[] {
  const nodes: PlaneNode[] = [];
  for (let k = 0; k < road.points.length; k++) {
    const seeds = nodeSeeds(network, road, plan, k);
    if (seeds !== undefined) nodes.push({ point: k, seeds });
  }
  return nodes;
}

/**
 * The mouths the node at a point of the road will be fitted from: the road
 * itself, the roads that already have a point there, and the ones taking a
 * point there for it. Undefined where the point stands on no node at all.
 */
function nodeSeeds(network: CrossingNetwork, road: DraftLine, plan: Plan, k: number): MouthSeed[] | undefined {
  const p = road.points[k] as Point;
  const on = network.nodeAt(p);
  const edits = plan.edits.filter((edit) => hypot(edit.x - p.x, edit.y - p.y) <= SAME_NODE);
  if (on.length === 0 && edits.length === 0) return undefined;
  const seeds = seedsOn(network.curves.length, road.tier, road.points, k, road.bridges, road.tunnels, road.lift);
  for (const at of on) {
    const laid = network.curves[at.curve] as RoadCurve;
    seeds.push(...seedsOn(laid.id, laid.tier, laid.points, at.index, laid.bridges, laid.tunnels, laid.lift));
  }
  for (const edit of edits) {
    // The laid road has no point there yet: it takes one when the plan holds,
    // and its mouths leave the node along the two halves of its segment. The
    // lift takes the new point the way `road-network.ts` gives it one.
    const laid = network.curves[edit.curve] as RoadCurve;
    const points = [...laid.points];
    points.splice(edit.segment + 1, 0, { x: edit.x, y: edit.y });
    let lift = laid.lift;
    if (lift !== undefined) {
      const at = edit.segment + 1;
      const t = alongSegment(laid.points[edit.segment] as Point, laid.points[at] as Point, { x: edit.x, y: edit.y });
      lift = [...lift];
      lift.splice(at, 0, lerp(lift[edit.segment] as number, lift[at] as number, t));
    }
    seeds.push(...seedsOn(laid.id, laid.tier, points, edit.segment + 1, [], [], lift));
  }
  return seeds;
}

/** The segment of a line a place stands nearest, or undefined where it stands off all of them. */
function segmentAt(points: readonly Point[], at: Point, within: number): number | undefined {
  let best: number | undefined;
  let bestOff = within;
  for (let i = 0; i + 1 < points.length; i++) {
    const off = toSegment(at, points[i] as Point, points[i + 1] as Point);
    if (off >= bestOff) continue;
    bestOff = off;
    best = i;
  }
  return best;
}

/**
 * True where a junction at a place would take the headroom of a crossing near
 * it: its plane would reach a place where a road that meets there passes under
 * or over another (issue #533). Every road at the place is asked, since each of
 * them gains a mouth and so a plane it did not have.
 *
 * A crossing was decided on the surfaces of its two roads as they stood then
 * (`separation`), and a junction laid later is the one thing that can still
 * move them. So it is refused here, and the crossing stands as it was planned.
 */
function planeOverCrossing(network: CrossingNetwork, other: RoadCurve, segment: number, at: Point): boolean {
  if (crossingNear(network, other, segment, at)) return true;
  for (const id of network.curvesAt(at)) {
    if (id === other.id) continue;
    const road = network.curves[id] as RoadCurve;
    const place = segmentAt(road.points, at, CROSSING_SNAP);
    if (place !== undefined && crossingNear(network, road, place, at)) return true;
  }
  return false;
}

/**
 * True where a laid road passes under or over another road within a plane's
 * reach along it of a place on its segment `segment`. The reach is measured
 * along the curve, as a plane reaches, with the snap a junction may be moved by
 * allowed for.
 */
function crossingNear(network: CrossingNetwork, road: RoadCurve, segment: number, at: Point): boolean {
  const distances = curveDistances(road.points);
  const a = road.points[segment] as Point;
  const b = road.points[segment + 1] as Point;
  const place = (distances[segment] as number) + alongSegment(a, b, at) * ((distances[segment + 1] as number) - (distances[segment] as number));
  return crossingsWithin(network, road, distances, place).length > 0;
}

/**
 * True where the road joins a node so near a crossing that the junction there,
 * fitted afresh with the mouth the road brings, would take its headroom. A
 * point of a road standing on a point of the network joins its node whatever
 * the crossings were planned as (`road-network.ts`), so no junction can be
 * declined here: the road itself is refused.
 *
 * The crossings are the ones the roads at that node already carry, and each is
 * measured again with the node as it will stand. Most junctions beside a
 * crossing leave it the headroom it had, and refusing them all costs the
 * outskirts their blocks and the odd island its arterial.
 */
function joinsPlanedCrossing(network: CrossingNetwork, road: DraftLine, plan: Plan): boolean {
  for (let k = 0; k < road.points.length; k++) {
    const p = road.points[k] as Point;
    const on = network.nodeAt(p);
    if (on.length === 0) continue;
    const seeds = nodeSeeds(network, road, plan, k);
    if (seeds === undefined) continue;
    const edits = [{ at: p, seeds }];
    for (const at of on) {
      const laid = network.curves[at.curve] as RoadCurve;
      const distances = curveDistances(laid.points);
      for (const crossing of crossingsWithin(network, laid, distances, distances[at.index] as number)) {
        const here = surfaceSpan(network, laid.id, crossing.segment, crossing, edits);
        const there = surfaceSpan(network, crossing.curve, crossing.other, crossing, edits);
        if (Math.max(here.low - there.high, there.low - here.high) < CLEARANCE - HEADROOM_SLACK) return true;
      }
    }
  }
  return false;
}

/** Every place a laid road passes under or over another road within a plane's reach of a place on it. */
function crossingsWithin(network: CrossingNetwork, road: RoadCurve, distances: Float32Array, place: number): Crossing[] {
  const out: Crossing[] = [];
  const reach = PLANE_REACH + CROSSING_SNAP;
  for (let i = 0; i + 1 < road.points.length; i++) {
    if ((distances[i + 1] as number) < place - reach || (distances[i] as number) > place + reach) continue;
    const from = road.points[i] as Point;
    const to = road.points[i + 1] as Point;
    for (const hit of network.crossingsAlong(from, to)) {
      if (hit.curve === road.id) continue;
      const crossed = network.curves[hit.curve] as RoadCurve;
      if (onGround(road, i) && onGround(crossed, hit.segment)) continue;
      out.push({ segment: i, at: alongSegment(from, to, hit), curve: hit.curve, other: hit.segment, x: hit.x, y: hit.y });
    }
  }
  return out;
}


/** Every place the draft crosses a laid road, in order along the draft. */
function crossingsOf(network: CrossingNetwork, draft: DraftLine): Crossing[] {
  const out: Crossing[] = [];
  for (let i = 0; i + 1 < draft.points.length; i++) {
    const a = draft.points[i] as Point;
    const b = draft.points[i + 1] as Point;
    for (const hit of network.crossingsAlong(a, b)) {
      out.push({ segment: i, at: alongSegment(a, b, hit), curve: hit.curve, other: hit.segment, x: hit.x, y: hit.y });
    }
  }
  return out.sort((m, n) => m.segment - n.segment || m.at - n.at || m.curve - n.curve || m.other - n.other);
}

/** True where a segment of a line lies on the ground: no deck, no bore, no lift at either end. */
export function onGround(line: DraftLine, segment: number): boolean {
  if (line.bridges.includes(segment) || line.tunnels.includes(segment)) return false;
  return (line.lift?.[segment] ?? 0) === 0 && (line.lift?.[segment + 1] ?? 0) === 0;
}

/**
 * True where the draft already meets the other road within a junction's reach
 * of the crossing: a second junction there would stand inside the first.
 */
function meetsNear(network: CrossingNetwork, draft: DraftLine, plan: Plan, other: RoadCurve, crossing: Crossing): boolean {
  const reach = footprintHalfWidth(draft.tier) + footprintHalfWidth(other.tier);
  for (const junction of plan.junctions) {
    if (junction.curve === other.id && hypot(junction.x - crossing.x, junction.y - crossing.y) < reach) return true;
  }
  for (const p of draft.points) {
    if (hypot(p.x - crossing.x, p.y - crossing.y) >= reach) continue;
    if (network.curvesAt(p).includes(other.id)) return true;
  }
  return false;
}

/**
 * How far the draft stands over the other road at a crossing, where one of
 * them is already carried over the other; negative where the draft is below.
 * Undefined where the two are not apart.
 *
 * Both are measured on the surface each road drives, never on the lift of one
 * of them: the two roads have different points, so a lift of the clearance over
 * the ground under this road leaves the two beds anywhere from that down to a
 * metre and a half apart (issue #290). The laid road's surface is the one the
 * junctions near it leave, which is anywhere in a span where a plane reaches
 * the place (`plane-lift.ts`), and the crossing is apart only where the whole
 * span is. The draft carries no junction plane yet: it takes its own when it is
 * laid, and {@link planedApart} asks the question again of the line it will
 * really drive.
 * Two roads on the ground are never apart, whatever their beds say: the carve
 * levels the ground to each of them, and one bench cannot stand under the
 * other.
 */
function separation(network: CrossingNetwork, draft: DraftLine, crossing: Crossing, other: RoadCurve): number | undefined {
  if (onGround(draft, crossing.segment) && onGround(other, crossing.other)) return undefined;
  const here = bedOn(network, draft, crossing.segment, crossing);
  const there = surfaceSpan(network, other.id, crossing.other, crossing);
  const over = here - there.high;
  const under = there.low - here;
  if (over >= CLEARANCE - HEADROOM_SLACK) return over;
  if (under >= CLEARANCE - HEADROOM_SLACK) return -under;
  return undefined;
}

/** The lift of a segment of a line at a place on it. */
function liftOn(line: DraftLine, segment: number, at: Point): number {
  const a = line.points[segment] as Point;
  const b = line.points[segment + 1] as Point;
  const t = alongSegment(a, b, at);
  return (line.lift?.[segment] ?? 0) * (1 - t) + (line.lift?.[segment + 1] ?? 0) * t;
}

/** The height of the line a segment drives at a place on it: the ground under its ends, straight between them, and its lift. */
function bedOn(network: CrossingNetwork, line: DraftLine, segment: number, at: Point): number {
  const a = line.points[segment] as Point;
  const b = line.points[segment + 1] as Point;
  const t = alongSegment(a, b, at);
  const from = network.heightAt(a.x, a.y);
  const to = network.heightAt(b.x, b.y);
  return from + (to - from) * t + liftOn(line, segment, at);
}

/**
 * The raise that carries the finished draft over the road at a crossing, or
 * undefined where it may not be carried: a junction of the draft, a place it
 * passes under another road, or a deck or bore of its own inside the reach, or
 * too little road to land again.
 */
function raiseFor(network: CrossingNetwork, draft: DraftLine, road: DraftLine, plan: Plan, crossing: Crossing): Raise | undefined {
  const a = draft.points[crossing.segment] as Point;
  const b = draft.points[crossing.segment + 1] as Point;
  const start = road.points.indexOf(a);
  const end = road.points.indexOf(b);
  // A snapped junction bends the segment, and the crossing is then no longer
  // on the line the distances are measured along.
  for (let k = start + 1; k < end; k++) if (toSegment(road.points[k] as Point, a, b) > 1e-6) return undefined;
  const distances = curveDistances(road.points);
  const along = alongRoad(draft, road, distances, crossing.segment, crossing);
  const other = network.curves[crossing.curve] as RoadCurve;
  const c = other.points[crossing.other] as Point;
  const d = other.points[crossing.other + 1] as Point;
  const sine = Math.abs((b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)) / (hypot(b.x - a.x, b.y - a.y) * hypot(d.x - c.x, d.y - c.y));
  const plateau = footprintHalfWidth(other.tier) / Math.max(sine, sin(MIN_MEET)) + PLATEAU_MARGIN;
  // The deck has to clear the surface of the road below, not the ground under
  // the draft's own points: where that ground stands lower, the draft climbs
  // the difference as well (issue #290). That surface is the highest the
  // junctions near the crossing leave the road (issue #533). It never climbs
  // less than the clearance, so a deck is a deck however deep the road below
  // sits.
  const under = surfaceSpan(network, other.id, crossing.other, crossing).high;
  const height = Math.max(CLEARANCE, CLEARANCE + under - deckGround(network, road.points, distances, along, plateau));
  const raise = raiseAt(distances, along, plateau, height / TIERS[draft.tier].maxGrade, height);
  if (raise === undefined) return undefined;
  const inside = (d: number): boolean => d > raise.from && d < raise.to;
  for (let k = 0; k < road.points.length; k++) {
    const p = road.points[k] as Point;
    const meets = network.curvesAt(p).length > 0 || plan.junctions.some((j) => hypot(j.x - p.x, j.y - p.y) <= 1e-6);
    if (meets && inside(distances[k] as number)) return undefined;
  }
  for (const segment of [...road.bridges, ...road.tunnels]) {
    if ((distances[segment + 1] as number) > raise.from && (distances[segment] as number) < raise.to) return undefined;
  }
  for (const place of plan.under) if (inside(alongRoad(draft, road, distances, place.segment, place))) return undefined;
  return raise;
}

/**
 * The ground the deck of a raise stands on where it crosses the other road.
 * The raise puts a point at each end of its level deck, so the deck there
 * drives the line between the two points the raise leaves either side of the
 * crossing, and not the line over the whole segment the crossing fell in.
 */
function deckGround(network: CrossingNetwork, points: readonly Point[], distances: Float32Array, along: number, plateau: number): number {
  let before = -Infinity;
  let after = Infinity;
  for (let k = 0; k < points.length; k++) {
    const d = distances[k] as number;
    if (d <= along && d > before) before = d;
    if (d >= along && d < after) after = d;
  }
  const low = Math.max(before, along - plateau);
  const high = Math.min(after, along + plateau);
  const from = pointAlong(points, distances, low);
  const to = pointAlong(points, distances, high);
  const ground = network.heightAt(from.x, from.y);
  if (high <= low) return ground;
  return ground + (network.heightAt(to.x, to.y) - ground) * ((along - low) / (high - low));
}

/** The point `along` metres along a line, which is a point of it or inside one segment. */
function pointAlong(points: readonly Point[], distances: Float32Array, along: number): Point {
  for (let k = 0; k + 1 < points.length; k++) {
    const from = distances[k] as number;
    const to = distances[k + 1] as number;
    if (along > to || to <= from) continue;
    const a = points[k] as Point;
    const b = points[k + 1] as Point;
    const t = Math.max(0, (along - from) / (to - from));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return points[points.length - 1] as Point;
}

/**
 * Metres along the finished road to a place on segment `segment` of the draft.
 * A bend a snap made in that segment moves the place by less than the snap,
 * which no reach is measured that finely.
 */
function alongRoad(draft: DraftLine, road: DraftLine, distances: Float32Array, segment: number, p: Point): number {
  const a = draft.points[segment] as Point;
  return (distances[road.points.indexOf(a)] as number) + hypot(p.x - a.x, p.y - a.y);
}

/**
 * The draft with the points the plan gave it. Every deck, bore, slot and lift
 * moves with the points, and a given point takes the lift of its segment there.
 */
function lineOf(draft: DraftLine, line: PlannedLine): DraftLine {
  if (line.given.length === 0) return draft;
  const seq = line.sequence();
  const points: Point[] = [];
  const first: number[] = [];
  const lift: number[] = [];
  for (const place of seq) {
    if (place.index >= 0) first[place.index] = points.length;
    points.push(place.index >= 0 ? (draft.points[place.index] as Point) : { x: place.x, y: place.y });
    const from = draft.lift?.[place.segment] ?? 0;
    const to = draft.lift?.[place.segment + 1] ?? from;
    lift.push(place.index >= 0 ? from : from + (to - from) * place.at);
  }
  const spread = (segments: readonly number[]): number[] => {
    const out: number[] = [];
    for (const s of segments) for (let k = first[s] as number; k < (first[s + 1] as number); k++) out.push(k);
    return out;
  };
  const road: DraftLine = {
    ...draft,
    points,
    bridges: spread(draft.bridges),
    tunnels: spread(draft.tunnels),
    interchanges: draft.interchanges.map((i) => first[i] as number),
  };
  if (draft.slots !== undefined) road.slots = spread(draft.slots);
  if (draft.lift !== undefined) road.lift = lift;
  return road;
}

/**
 * The longest piece of a draft between the crossings the plan could not decide
 * that still meets the network, each end cut back to where the road may end:
 * on a road, or clear of every road and of the crossing it stops short of.
 * Undefined where no piece meets the network.
 */
function shorten(network: CrossingNetwork, draft: DraftLine, plan: Plan): DraftLine | undefined {
  const failures = [...plan.failures].sort((m, n) => m.segment - n.segment);
  const last = draft.points.length - 1;
  const endsOk = (i: number, failure: Failure | undefined): boolean => {
    const p = draft.points[i] as Point;
    if (network.curvesAt(p).length > 0) return true;
    if (!network.clearAt(p.x, p.y, draft.tier)) return false;
    return failure === undefined || hypot(p.x - failure.x, p.y - failure.y) >= footprintHalfWidth(draft.tier) + footprintHalfWidth(failure.tier);
  };
  let best: DraftLine | undefined;
  let bestLength = 2 * footprintHalfWidth(draft.tier);
  for (let k = 0; k <= failures.length; k++) {
    const before = failures[k - 1];
    const after = failures[k];
    let start = before === undefined ? 0 : before.segment + 1;
    let end = after === undefined ? last : after.segment;
    // Only an end cut at a crossing moves; the draft's own ends stay where they were proposed.
    while (before !== undefined && start < end && !endsOk(start, before)) start++;
    while (after !== undefined && end > start && !endsOk(end, after)) end--;
    if (end <= start) continue;
    const meets =
      draft.points.slice(start, end + 1).some((p) => network.curvesAt(p).length > 0) ||
      plan.junctions.some((j) => j.segment >= start && j.segment < end);
    if (!meets) continue;
    const piece = slice(draft, start, end);
    const length = curveDistances(piece.points)[piece.points.length - 1] as number;
    if (length <= bestLength) continue;
    bestLength = length;
    best = piece;
  }
  return best;
}

/** The part of a draft from point `start` to point `end`, its structures with it. */
function slice(draft: DraftLine, start: number, end: number): DraftLine {
  const keep = (segments: readonly number[]): number[] => segments.filter((s) => s >= start && s < end).map((s) => s - start);
  const piece: DraftLine = {
    ...draft,
    points: draft.points.slice(start, end + 1),
    bridges: keep(draft.bridges),
    tunnels: keep(draft.tunnels),
    interchanges: draft.interchanges.filter((i) => i >= start && i <= end).map((i) => i - start),
  };
  if (draft.slots !== undefined) piece.slots = keep(draft.slots);
  if (draft.lift !== undefined) piece.lift = draft.lift.slice(start, end + 1);
  return piece;
}

