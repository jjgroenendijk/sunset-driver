/**
 * The junctions of the road network (spec section 6.2): where roads meet, and
 * how each one is cut back so that they meet rather than cross.
 *
 * A road is lofted along its curve on its own, so two roads that share a point
 * would otherwise be drawn straight through one another: the kerb and the
 * pavement of each across the carriageway of the other, and the paint of both
 * running on through the crossing. A junction is the fix. At every node of the
 * road graph where two or more roads meet on the ground, each road is a mouth
 * of the junction, and it is cut back to where its kerbs leave the kerbs of its
 * neighbours; the ground between the cuts is one carriageway, and the corner
 * between two neighbouring mouths is one piece of pavement with a rounded kerb.
 *
 * Everything here is measured along the curves, so a chunk that holds a road
 * but not the junction it ends at cuts the road at exactly the place the chunk
 * that draws the junction expects. The distances are the ones `ribbon.ts`
 * answers with, computed the same way.
 *
 * Built on demand from the curves and the graph like the footprint, not stored
 * in the world description. Pure: the same roads give the same junctions.
 */
import { compareNumbers } from '../core/sort.ts';
import { atan2, cos, hypot, sin, tan } from '../core/libm.ts';
import { alongSegment } from './crossing-line.ts';
import type { RoadGraph, RoadNode } from './graph.ts';
import { curveDistances } from './ribbon.ts';
import { footprintHalfWidth, TIERS } from './tiers.ts';
import type { Point, RoadCurve, RoadTier } from './types.ts';

/**
 * Metres a mouth may be cut back from the node at most. Two roads that meet at
 * a shallow angle have kerbs that only cross far along; past this the corner
 * is closed straight across instead, and the roads overlap a little.
 */
export const MAX_CUT = 40;

/** Metres of radius the kerb takes round a convex corner, where the roads are wide enough for it. */
export const FILLET_RADIUS = 4;
/** Straight pieces one rounded kerb is drawn in. */
const FILLET_STEPS = 4;

/**
 * Cosine of the bend below which two roads meeting end to end are one road and
 * take no junction: their sections hand over in line, as they do at every point
 * inside a curve.
 */
const STRAIGHT = cos((10 * Math.PI) / 180);

/** Sine of the angle below which two kerb lines are parallel and have no crossing to find. */
const PARALLEL = 1e-6;

/** Metres a mouth walks along its curve to find which way it leaves the node. */
const HEADING_REACH = 0.01;

/**
 * Metres a mouth's curve may stray from the straight line it leaves the node
 * on before the junction stops treating it as straight. The corners are found
 * on straight kerb lines and the road is cut where its curve really is, so a
 * mouth that bends inside its cut would put the two in different places.
 */
const STRAY = 1;

/** One road leaving a junction. */
export interface JunctionMouth {
  curve: number;
  tier: RoadTier;
  /** Index of the curve point that stands on the node. */
  point: number;
  /** 1 where the road leaves the node along its curve, -1 where it leaves against it. */
  direction: 1 | -1;
  /** Unit direction the road leaves the node in. */
  dx: number;
  dy: number;
  /** Metres along the curve from the node that the road is cut back. */
  cut: number;
  /** Where that cut stands on the curve, and the segment it stands on. */
  at: Point;
  segment: number;
  /**
   * Metres the road stands over the ground at the node, and at the cut
   * (`RoadCurve.lift`). Both are zero for a road on the ground; a road on an
   * embankment drives that far over it, and the plane the junction is levelled
   * to has to meet it there rather than in the ground below (`bed.ts`).
   */
  lift: number;
  liftAtCut: number;
}

/**
 * The pavement between two neighbouring mouths: from the near kerb of one to
 * the near kerb of the next, and the back edge of the pavement behind it.
 */
export interface JunctionCorner {
  /**
   * The kerb, from the left kerb of the first mouth at its cut to the right
   * kerb of the next at its cut. Several points where the corner is rounded.
   */
  kerb: Point[];
  /** The back of the pavement, the same way round. */
  outer: Point[];
  /** The wider of the two tiers, which is what the corner is paved as. */
  tier: RoadTier;
}

