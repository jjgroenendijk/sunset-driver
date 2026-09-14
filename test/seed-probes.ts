import { type BufferGeometry } from 'three';
import { hashInts } from '../src/core/hash.ts';
import { type Region } from '../src/core/geom.ts';
import { CHUNK_SIZE, type WorldChunk } from '../src/world/chunks.ts';
import { type RoadCarve } from '../src/world/carve.ts';
import { CROSSING_SNAP } from '../src/world/connect.ts';
import { type RoadEdge, type RoadGraph } from '../src/world/graph.ts';
import { CLEARANCE as OVERPASS_CLEARANCE, PLATEAU_MARGIN } from '../src/world/overpass.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { curveDistances } from '../src/world/ribbon.ts';
import { CHUNK_TERRAIN_CELL } from '../src/world/terrain.ts';
import { type Surface } from '../src/world/surface.ts';
import { footprintHalfWidth, mayJoin, TIERS } from '../src/world/tiers.ts';
import { type Point, type RoadCurve, type RoadTier, type WorldDescription } from '../src/world/types.ts';
import { pointInRing } from './helpers.ts';
import { BOARDWALK_DRIFT, CHUNK_BLOCK, FAR_CHUNKS, BEYOND_MAP } from './seed-limits.ts';

/**
 * What the seed sweep measures a world with: the small pure readings its checks
 * take of a road, a region, a heightfield or a chunk. Nothing here knows what a
 * check expects; the limits are in `seed-limits.ts`.
 */
/** Metres between the samples that ask whether a road segment is over water. */
export const WET_SAMPLE = 5;
/** Metres a bridge head may stand from the crossing's own shore point. */
export const BRIDGE_TOLERANCE = 150;

/**
 * Metres of the line a beach laid for its boardwalk that the road really
 * covers: the run of it standing on the road, give or take
 * {@link BOARDWALK_DRIFT}. The road is longer than the line at its ends,
 * because each of them reaches on to the network.
 */
export function coverOf(road: readonly Point[], line: readonly Point[]): number {
  let covered = 0;
  for (let k = 0; k + 1 < line.length; k++) {
    const a = line[k] as Point;
    const b = line[k + 1] as Point;
    if (onRoad(road, a) && onRoad(road, b)) covered += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return covered;
}

export function onRoad(road: readonly Point[], p: Point): boolean {
  for (let i = 0; i + 1 < road.length; i++) {
    if (distanceToSegment(p, road[i] as Point, road[i + 1] as Point) <= BOARDWALK_DRIFT) return true;
  }
  return false;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSquared = vx * vx + vy * vy;
  let t = lengthSquared > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / lengthSquared : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

/**
 * The carved ground at a place as a chunk draws it: the chunk grid is anchored
 * on the origin and samples the carve every CHUNK_TERRAIN_CELL metres, and the
 * ground between four samples is bilinear between them, as `Heightfield.sample`
 * reads it. Reading the four samples here costs four carve lookups rather than
 * a whole map of them.
 */
export function chunkGroundAt(carve: RoadCarve, x: number, y: number): number {
  const cell = CHUNK_TERRAIN_CELL;
  const fx = Math.floor(x / cell);
  const fy = Math.floor(y / cell);
  const tx = x / cell - fx;
  const ty = y / cell - fy;
  const x0 = fx * cell;
  const y0 = fy * cell;
  const h00 = carve.heightAt(x0, y0);
  const h10 = carve.heightAt(x0 + cell, y0);
  const h01 = carve.heightAt(x0, y0 + cell);
  const h11 = carve.heightAt(x0 + cell, y0 + cell);
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}

/** How far a place stands from a line. */
export function distanceToLine(p: Point, line: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    best = Math.min(best, distanceToSegment(p, line[i] as Point, line[i + 1] as Point));
  }
  return best;
}

/**
 * What `SurfaceIndex.at` should answer, worked out the slow and obvious way:
 * every segment of every road measured, nearest claim wins, then the beaches.
 * The index files the same segments in a bucket grid; this is what says the
 * grid files them where they belong.
 */
export function surfaceByHand(w: WorldDescription, x: number, y: number): Surface {
  const p = { x, y };
  let tier: RoadTier | undefined;
  let nearest = Infinity;
  for (const road of w.roads) {
    const half = footprintHalfWidth(road.tier);
    for (let i = 0; i + 1 < road.points.length; i++) {
      const distance = distanceToSegment(p, road.points[i] as Point, road.points[i + 1] as Point);
      if (distance > half || distance >= nearest) continue;
      nearest = distance;
      tier = road.tier;
    }
  }
  if (tier !== undefined) return tier === 'dirt' ? 'dirt' : 'asphalt';
  for (const beach of w.beaches) {
    if (beach.sand.length >= 3 && pointInRing(p, beach.sand)) return 'sand';
  }
  return 'ground';
}

/** The middle of a ring's corners. */
export function middleOf(ring: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ring.length, y: y / ring.length };
}

