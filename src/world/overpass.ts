/**
 * The overpasses of the road network (spec section 6.2): where one road is
 * carried over another instead of meeting it.
 *
 * Two roads that cross without sharing a point take no junction, and the graph
 * says which one is carried over the other. Nothing carried it: both were laid
 * on the ground and drawn through each other, the kerbs and the pavement of one
 * across the carriageway of the other. This pass carries the road the graph
 * calls `over` over the other one. It climbs to {@link CLEARANCE} above the road
 * it crosses, holds that over the crossing, and ramps back onto the ground each
 * side no harder than its tier's `maxGrade`.
 *
 * A raised stretch is a deck: it is added to the curve's `bridges`, so the
 * carve leaves the ground under it alone, `road-mesh.ts` lofts the deck it
 * already lofts over water, and the physics stands on it (`decks.ts`). The
 * height itself lives in `RoadCurve.lift`, which is the one thing a curve says
 * about its own height; everything else reads the ground under it.
 *
 * The raise is refused where the road cannot be carried: where a junction of it
 * stands inside the reach of the ramps, because a junction is one plane at the
 * height of the ground; where the road is bored through a hill there; and where
 * the curve is too short to land again. Those crossings stay flat, and the
 * sweep counts them.
 *
 * Runs last in `traceRoads`, on curves that no longer move. Pure: the same
 * roads give the same overpasses.
 */
import { compareNumbers } from '../core/sort.ts';
import { buildRoadGraph } from './graph.ts';
import { curveDistances } from './ribbon.ts';
import { footprintHalfWidth, TIERS } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/**
 * Metres of headroom over the road that passes underneath: the deck of the road
 * above stands this far over the bed of the road below, which is enough for the
 * tallest of the roster (spec section 11.3) to drive under it.
 */
export const CLEARANCE = 6.5;

/**
 * Which road climbs where two cross: the lowest rank of the two. A dirt road or
 * an alley gives way to everything, and a highway climbs only where the road it
 * crosses cannot.
 */
const CLIMB_RANK: Record<RoadTier, number> = { dirt: 0, alley: 1, street: 2, arterial: 3, highway: 4 };

/** Metres of level deck each side of the road crossed, past the ground it claims. */
export const PLATEAU_MARGIN = 4;

/** Metres a raised point has to stand over the ground before its segment is a deck. */
const DECK_LIFT = 0.2;

/** Metres short of the clearance a lift still counts as the full clearance, for the rounding of a blend. */
const SEPARATED_SLACK = 1e-6;

/** Millimetres: two points this close are the same place, so no knot is inserted. */
const SAME_PLACE = 0.5;

/**
 * Where a road is carried over another one, as distances along the road that
 * climbs: the level deck runs from `low` to `high`, and the ramps come down
 * from there to the ground at `from` and at `to`.
 *
 * Both ends stand on a point the curve already has. A ramp that ended between
 * two points would cut the segment there in two, and half a segment can climb
 * harder than the whole did, which is ground the tier may not be laid on. So
 * the ramp is taken out to the next point instead, which makes it longer than
 * the grade asks for and never steeper.
 */
interface Raise {
  from: number;
  low: number;
  high: number;
  to: number;
}

/**
 * Carry every road that crosses another one over it. The curves come back with
 * the points the ramps need, a `lift` above the ground at each point, and the
 * raised segments in `bridges`.
 */
export function raiseOverpasses(roads: readonly RoadCurve[]): RoadCurve[] {
  const graph = buildRoadGraph(roads);
  if (graph.crossings.length === 0) return roads.slice();
  const along: Float32Array[] = roads.map((road) => curveDistances(road.points));
  const shared = sharedPoints(roads, along);
  const pairs = graph.crossings.map((crossing) => {
    const one = roads[graph.edges[crossing.over]?.curve ?? -1];
    const other = roads[graph.edges[crossing.under]?.curve ?? -1];
    return one === undefined || other === undefined ? undefined : { crossing, one, other };
  });
  // A highway was laid on its decks, so where a road passes under one the two
  // are apart already. That road may not climb there, or it would climb into
  // the deck, so the place blocks a raise the way a junction does.
  const separated = pairs.map((pair) => pair !== undefined && underDeck(pair.one, pair.other, pair.crossing, shared));
  const raises: Raise[][] = roads.map(() => []);
  for (let k = 0; k < pairs.length; k++) {
    const pair = pairs[k];
    if (pair === undefined || separated[k] === true) continue;
    const { crossing, one, other } = pair;
    // The narrower road is the one that climbs. A highway holds its line: it is
    // the road that does not stop, its grade limit is the gentlest of any tier,
    // so its ramps would be the longest, and a local road hopping over a trunk
    // road is what a city does. Where the narrower one cannot be carried, the
    // wider one climbs instead, because either way round separates the two.
    const first = CLIMB_RANK[one.tier] <= CLIMB_RANK[other.tier] ? one : other;
    const second = first === one ? other : one;
    for (const road of [first, second]) {
      const met = road === first ? second : first;
      const plan = planRaise(road, met, crossing, along[road.id] as Float32Array, shared[road.id] as number[]);
      if (plan === undefined) continue;
      (raises[road.id] as Raise[]).push(plan);
      break;
    }
  }
  return roads.map((road) => raised(road, raises[road.id] as Raise[]));
}

