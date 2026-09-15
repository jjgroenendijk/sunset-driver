/**
 * How much daylight the street wall of a seed lets through (spec section 10.3).
 *
 * Two attached lots share a side edge, and the two buildings on them should meet
 * along it. This builds the buildings within `RADIUS` chunks of the core and
 * measures every shared edge. Each shell is taken as the convex hull of its
 * vertices on the ground. At each station along the edge, clear of its two
 * ends, the gap is how far the two walls stand from it, added together. An edge
 * has daylight through it where the widest gap passes `DAYLIGHT`.
 *
 * Usage: node scripts/wall-gaps.ts [seed] [near|mid|far]
 */
import { Vector3, type BufferAttribute } from 'three';
import type { Point } from '../src/core/geom.ts';
import { seedFromString } from '../src/core/rng.ts';
import { buildChunkBuildings, buildingLookup } from '../src/render/building-mesh.ts';
import type { ChunkDetail } from '../src/render/streaming.ts';
import type { Building } from '../src/world/buildings.ts';
import { buildLayers, chunkAt, ChunkSource } from '../src/world/chunks.ts';
import { generateWorld } from '../src/world/world.ts';

/** Chunks each way from the core's own chunk. */
const RADIUS = 3;
/** Metres of gap an edge may keep and still count as closed. */
const DAYLIGHT = 0.05;
/** Metres between the stations along an edge. */
const STATION = 0.25;
/**
 * Metres of each end of an edge left out: the front and the back of a lot keep
 * their margin, so the two walls stand apart there by design.
 */
const END = 2.5;

const seedText = process.argv[2] ?? 'sunset';
const detail = (process.argv[3] ?? 'near') as ChunkDetail;
const world = generateWorld(seedFromString(seedText));
const layers = buildLayers(world);
const source = new ChunkSource(world, layers);
const lookup = buildingLookup(world, layers);

const hulls = new Map<number, { building: Building; hull: Point[] }>();
const home = chunkAt(world.core.x, world.core.y);
for (let cy = home.cy - RADIUS; cy <= home.cy + RADIUS; cy++) {
  for (let cx = home.cx - RADIUS; cx <= home.cx + RADIUS; cx++) {
    for (const one of buildChunkBuildings(source.chunk(cx, cy), lookup, detail)) {
      const position = one.shell.getAttribute('position') as BufferAttribute;
      const at = new Vector3();
      const points: Point[] = [];
      for (let v = 0; v < position.count; v++) {
        at.fromBufferAttribute(position, v).applyMatrix4(one.matrix);
        points.push({ x: at.x, y: at.z });
      }
      hulls.set(one.building.id, { building: one.building, hull: convexHull(points) });
      one.shell.dispose();
      one.hull.dispose();
    }
  }
}

// A lot's second front corner is its right-hand neighbour's first.
const byFirst = new Map<string, number>();
for (const [id, one] of hulls) if (one.building.shared.left) byFirst.set(keyOf(one.building.lot[0] as Point), id);

const gaps: number[] = [];
let worstAt: Point = { x: 0, y: 0 };
for (const [, one] of hulls) {
  if (!one.building.shared.right) continue;
  const other = hulls.get(byFirst.get(keyOf(one.building.lot[1] as Point)) ?? -1);
  if (other === undefined) continue;
  const p = one.building.lot[1] as Point;
  const q = one.building.lot[2] as Point;
  const r = other.building.lot[3] as Point;
  const own = Math.hypot(q.x - p.x, q.y - p.y);
  const length = Math.min(own, Math.hypot(r.x - p.x, r.y - p.y));
  const e = { x: (q.x - p.x) / own, y: (q.y - p.y) / own };
  let widest = -Infinity;
  for (let s = END; s <= length - END; s += STATION) {
    const at = { x: p.x + e.x * s, y: p.y + e.y * s };
    widest = Math.max(widest, distanceToRing(one.hull, at) + distanceToRing(other.hull, at));
  }
  if (widest === -Infinity) continue;
  if (gaps.every((gap) => gap < widest)) worstAt = p;
  gaps.push(widest);
}

gaps.sort((x, y) => x - y);
const open = gaps.filter((gap) => gap > DAYLIGHT).length;
const share = gaps.length > 0 ? (100 * open) / gaps.length : 0;
console.log(`seed ${seedText}, ${detail} detail: ${gaps.length} shared edges within ${RADIUS} chunks of the core`);
console.log(`daylight through ${open} of them (${share.toFixed(1)} %)`);
console.log(`widest gap: median ${quantile(gaps, 0.5).toFixed(3)} m, worst ${quantile(gaps, 1).toFixed(3)} m at ${worstAt.x.toFixed(0)}, ${worstAt.y.toFixed(0)}`);

function keyOf(p: Point): string {
  return `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] as number;
}

/** Metres from a point to a convex ring wound anticlockwise: 0 inside it. */
function distanceToRing(ring: readonly Point[], at: Point): number {
  let inside = true;
  let nearest = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx * (at.y - a.y) - dy * (at.x - a.x) < 0) inside = false;
    const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    nearest = Math.min(nearest, Math.hypot(a.x + dx * t - at.x, a.y + dy * t - at.y));
  }
  return inside ? 0 : nearest;
}

/** The convex hull of a set of points, anticlockwise. */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Point, lower[lower.length - 1] as Point, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i] as Point;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Point, upper[upper.length - 1] as Point, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
