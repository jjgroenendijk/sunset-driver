/**
 * Rings and regions: the shapes the polygon arithmetic of spec section 6.4 is
 * written in, and the readings that need no boolean engine.
 *
 * A ring is a closed loop of points; the first point is not repeated at the
 * end. A region is one piece of ground: an outer ring wound anticlockwise and
 * the rings of its holes wound clockwise.
 *
 * `geom.ts` is the door onto all of this, and re-exports everything here.
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * One piece of ground: an outer ring wound anticlockwise, and the rings of the
 * holes in it wound clockwise. Nothing else stands inside the outer ring.
 */
export interface Region {
  outer: Point[];
  holes: Point[][];
}

/** The signed area of a ring in square metres. Positive when it winds anticlockwise. */
export function ringArea(ring: readonly Point[]): number {
  const origin = ring[0];
  if (origin === undefined) return 0;
  // Fanned out from the first point, so a small ring far from the origin keeps
  // its precision instead of being lost between two huge cross products.
  let sum = 0;
  for (let i = 1; i + 1 < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[i + 1] as Point;
    sum += (a.x - origin.x) * (b.y - origin.y) - (b.x - origin.x) * (a.y - origin.y);
  }
  return sum / 2;
}

/** The ground a region covers in square metres: its outer ring less its holes. */
export function regionArea(region: Region): number {
  let total = ringArea(region.outer);
  for (const hole of region.holes) total += ringArea(hole);
  return total;
}

/** The ground a set of regions covers in square metres. They must not overlap. */
export function areaOf(regions: readonly Region[]): number {
  let total = 0;
  for (const region of regions) total += regionArea(region);
  return total;
}

/** True when a point stands inside a closed ring, by counting the crossings of a ray. */
export function pointInRing(p: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a.y > p.y === b.y > p.y) continue;
    if (p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** True when a point stands on the ground a region owns: inside its outer ring and in none of its holes. */
export function pointInRegion(p: Point, region: Region): boolean {
  if (!pointInRing(p, region.outer)) return false;
  for (const hole of region.holes) if (pointInRing(p, hole)) return false;
  return true;
}

/** True when a point stands on the ground any of the regions owns. */
export function pointInRegions(p: Point, regions: readonly Region[]): boolean {
  for (const region of regions) if (pointInRegion(p, region)) return true;
  return false;
}

/** A ring on its own as a region, wound the way the engine expects. */
export function regionOf(ring: readonly Point[]): Region {
  const outer = ring.map((p) => ({ x: p.x, y: p.y }));
  if (ringArea(outer) < 0) outer.reverse();
  return { outer, holes: [] };
}

/**
 * Rings that already wind with the ground on their left — an outline
 * anticlockwise, a hole clockwise — gathered into regions. Each hole is put
 * inside the smallest outline around it. Rings that come from tracing one
 * boundary, such as a coastline, arrive this way.
 */
export function regionsFromRings(rings: readonly Point[][]): Region[] {
  const outers: Region[] = [];
  const holes: Point[][] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    if (ringArea(ring) > 0) outers.push({ outer: ring.map((p) => ({ x: p.x, y: p.y })), holes: [] });
    else holes.push(ring.map((p) => ({ x: p.x, y: p.y })));
  }
  for (const hole of holes) {
    const home = smallestAround(outers, hole[0] as Point);
    if (home !== undefined) home.holes.push(hole);
  }
  return outers;
}

export function gatherRings(rings: readonly Point[][], owner: readonly number[]): Region[] {
  const groups = new Map<number, number[]>();
  const keys: number[] = [];
  for (let i = 0; i < rings.length; i++) {
    const key = owner[i] as number;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [i]);
      keys.push(key);
    } else {
      group.push(i);
    }
  }
  keys.sort((a, b) => a - b);
  const regions: Region[] = [];
  for (const key of keys) {
    const group = groups.get(key) as number[];
    const outers: Region[] = [];
    const holes: Point[][] = [];
    for (const i of group) {
      const ring = rings[i] as Point[];
      if (ringArea(ring) > 0) outers.push({ outer: ring, holes: [] });
      else holes.push(ring);
    }
    if (outers.length === 0) continue;
    for (const hole of holes) {
      const home = smallestAround(outers, hole[0] as Point);
      if (home !== undefined) home.holes.push(hole);
    }
    for (const region of outers) regions.push(region);
  }
  return regions;
}

/** The smallest of the outlines a point stands inside, or none of them. */
export function smallestAround(outers: readonly Region[], p: Point): Region | undefined {
  let best: Region | undefined;
  let bestArea = Infinity;
  for (const region of outers) {
    if (!pointInRing(p, region.outer)) continue;
    const area = ringArea(region.outer);
    if (area < bestArea) {
      bestArea = area;
      best = region;
    }
  }
  return best;
}