/**
 * True when another run of the same road stands on the ground within reach of a
 * place, so the carve there is that run's and not the structure's. A switchback
 * that doubles back under its own deck does exactly this.
 */
export function passesUnder(road: RoadCurve, segment: number, at: Point, reach: number): boolean {
  for (let i = 0; i + 1 < road.points.length; i++) {
    if (i === segment || road.bridges.includes(i) || road.tunnels.includes(i)) continue;
    const a = road.points[i] as Point;
    const b = road.points[i + 1] as Point;
    if (distanceToSegment(at, a, b) <= reach) return true;
  }
  return false;
}

/** A road point as a key, so two curves that share a point share a string. */
/**
 * A point as one number, to the millimetre, so the maps keyed on it hold
 * numbers rather than strings. A sweep keys every road point of every seed, and
 * a string key there is a million allocations a test. The map is at most 6 km
 * across (`size.ts`), so each coordinate fits in the 24 bits it is given and no
 * two points share a key.
 */
export const KEY_SPAN = 1 << 23;

export function pointKey(p: Point): number {
  return (Math.round(p.x * 1000) + KEY_SPAN) * (KEY_SPAN * 2) + (Math.round(p.y * 1000) + KEY_SPAN);
}

/**
 * Metres the ground has to leave the line a road drives before the road counts
 * as standing off it. The tracer allows itself more cut and fill than this, so
 * anything it marks as a structure clears this comfortably.
 */
export const CLEARANCE = 1;

/** Metres along a polyline. */
export function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** How hard a road segment climbs between its ends: rise over run. */
export function gradeOf(hf: Heightfield, a: Point, b: Point): number {
  const run = Math.hypot(b.x - a.x, b.y - a.y);
  return run > 0 ? Math.abs(hf.sample(b.x, b.y) - hf.sample(a.x, a.y)) / run : 0;
}

/**
 * How far the ground leaves the line a road segment drives: metres above it at
 * its highest, and metres below it at its lowest.
 */
export function profileUnder(hf: Heightfield, a: Point, b: Point): { above: number; below: number } {
  const start = hf.sample(a.x, a.y);
  const end = hf.sample(b.x, b.y);
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / WET_SAMPLE));
  let above = 0;
  let below = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const h = hf.sample(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    above = Math.max(above, h - (start + (end - start) * t));
    below = Math.max(below, start + (end - start) * t - h);
  }
  return { above, below };
}

/** How much of a straight span stands over water, in [0, 1]. */
export function wetFraction(hf: Heightfield, a: Point, b: Point, seaLevel: number): number {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / WET_SAMPLE));
  let wet = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (hf.sample(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < seaLevel) wet++;
  }
  return wet / (steps + 1);
}

/**
 * True where the ground is dry for two cells of the water sheet each way, which
 * is further than the sheet reaches inland past a shore.
 */
