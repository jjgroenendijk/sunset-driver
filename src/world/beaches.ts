/**
 * The beaches of spec section 7.3.
 *
 * A beach is a run of gentle coast facing the open sea. The waterline comes
 * from `land.ts`, which traces it off the heightfield, and every point of it is
 * asked two questions: how far inland the ground stays below the dune line, and
 * whether the water in front of it runs out to sea. Flat ground behind and open
 * water in front make sand. Where the ground climbs straight out of the water
 * the coast stays cliff or sea wall, and the harbour is left out as well,
 * because its frontage is quay.
 *
 * The sand a beach describes is the ground it asks for, not the ground it gets.
 * Space is claimed once (spec section 1.1), so the beach takes its ground the
 * same way everything else does: `parcels.ts` cuts the sand out of the land the
 * road footprint leaves, and a road that crosses the sand keeps the strip it
 * stands on. The shallows and the pier stand over water, which is no parcel at
 * all, so both are kept here as polygons.
 *
 * Every seed gets one long beach outside the core (spec section 7.3). Where no
 * coast is gentle enough for one, the flattest run of the right length is taken
 * anyway, so the guarantee holds on a seed of cliffs.
 *
 * Beaches sit between the districts and the roads in `generateWorld`. They come
 * after the districts because the main beach has to stand on an island a road
 * will reach, and a district on an island is what brings a bridge to it. They
 * come before the roads because the boardwalk is one.
 *
 * Pure and headless: the same terrain gives the same beaches, in the same order.
 */
import { pointInRing, ringArea, type Point } from '../core/geom.ts';
import { clamp, wrapAngle } from '../core/math.ts';
import type { Noise2D } from '../core/noise.ts';
import { zoneAt, ZONE_RADII, type ZoneLayout } from './districts.ts';
import type { Heightfield } from './heightfield.ts';
import { landRings } from './land.ts';
import { coastNoise, islandAt, segmentDistance } from './terrain.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { Beach, District, Island, Pier, Point as WorldPoint, RiverDescription, RoadCurve, RoadTier, WaterDescription, Zone } from './types.ts';

/** Metres between the points a beach is measured, cut and drawn at. */
const SHORE_STEP = 12;
/** Passes of a three-point average over the traced waterline, which is jagged at the grid. */
const SHORE_SMOOTHING = 2;
/**
 * Metres above the sea the dune line stands at. The sand is the ground between
 * the waterline and this height, so how far inland it reaches is how flat the
 * coast is.
 */
const DUNE_RISE = 2;
/** Metres inland between the samples that look for the dune line. */
const PROBE_STEP = 3;
/**
 * Metres of sand a beach needs, and the most it is given. The lower bound is a
 * grade of about one in twenty-two, which is flatter than half the coast of a
 * seed; the upper one stops a whole tidal flat from becoming one beach.
 */
const MIN_SAND = 45;
const MAX_SAND = 70;
/** Metres of waterline a run needs to be a beach. Spec section 7.3 asks for a long one. */
const MIN_BEACH = 200;
/**
 * Metres out to sea a beach needs open water, and the samples that ask for it.
 * A beach faces the sea, so this is what keeps one off a river bank and out of
 * a strait narrow enough that the far side is in wading distance.
 */
const OFFSHORE_PROBE = 250;
const OFFSHORE_SAMPLES = 10;
/** Metres of dry margin a beach keeps from the river, on top of the river's own half-width. */
const RIVER_MARGIN = 25;
/** How much of the harbour's radius its frontage claims. Quay, not sand. */
const HARBOUR_REACH = 1.25;
/** Metres from the edge of the map a beach keeps, so its boardwalk has room to run. */
const EDGE_MARGIN = 120;
/** Points each side the sand width is averaged over, so the dune line does not zigzag. */
const WIDTH_SMOOTHING = 2;
/**
 * How much of the turning radius of the waterline the sand may use. Offsetting
 * a curve inland around a headland folds it over once the offset passes that
 * radius, so a headland tighter than the sand is wide splits one run of coast
 * into two beaches.
 */
const CURVE_SAFETY = 0.7;
/**
 * Metres of water the shallows reach out to, and the band they are held to. The
 * sea bed of this world drops away fast, so the shallows are a narrow strip.
 */
