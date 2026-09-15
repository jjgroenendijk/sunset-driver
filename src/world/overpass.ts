/**
 * The lift profile of an overpass (spec section 6.2): how a road is carried
 * over another one instead of meeting it.
 *
 * The road climbs to {@link CLEARANCE} above the road it crosses, holds that
 * over the crossing, and ramps back onto the ground each side no harder than its
 * tier's `maxGrade`. A raised stretch is a deck: it is added to the curve's
 * `bridges`, so the carve leaves the ground under it alone, `road-mesh.ts`
 * lofts the deck it already lofts over water, and the physics stands on it
 * (`decks.ts`). The height itself lives in `RoadCurve.lift`, which is the one
 * thing a curve says about its own height; everything else reads the ground
 * under it.
 *
 * Whether a crossing is raised at all is decided when the road is added to the
 * network (`crossing-plan.ts`). This file only says what a raise reaches and
 * lays it into a line. Pure: the same line and raises give the same curve.
 */
import { compareNumbers } from '../core/sort.ts';
import { curveDistances } from './ribbon.ts';
import type { Point } from './types.ts';

/**
 * Metres of headroom over the road that passes underneath: the deck of the road
 * above stands this far over the bed of the road below, which is enough for the
 * tallest of the roster (spec section 11.3) to drive under it.
 */
export const CLEARANCE = 6.5;

/** Metres of level deck each side of the road crossed, past the ground it claims. */
export const PLATEAU_MARGIN = 4;

/** Metres a raised point has to stand over the ground before its segment is a deck. */
const DECK_LIFT = 0.2;

/** Millimetres: two points this close are the same place, so no knot is inserted. */
const SAME_PLACE = 0.5;

/**
 * Where a road is carried over another one, as distances along the road that
 * climbs: the level deck runs from `low` to `high`, and the ramps come down
 * from there to the ground at `from` and at `to`.
 *
 * Both ends stand on a point the line already has. A ramp that ended between
 * two points would cut the segment there in two, and half a segment can climb
 * harder than the whole did, which is ground the tier may not be laid on. So
 * the ramp is taken out to the next point instead, which makes it longer than
 * the grade asks for and never steeper.
 */
export interface Raise {
  from: number;
  low: number;
  high: number;
  to: number;
}

/** A line with the structures a raise moves with its points. */
export interface RaisedLine {
  points: Point[];
  bridges: number[];
  tunnels: number[];
  interchanges: number[];
  slots?: number[];
  lift?: number[];
}

/**
 * What it takes to carry a line over a road at `along` metres along it: a level
 * deck `plateau` metres each side, and ramps of `ramp` metres out to the points
 * beyond. Undefined where the line runs out before it is down again.
 */
export function raiseAt(distances: Float32Array, along: number, plateau: number, ramp: number): Raise | undefined {
  const low = along - plateau;
  const high = along + plateau;
  let from: number | undefined;
  for (let i = 0; i < distances.length && (distances[i] as number) <= low - ramp; i++) from = distances[i] as number;
  let to: number | undefined;
  for (let i = 0; i < distances.length; i++) {
    if ((distances[i] as number) < high + ramp) continue;
    to = distances[i] as number;
    break;
  }
  return from === undefined || to === undefined ? undefined : { from, low, high, to };
}

/**
 * One line with its raises in it: a point at each knot of the profile, the
 * lift at every point, and every raised segment listed as a deck. Two raises
 * that reach into each other give one longer deck, because the lift is the
 * higher of the two profiles everywhere and never comes back down between them.
 */
export function raised<T extends RaisedLine>(road: T, raises: readonly Raise[]): T {
  if (raises.length === 0) return road;
  const distances = curveDistances(road.points);
  const wanted: number[] = [];
  // Only the two ends of the level deck are new points; the ramps end on
  // points the line already has.
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
  // The distances along a line are single precision, so a knot of the level
  // deck can come back a fraction of a millimetre outside it.
  const knot = SAME_PLACE / 1000;
  for (const raise of raises) {
    if (along <= raise.from || along >= raise.to) continue;
    if (along >= raise.low - knot && along <= raise.high + knot) lift = Math.max(lift, CLEARANCE);
    else if (along < raise.low) {
      lift = Math.max(lift, (CLEARANCE * (along - raise.from)) / (raise.low - raise.from));
    } else {
      lift = Math.max(lift, (CLEARANCE * (raise.to - along)) / (raise.to - raise.high));
    }
  }
  return lift;
}

/**
 * A line with a point at each of `wanted`, measured along it. The decks, the
 * bores, the slots, the interchanges and the lift move with the points they
 * stand on.
 */
function insertAt<T extends RaisedLine>(road: T, distances: Float32Array, wanted: readonly number[]): T {
  const points: Point[] = [];
  /** How far each old point moved along the new list. */
  const shift: number[] = [];
  const lift: number[] = [];
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
      lift.push((road.lift?.[i - 1] ?? 0) * (1 - t) + (road.lift?.[i] ?? 0) * t);
    }
    // A knot within half a millimetre of a point is that point.
    while (next < wanted.length && Math.abs((wanted[next] as number) - here) <= SAME_PLACE / 1000) next++;
    shift[i] = points.length;
    points.push(road.points[i] as Point);
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
  const cut: T = {
    ...road,
    points,
    bridges: spread(road.bridges),
    tunnels: spread(road.tunnels),
    interchanges: road.interchanges.map((i) => shift[i] as number).sort(compareNumbers),
  };
  if (road.slots !== undefined) cut.slots = spread(road.slots);
  if (road.lift !== undefined) cut.lift = lift;
  return cut;
}