export function standsClearOfWater(hf: Heightfield, x: number, y: number, seaLevel: number, cell: number): boolean {
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) if (hf.sample(x + i * cell, y + j * cell) < seaLevel) return false;
  }
  return true;
}

/** The segment of a curve a place stands on, or nothing where it stands on none. */
export function segmentUnder(road: RoadCurve, at: Point): number | undefined {
  for (let i = 0; i + 1 < road.points.length; i++) {
    if (distanceToSegment(at, road.points[i] as Point, road.points[i + 1] as Point) < 1e-6) return i;
  }
  return undefined;
}

/** The point of a curve nearest a place, within {@link CROSSING_SNAP} of it. */
export function nearestPointOf(road: RoadCurve, at: Point): Point | undefined {
  let best: Point | undefined;
  let bestD = CROSSING_SNAP;
  for (const p of road.points) {
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d > bestD) continue;
    bestD = d;
    best = p;
  }
  return best;
}

/** Whichever of two candidate places stands nearer a point. */
export function nearer(first: Point | undefined, second: Point | undefined, to: Point): Point | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.hypot(second.x - to.x, second.y - to.y) < Math.hypot(first.x - to.x, first.y - to.y) ? second : first;
}

/** True where a road of this tier may not take a point at a place another road stands on. */
export function refusedPlace(roads: readonly RoadCurve[], at: Point, joiner: RoadTier): boolean {
  for (const road of roads) {
    for (let i = 0; i < road.points.length; i++) {
      const p = road.points[i] as Point;
      if (Math.abs(p.x - at.x) > 1e-3 || Math.abs(p.y - at.y) > 1e-3) continue;
      if (!mayJoin(joiner, road.tier, road.interchanges.includes(i))) return true;
    }
  }
  return false;
}

/** A point two curves share within {@link CROSSING_SNAP} of a place. */
export function sharedNear(a: RoadCurve, b: RoadCurve, at: Point): Point | undefined {
  for (const p of a.points) {
    if (Math.hypot(p.x - at.x, p.y - at.y) > CROSSING_SNAP) continue;
    for (const q of b.points) {
      if (Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9) return p;
    }
  }
  return undefined;
}

/** True when the segment spans the crossing, either way round. */
export function spansCrossing(a: Point, b: Point, from: Point, to: Point): boolean {
  const near = Math.max(Math.hypot(a.x - from.x, a.y - from.y), Math.hypot(b.x - to.x, b.y - to.y));
  const flipped = Math.max(Math.hypot(a.x - to.x, a.y - to.y), Math.hypot(b.x - from.x, b.y - from.y));
  return Math.min(near, flipped) <= BRIDGE_TOLERANCE;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

/** The value `share` of the way up a spread; 0.5 is the median. */
export function percentile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * share));
  return at < 0 ? 0 : (sorted[at] as number);
}

export function heightsHash(h: Float32Array): number {
  let acc = 0;
  const u = new Uint32Array(h.buffer, h.byteOffset, h.length);
  for (let i = 0; i < u.length; i++) acc = hashInts(acc, u[i] as number);
  return acc;
}

/** Square metres of dry land in a world, counted over the heightfield. */
export function landArea(world: WorldDescription): number {
  const hf = new Heightfield(world.terrain);
  const cell = hf.cellSize * hf.cellSize;
  let land = 0;
  for (let iy = 0; iy < hf.gridSize; iy++) {
    for (let ix = 0; ix < hf.gridSize; ix++) if (hf.at(ix, iy) > world.water.seaLevel) land += cell;
  }
  return land;
}

export function seaFraction(world: WorldDescription): number {
  const h = world.terrain.heights;
  let wet = 0;
  for (let i = 0; i < h.length; i++) if ((h[i] as number) < world.water.seaLevel) wet++;
  return wet / h.length;
}

/**
 * The chunks every seed is cut into: the block around the origin, then the far
 * offsets, in a fixed order (spec section 3).
 */