const SHALLOW_DEPTH = 1.5;
const MIN_SHALLOWS = 6;
const MAX_SHALLOWS = 40;
/** Metres of water under the head of a pier, and the deck it takes to get there. */
const PIER_DEPTH = 3;
const MIN_PIER = 60;
const MAX_PIER = 160;
/** Metres the pier deck reaches each side of its line. */
const PIER_HALF_WIDTH = 6;

/** One traced ring of coast, measured point by point. */
interface Coast {
  /** The waterline, evenly spaced and smoothed. Closed: the last point joins the first. */
  shore: Point[];
  /** The unit normal pointing inland at each shore point. */
  inward: Point[];
  /** Metres of sand at each shore point, before it is smoothed. */
  width: number[];
  /** True where the coast is open sea outside the harbour, the river and the core. */
  open: boolean[];
}

/** A run of one coast that becomes a beach: the indices from `at`, `count` of them. */
interface Run {
  coast: number;
  at: number;
  count: number;
  length: number;
}

/**
 * Describe the beaches of a world. The zone layout keeps the downtown waterfront
 * out — the core has quays and sea walls — and the districts say which islands
 * the roads will reach, which is what the main beach has to stand on.
 */
export function describeBeaches(
  seed: number,
  hf: Heightfield,
  water: WaterDescription,
  zones: ZoneLayout,
  districts: readonly District[],
): Beach[] {
  const size = zones.size;
  const core = zones.core;
  const coasts: Coast[] = [];
  for (const ring of landRings(hf, water.seaLevel)) {
    const coast = measureCoast(hf, water, size, core, ring);
    if (coast !== undefined) coasts.push(coast);
  }

  let runs = gentleRuns(coasts);
  // Spec section 7.3 promises a long beach on every seed. A map whose coast is
  // all cliff gets the flattest run of the right length instead of nothing.
  if (runs.length === 0) {
    const forced = flattestRun(coasts);
    if (forced !== undefined) runs = [forced];
  }

  const noise = coastNoise(seed);
  const beaches: Beach[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i] as Run;
    beaches.push(buildBeach(hf, water, noise, coasts[run.coast] as Coast, run, i));
  }
  // The main beach is picked once they are all built, because the choice reads
  // the island each one lies on, and only the pier depends on the answer.
  const mainAt = pickMain(beaches, zones, inhabitedIslands(water, size, noise, districts));
  const main = beaches[mainAt];
  if (main !== undefined) beaches[mainAt] = { ...main, main: true, pier: pierFor(hf, water.seaLevel, main) };
  return beaches;
}

/**
 * How close to the dune line a road's centreline has to run before the road is
 * the boardwalk: the ground it claims itself, plus the ground a street would
 * claim. A road that near leaves no room for a boardwalk between it and the
 * sand, so it is the road along the back of the beach.
 */
function boardwalkReach(tier: RoadTier): number {
  return footprintHalfWidth(tier) + footprintHalfWidth('street');
}

/**
 * Metres of dune line a road has to run along before it is part of the
 * boardwalk. A cross street that reaches the sand and stops is not one.
 */
const BOARDWALK_ALONG = 40;

/**
 * List the boardwalk of each beach: the roads that run along its dune line
 * (spec section 7.3). The road tracer lays a street where the back of the main
 * beach is free, and the coast road already there takes the rest, so the
 * boardwalk is whatever ends up running along the sand.
 *
 * Called once the roads are traced, because a beach is described before them.
 * Returns new beaches rather than changing the ones it was given.
 */
export function linkBoardwalks(beaches: readonly Beach[], roads: readonly RoadCurve[]): Beach[] {
  return beaches.map((beach) => (beach.main ? { ...beach, boardwalk: roadsAlongBack(beach, roads) } : beach));
}

/** The curves that run along the back of one beach, ascending. */
function roadsAlongBack(beach: Beach, roads: readonly RoadCurve[]): number[] {
  const found: number[] = [];
  for (const road of roads) {
    const covered = coverOf(beach.back, road);
    if (covered !== undefined && metresCovered(beach.back, covered) >= BOARDWALK_ALONG) found.push(road.id);
  }
  return found;
}

/**
 * How much of a beach's dune line its boardwalk runs along, in metres. The
 * sweep reads it, and so does anything that asks whether a beach has a
 * boardwalk worth the name.
 */