export interface Junction {
  node: number;
  x: number;
  y: number;
  /** The widest tier that meets here, which is what the carriageway is surfaced as. */
  tier: RoadTier;
  /** The mouths, anticlockwise round the node. */
  mouths: JunctionMouth[];
  /** The corners, `corners[i]` between `mouths[i]` and the next mouth round. */
  corners: JunctionCorner[];
  /**
   * The ground the whole junction stands on, anticlockwise: the back of the
   * pavement at each mouth's cut and the outer corners between them. The carve
   * levels all of it to the junction's plane.
   */
  outline: Point[];
}

/** One end of a stretch of curve a junction takes: metres from the start of the curve, and the place. */
export interface GapEnd {
  distance: number;
  at: Point;
  /** The curve segment the place stands on. */
  segment: number;
}

/** A stretch of a curve that a junction covers, so no road surface is lofted along it. */
export interface RoadGap {
  from: GapEnd;
  to: GapEnd;
}

export interface JunctionMap {
  junctions: Junction[];
  /** The gaps of each curve, filed under the curve's id, ascending and not overlapping. */
  gaps: RoadGap[][];
}

/** Build the junctions of a road network. The graph says where roads meet. */
export function buildJunctions(roads: readonly RoadCurve[], graph: RoadGraph): JunctionMap {
  const distances: (Float32Array | undefined)[] = [];
  for (const road of roads) distances[road.id] = curveDistances(road.points);
  const junctions: Junction[] = [];
  const gaps: RoadGap[][] = [];
  for (const road of roads) gaps[road.id] = [];
  for (const node of graph.nodes) {
    const junction = junctionAt(node, roads, graph);
    if (junction === undefined) continue;
    junctions.push(junction);
    for (const mouth of junction.mouths) {
      const road = roads[mouth.curve] as RoadCurve;
      const along = distances[mouth.curve] as Float32Array;
      (gaps[mouth.curve] as RoadGap[]).push(gapOf(road, along, mouth));
    }
  }
  for (const list of gaps) if (list !== undefined) mergeGaps(list);
  return { junctions, gaps };
}

/** The mouths of a node, before their cuts are known. */
interface Mouth {
  curve: number;
  tier: RoadTier;
  /** The points of the curve the mouth is on, which its cut is placed along. */
  points: readonly Point[];
  /** The lift of the curve at each of those points, where it carries any. */
  lift: readonly number[] | undefined;
  point: number;
  direction: 1 | -1;
  dx: number;
  dy: number;
  /** Half the carriageway: where the kerb stands. */
  kerb: number;
  /** Half the ground the tier claims: where the back of the pavement stands. */
  outer: number;
  angle: number;
  cut: number;
  /** Metres along the curve it runs straight enough to be cut on a straight line. */
  straight: number;
}

/** What one corner asks of the two mouths beside it. */
interface Corner {
  kerb: Point[];
  outer: Point[];
  /** Metres along the first mouth its left kerb runs before the corner, and along the second its right kerb. */
  first: number;
  second: number;
}

/**
 * A road leaving a node, before the junction is fitted: the curve, the point of
 * it that stands on the node, and which way the road runs from there. The
 * crossing plan builds these from the network it is adding to, where there is
 * no graph to read them off yet (`plane-lift.ts`).
 */
export interface MouthSeed {
  curve: number;
  tier: RoadTier;
  points: readonly Point[];
  /** The curve's lift at each of its points, where it carries any (`overpass.ts`). */
  lift?: readonly number[];
  /** Index of the point standing on the node. */
  point: number;
  direction: 1 | -1;
}

/**
 * The mouths a node would have, cut back and anticlockwise. Empty where the
 * roads make no junction: fewer than two of them, or two that carry straight on
 * into each other.
 */
export function junctionMouths(node: Point, seeds: readonly MouthSeed[]): JunctionMouth[] {
  const fitted = fitMouths(node, seeds);
  return fitted === undefined ? [] : fitted.mouths.map(cutOf);
}