export function chunkKeys(): [number, number][] {
  const keys: [number, number][] = [];
  for (let cx = -CHUNK_BLOCK; cx <= CHUNK_BLOCK; cx++) {
    for (let cy = -CHUNK_BLOCK; cy <= CHUNK_BLOCK; cy++) keys.push([cx, cy]);
  }
  for (const [cx, cy] of FAR_CHUNKS) keys.push([cx, cy]);
  keys.push([BEYOND_MAP[0], BEYOND_MAP[1]]);
  return keys;
}

/**
 * Where the runs of a chunk meet the line the chunk shares with a neighbour, as
 * sorted keys. Two chunks that hand a road over to each other meet it at the
 * same places, so their keys are the same list.
 *
 * Two ends are left out. A run that stops there because the whole curve stops
 * there hands nothing over. So does one that stops on a corner of the chunk
 * grid, where the road passes through four chunks at a point and belongs to
 * none of them.
 */
export function handovers(chunk: WorldChunk, roads: readonly RoadCurve[], axis: 'x' | 'y', at: number): string[] {
  const keys: string[] = [];
  for (const run of chunk.roads) {
    const road = roads[run.curve] as RoadCurve;
    for (const p of [run.points[0] as Point, run.points[run.points.length - 1] as Point]) {
      const along = axis === 'x' ? p.y : p.x;
      if (Math.abs((axis === 'x' ? p.x : p.y) - at) > 1e-9) continue;
      if (along % CHUNK_SIZE === 0) continue;
      if (isCurveEnd(road, p)) continue;
      keys.push(`${run.curve}:${along.toFixed(3)}`);
    }
  }
  return keys.sort();
}

/** Metres round the boundary of a region: its outer ring and its holes. */
export function perimeterOf(region: Region): number {
  let total = 0;
  for (const ring of [region.outer, ...region.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Point;
      const b = ring[(i + 1) % ring.length] as Point;
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return total;
}

/** True when every point stands on the ground a chunk covers, give or take `slack` metres. */
export function insideBounds(points: readonly Point[], chunk: WorldChunk, slack: number): boolean {
  const { minX, minY, maxX, maxY } = chunk.bounds;
  for (const p of points) {
    if (p.x < minX - slack || p.x > maxX + slack || p.y < minY - slack || p.y > maxY + slack) return false;
  }
  return true;
}

/** Metres from a place to the nearest edge of a region, inside it or outside it. */
export function distanceToBoundary(p: Point, region: Region): number {
  let best = Infinity;
  for (const ring of [region.outer, ...region.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Point;
      const b = ring[(i + 1) % ring.length] as Point;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const squared = vx * vx + vy * vy;
      let t = squared > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / squared : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      best = Math.min(best, Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t)));
    }
  }
  return best;
}

/**
 * How the quad of a lofted road surface between section columns `column` and
 * `column + 1`, at row `row` of the loft, is wound and how long it is.
 *
 * A loft lays its rows in order along the run and its columns across the
 * section, so the quad's corners are the two points at `row` and the two at the
 * row after it. The camera looks down on a road, so a quad wound the other way
 * would leave the carriageway invisible from above.
 */
export function quadOf(surface: BufferGeometry, columns: number, row: number, column: number): { up: boolean; along: number } {
  const position = surface.getAttribute('position');
  const a = row * columns + column;
  const b = a + 1;
  const d = (row + 1) * columns + column;
  const abx = position.getX(b) - position.getX(a);
  const abz = position.getZ(b) - position.getZ(a);
  const adx = position.getX(d) - position.getX(a);
  const adz = position.getZ(d) - position.getZ(a);
  return { up: abz * adx - abx * adz > 0, along: Math.hypot(adx, adz) };
}

/** True when a place is one of the two ends of a curve. */
export function isCurveEnd(road: RoadCurve, p: Point): boolean {
  const head = road.points[0] as Point;
  const tail = road.points[road.points.length - 1] as Point;
  return (head.x === p.x && head.y === p.y) || (tail.x === p.x && tail.y === p.y);
}