export function boardwalkLength(beach: Beach, roads: readonly RoadCurve[]): number {
  const covered = new Uint8Array(beach.back.length);
  for (const id of beach.boardwalk) {
    const road = roads[id];
    if (road === undefined) continue;
    const one = coverOf(beach.back, road);
    if (one === undefined) continue;
    for (let i = 0; i < covered.length; i++) if (one[i] === 1) covered[i] = 1;
  }
  return metresCovered(beach.back, covered);
}

/**
 * Which points of a line stand on the ground one road claims, give or take a
 * pavement. A road whose box does not reach the line at all gives nothing, so
 * the whole network costs four comparisons a curve.
 */
function coverOf(line: readonly Point[], road: RoadCurve): Uint8Array | undefined {
  const reach = boardwalkReach(road.tier);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of line) {
    minX = Math.min(minX, p.x - reach);
    minY = Math.min(minY, p.y - reach);
    maxX = Math.max(maxX, p.x + reach);
    maxY = Math.max(maxY, p.y + reach);
  }
  let near = false;
  for (const p of road.points) {
    if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
    near = true;
    break;
  }
  if (!near) return undefined;
  const covered = new Uint8Array(line.length);
  for (let i = 0; i < line.length; i++) {
    const p = line[i] as Point;
    for (let k = 0; k + 1 < road.points.length; k++) {
      const a = road.points[k] as WorldPoint;
      const b = road.points[k + 1] as WorldPoint;
      if (segmentDistance(p.x, p.y, a, b) > reach) continue;
      covered[i] = 1;
      break;
    }
  }
  return covered;
}

/**
 * Metres of a line that are covered. A step counts when both its ends are, so
 * the answer is length rather than a count of points.
 */
function metresCovered(line: readonly Point[], covered: Uint8Array): number {
  let metres = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    if (covered[i] === 0 || covered[i + 1] === 0) continue;
    const a = line[i] as Point;
    const b = line[i + 1] as Point;
    metres += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return metres;
}

/**
 * A test for the ground the sand covers, with a box around each beach so a
 * place away from the coast costs four comparisons. The road fill asks it, so
 * the streets between the blocks are not laid across a beach.
 */
export function sandTest(beaches: readonly Beach[]): (x: number, y: number) => boolean {
  const rings: Point[][] = [];
  const minX: number[] = [];
  const minY: number[] = [];
  const maxX: number[] = [];
  const maxY: number[] = [];
  for (const beach of beaches) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of beach.sand) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    rings.push(beach.sand);
    minX.push(x0);
    minY.push(y0);
    maxX.push(x1);
    maxY.push(y1);
  }
  return (x, y) => {
    for (let i = 0; i < rings.length; i++) {
      if (x < (minX[i] as number) || x > (maxX[i] as number)) continue;
      if (y < (minY[i] as number) || y > (maxY[i] as number)) continue;
      if (pointInRing({ x, y }, rings[i] as Point[])) return true;
    }
    return false;
  };
}

// ------------------------------------------------------------------- the coast

/** Measure one traced ring of coast: where it faces, how flat it is, and whether it is sand at all. */
function measureCoast(hf: Heightfield, water: WaterDescription, size: number, core: Point, ring: readonly Point[]): Coast | undefined {
  const shore = smoothRing(resample(ring, SHORE_STEP), SHORE_SMOOTHING);
  // Three points is not a coast, and neither is a rock the resampling collapses.
  if (shore.length < 4) return undefined;
  const inward = inwardNormals(shore);
  const width: number[] = [];
  const open: boolean[] = [];
  for (let i = 0; i < shore.length; i++) {
    const p = shore[i] as Point;
    const n = inward[i] as Point;
    width.push(sandWidth(hf, water.seaLevel, p, n));
    open.push(openCoast(hf, water, size, core, p, n));
  }
  capByCurvature(shore, width);
  return { shore, inward, width, open };
}

/** How far inland the ground stays below the dune line, in metres. */
function sandWidth(hf: Heightfield, seaLevel: number, p: Point, n: Point): number {
  const dune = seaLevel + DUNE_RISE;
  for (let reach = PROBE_STEP; reach <= MAX_SAND; reach += PROBE_STEP) {
    if (hf.sample(p.x + n.x * reach, p.y + n.y * reach) >= dune) return reach;
  }
  return MAX_SAND;
}

/**
 * True where a point of coast may carry sand: open sea in front of it, clear of
 * the harbour and the river, outside the core, and far enough from the edge of
 * the map for a boardwalk to run behind it.
 */
