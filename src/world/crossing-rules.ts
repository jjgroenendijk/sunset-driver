/**
 * Where a junction may stand at a crossing (spec section 6.2): the rules one
 * place is tried by while `crossing-plan.ts` decides a crossing.
 *
 * A place is the nearest point either road already has within the snap, or the
 * crossing itself. It is refused:
 *
 * - where a road standing on it may not be joined by either tier;
 * - where the ground refuses a half the point cuts a segment into, which can
 *   climb harder than the whole segment did;
 * - where the point bends a road back over its own carriageway, over the free
 *   end of a third road, or across a road the segment did not cross before;
 * - where any two roads would leave the place, or the places beside it, at less
 *   than `MIN_MEET`, since each would lie in the other's carriageway.
 */
import { alongSegment, PlannedLine, shallow, toSegment, type Place } from './crossing-line.ts';
import type { DraftLine, PointEdit } from './crossing-plan.ts';
import { crossPoint, type SegmentCrossing } from './network-clearance.ts';
import { bendOverlaps } from './self-overlap.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/** Metres off a segment's line a point may stand and still lie on it. */
const ON_LINE = 1e-6;

/** What a crossing is planned against: the roads laid so far and the ground under them. */
export interface CrossingNetwork {
  readonly curves: readonly RoadCurve[];
  /** Every segment of a laid road the straight run crosses. */
  crossingsAlong(a: Point, b: Point): SegmentCrossing[];
  /** The roads with a point at a place, ascending; empty where none has. */
  curvesAt(p: Point): number[];
  /** The points the roads other than `except` run on to from a place. */
  neighboursAt(p: Point, except: number): Point[];
  /** True where a road of this tier may take a junction at every road point standing on a place. */
  joinableAt(p: Point, tier: RoadTier): boolean;
  /** The free ends of laid roads within `reach` of a place: ends no other road meets. */
  freeEnds(x: number, y: number, reach: number): { curve: number; at: Point }[];
  /** True where a road of this tier may run straight from `a` to `b` on the ground. */
  canRun(a: Point, b: Point, tier: RoadTier): boolean;
  /** The natural ground at a place. */
  heightAt(x: number, y: number): number;
  /** True where a road of this tier may end: its footprint stands on no other road's. */
  clearAt(x: number, y: number, tier: RoadTier): boolean;
}

/** A junction the plan takes: where, the point the draft is given, and the point the laid road takes. */
export interface Junction {
  x: number;
  y: number;
  draft?: Place;
  edit?: PointEdit;
}

/** How one road takes a place: the point it is given, if any, and the places it runs on to. */
interface Side {
  given?: Place;
  around: Place[];
}

/** The crossing a junction is tried at: the draft's segment, the laid road's, and where. */
export interface CrossingAt {
  segment: number;
  curve: number;
  other: number;
  x: number;
  y: number;
}

/**
 * The junction a crossing takes, or undefined where every place is refused.
 * The nearest point either road has within `snap` is tried first, then the
 * crossing itself.
 */
export function junctionAt(
  network: CrossingNetwork,
  draftLine: PlannedLine,
  otherLine: PlannedLine,
  draft: DraftLine,
  other: RoadCurve,
  crossing: CrossingAt,
  snap: number,
): Junction | undefined {
  const here = { x: crossing.x, y: crossing.y };
  const first = otherLine.nearest(here, snap);
  const second = draftLine.nearest(here, snap);
  let snapped: Point | undefined = first ?? second;
  if (first !== undefined && second !== undefined) {
    snapped = Math.hypot(second.x - here.x, second.y - here.y) < Math.hypot(first.x - here.x, first.y - here.y) ? second : first;
  }
  for (const spot of snapped === undefined ? [here] : [{ x: snapped.x, y: snapped.y }, here]) {
    if (!network.joinableAt(spot, draft.tier) || !network.joinableAt(spot, other.tier)) continue;
    const theirs = sideAt(network, otherLine, other.lift, crossing.other, spot, other.id, draftLine);
    if (theirs === undefined) continue;
    const mine = sideAt(network, draftLine, draft.lift, crossing.segment, spot, -1, undefined);
    if (mine === undefined) continue;
    if (shallow(spot, theirs.around, mine.around)) continue;
    if (bends(network, spot, theirs.around, other.id) || bends(network, spot, mine.around, -1)) continue;
    const junction: Junction = { x: spot.x, y: spot.y };
    if (mine.given !== undefined) junction.draft = mine.given;
    if (theirs.given !== undefined) {
      const g = theirs.given;
      junction.edit = { curve: other.id, segment: g.segment, at: g.at, x: g.x, y: g.y };
    }
    return junction;
  }
  return undefined;
}