/**
 * What it takes to carry `road` over `met` at a crossing, or undefined where it
 * may not be carried there. The reach is the whole of the plateau and both
 * ramps: the road has to be free of junctions and of bores over all of it, and
 * long enough to land on the ground again at each end.
 */
function planRaise(
  road: RoadCurve,
  met: RoadCurve,
  at: Point,
  distances: Float32Array,
  nodes: readonly number[],
): Raise | undefined {
  const along = distanceOf(road, distances, at);
  if (along === undefined) return undefined;
  const plateau = footprintHalfWidth(met.tier) + PLATEAU_MARGIN;
  const ramp = CLEARANCE / TIERS[road.tier].maxGrade;
  const low = along - plateau;
  const high = along + plateau;
  const from = pointBefore(distances, low - ramp);
  const to = pointAfter(distances, high + ramp);
  // A road that runs out before it is down again would end in mid-air.
  if (from === undefined || to === undefined) return undefined;
  // A junction inside the reach is a plane at the height of the ground, and a
  // road cannot be on the ground and over it at once.
  for (const node of nodes) {
    if (node > from && node < to) return undefined;
  }
  // A bore is inside the hill the road would be carried over, and a deck over
  // water is already a structure with its own two ends on dry land. The raise
  // keeps off both rather than cutting them into pieces.
  for (const segment of [...road.tunnels, ...road.bridges]) {
    if ((distances[segment + 1] as number) > from && (distances[segment] as number) < to) return undefined;
  }
  return { from, low, high, to };
}

/** The last point of a curve at or before a distance along it, or undefined where it starts later. */
function pointBefore(distances: Float32Array, at: number): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < distances.length; i++) {
    const here = distances[i] as number;
    if (here > at) break;
    best = here;
  }
  return best;
}

/** The first point of a curve at or after a distance along it, or undefined where it ends earlier. */
function pointAfter(distances: Float32Array, at: number): number | undefined {
  for (let i = 0; i < distances.length; i++) {
    const here = distances[i] as number;
    if (here >= at) return here;
  }
  return undefined;
}

/** The distance along a curve a crossing stands at, or undefined where it stands on none of it. */
function distanceOf(road: RoadCurve, distances: Float64Array | Float32Array, at: Point): number | undefined {
  let best: number | undefined;
  let bestOff = 0.01;
  for (let i = 0; i + 1 < road.points.length; i++) {
    const a = road.points[i] as Point;
    const b = road.points[i + 1] as Point;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const length2 = vx * vx + vy * vy;
    if (length2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((at.x - a.x) * vx + (at.y - a.y) * vy) / length2));
    const off = Math.hypot(a.x + vx * t - at.x, a.y + vy * t - at.y);
    if (off >= bestOff) continue;
    bestOff = off;
    best = (distances[i] as number) + t * Math.sqrt(length2);
  }
  return best;
}

/**
 * True where one of two crossing roads already stands a clearance over the
 * other at the crossing. The distance along the lower road is added to its
 * places a raise may not reach.
 */
function underDeck(one: RoadCurve, other: RoadCurve, at: Point, blocked: number[][]): boolean {
  for (const [high, low] of [[one, other], [other, one]] as const) {
    const lift = high.lift;
    if (lift === undefined) continue;
    const place = distanceOf(high, curveDistances(high.points), at);
    if (place === undefined || liftAlong(high, place) < CLEARANCE - SEPARATED_SLACK) continue;
    const below = distanceOf(low, curveDistances(low.points), at);
    if (below !== undefined) (blocked[low.id] as number[]).push(below);
    return true;
  }
  return false;
}

/** The lift a curve carries at a distance along it, straight between its points. */
function liftAlong(road: RoadCurve, along: number): number {
  const lift = road.lift;
  if (lift === undefined) return 0;
  const distances = curveDistances(road.points);
  for (let i = 0; i + 1 < distances.length; i++) {
    const from = distances[i] as number;
    const to = distances[i + 1] as number;
    if (along > to) continue;
    const t = to === from ? 0 : (along - from) / (to - from);
    return (lift[i] as number) * (1 - t) + (lift[i + 1] as number) * t;
  }
  return 0;
}

/**
 * The distances along each curve of the nodes it shares with another curve:
 * the junctions a raise may not reach into.
 */