function openCoast(hf: Heightfield, water: WaterDescription, size: number, core: Point, p: Point, n: Point): boolean {
  const half = size / 2 - EDGE_MARGIN;
  if (Math.abs(p.x) > half || Math.abs(p.y) > half) return false;
  if (Math.hypot(p.x - core.x, p.y - core.y) < ZONE_RADII.core * size) return false;
  if (Math.hypot(p.x - water.harbour.x, p.y - water.harbour.y) < water.harbour.radius * HARBOUR_REACH) return false;
  if (nearRiver(water.river, p)) return false;
  // Open water in front of it all the way out, so the far bank of a narrow
  // channel is never what a beach faces.
  for (let k = 1; k <= OFFSHORE_SAMPLES; k++) {
    const reach = (OFFSHORE_PROBE * k) / OFFSHORE_SAMPLES;
    if (hf.sample(p.x - n.x * reach, p.y - n.y * reach) >= water.seaLevel) return false;
  }
  return true;
}

/** True when a point stands on the bank of the river rather than on the sea shore. */
function nearRiver(river: RiverDescription, p: Point): boolean {
  for (let i = 0; i + 1 < river.path.length; i++) {
    const a = river.path[i] as WorldPoint;
    const b = river.path[i + 1] as WorldPoint;
    const halfWidth = Math.max(river.halfWidths[i] as number, river.halfWidths[i + 1] as number);
    if (segmentDistance(p.x, p.y, a, b) < halfWidth + RIVER_MARGIN) return true;
  }
  return false;
}

/**
 * Hold the sand back where the waterline turns toward the land. The land lies
 * to the left of the traced ring, so a left turn is a headland, and offsetting
 * inland further than the turning radius would fold the dune line over itself.
 * A headland tight enough therefore fails the width a beach needs, and the run
 * of coast is cut in two there rather than carried round the corner.
 */