/**
 * How a line takes a point at a place: nothing new where it stands there
 * already, else a point in `segment`. Undefined where the line may not take it.
 * `crossed` is the other line of the pair, which a bend of this one may not
 * cross; it is only asked of the laid road, since the draft is not laid yet.
 */
function sideAt(
  network: CrossingNetwork,
  line: PlannedLine,
  lift: readonly number[] | undefined,
  segment: number,
  spot: Point,
  curve: number,
  crossed: PlannedLine | undefined,
): Side | undefined {
  const own = line.placeAt(spot);
  if (own !== undefined) {
    if (own.index >= 0 && (lift?.[own.index] ?? 0) > 0) return undefined;
    return { around: line.around(own) };
  }
  const a = line.points[segment] as Point;
  const b = line.points[segment + 1] as Point;
  const at = Math.min(1 - 1e-9, Math.max(1e-9, alongSegment(a, b, spot)));
  const [before, after] = line.halves(segment, at);
  if (!network.canRun(before, spot, line.tier) || !network.canRun(spot, after, line.tier)) return undefined;
  const bent = line.bentAt(before, spot);
  if (bendOverlaps(bent.line, bent.segment, spot, line.tier)) return undefined;
  if (toSegment(spot, before, after) > ON_LINE && crossesNew(network, before, spot, after, crossed)) return undefined;
  if (buried(network, line.tier, spot, [before, after], curve)) return undefined;
  return { given: { x: spot.x, y: spot.y, segment, at, index: -1 }, around: [before, after] };
}

/**
 * True where a road bent from `before`–`after` through `spot` crosses a laid
 * road the straight run did not, or crosses `crossed` anywhere.
 */
function crossesNew(network: CrossingNetwork, before: Point, spot: Point, after: Point, crossed: PlannedLine | undefined): boolean {
  const key = (hit: SegmentCrossing): string => `${hit.curve}:${hit.segment}`;
  const was = new Set(network.crossingsAlong(before, after).map(key));
  for (const [a, b] of [[before, spot], [spot, after]] as const) {
    if (network.crossingsAlong(a, b).some((hit) => !was.has(key(hit)))) return true;
    if (crossed === undefined) continue;
    const seq = crossed.sequence();
    for (let i = 0; i + 1 < seq.length; i++) {
      if (crossPoint(a, b, seq[i] as Point, seq[i + 1] as Point) !== undefined) return true;
    }
  }
  return false;
}

/**
 * True where a road given a point at `spot`, running on from it to `around`,
 * would leave the place or a place beside it along the line of another road
 * that meets it there.
 */
function bends(network: CrossingNetwork, spot: Point, around: readonly Point[], curve: number): boolean {
  if (shallow(spot, around, network.neighboursAt(spot, curve))) return true;
  return around.some((place) => shallow(place, [spot], network.neighboursAt(place, curve)));
}

/**
 * True when a road bent through `spot` covers a free end of another road with
 * its carriageway that the straight run between the two places beside it left
 * clear.
 */
function buried(network: CrossingNetwork, tier: RoadTier, spot: Point, around: readonly Point[], curve: number): boolean {
  const half = footprintHalfWidth(tier);
  let reach = half;
  for (const p of around) reach = Math.max(reach, Math.hypot(p.x - spot.x, p.y - spot.y) + half);
  for (const end of network.freeEnds(spot.x, spot.y, reach)) {
    if (end.curve === curve) continue;
    let near = Infinity;
    for (const p of around) near = Math.min(near, toSegment(end.at, spot, p));
    if (near >= half) continue;
    const before = around.length === 2 ? toSegment(end.at, around[0] as Point, around[1] as Point) : Infinity;
    if (before >= half) return true;
  }
  return false;
}