function junctionAt(node: RoadNode, roads: readonly RoadCurve[], graph: RoadGraph): Junction | undefined {
  const seeds: MouthSeed[] = [];
  for (const id of node.runs) {
    const edge = graph.edges[id];
    if (edge === undefined) continue;
    const road = roads[edge.curve] as RoadCurve;
    const { point, direction } = graph.mouthAt(id, node.id);
    // A mouth on a deck or in a bore meets nothing on the ground.
    const first = direction === 1 ? point : point - 1;
    if (road.bridges.includes(first) || road.tunnels.includes(first)) continue;
    seeds.push({ curve: road.id, tier: road.tier, points: road.points, lift: road.lift, point, direction });
  }
  const fitted = fitMouths(node, seeds);
  if (fitted === undefined) return undefined;
  const { mouths, corners } = fitted;

  let tier: RoadTier = (mouths[0] as Mouth).tier;
  for (const mouth of mouths) if (widthRank(mouth.tier) > widthRank(tier)) tier = mouth.tier;

  const outline: Point[] = [];
  for (let i = 0; i < mouths.length; i++) {
    const mouth = mouths[i] as Mouth;
    const cut = Math.min(mouth.cut, MAX_CUT);
    const x = node.x + mouth.dx * cut;
    const y = node.y + mouth.dy * cut;
    outline.push({ x: x + mouth.dy * mouth.outer, y: y - mouth.dx * mouth.outer });
    outline.push({ x: x - mouth.dy * mouth.outer, y: y + mouth.dx * mouth.outer });
    outline.push(...(corners[i] as Corner).outer);
  }

  return {
    node: node.id,
    x: node.x,
    y: node.y,
    tier,
    mouths: mouths.map(cutOf),
    corners: corners.map((corner, i) => {
      const a = mouths[i] as Mouth;
      const b = mouths[(i + 1) % mouths.length] as Mouth;
      return { kerb: corner.kerb, outer: corner.outer, tier: widthRank(a.tier) >= widthRank(b.tier) ? a.tier : b.tier };
    }),
    outline,
  };
}

/**
 * Where each road leaves a node and how far back it is cut, with the corners
 * between them. Nothing where the roads make no junction.
 */
function fitMouths(node: Point, seeds: readonly MouthSeed[]): { mouths: Mouth[]; corners: Corner[] } | undefined {
  const mouths: Mouth[] = [];
  for (const seed of seeds) {
    const heading = headingOf(seed.points, seed.point, seed.direction);
    if (heading === undefined) continue;
    const spec = TIERS[seed.tier];
    mouths.push({
      curve: seed.curve,
      tier: seed.tier,
      points: seed.points,
      lift: seed.lift,
      point: seed.point,
      direction: seed.direction,
      dx: heading.x,
      dy: heading.y,
      kerb: spec.width / 2,
      outer: footprintHalfWidth(seed.tier),
      angle: atan2(heading.y, heading.x),
      cut: 0,
      straight: straightReach(seed.points, seed.point, seed.direction, heading),
    });
  }
  if (mouths.length < 2) return undefined;
  if (mouths.length === 2) {
    const [a, b] = mouths as [Mouth, Mouth];
    // Two roads that carry straight on into each other are one road.
    if (-(a.dx * b.dx + a.dy * b.dy) >= STRAIGHT) return undefined;
  }
  mouths.sort((a, b) => a.angle - b.angle || compareNumbers(a.curve, b.curve) || a.direction - b.direction);

  const corners: Corner[] = [];
  for (let i = 0; i < mouths.length; i++) {
    const a = mouths[i] as Mouth;
    const b = mouths[(i + 1) % mouths.length] as Mouth;
    const corner = cornerOf(node, a, b, Math.min(MAX_CUT, a.straight, b.straight));
    corners.push(corner);
    a.cut = Math.max(a.cut, corner.first);
    b.cut = Math.max(b.cut, corner.second);
  }
  // The corners alone do not cut a mouth back far enough to hold the kerbs its
  // neighbours start on, so each mouth reaches for all of them once they are
  // all placed. A mouth that bends is cut where it leaves its straight line,
  // whatever this asks.
  for (const mouth of mouths) {
    for (const other of mouths) {
      if (other !== mouth) mouth.cut = Math.max(mouth.cut, Math.min(mouth.straight, kerbReach(mouth, other)));
    }
  }
  return { mouths, corners };
}