function sharedPoints(roads: readonly RoadCurve[], along: readonly Float32Array[]): number[][] {
  const counts = new Map<number, number>();
  for (const road of roads) {
    for (const node of road.nodes) if (node >= 0) counts.set(node, (counts.get(node) ?? 0) + 1);
  }
  return roads.map((road) => {
    const distances = along[road.id] as Float32Array;
    const out: number[] = [];
    for (let i = 0; i < road.points.length; i++) {
      const node = road.nodes[i] ?? -1;
      if (node >= 0 && (counts.get(node) ?? 0) > 1) out.push(distances[i] as number);
    }
    return out;
  });
}

/**
 * One curve with its raises in it: a point at each knot of the profile, the
 * lift at every point, and every raised segment listed as a deck. Two raises
 * that reach into each other give one longer deck, because the lift is the
 * higher of the two profiles everywhere and never comes back down between them.
 */
function raised(road: RoadCurve, raises: readonly Raise[]): RoadCurve {
  if (raises.length === 0) return road;
  const distances = curveDistances(road.points);
  const wanted: number[] = [];
  // Only the two ends of the level deck are new points; the ramps end on
  // points the curve already has.
  for (const raise of raises) wanted.push(raise.low, raise.high);
  wanted.sort(compareNumbers);
  const cut = insertAt(road, distances, wanted);
  const after = curveDistances(cut.points);
  const lift: number[] = [];
  // A highway already stands on the decks it was planned with; a raise only
  // ever adds to that.
  for (let i = 0; i < cut.points.length; i++) lift.push(Math.max(cut.lift?.[i] ?? 0, liftAt(raises, after[i] as number)));
  const bridges = cut.bridges.slice();
  for (let i = 0; i + 1 < cut.points.length; i++) {
    if ((lift[i] as number) < DECK_LIFT && (lift[i + 1] as number) < DECK_LIFT) continue;
    if (!bridges.includes(i)) bridges.push(i);
  }
  bridges.sort(compareNumbers);
  return { ...cut, bridges, lift };
}

/** How far over the ground the road stands at a distance along it: the highest profile there. */
function liftAt(raises: readonly Raise[], along: number): number {
  let lift = 0;
  for (const raise of raises) {
    if (along <= raise.from || along >= raise.to) continue;
    if (along >= raise.low && along <= raise.high) lift = Math.max(lift, CLEARANCE);
    else if (along < raise.low) {
      lift = Math.max(lift, (CLEARANCE * (along - raise.from)) / (raise.low - raise.from));
    } else {
      lift = Math.max(lift, (CLEARANCE * (raise.to - along)) / (raise.to - raise.high));
    }
  }
  return lift;
}

/**
 * A curve with a point at each of `wanted`, measured along it. The decks, the
 * bores, the slots, the interchanges and the lift move with the points they
 * stand on.
 */
function insertAt(road: RoadCurve, distances: Float32Array, wanted: readonly number[]): RoadCurve {
  const points: Point[] = [];
  /** How far each old point moved along the new list. */
  const shift: number[] = [];
  const lift: number[] = [];
  const nodes: number[] = [];
  let next = 0;
  for (let i = 0; i < road.points.length; i++) {
    const here = distances[i] as number;
    while (next < wanted.length && (wanted[next] as number) < here - SAME_PLACE / 1000) {
      const want = wanted[next] as number;
      next++;
      if (i === 0) continue;
      const from = distances[i - 1] as number;
      if (want <= from) continue;
      const a = road.points[i - 1] as Point;
      const b = road.points[i] as Point;
      const t = (want - from) / (here - from);
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      // A knot is where a deck begins, not where roads meet.
      nodes.push(-1);
      lift.push((road.lift?.[i - 1] ?? 0) * (1 - t) + (road.lift?.[i] ?? 0) * t);
    }
    // A knot within half a millimetre of a point is that point.
    while (next < wanted.length && Math.abs((wanted[next] as number) - here) <= SAME_PLACE / 1000) next++;
    shift[i] = points.length;
    points.push(road.points[i] as Point);
    nodes.push(road.nodes[i] ?? -1);
    lift.push(road.lift?.[i] ?? 0);
  }
  // A segment a knot was inserted into is now several, and all of them stand on
  // the structure the one segment did.
  const spread = (segments: readonly number[]): number[] => {
    const out: number[] = [];
    for (const segment of segments) {
      for (let i = shift[segment] as number; i < (shift[segment + 1] as number); i++) out.push(i);
    }
    return out.sort(compareNumbers);
  };
  const cut: RoadCurve = {
    ...road,
    points,
    nodes,
    bridges: spread(road.bridges),
    tunnels: spread(road.tunnels),
    interchanges: road.interchanges.map((i) => shift[i] as number).sort(compareNumbers),
  };
  if (road.slots !== undefined) cut.slots = spread(road.slots);
  if (road.lift !== undefined) cut.lift = lift;
  return cut;
}