function capByCurvature(shore: readonly Point[], width: number[]): void {
  const count = shore.length;
  const caps = new Float64Array(count).fill(MAX_SAND);
  for (let i = 0; i < count; i++) {
    const a = shore[i] as Point;
    const b = shore[(i + 1) % count] as Point;
    const c = shore[(i + 2) % count] as Point;
    const turn = wrapAngle(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
    if (turn <= 1e-6) continue;
    const cap = (CURVE_SAFETY * Math.hypot(b.x - a.x, b.y - a.y)) / turn;
    // The fold would start at the turn and open out either side of it.
    for (const at of [i, (i + 1) % count, (i + 2) % count]) {
      caps[at] = Math.min(caps[at] as number, cap);
    }
  }
  for (let i = 0; i < count; i++) width[i] = Math.min(width[i] as number, caps[i] as number);
}

// -------------------------------------------------------------------- the runs

/** Every run of coast that is open, flat and long enough to be a beach. */
function gentleRuns(coasts: readonly Coast[]): Run[] {
  const runs: Run[] = [];
  for (let c = 0; c < coasts.length; c++) {
    const coast = coasts[c] as Coast;
    const sand = (i: number): boolean => (coast.open[i] as boolean) && (coast.width[i] as number) >= MIN_SAND;
    for (const span of spansOf(coast.shore.length, sand)) {
      const length = runLength(coast.shore, span.at, span.count);
      if (length < MIN_BEACH) continue;
      runs.push({ coast: c, at: span.at, count: span.count, length });
    }
  }
  return runs;
}

/**
 * The flattest open run of the shortest length a beach may have. This is the
 * fallback for a seed whose coast is nowhere gentle: it takes the least steep
 * coast there is rather than leaving the seed without a beach.
 */
function flattestRun(coasts: readonly Coast[]): Run | undefined {
  let best: Run | undefined;
  let bestWidth = -1;
  for (let c = 0; c < coasts.length; c++) {
    const coast = coasts[c] as Coast;
    const count = coast.shore.length;
    for (const span of spansOf(count, (i) => coast.open[i] as boolean)) {
      // The window walks the run once: it grows at the tail and gives up
      // whatever the head can spare while it is still long enough.
      const steps: number[] = [];
      const widths: number[] = [];
      for (let k = 0; k < span.count; k++) {
        const at = (span.at + k) % count;
        widths.push(coast.width[at] as number);
        if (k + 1 >= span.count) continue;
        const a = coast.shore[at] as Point;
        const b = coast.shore[(span.at + k + 1) % count] as Point;
        steps.push(Math.hypot(b.x - a.x, b.y - a.y));
      }
      let head = 0;
      let length = 0;
      let total = widths[0] ?? 0;
      for (let tail = 1; tail < span.count; tail++) {
        length += steps[tail - 1] as number;
        total += widths[tail] as number;
        while (head < tail && length - (steps[head] as number) >= MIN_BEACH) {
          length -= steps[head] as number;
          total -= widths[head] as number;
          head++;
        }
        if (length < MIN_BEACH) continue;
        const mean = total / (tail - head + 1);
        if (mean <= bestWidth) continue;
        bestWidth = mean;
        best = { coast: c, at: (span.at + head) % count, count: tail - head + 1, length };
      }
    }
  }
  return best;
}

/**
 * How much a zone wants the main beach. Spec section 7.3 puts it on the
 * suburban or the outskirts coast, and the core has no beach at all. The
 * wilderness comes last because a beach out there has no city behind it.
 */
const MAIN_BY_ZONE: Record<Zone, number> = {
  core: 5,
  inner: 2,
  industrial: 3,
  suburban: 0,
  outskirts: 1,
  wilderness: 4,
};

/**
 * The islands a district stands on, as one flag per island. The road tracer
 * bridges out to exactly these (spec section 7.2), so a beach anywhere else is
 * on ground no road ever reaches.
 */
function inhabitedIslands(water: WaterDescription, size: number, noise: Noise2D, districts: readonly District[]): Uint8Array {
  const flags = new Uint8Array(water.islands.length);
  for (const d of districts) {
    const at = islandAt(water.islands, size, noise, d.x, d.y);
    if (at >= 0 && at < flags.length) flags[at] = 1;
  }
  return flags;
}

/**
 * Which beach is the main one: the longest on the coast that wants it most
 * (spec section 7.3). It carries the boardwalk, the pier and the beach
 * neighbourhood, so it has to be one the city can reach. Whether a road ever
 * gets to the island comes before the zone in that, because a beach on an
 * island with no district has no road within miles of it.
 */
function pickMain(beaches: readonly Beach[], zones: ZoneLayout, inhabited: Uint8Array): number {
  let at = -1;
  let bestIsland = Infinity;
  let bestZone = Infinity;
  let bestLength = 0;
  for (let i = 0; i < beaches.length; i++) {
    const beach = beaches[i] as Beach;
    const middle = beach.back[beach.back.length >> 1] as Point;
    const island = inhabited[beach.island] === 1 ? 0 : 1;
    const zone = MAIN_BY_ZONE[zoneAt(zones, middle.x, middle.y)] as number;
    if (island > bestIsland) continue;
    if (island === bestIsland) {
      if (zone > bestZone) continue;
      if (zone === bestZone && beach.length <= bestLength) continue;
    }
    at = i;
    bestIsland = island;
    bestZone = zone;
    bestLength = beach.length;
  }
  return at;
}

/**
 * The pier of the main beach: out from the middle of its dune line. A pier is
 * walked onto from the sand, so its root has to stand on dry ground. The dune
 * line does not always: a spit can put a lagoon behind the sand. So the search
 * works outward from the middle of the beach until it finds a place the deck
 * can start from.
 */
function pierFor(hf: Heightfield, seaLevel: number, beach: Beach): Pier {
  const middle = beach.back.length >> 1;
  for (let step = 0; step < beach.back.length; step++) {
    for (const at of [middle - step, middle + step]) {
      if (at < 0 || at >= beach.back.length) continue;
      const shore = beach.shore[at] as Point;
      const back = beach.back[at] as Point;
      const root = dryRoot(hf, seaLevel, shore, back);
      if (root === undefined) continue;
      const dx = back.x - shore.x;
      const dy = back.y - shore.y;
      const span = Math.hypot(dx, dy);
      const inward = span > 0 ? { x: dx / span, y: dy / span } : { x: 0, y: 1 };
      return buildPier(hf, seaLevel, shore, root, inward);
    }
  }
  // No dry sand anywhere along the beach: root the deck on the dune line and
  // let it stand over the water, which is what a pier does anyway.
  const shore = beach.shore[middle] as Point;
  const back = beach.back[middle] as Point;
  const span = Math.hypot(back.x - shore.x, back.y - shore.y);
  const inward = span > 0 ? { x: (back.x - shore.x) / span, y: (back.y - shore.y) / span } : { x: 0, y: 1 };
  return buildPier(hf, seaLevel, shore, back, inward);
}

/**
 * Where a pier may root on one line across the sand: the place furthest from
 * the water that still stands on dry ground. Nothing at all when the whole line
 * is wet.
 */
function dryRoot(hf: Heightfield, seaLevel: number, shore: Point, back: Point): Point | undefined {
  const span = Math.hypot(back.x - shore.x, back.y - shore.y);
  const steps = Math.max(1, Math.round(span / PROBE_STEP));
  for (let k = steps; k > 0; k--) {
    const t = k / steps;
    const p = { x: shore.x + (back.x - shore.x) * t, y: shore.y + (back.y - shore.y) * t };
    if (hf.sample(p.x, p.y) > seaLevel) return p;
  }
  return undefined;
}

/**
 * The runs of a closed ring the test accepts, as a start and a count. A ring
 * every point of which passes gives one run of the whole ring.
 */
function spansOf(count: number, accepts: (i: number) => boolean): { at: number; count: number }[] {
  const spans: { at: number; count: number }[] = [];
  let first = -1;
  for (let i = 0; i < count; i++) {
    if (accepts(i)) continue;
    first = i;
    break;
  }
  if (first === -1) return count > 0 ? [{ at: 0, count }] : [];
  let at = -1;
  let run = 0;
  for (let k = 1; k <= count; k++) {
    const i = (first + k) % count;
    if (accepts(i)) {
      if (at === -1) at = i;
      run++;
      continue;
    }
    if (at !== -1) spans.push({ at, count: run });
    at = -1;
    run = 0;
  }
  if (at !== -1) spans.push({ at, count: run });
  return spans;
}

/** Metres along a run of a closed ring, from its first point to its last. */
function runLength(ring: readonly Point[], at: number, count: number): number {
  let total = 0;
  for (let k = 0; k + 1 < count; k++) {
    const a = ring[(at + k) % ring.length] as Point;
    const b = ring[(at + k + 1) % ring.length] as Point;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

// ----------------------------------------------------------------- the beaches

/** Build one beach out of a run of coast. */
function buildBeach(
  hf: Heightfield,
  water: WaterDescription,
  noise: ReturnType<typeof coastNoise>,
  coast: Coast,
  run: Run,
  id: number,
): Beach {
  const shore: Point[] = [];
  const inward: Point[] = [];
  const widths: number[] = [];
  for (let k = 0; k < run.count; k++) {
    const at = (run.at + k) % coast.shore.length;
    shore.push(coast.shore[at] as Point);
    inward.push(coast.inward[at] as Point);
    widths.push(coast.width[at] as number);
  }
  const sandWidths = smoothWidths(widths, MIN_SAND, MAX_SAND);
  const back = offsetLine(shore, inward, sandWidths, 1);

  const wetWidths: number[] = [];
  for (let i = 0; i < shore.length; i++) {
    wetWidths.push(shallowWidth(hf, water.seaLevel, shore[i] as Point, inward[i] as Point));
  }
  const front = offsetLine(shore, inward, smoothWidths(wetWidths, MIN_SHALLOWS, MAX_SHALLOWS), -1);

  const middle = shore.length >> 1;
  const at = back[middle] as Point;
  return {
    id,
    shore,
    back,
    sand: bandRing(shore, back),
    shallows: bandRing(front, shore),
    length: run.length,
    island: islandAt(water.islands as readonly Island[], hf.extent, noise, at.x, at.y),
    main: false,
    boardwalk: [],
    pier: undefined,
  };
}

/** How far out the water stays shallow, in metres. */
function shallowWidth(hf: Heightfield, seaLevel: number, p: Point, n: Point): number {
  const floor = seaLevel - SHALLOW_DEPTH;
  for (let reach = PROBE_STEP; reach <= MAX_SHALLOWS; reach += PROBE_STEP) {
    if (hf.sample(p.x - n.x * reach, p.y - n.y * reach) <= floor) return reach;
  }
  return MAX_SHALLOWS;
}

/**
 * The pier: a deck from the back of the sand out to water deep enough to moor
 * in (spec section 7.3). It never reaches further than {@link MAX_PIER}, so a
 * beach with a long shallow bottom gets a long pier rather than an endless one.
 */
function buildPier(hf: Heightfield, seaLevel: number, shore: Point, root: Point, inward: Point): Pier {
  const deep = seaLevel - PIER_DEPTH;
  let out = MIN_PIER;
  for (let reach = PROBE_STEP; reach <= MAX_PIER; reach += PROBE_STEP) {
    if (hf.sample(shore.x - inward.x * reach, shore.y - inward.y * reach) > deep) continue;
    out = Math.max(MIN_PIER, reach);
    break;
  }
  const head = { x: shore.x - inward.x * out, y: shore.y - inward.y * out };
  const along = { x: head.x - root.x, y: head.y - root.y };
  const length = Math.hypot(along.x, along.y);
  const side = length > 0 ? { x: (-along.y / length) * PIER_HALF_WIDTH, y: (along.x / length) * PIER_HALF_WIDTH } : { x: 0, y: PIER_HALF_WIDTH };
  const polygon = [
    { x: root.x - side.x, y: root.y - side.y },
    { x: head.x - side.x, y: head.y - side.y },
    { x: head.x + side.x, y: head.y + side.y },
    { x: root.x + side.x, y: root.y + side.y },
  ];
  return { root, head, polygon: ringArea(polygon) < 0 ? polygon.reverse() : polygon, length };
}

// -------------------------------------------------------------------- polylines

/** A polyline resampled at a fixed spacing, walking a closed ring once round. */
function resample(ring: readonly Point[], step: number): Point[] {
  const out: Point[] = [];
  let since = step;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    let walked = 0;
    while (since + (span - walked) >= step) {
      walked += step - since;
      since = 0;
      const t = span > 0 ? walked / span : 0;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    since += span - walked;
  }
  return out;
}

/** A closed ring with each point pulled toward its two neighbours, `passes` times. */
function smoothRing(ring: readonly Point[], passes: number): Point[] {
  let out = [...ring];
  const count = out.length;
  if (count < 3) return out;
  for (let pass = 0; pass < passes; pass++) {
    const next: Point[] = [];
    for (let i = 0; i < count; i++) {
      const a = out[(i + count - 1) % count] as Point;
      const b = out[i] as Point;
      const c = out[(i + 1) % count] as Point;
      next.push({ x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 });
    }
    out = next;
  }
  return out;
}

/**
 * The unit normal pointing inland at each point of a closed ring. `land.ts`
 * winds a ring with the land on its left, so the inland side is the left of the
 * direction the ring runs in.
 */
function inwardNormals(ring: readonly Point[]): Point[] {
  const count = ring.length;
  const out: Point[] = [];
  for (let i = 0; i < count; i++) {
    const a = ring[(i + count - 1) % count] as Point;
    const b = ring[(i + 1) % count] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const span = Math.hypot(dx, dy);
    out.push(span > 0 ? { x: -dy / span, y: dx / span } : { x: 0, y: 1 });
  }
  return out;
}

/** Widths averaged over their neighbours and held inside a range. */
function smoothWidths(widths: readonly number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < widths.length; i++) {
    let total = 0;
    let taken = 0;
    for (let k = -WIDTH_SMOOTHING; k <= WIDTH_SMOOTHING; k++) {
      const at = i + k;
      if (at < 0 || at >= widths.length) continue;
      total += widths[at] as number;
      taken++;
    }
    out.push(clamp(total / taken, lo, hi));
  }
  return out;
}

/** A line offset from another by a width at each point, `side` inland or seaward. */
function offsetLine(line: readonly Point[], normals: readonly Point[], widths: readonly number[], side: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < line.length; i++) {
    const p = line[i] as Point;
    const n = normals[i] as Point;
    const w = (widths[i] as number) * side;
    out.push({ x: p.x + n.x * w, y: p.y + n.y * w });
  }
  return out;
}

/** Two lines closed into one ring, wound anticlockwise: out along the first, back along the second. */
function bandRing(near: readonly Point[], far: readonly Point[]): Point[] {
  const ring = [...near];
  for (let i = far.length - 1; i >= 0; i--) ring.push(far[i] as Point);
  return ringArea(ring) < 0 ? ring.reverse() : ring;
}

/** Reverse a ring in place when it is wound the wrong way. Returns nothing to spread. */
function anticlockwise(ring: Point[]): Record<string, never> {
  if (ringArea(ring) < 0) ring.reverse();
  return {};
}