/** A fitted mouth with its cut placed on its curve. */
function cutOf(mouth: Mouth): JunctionMouth {
  const cut = Math.min(mouth.cut, MAX_CUT);
  const place = alongCurve(mouth.points, mouth.point, mouth.direction, cut);
  return {
    curve: mouth.curve,
    tier: mouth.tier,
    point: mouth.point,
    direction: mouth.direction,
    dx: mouth.dx,
    dy: mouth.dy,
    cut,
    at: place.at,
    segment: place.segment,
    lift: mouth.lift?.[mouth.point] ?? 0,
    liftAtCut: liftAt(mouth.lift, mouth.points, place.segment, place.at),
  };
}

/** The lift a curve carries at a place on one of its segments: straight between the two ends. */
function liftAt(lift: readonly number[] | undefined, points: readonly Point[], segment: number, at: Point): number {
  if (lift === undefined) return 0;
  const b = points[segment + 1] as Point | undefined;
  if (b === undefined) return lift[segment] ?? 0;
  const t = alongSegment(points[segment] as Point, b, at);
  return (lift[segment] ?? 0) * (1 - t) + (lift[segment + 1] ?? 0) * t;
}

/** Tiers by the ground they claim, so the widest road at a node is found without comparing widths twice. */
function widthRank(tier: RoadTier): number {
  return footprintHalfWidth(tier);
}

/**
 * The corner between mouth `a` and the next mouth `b` anticlockwise: where the
 * left kerb of `a` meets the right kerb of `b`, rounded where the corner is
 * convex, and where the backs of their pavements meet behind it. `limit` is
 * how far along either mouth the corner may stand: the shorter of the two
 * straight runs, and never more than {@link MAX_CUT}.
 */
function cornerOf(node: Point, a: Mouth, b: Mouth, limit: number): Corner {
  // Across a mouth, to its left.
  const alx = -a.dy;
  const aly = a.dx;
  const blx = -b.dy;
  const bly = b.dx;
  const kerbA: Point = { x: node.x + alx * a.kerb, y: node.y + aly * a.kerb };
  const kerbB: Point = { x: node.x - blx * b.kerb, y: node.y - bly * b.kerb };
  const outerA: Point = { x: node.x + alx * a.outer, y: node.y + aly * a.outer };
  const outerB: Point = { x: node.x - blx * b.outer, y: node.y - bly * b.outer };
  const kerb = meet(kerbA, a, kerbB, b);
  const outer = meet(outerA, a, outerB, b);
  // The turn from a to b, anticlockwise, in (0, 2π).
  let turn = b.angle - a.angle;
  if (turn <= 0) turn += 2 * Math.PI;
  const convex = turn < Math.PI - 1e-6;

  const reach = (at: Point): number => hypot(at.x - node.x, at.y - node.y);
  if (
    kerb === undefined ||
    outer === undefined ||
    Math.max(kerb.s, kerb.u, outer.s, outer.u) > limit ||
    // A corner behind the node, the outside of a bend, stands as far back as
    // the bend is sharp; a hairpin's would stand out on open ground.
    Math.max(reach(kerb.at), reach(outer.at)) > limit
  ) {
    // No corner to find within reach: two roads in one line hand over where
    // they stand, and two that leave at a shallow angle, or bend away inside
    // the reach, are closed straight across a short way out and overlap
    // beyond that, as they did before either was cut.
    const short = kerb === undefined ? 0 : Math.min(limit, Math.max(a.outer, b.outer));
    const s = kerb === undefined ? 0 : Math.max(0, Math.min(short, kerb.s, outer?.s ?? 0));
    const u = kerb === undefined ? 0 : Math.max(0, Math.min(short, kerb.u, outer?.u ?? 0));
    // Straight across from one kerb to the other, and not their middle: a
    // middle point stands inside both carriageways, and the junction's fan
    // then leaves the ground between it and the kerbs bare (issue #299).
    return {
      kerb: [step(kerbA, a, s), step(kerbB, b, u)],
      outer: [step(outerA, a, s), step(outerB, b, u)],
      first: s,
      second: u,
    };
  }

  let first = Math.max(0, kerb.s, outer.s);
  let second = Math.max(0, kerb.u, outer.u);
  let kerbLine: Point[] = [kerb.at];
  if (convex) {
    // Round the kerb: an arc tangent to both kerb lines, as far from the corner
    // along each as the radius and the angle between them ask.
    const half = turn / 2;
    let radius = Math.min(FILLET_RADIUS, a.kerb, b.kerb);
    let tangent = radius / tan(half);
    const room = limit - Math.max(kerb.s, kerb.u);
    if (tangent > room) {
      tangent = Math.max(0, room);
      radius = tangent * tan(half);
    }
    if (radius > 1e-3) {
      kerbLine = fillet(kerb.at, a, b, radius, tangent, half);
      first = Math.max(first, kerb.s + tangent);
      second = Math.max(second, kerb.u + tangent);
    }
  }
  return { kerb: kerbLine, outer: [outer.at], first, second };
}

