/**
 * What a junction's plane does to a road that passes under a deck, and the
 * surface the crossing plan measures because of it (issue #533).
 *
 * A crossing is decided on the surface each road drives. Away from a junction
 * that surface is the road's bed: the ground under its own points, straight
 * between them, and its lift. At a junction it is not. Every road that meets
 * there is laid on the junction's one plane out to its cut and blended back
 * onto its own line over as far again (`bed.ts`), so a road under a deck inside
 * that reach drives above or below the bed the plan read. The lift reached
 * 2.15 m, and took the headroom of the deck over it with it.
 *
 * So the plan asks here instead. Every junction of the network within
 * {@link PLANE_REACH} of a place is fitted the way `bed.ts` will fit it, and
 * the answer is the lowest and the highest the surface can stand there: the
 * road's own bed where no plane reaches it. The junctions are the ones the
 * network holds now, which is all a plan can know; `crossing-plan.ts` keeps a
 * junction laid later out of the reach of a crossing, so the answer still
 * stands when the world is finished.
 *
 * Pure: the same network and place give the same span.
 */
import { hypot } from '../core/libm.ts';
import { lerp } from '../core/math.ts';
import { BLEND_CUTS, junctionPlane, planeHeight, type Ground, type JunctionPlane } from './bed.ts';
import { alongSegment } from './crossing-line.ts';
import { junctionMouths, MAX_CUT, type JunctionMouth, type MouthSeed } from './junctions.ts';
import { curveDistances } from './ribbon.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/**
 * Metres along a road that a junction's plane can move it: the longest cut a
 * mouth takes, and the blend that carries it back onto its own line past that.
 */
export const PLANE_REACH = MAX_CUT * (1 + BLEND_CUTS);

/** What a plane is worked out against: the roads laid so far, the nodes they share, and the ground. */
export interface PlaneNetwork {
  readonly curves: readonly RoadCurve[];
  /** Every curve point standing on the node a place is; the point it stands on alone where that is no node, and empty where no road has a point there. */
  nodeAt(p: Point): { curve: number; index: number }[];
  /** The natural ground at a place. */
  heightAt(x: number, y: number): number;
}

/** A line a span is asked about: a road laid, or the one a plan is settling. */
export interface PlaneLine {
  /** The id the line has, or will have once it is laid: which mouths are its own. */
  id: number;
  points: readonly Point[];
  lift?: readonly number[];
}

/** A node a line stands on, and every road that leaves it. */
export interface PlaneNode {
  /** Index of the line's point standing on the node. */
  point: number;
  seeds: MouthSeed[];
}

/** A node of the network a plan gives another mouth: where it stands, and the roads that will leave it. */
export interface PlaneEdit {
  at: Point;
  seeds: MouthSeed[];
}

/** Metres apart two places are the same node. */
const SAME_NODE = 1e-6;

/** How high a road can stand at a place: its bed where no plane reaches it. */
export interface SurfaceSpan {
  low: number;
  high: number;
}

/** One mouth of a junction near a place, with the plane its junction is levelled to. */
interface Reaching {
  mouth: JunctionMouth;
  plane: JunctionPlane;
}

/**
 * The surface a laid road drives where a place stands on one of its segments:
 * the lowest and the highest the junction planes near it leave the road there.
 * The two are the bed itself where no junction reaches the place.
 */
export function surfaceSpan(network: PlaneNetwork, curve: number, segment: number, at: Point, edits: readonly PlaneEdit[] = []): SurfaceSpan {
  const road = network.curves[curve] as RoadCurve;
  const distances = curveDistances(road.points);
  const nodes: PlaneNode[] = [];
  const from = (distances[segment] as number) - PLANE_REACH;
  const to = (distances[segment + 1] as number) + PLANE_REACH;
  for (let i = 0; i < road.points.length; i++) {
    const along = distances[i] as number;
    if (along < from || along > to) continue;
    const p = road.points[i] as Point;
    const edit = edits.find((one) => hypot(one.at.x - p.x, one.at.y - p.y) <= SAME_NODE);
    const seeds = edit === undefined ? seedsAt(network, p) : edit.seeds;
    if (seeds.length >= 2) nodes.push({ point: i, seeds });
  }
  return spanOf((x, y) => network.heightAt(x, y), { id: road.id, points: road.points, lift: road.lift }, nodes, segment, at);
}