/**
 * Where each curve stands on a point another curve has, as distances along it.
 * A junction is exactly a shared point, and a raise may not reach one.
 */
export function sharedDistances(roads: readonly RoadCurve[]): Float64Array[] {
  const counts = new Map<number, number>();
  const key = (p: Point): number =>
    (Math.round(p.x * 1000) + 8_000_000) * 16_000_001 + Math.round(p.y * 1000) + 8_000_000;
  for (const road of roads) {
    for (const point of road.points) counts.set(key(point), (counts.get(key(point)) ?? 0) + 1);
  }
  return roads.map((road) => {
    const distances = curveDistances(road.points);
    const out: number[] = [];
    for (let i = 0; i < road.points.length; i++) {
      if ((counts.get(key(road.points[i] as Point)) ?? 0) > 1) out.push(distances[i] as number);
    }
    return Float64Array.from(out);
  });
}

/**
 * The same distances with every place a road passes under a deck added: a
 * crossing where the other road already stands a clearance over it. A raise
 * may not reach one of those either, or the road would climb into the deck.
 */
export function withUnderDecks(roads: readonly RoadCurve[], graph: RoadGraph, shared: readonly Float64Array[]): Float64Array[] {
  const out = shared.map((distances) => Array.from(distances));
  for (const crossing of graph.crossings) {
    const one = roads[(graph.edges[crossing.over] as RoadEdge).curve] as RoadCurve;
    const other = roads[(graph.edges[crossing.under] as RoadEdge).curve] as RoadCurve;
    for (const [high, low] of [[one, other], [other, one]] as const) {
      if (liftAtCrossing(high, crossing) < OVERPASS_CLEARANCE - 1e-6) continue;
      const place = placeOn(low, crossing);
      if (place !== undefined) (out[low.id] as number[]).push(place.along);
      break;
    }
  }
  return out.map((distances) => Float64Array.from(distances));
}

/** Where a place falls on a curve: the segment, how far along it, and the distance along the curve. */
export function placeOn(road: RoadCurve, at: Point): { segment: number; t: number; along: number } | undefined {
  const distances = curveDistances(road.points);
  let best: { segment: number; t: number; along: number } | undefined;
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
    best = { segment: i, t, along: (distances[i] as number) + t * Math.sqrt(length2) };
  }
  return best;
}

/** How far over the ground a road stands where another road crosses it. */
export function liftAtCrossing(road: RoadCurve, at: Point): number {
  const lift = road.lift;
  if (lift === undefined) return 0;
  const place = placeOn(road, at);
  if (place === undefined) return 0;
  const from = lift[place.segment] ?? 0;
  const to = lift[place.segment + 1] ?? 0;
  return from + (to - from) * place.t;
}

/**
 * True where `overpass.ts` could carry `road` over `met` at a crossing: the
 * rule of that pass, written out again so a change to it has to be meant.
 */
export function canRaise(road: RoadCurve, met: RoadCurve, at: Point, shared: readonly Float64Array[]): boolean {
  const place = placeOn(road, at);
  if (place === undefined) return false;
  const distances = curveDistances(road.points);
  const reach = footprintHalfWidth(met.tier) + PLATEAU_MARGIN + OVERPASS_CLEARANCE / TIERS[road.tier].maxGrade;
  let from: number | undefined;
  let to: number | undefined;
  for (let i = 0; i < distances.length; i++) {
    const here = distances[i] as number;
    if (here <= place.along - reach) from = here;
    if (to === undefined && here >= place.along + reach) to = here;
  }
  if (from === undefined || to === undefined) return false;
  for (const node of shared[road.id] as Float64Array) {
    if (node > from && node < to) return false;
  }
  for (const segment of [...road.tunnels, ...road.bridges]) {
    if ((distances[segment + 1] as number) > from && (distances[segment] as number) < to) return false;
  }
  return true;
}