/**
 * Where the line from `pa` along mouth `a` meets the line from `pb` along mouth
 * `b`, as the place and how far along each line it stands. Nothing where the
 * lines are parallel.
 */
function meet(pa: Point, a: Mouth, pb: Point, b: Mouth): { at: Point; s: number; u: number } | undefined {
  const cross = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(cross) < PARALLEL) return undefined;
  const wx = pb.x - pa.x;
  const wy = pb.y - pa.y;
  const s = (wx * b.dy - wy * b.dx) / cross;
  const u = (wx * a.dy - wy * a.dx) / cross;
  return { at: { x: pa.x + a.dx * s, y: pa.y + a.dy * s }, s, u };
}

/**
 * The arc that rounds a convex corner at `at`: from `tangent` metres along mouth
 * `a` back to the corner, round to `tangent` metres along mouth `b`.
 */
function fillet(at: Point, a: Mouth, b: Mouth, radius: number, tangent: number, half: number): Point[] {
  const from: Point = { x: at.x + a.dx * tangent, y: at.y + a.dy * tangent };
  const to: Point = { x: at.x + b.dx * tangent, y: at.y + b.dy * tangent };
  // The centre stands on the bisector of the two mouths, as far from the corner
  // as the radius and the half angle put it.
  let bx = a.dx + b.dx;
  let by = a.dy + b.dy;
  const length = hypot(bx, by);
  bx /= length;
  by /= length;
  const centre: Point = { x: at.x + (bx * radius) / sin(half), y: at.y + (by * radius) / sin(half) };
  const start = atan2(from.y - centre.y, from.x - centre.x);
  let sweep = atan2(to.y - centre.y, to.x - centre.x) - start;
  if (sweep > Math.PI) sweep -= 2 * Math.PI;
  if (sweep < -Math.PI) sweep += 2 * Math.PI;
  const out: Point[] = [from];
  for (let k = 1; k < FILLET_STEPS; k++) {
    const angle = start + (sweep * k) / FILLET_STEPS;
    out.push({ x: centre.x + cos(angle) * radius, y: centre.y + sin(angle) * radius });
  }
  out.push(to);
  return out;
}

function step(p: Point, mouth: Mouth, s: number): Point {
  return { x: p.x + mouth.dx * s, y: p.y + mouth.dy * s };
}

/**
 * Metres along mouth `a` that the junction has to cover for the kerbs another
 * mouth `b` starts on to stand inside `a`'s own carriageway. The carriageway is
 * drawn as a fan from the node out to each mouth's cut, so ground beyond a
 * mouth's cut is drawn by no mouth at all. Where two mouths turn more than a
 * right angle apart, `b` starts its kerb further along `a` than the two kerb
 * lines meet, and without this that corner of `b` is left bare (issue #299).
 */
function kerbReach(a: Mouth, b: Mouth): number {
  let reach = 0;
  for (const side of [1, -1]) {
    // Where b's kerb stands at the node, in a's own along and across.
    const x = side * b.dy * b.kerb;
    const y = -side * b.dx * b.kerb;
    const along = x * a.dx + y * a.dy;
    if (along > reach && Math.abs(y * a.dx - x * a.dy) <= a.kerb) reach = along;
  }
  return reach;
}

/**
 * How far along its curve from point `from` a mouth keeps within {@link STRAY}
 * of the straight line it leaves on. The corner is found on that line, so the
 * cut may not reach past where the curve leaves it.
 */