/**
 * The surface span at a place on a line whose nodes are known: the lowest and
 * the highest the junctions at those nodes leave it. A plan asks this about the
 * road it is settling, whose junctions it knows but the network does not yet.
 */
export function spanOf(ground: Ground, line: PlaneLine, nodes: readonly PlaneNode[], segment: number, at: Point): SurfaceSpan {
  const points = line.points;
  const distances = curveDistances(points);
  const own = (i: number): number => {
    const p = points[i] as Point;
    return ground(p.x, p.y) + (line.lift?.[i] ?? 0);
  };
  const reaching = reachingMouths(ground, line, distances, nodes, segment);
  const t = alongSegment(points[segment] as Point, points[segment + 1] as Point, at);
  if (reaching.length === 0) {
    const height = lerp(own(segment), own(segment + 1), t);
    return { low: height, high: height };
  }
  // What one end of the segment stands at. A mouth lays the plane itself inside
  // its cut and holds it there, so a cut beats a blend, and the road's own bed
  // is left only where no mouth reaches the point at all. Two mouths of the
  // same kind reaching one point is the only thing that leaves a span rather
  // than a height, and it is rare: junctions that close together stand inside
  // each other.
  const ends = [segment, segment + 1].map((i) => {
    const cut: number[] = [];
    const blend: number[] = [];
    for (const reach of reaching) {
      const laid = laidHeight(points, distances, own, reach, i);
      if (laid !== undefined) (laid.cut ? cut : blend).push(laid.height);
    }
    let heights: number[];
    if (cut.length > 0) heights = cut;
    else if (blend.length > 0) heights = blend;
    else heights = [own(i)];
    return { low: Math.min(...heights), high: Math.max(...heights) };
  });
  // A cut inside the segment is a knot of the profile, as `bed.ts` inserts it.
  const knots = reaching
    .filter((reach) => reach.mouth.segment === segment && reach.mouth.cut > 0)
    .map((reach) => ({
      t: alongSegment(points[segment] as Point, points[segment + 1] as Point, reach.mouth.at),
      h: planeHeight(reach.plane, reach.mouth.at.x, reach.mouth.at.y),
    }))
    .sort((m, n) => m.t - n.t);
  const [from, to] = ends as [SurfaceSpan, SurfaceSpan];
  return { low: alongProfile(from.low, to.low, knots, t), high: alongProfile(from.high, to.high, knots, t) };
}

/** The height at `t` along a segment that stands at `from` and `to` with these knots inside it. */
function alongProfile(from: number, to: number, knots: readonly { t: number; h: number }[], t: number): number {
  let lastT = 0;
  let lastH = from;
  for (const knot of knots) {
    if (t <= knot.t) return knot.t <= lastT ? knot.h : lerp(lastH, knot.h, (t - lastT) / (knot.t - lastT));
    lastT = knot.t;
    lastH = knot.h;
  }
  return lastT >= 1 ? lastH : lerp(lastH, to, (t - lastT) / (1 - lastT));
}

/**
 * The height one mouth of a junction lays at a point of its road, as `bed.ts`
 * lays it: the plane inside the cut, and the road's own bed plus its share of
 * the offset at the cut over the blend. Nothing past the blend, and nothing
 * behind the node, where this mouth says nothing about the road.
 */
