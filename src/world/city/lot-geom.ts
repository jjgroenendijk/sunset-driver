/**
 * The geometry `lots.ts` cuts a parcel's frontage with.
 *
 * Nothing here knows about a zone or a road: it is the arithmetic of walking a
 * ring, casting a ray into a region and asking whether two convex rings stand
 * apart. `src/core/geom.ts` is the polygon arithmetic of the parcels
 * themselves, which cuts and unions whole regions; these are the point and
 * segment questions a lot asks about ground that is already cut.
 */
import { pointInRegion, type Point, type Region } from '../../core/geom.ts';
import { hypot } from '../../core/libm.ts';

/** Metres of the grid the lot corners are rounded onto, as `src/core/geom.ts` rounds its own. */
export const MM = 1e-3;

/** A point moved a distance along a direction. */
export function step(from: Point, way: Point, distance: number): Point {
  return { x: from.x + way.x * distance, y: from.y + way.y * distance };
}

/** A point rounded onto the millimetre grid the polygon arithmetic uses. */
export function round(p: Point): Point {
  return { x: Math.round(p.x / MM) * MM, y: Math.round(p.y / MM) * MM };
}

/** A ring walked at a fixed step, starting at its first corner. */
export function sampleRing(ring: readonly Point[], by: number): Point[] {
  const out: Point[] = [];
  let since = by;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const span = hypot(b.x - a.x, b.y - a.y);
    let at = 0;
    while (since + (span - at) >= by) {
      at += by - since;
      since = 0;
      const t = span > 0 ? at / span : 0;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    since += span - at;
  }
  return out;
}

/** Metres along a line. */
export function lengthOf(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    total += hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** The point a given distance along a line. Past its end is its end. */
export function pointAlong(points: readonly Point[], distance: number): Point {
  let left = Math.max(0, distance);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const span = hypot(b.x - a.x, b.y - a.y);
    if (left <= span || i + 2 === points.length) {
      const t = span > 0 ? Math.min(1, left / span) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= span;
  }
  return points[points.length - 1] as Point;
}

/** Where a ray into a region first meets its boundary. */
export interface RayHit {
  /** Metres from the start of the ray to the boundary. */
  room: number;
  /**
   * How squarely the boundary crosses the ray, as a sine: 1 where it stands
   * across the ray and 0 where it runs alongside it. A caller that asks what is
   * opposite a place reads this, because the nearest boundary of a corner lot
   * is the street down its side and not the one across the block.
   */
  across: number;
}

/** Where a ray from a point inside a region first meets its boundary. */
export function rayToBoundary(region: Region, from: Point, way: Point): RayHit {
  let room = Infinity;
  let across = 0;
  for (const ring of [region.outer, ...region.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Point;
      const b = ring[(i + 1) % ring.length] as Point;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const cross = way.x * ey - way.y * ex;
      if (cross === 0) continue;
      const dx = a.x - from.x;
      const dy = a.y - from.y;
      const t = (dx * ey - dy * ex) / cross;
      if (t <= 0 || t >= room) continue;
      const u = (dx * way.y - dy * way.x) / cross;
      if (u < 0 || u > 1) continue;
      room = t;
      across = Math.abs(cross) / hypot(ex, ey);
    }
  }
  return { room, across };
}

/** The squared distance from a point to the nearest of a set of points. */
export function nearestSquared(points: readonly Point[], p: Point): number {
  let least = Infinity;
  for (const q of points) {
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < least) least = d;
  }
  return least;
}

/** True when a ring is wound anticlockwise and turns the same way at every corner. */
export function isConvex(ring: readonly Point[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const c = ring[(i + 2) % ring.length] as Point;
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return false;
  }
  return true;
}

/**
 * True when a convex ring stands wholly inside a region. Every corner is in the
 * region and no side of the ring crosses a side of it, which together leave the
 * ring nowhere to go but inside.
 */
export function insideRegion(ring: readonly Point[], region: Region): boolean {
  for (const corner of ring) if (!pointInRegion(corner, region)) return false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    if (crossesRing(a, b, region.outer)) return false;
    for (const hole of region.holes) if (crossesRing(a, b, hole)) return false;
  }
  return true;
}

/** True when a segment crosses any side of a ring. */
function crossesRing(a: Point, b: Point, ring: readonly Point[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    if (segmentsCross(a, b, ring[i] as Point, ring[(i + 1) % ring.length] as Point)) return true;
  }
  return false;
}

/** True when two segments cross, ends excluded. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const abc = side(a, b, c);
  const abd = side(a, b, d);
  const cda = side(c, d, a);
  const cdb = side(c, d, b);
  return abc * abd < 0 && cda * cdb < 0;
}

/** Which side of a line a point falls on: positive left, negative right, zero on it. */
function side(a: Point, b: Point, p: Point): number {
  return Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
}

/**
 * True when two convex rings share ground they may not, with `daylight` metres
 * demanded between them. Separating axis: two convex shapes stand apart exactly
 * when a side of one of them has all of the other outside it.
 *
 * The daylight is what turns the question from "do these overlap" into "do
 * these touch": a positive figure keeps two lots apart, and a negative one lets
 * them share an edge.
 */
export function ringsClash(a: readonly Point[], b: readonly Point[], daylight: number): boolean {
  return !separates(a, b, daylight) && !separates(b, a, daylight);
}

/** True when some side of the first ring has the whole of the second beyond it. */
function separates(ring: readonly Point[], other: readonly Point[], daylight: number): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const span = hypot(b.x - a.x, b.y - a.y);
    if (span === 0) continue;
    let apart = true;
    for (const p of other) {
      // The rings are wound anticlockwise, so their own ground is to the left.
      const distance = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / span;
      if (distance > -daylight) {
        apart = false;
        break;
      }
    }
    if (apart) return true;
  }
  return false;
}

/** The squared distance from a point to a line. */
export function distanceSquaredToLine(p: Point, points: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    best = Math.min(best, distanceSquaredToSegment(p, points[i] as Point, points[i + 1] as Point));
  }
  return best;
}

function distanceSquaredToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSquared = vx * vx + vy * vy;
  let t = lengthSquared > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / lengthSquared : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = p.x - (a.x + vx * t);
  const dy = p.y - (a.y + vy * t);
  return dx * dx + dy * dy;
}