function straightReach(points: readonly Point[], from: number, direction: 1 | -1, heading: Point): number {
  const origin = points[from] as Point;
  let distance = 0;
  let last = origin;
  for (let i = from + direction; i >= 0 && i < points.length; i += direction) {
    const p = points[i] as Point;
    const stray = Math.abs(heading.x * (p.y - origin.y) - heading.y * (p.x - origin.x));
    if (stray > STRAY) {
      // Where along the last segment the curve crossed the stray line, so a
      // long segment that leaves the line at its far end still counts.
      const strayLast = Math.abs(heading.x * (last.y - origin.y) - heading.y * (last.x - origin.x));
      const share = (STRAY - strayLast) / Math.max(1e-9, stray - strayLast);
      return distance + hypot(p.x - last.x, p.y - last.y) * Math.max(0, Math.min(1, share));
    }
    distance += hypot(p.x - last.x, p.y - last.y);
    last = p;
    if (distance >= MAX_CUT) break;
  }
  return Math.min(MAX_CUT, distance);
}

/** Which way a curve leaves point `from` going `direction`, as a unit vector. Nothing where it goes nowhere. */
function headingOf(points: readonly Point[], from: number, direction: 1 | -1): Point | undefined {
  const origin = points[from] as Point;
  for (let i = from + direction; i >= 0 && i < points.length; i += direction) {
    const p = points[i] as Point;
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const length = hypot(dx, dy);
    if (length > HEADING_REACH) return { x: dx / length, y: dy / length };
  }
  return undefined;
}

/**
 * The place `metres` along a curve from point `from` going `direction`, and the
 * segment it stands on. A curve too short is answered with its end.
 */
export function alongCurve(points: readonly Point[], from: number, direction: 1 | -1, metres: number): { at: Point; segment: number } {
  let left = metres;
  let i = from;
  while (i + direction >= 0 && i + direction < points.length) {
    const a = points[i] as Point;
    const b = points[i + direction] as Point;
    const span = hypot(b.x - a.x, b.y - a.y);
    const segment = direction === 1 ? i : i - 1;
    if (left <= span) {
      const t = span === 0 ? 0 : left / span;
      return { at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, segment };
    }
    left -= span;
    i += direction;
  }
  const last = direction === 1 ? points.length - 1 : 0;
  return { at: { x: (points[last] as Point).x, y: (points[last] as Point).y }, segment: Math.max(0, direction === 1 ? last - 1 : 0) };
}

/** The stretch of curve a mouth takes, from the node out to its cut. */
function gapOf(road: RoadCurve, distances: Float32Array, mouth: JunctionMouth): RoadGap {
  const node = road.points[mouth.point] as Point;
  const nodeSegment = mouth.direction === 1 ? mouth.point : Math.max(0, mouth.point - 1);
  const atNode: GapEnd = { distance: distances[mouth.point] as number, at: { x: node.x, y: node.y }, segment: nodeSegment };
  const atCut: GapEnd = {
    distance: distanceOf(road.points, distances, mouth.segment, mouth.at),
    at: mouth.at,
    segment: mouth.segment,
  };
  return mouth.direction === 1 ? { from: atNode, to: atCut } : { from: atCut, to: atNode };
}

/** Metres from the start of a curve to a place on one of its segments, as `ribbon.ts` measures it. */
function distanceOf(points: readonly Point[], distances: Float32Array, segment: number, at: Point): number {
  const a = points[segment] as Point;
  const b = points[segment + 1] as Point;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const squared = dx * dx + dy * dy;
  if (squared === 0) return distances[segment] as number;
  const t = Math.min(1, Math.max(0, ((at.x - a.x) * dx + (at.y - a.y) * dy) / squared));
  const span = (distances[segment + 1] as number) - (distances[segment] as number);
  return (distances[segment] as number) + t * span;
}

/** Sort a curve's gaps and join the ones that touch, in place. */
function mergeGaps(gaps: RoadGap[]): void {
  gaps.sort((a, b) => a.from.distance - b.from.distance || a.to.distance - b.to.distance);
  let write = 0;
  for (let read = 0; read < gaps.length; read++) {
    const gap = gaps[read] as RoadGap;
    const last = write > 0 ? (gaps[write - 1] as RoadGap) : undefined;
    if (last !== undefined && gap.from.distance <= last.to.distance) {
      if (gap.to.distance > last.to.distance) last.to = gap.to;
      continue;
    }
    gaps[write++] = gap;
  }
  gaps.length = write;
}