function laidHeight(
  points: readonly Point[],
  distances: Float32Array,
  own: (i: number) => number,
  reach: Reaching,
  i: number,
): { height: number; cut: boolean } | undefined {
  const { mouth, plane } = reach;
  if (i === mouth.point) return { height: plane.level, cut: true };
  if ((i - mouth.point) * mouth.direction < 0) return undefined;
  const along = Math.abs((distances[i] as number) - (distances[mouth.point] as number));
  const cutHeight = planeHeight(plane, mouth.at.x, mouth.at.y);
  if (along < mouth.cut) {
    const p = points[i] as Point;
    return { height: planeHeight(plane, p.x, p.y), cut: true };
  }
  if (along === mouth.cut) return { height: cutHeight, cut: true };
  const blendEnd = mouth.cut * (1 + BLEND_CUTS);
  if (along >= blendEnd) return undefined;
  // The blend: the cut stands off the road's own line by the offset, and both
  // it and the tilt fall away to nothing at the first point past the blend.
  const a = points[mouth.segment] as Point;
  const b = points[mouth.segment + 1] as Point | undefined;
  const t = b === undefined ? 0 : alongSegment(a, b, mouth.at);
  const offset = cutHeight - lerp(own(mouth.segment), own(mouth.segment + 1 < points.length ? mouth.segment + 1 : mouth.segment), t);
  let end = mouth.point + mouth.direction;
  const from = distances[mouth.point] as number;
  while (end >= 0 && end < points.length && Math.abs((distances[end] as number) - from) < blendEnd) end += mouth.direction;
  const span = end >= 0 && end < points.length ? Math.abs((distances[end] as number) - from) - mouth.cut : blendEnd - mouth.cut;
  return { height: own(i) + offset * (1 - (along - mouth.cut) / span), cut: false };
}

/** The mouths of the junctions near enough to a segment of a line to move either end of it. */
function reachingMouths(ground: Ground, line: PlaneLine, distances: Float32Array, nodes: readonly PlaneNode[], segment: number): Reaching[] {
  const out: Reaching[] = [];
  const from = (distances[segment] as number) - PLANE_REACH;
  const to = (distances[segment + 1] as number) + PLANE_REACH;
  for (const node of nodes) {
    const along = distances[node.point] as number;
    if (along < from || along > to) continue;
    const at = line.points[node.point] as Point;
    const mouths = junctionMouths(at, node.seeds);
    if (mouths.length === 0) continue;
    const plane = junctionPlane(ground, at, mouths);
    for (const mouth of mouths) if (mouth.curve === line.id && mouth.point === node.point) out.push({ mouth, plane });
  }
  return out;
}

/**
 * The roads leaving the node a place stands on, as `junctions.ts` reads them
 * off the graph. Nothing where one road alone has a point there: a point inside
 * a curve is no node, and the graph breaks no edge at it.
 */
function seedsAt(network: PlaneNetwork, at: Point): MouthSeed[] {
  const on = network.nodeAt(at);
  if (on.length < 2) return [];
  const seeds: MouthSeed[] = [];
  for (const point of on) {
    const road = network.curves[point.curve] as RoadCurve;
    seeds.push(...seedsOn(road.id, road.tier, road.points, point.index, road.bridges, road.tunnels, road.lift));
  }
  return seeds;
}

/**
 * The mouths one road leaves a node by: one each way, less a way it runs out
 * of road, and less one on a deck or in a bore, which meets nothing on the
 * ground.
 */
export function seedsOn(
  curve: number,
  tier: RoadTier,
  points: readonly Point[],
  index: number,
  bridges: readonly number[],
  tunnels: readonly number[],
  lift?: readonly number[],
): MouthSeed[] {
  const seeds: MouthSeed[] = [];
  for (const direction of [1, -1] as const) {
    if (points[index + direction] === undefined) continue;
    const first = direction === 1 ? index : index - 1;
    if (bridges.includes(first) || tunnels.includes(first)) continue;
    seeds.push({ curve, tier, points, lift, point: index, direction });
  }
  return seeds;
}
