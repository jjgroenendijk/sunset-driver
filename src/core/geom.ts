/**
 * Polygon arithmetic for the parcel model (spec section 6.4).
 *
 * A ring is a closed loop of points; the first point is not repeated at the
 * end. A region is one piece of ground: an outer ring wound anticlockwise and
 * the rings of its holes wound clockwise. {@link union}, {@link difference} and
 * {@link split} take regions and give regions, so a hole stays a hole through
 * every step.
 *
 * All three share one engine, which is `edges.ts` and `planar.ts`: it cuts
 * every edge where another edge meets it, walks the faces of the planar graph
 * that leaves, counts how many input rings wind round each face, and keeps the
 * faces the operation asks for. A split keeps both answers off the one graph,
 * so the two sides of a cut are bounded by the same edges and cannot overlap.
 *
 * Coordinates are rounded to the millimetre first. Every cross product that
 * decides which side of an edge a point falls on is then an exact integer, so
 * two such answers can never contradict each other, and the same input gives
 * the same output on every machine.
 *
 * This file is the whole public face: the shapes come from `ring.ts` and are
 * re-exported here, so nothing outside `src/core` imports the engine.
 */
import { clamp, direction } from './math.ts';
import { type Point, type Region, ringArea } from './ring.ts';
import { assemble, classify, combine, planarise } from './planar.ts';
import { cos, hypot, sin } from './libm.ts';

export type { Point, Region } from './ring.ts';
export {
  areaOf,
  pointInRegion,
  pointInRegions,
  pointInRing,
  regionArea,
  regionOf,
  regionsFromRings,
  ringArea,
} from './ring.ts';

/** How far past the half-width a mitred corner may reach, so a sharp bend does not spike. */
const MITER_LIMIT = 1.5;
/** Metres below which two points on a line are the same place. */
const EPSILON = 1e-6;

/**
 * The two sides of a strip of the given half-width along a line. A corner is
 * mitred, so the two segments that meet there hand the ground over without a
 * gap, and the mitre is clamped at {@link MITER_LIMIT} so a sharp bend does not
 * throw a spike of land far out to the side.
 */
export function offsetSides(points: readonly Point[], halfWidth: number): { left: Point[]; right: Point[] } {
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const here = points[i] as Point;
    const back = i > 0 ? direction(points[i - 1] as Point, here) : undefined;
    const ahead = i + 1 < points.length ? direction(here, points[i + 1] as Point) : undefined;
    const d0 = back ?? (ahead as Point);
    const d1 = ahead ?? (back as Point);
    // The mitre bisects the two segments; where they double back it is the
    // normal of the one ahead, because there is no corner to bisect.
    let mx = -(d0.y + d1.y);
    let my = d0.x + d1.x;
    const len = hypot(mx, my);
    if (len < EPSILON) {
      mx = -d1.y;
      my = d1.x;
    } else {
      mx /= len;
      my /= len;
    }
    const reach = halfWidth / clamp(mx * -d1.y + my * d1.x, 1 / MITER_LIMIT, 1);
    left.push({ x: here.x + mx * reach, y: here.y + my * reach });
    right.push({ x: here.x - mx * reach, y: here.y - my * reach });
  }
  return { left, right };
}

/**
 * A line offset by a half-width each side and closed into one ring, wound
 * anticlockwise. This is the ground a road of that width covers.
 */
export function strip(points: readonly Point[], halfWidth: number): Point[] {
  const sides = offsetSides(points, halfWidth);
  const ring = sides.left.concat(sides.right.reverse());
  if (ringArea(ring) < 0) ring.reverse();
  return ring;
}

/**
 * A ring of `sides` corners round a point, wound anticlockwise and covering the
 * whole circle of that radius: the corners stand far enough out that the flats
 * between them still clear it.
 */
export function disc(x: number, y: number, radius: number, sides: number): Point[] {
  const reach = radius / cos(Math.PI / sides);
  const ring: Point[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = (2 * Math.PI * i) / sides;
    ring.push({ x: x + reach * cos(angle), y: y + reach * sin(angle) });
  }
  return ring;
}

/** The ground all the regions cover together, as regions that do not overlap. */
export function union(regions: readonly Region[]): Region[] {
  return combine(regions, [], 'union');
}

/** The ground the subject covers and the clip does not. */
export function difference(subject: readonly Region[], clip: readonly Region[]): Region[] {
  return combine(subject, clip, 'difference');
}

/**
 * The subject cut by the clip: the ground it shares with the clip, and the
 * ground it keeps to itself. Both sides come out of one pass, so they are cut
 * on exactly the same edges and neither can overlap the other.
 */
export function split(subject: readonly Region[], clip: readonly Region[]): { inside: Region[]; outside: Region[] } {
  const graph = planarise(subject, clip);
  if (graph === undefined) return { inside: [], outside: [] };
  return {
    inside: assemble(graph, classify(graph, 'intersection')),
    outside: assemble(graph, classify(graph, 'difference')),
  };
}

// --- The boolean engine -----------------------------------------------------
//
// Everything below works in whole grid units, not metres.

