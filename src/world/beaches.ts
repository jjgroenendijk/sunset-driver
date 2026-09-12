/**
 * The beaches of spec section 7.3.
 *
 * A beach is a run of coastline where the ground behind the waterline rises
 * slowly. Steep coast is cliff, the harbour is quay, and the river mouth is
 * neither, so all three are cut out before the runs are measured. What is left
 * is sand from the waterline back to the dune line, shallows in front of it,
 * and on a long beach a boardwalk line behind the dune, a pier out over the
 * water and car parks behind the boardwalk.
 *
 * Beaches are planned before the roads, because the boardwalk is a road and the
 * tracer has to know where to lay it (`roads.ts`). They carry lines and rings
 * only: the ground itself is claimed once, by the parcels cut from the land the
 * roads leave (`parcels.ts`), which is what keeps a beach off a road without
 * anything being nudged apart afterwards.
 *
 * Pure and headless: the same terrain gives the same beaches, in the same
 * order, on every machine.
 */
import { pointInRing, ringArea, type Point } from '../core/geom.ts';
import { wrapAngle } from '../core/math.ts';
import { sortedMembers } from '../core/sort.ts';
import { districtAt, zoneAt, type ZoneLayout } from './districts.ts';
import { Heightfield } from './heightfield.ts';
import { landRings } from './land.ts';
import { LandMasses } from './landmass.ts';
import { segmentDistance } from './terrain.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { Beach, District, Pier, Point as WorldPoint, WaterDescription, Zone } from './types.ts';

/**
 * Metres inland the gentleness test looks, and the metres the ground may stand
 * above the sea at that reach. Together they are a grade of about 4 %: the
 * flattest third of the coastline, measured far enough inland that the shelf
 * every waterline has does not make the whole map a beach.
 */
export const BEACH_REACH = 80;
export const BEACH_RISE = 3.3;

/**
 * How far the dune line stands behind the waterline: the widest sand where the
 * ground behind is flat, the narrowest where it climbs as hard as a beach may.
 * The width is read off that climb rather than off a height, because the coast
 * these islands have is a plain that never reaches a dune height of its own.
 */
export const MIN_SAND = 14;
export const MAX_SAND = 52;
/**
 * How much of the way to the centre of a bend the dune line may reach. At the
 * centre itself the offset line has no length left and folds over; short of it
 * the sand narrows the way sand in a cove really does.
 */
const FOLD_CLEARANCE = 0.7;

/** Metres of shallow water in front of the waterline. */
const SHALLOWS = 30;

/**
 * Metres between the samples along the waterline, and how many samples each
 * side of one the direction of the coast is taken across.
 */
export const SHORE_STEP = 12;
const NORMAL_SPAN = 3;

/**
 * Metres of waterline below which a gentle run is a cove rather than a beach,
 * and the metres one needs before it is developed as a resort: a boardwalk
 * along its back, a pier and car parks. Spec section 7.3 wants one long beach
 * per seed outside the core, so the longest beach outside the core is made a
 * resort however long it turned out to be.
 */
export const MIN_BEACH = 140;
export const RESORT_BEACH = 800;
/**
 * How good a zone is to put a resort in, best first. Spec section 7.3 says the
 * long beach is typically on the suburban or outskirts coast, so those two are
 * one group and the longest beach in it wins; open country comes last, because
 * a boardwalk out there may have no road to reach it. The core is in none of
 * the groups: the spec wants the long beach outside it.
 */
const RESORT_ZONES: Zone[][] = [
  ['suburban', 'outskirts'],
  ['inner', 'industrial'],
  ['wilderness'],
];
/** How many beaches are promoted to resorts to be sure of getting one. */
const PROMOTED_RESORTS = 2;

/**
 * Metres behind the dune line that the boardwalk's centreline runs: exactly the
 * ground a street claims, so the near edge of its footprint lands on the dune
 * line. The sand then borders the boardwalk, which is what makes it a parcel —
 * `parcels.ts` drops ground no road runs along.
 */
const BOARDWALK_SET_BACK = footprintHalfWidth('street');

/** The pier: metres out from the waterline, and metres each side of its centreline. */
const PIER_LENGTH = 110;
const PIER_HALF_WIDTH = 6;
/** Metres of pier that have to stand over water before the pier is worth building. */
export const MIN_PIER = 45;

/** Metres above the sea a piece of land has to reach before it counts as dry. */
const DRY = 1;

/** Metres of quay each side of the harbour, and of river bank each side of the mouth. */
const HARBOUR_MARGIN = 70;
const RIVER_MARGIN = 40;

/** The car parks behind a long beach: where along it they stand, and how big they are. */
const CAR_PARK_AT = [0.25, 0.75];
const CAR_PARK_ALONG = 56;
const CAR_PARK_DEEP = 40;
/** Metres behind the far edge of the boardwalk that a car park starts. */
const CAR_PARK_SET_BACK = 2;

/** One sample of the waterline: where it is, and which way the land lies. */
interface ShoreSample {
  x: number;
  y: number;
  /** Unit vector pointing inland, across the waterline. */
  nx: number;
  ny: number;
  /** Metres from the waterline to the dune line here. */
  sand: number;
}

/**
 * Plan the beaches of a world. The districts are read for their sites only, so
 * the cultures they are given afterwards do not feed back into this.
 */
export function planBeaches(
  size: number,
  terrain: Heightfield,
  water: WaterDescription,
  zones: ZoneLayout,
  districts: readonly District[],
): Beach[] {
  const half = size / 2;
  const runs: ShoreSample[][] = [];
  for (const ring of landRings(terrain, water.seaLevel)) {
    for (const run of gentleRuns(walkShore(ring, terrain, water, half))) {
      if (shoreLength(run) >= MIN_BEACH) runs.push(run);
    }
  }
  // Only a beach on land a crossing reaches can be developed: the rest are rocks
  // in the sea, and nothing can be driven to them. The same test keeps the
  // district sites off them (`landmass.ts`).
  const land = new LandMasses(terrain, water.islands, water.seaLevel + DRY);
  const servable = runs.map((run) => {
    const mid = run[Math.floor(run.length / 2)] as ShoreSample;
    return land.carriesIsland(mid.x + mid.nx * mid.sand, mid.y + mid.ny * mid.sand);
  });
  const promoted = new Set(promotions(runs, servable, zones));
  return runs.map((run, i) =>
    beachOf(i, run, servable[i] === true && (shoreLength(run) >= RESORT_BEACH || promoted.has(i)), terrain, water, zones, districts),
  );
}

/**
 * Which beaches are made resorts however long they are, so that every seed has
 * the one spec section 7.3 asks for. The best candidates go first: the beaches
 * of the suburban and outskirts coast, which is where the spec says the long
 * beach usually is, before the ones on ground the city never reaches.
 *
 * More than one is taken, because whether a boardwalk can be laid at all is
 * only known once the roads are traced: a beach on an island with no road on it
 * gets none, and the next candidate is what saves the seed.
 */
function promotions(runs: readonly ShoreSample[][], servable: readonly boolean[], zones: ZoneLayout): number[] {
  const ranked: { at: number; rank: number; length: number }[] = [];
  for (let i = 0; i < runs.length; i++) {
    const head = (runs[i] as ShoreSample[])[0] as ShoreSample;
    const rank = RESORT_ZONES.findIndex((group) => group.includes(zoneAt(zones, head.x, head.y)));
    if (servable[i] !== true || rank < 0) continue;
    ranked.push({ at: i, rank, length: shoreLength(runs[i] as ShoreSample[]) });
  }
  ranked.sort((a, b) => a.rank - b.rank || b.length - a.length || a.at - b.at);
  return ranked.slice(0, PROMOTED_RESORTS).map((r) => r.at);
}

/**
 * The districts a resort beach runs through, with the beach culture of spec
 * section 8.3. The longest resort outside the core makes its districts a beach
 * neighbourhood whatever they were before, so every seed with a beach has one;
 * the other resorts only claim districts that have no culture yet, which leaves
 * a named neighbourhood and the faction that lives in it alone.
 */
export function withBeachCulture(districts: readonly District[], beaches: readonly Beach[], zones: ZoneLayout): District[] {
  const spare = new Set<number>();
  for (const beach of beaches) {
    if (isResort(beach)) for (const id of beach.districts) spare.add(id);
  }
  const best = resortsOutsideCore(beaches, zones)[0];
  const claim = new Set<number>(best?.districts ?? []);
  return districts.map((d) => {
    if (claim.has(d.id) || (spare.has(d.id) && d.culture === 'none')) return { ...d, culture: 'beach' as const };
    return d;
  });
}

/** The name spec section 8.3 gives the beach neighbourhood. */
const BOARDWALK_NAME = 'The Boardwalk';

/**
 * Give the name "The Boardwalk" to a district a resort beach really runs
 * through. The districts are named before the beaches are planned, because a
 * beach reads the district sites, so the name can only be placed here.
 *
 * The longest resort outside the core is taken first, and inside it the
 * district that holds the most of its waterline. A district that carries a
 * fixed name — Chinatown, The Docks, Gull Island — keeps it, because that name
 * belongs to a faction and to a place of its own; the beach takes another of
 * its districts instead, and on a seed whose longest resort runs through
 * nothing else, the next resort. The culture is handed out afterwards by
 * {@link withBeachCulture}, so a district with no culture here is exactly one
 * holding a name from its zone's pool.
 */
export function nameBoardwalk(districts: readonly District[], beaches: readonly Beach[], zones: ZoneLayout): District[] {
  for (const beach of resortsOutsideCore(beaches, zones)) {
    const held = mostOfShore(beach, districts, zones);
    if (held === undefined) continue;
    return districts.map((d) => (d.id === held ? { ...d, name: BOARDWALK_NAME } : d));
  }
  return [...districts];
}

/** The resort beaches that lie outside the core, longest first. */
function resortsOutsideCore(beaches: readonly Beach[], zones: ZoneLayout): Beach[] {
  const out = beaches.filter((beach) => {
    const head = beach.shore[0];
    return isResort(beach) && head !== undefined && zoneAt(zones, head.x, head.y) !== 'core';
  });
  out.sort((a, b) => b.length - a.length || a.id - b.id);
  return out;
}

/**
 * The district holding the most of one beach's waterline, among those that
 * still carry a name from their zone's pool. Districts are numbered from zero
 * in the order `generateDistricts` places them, so the tally is an array.
 */
function mostOfShore(beach: Beach, districts: readonly District[], zones: ZoneLayout): number | undefined {
  const tally = new Array<number>(districts.length).fill(0);
  for (const p of beach.shore) {
    const at = districtAt(districts, zones, p.x, p.y).id;
    tally[at] = (tally[at] as number) + 1;
  }
  let best: District | undefined;
  for (const d of districts) {
    if (d.culture !== 'none' || (tally[d.id] as number) === 0) continue;
    if (best === undefined || (tally[d.id] as number) > (tally[best.id] as number)) best = d;
  }
  return best?.id;
}

/** True on a beach developed as a resort: it carries the boardwalk, the pier and the car parks. */
export function isResort(beach: Beach): boolean {
  return beach.boardwalk.length > 0;
}

/**
 * Walk one coastline ring and sample it every {@link SHORE_STEP} metres. Every
 * ring comes back from `land.ts` wound with the land on its left, so the left
 * normal of the walking direction points inland.
 *
 * The normal is taken across {@link NORMAL_SPAN} samples rather than between
 * neighbours. Marching squares draws the waterline in steps of one terrain
 * cell, so the direction between two neighbouring corners swings a quarter turn
 * at a time, and a dune line offset along that would fold over itself.
 *
 * A sample that is not beach-worthy comes back with no sand: the quay around
 * the harbour, the banks of the river mouth, ground that climbs too fast, and
 * anything against the edge of the map, where there is no room for the rest of
 * the beach.
 */
function walkShore(ring: readonly Point[], terrain: Heightfield, water: WaterDescription, half: number): ShoreSample[] {
  const walk = stepAlong(ring);
  const n = walk.length;
  if (n < 2 * NORMAL_SPAN + 1) return [];
  const heading = walk.map((_, i) => {
    const before = walk[(i + n - NORMAL_SPAN) % n] as Point;
    const after = walk[(i + NORMAL_SPAN) % n] as Point;
    return Math.atan2(after.y - before.y, after.x - before.x);
  });
  return walk.map((p, i) => {
    const line = heading[i] as number;
    // A dune line offset into a bend folds over itself once it passes the
    // centre the bend turns about, so the sand is capped short of it. The land
    // is on the left, so a left turn is the shore curving round the sand.
    const turn = wrapAngle((heading[(i + 1) % n] as number) - (heading[(i + n - 1) % n] as number));
    const curvature = turn / (2 * SHORE_STEP);
    const cap = curvature > 0 ? FOLD_CLEARANCE / curvature : Infinity;
    return sampleShore(p.x, p.y, -Math.sin(line), Math.cos(line), cap, terrain, water, half);
  });
}

/** A closed ring walked in steps of {@link SHORE_STEP} metres. */
function stepAlong(ring: readonly Point[]): Point[] {
  const out: Point[] = [];
  const n = ring.length;
  if (n < 3) return out;
  let since = SHORE_STEP;
  for (let i = 0; i < n; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % n] as Point;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    let at = 0;
    while (since + (span - at) >= SHORE_STEP) {
      at += SHORE_STEP - since;
      since = 0;
      const t = span > 0 ? at / span : 0;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    since += span - at;
  }
  return out;
}

/** One waterline sample: how wide its sand is, or zero where it is not a beach at all. */
function sampleShore(
  x: number,
  y: number,
  nx: number,
  ny: number,
  cap: number,
  terrain: Heightfield,
  water: WaterDescription,
  half: number,
): ShoreSample {
  const none: ShoreSample = { x, y, nx, ny, sand: 0 };
  if (cap < MIN_SAND) return none;
  // A beach needs the whole of its sand, its boardwalk and its car parks to
  // stand on the map, so the test is made at the depth they reach.
  const room = MAX_SAND + BOARDWALK_SET_BACK + CAR_PARK_SET_BACK + CAR_PARK_DEEP;
  if (Math.abs(x) > half - room || Math.abs(y) > half - room) return none;
  if (Math.hypot(x - water.harbour.x, y - water.harbour.y) < water.harbour.radius + HARBOUR_MARGIN) return none;
  if (nearRiver(x, y, water)) return none;
  const sea = water.seaLevel;
  const rise = terrain.sample(x + nx * BEACH_REACH, y + ny * BEACH_REACH) - sea;
  // Ground below the sea behind the waterline is not gentle coast: it is the
  // far side of a spit too narrow to hold a beach, or a place where the coast
  // doubles back so hard that which way is inland means nothing.
  if (rise <= 0 || rise > BEACH_RISE) return none;
  // The flatter the ground behind, the further back the dune line stands.
  const climb = Math.min(1, rise / BEACH_RISE);
  const sand = Math.min(cap, MAX_SAND - (MAX_SAND - MIN_SAND) * climb);
  if (terrain.sample(x + nx * sand, y + ny * sand) <= sea) return none;
  return { x, y, nx, ny, sand };
}

/** True where a point stands on the banks of the river, which are not beach. */
function nearRiver(x: number, y: number, water: WaterDescription): boolean {
  const path = water.river.path;
  for (let i = 0; i + 1 < path.length; i++) {
    const halfWidth = Math.max(water.river.halfWidths[i] ?? 0, water.river.halfWidths[i + 1] ?? 0);
    if (segmentDistance(x, y, path[i] as WorldPoint, path[i + 1] as WorldPoint) < halfWidth + RIVER_MARGIN) return true;
  }
  return false;
}

/**
 * The runs of beach-worthy samples of one ring, longest first so the longest
 * beach of a seed is found without sorting the beaches themselves. A ring is a
 * loop, so a run that crosses its start is one run and not two.
 */
function gentleRuns(samples: readonly ShoreSample[]): ShoreSample[][] {
  const n = samples.length;
  if (n === 0) return [];
  const good = (i: number): boolean => (samples[i % n] as ShoreSample).sand > 0;
  let start = 0;
  while (start < n && good(start)) start++;
  // A ring that is beach the whole way round has no break to start at; take it
  // whole, cut at its first sample.
  if (start === n) return [[...samples]];
  const runs: ShoreSample[][] = [];
  let run: ShoreSample[] = [];
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (good(i)) {
      run.push(samples[i] as ShoreSample);
      continue;
    }
    if (run.length > 0) runs.push(run);
    run = [];
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** One beach from one run of the waterline. A resort also gets a boardwalk, a pier and car parks. */
function beachOf(
  id: number,
  run: readonly ShoreSample[],
  resort: boolean,
  terrain: Heightfield,
  water: WaterDescription,
  zones: ZoneLayout,
  districts: readonly District[],
): Beach {
  const shore: WorldPoint[] = run.map((s) => ({ x: s.x, y: s.y }));
  const back = run.map((s) => offsetBy(s, s.sand));
  return {
    id,
    shore,
    back,
    length: shoreLength(run),
    sand: wound([...shore, ...[...back].reverse()]),
    shallows: wound([...shore, ...run.map((s) => offsetBy(s, -SHALLOWS)).reverse()]),
    boardwalk: resort ? run.map((s) => offsetBy(s, s.sand + BOARDWALK_SET_BACK)) : [],
    boardwalkRoad: -1,
    pier: resort ? pierOf(run, terrain, water) : undefined,
    carParks: resort ? carParksOf(run) : [],
    districts: districtsAlong(shore, zones, districts),
  };
}

/** Metres of waterline a run of samples covers. */
function shoreLength(run: readonly ShoreSample[]): number {
  let total = 0;
  for (let i = 0; i + 1 < run.length; i++) {
    const a = run[i] as ShoreSample;
    const b = run[i + 1] as ShoreSample;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

function offsetBy(s: ShoreSample, metres: number): WorldPoint {
  return { x: s.x + s.nx * metres, y: s.y + s.ny * metres };
}

/**
 * The pier of spec section 7.3: a deck straight out to sea from the middle of
 * the beach, as long as the water under it lasts. A beach whose water runs out
 * at once carries no pier.
 */
function pierOf(run: readonly ShoreSample[], terrain: Heightfield, water: WaterDescription): Pier | undefined {
  const mid = run[Math.floor(run.length / 2)] as ShoreSample;
  const root: WorldPoint = { x: mid.x, y: mid.y };
  let reach = 0;
  for (let d = SHORE_STEP; d <= PIER_LENGTH; d += SHORE_STEP) {
    if (terrain.sample(mid.x - mid.nx * d, mid.y - mid.ny * d) >= water.seaLevel) break;
    reach = d;
  }
  if (reach < MIN_PIER) return undefined;
  const head: WorldPoint = { x: mid.x - mid.nx * reach, y: mid.y - mid.ny * reach };
  return { root, head, polygon: wound(rectangle(root, head, PIER_HALF_WIDTH)) };
}

/** The car parks behind a long beach's boardwalk: one at each of {@link CAR_PARK_AT}. */
function carParksOf(run: readonly ShoreSample[]): WorldPoint[][] {
  const out: WorldPoint[][] = [];
  for (const at of CAR_PARK_AT) {
    const s = run[Math.min(run.length - 1, Math.floor(at * run.length))] as ShoreSample;
    const near = offsetBy(s, s.sand + 2 * BOARDWALK_SET_BACK + CAR_PARK_SET_BACK);
    const far = { x: near.x + s.nx * CAR_PARK_DEEP, y: near.y + s.ny * CAR_PARK_DEEP };
    out.push(wound(rectangle(near, far, CAR_PARK_ALONG / 2)));
  }
  return out;
}

/** The ids of the districts a shore runs through, ascending and without repeats. */
function districtsAlong(shore: readonly WorldPoint[], zones: ZoneLayout, districts: readonly District[]): number[] {
  const seen = new Set<number>();
  for (const p of shore) seen.add(districtAt(districts, zones, p.x, p.y).id);
  return sortedMembers(seen);
}

/** The ground between two lines that run the same way: out along one, back along the other. */
function strip(near: readonly WorldPoint[], far: readonly WorldPoint[]): WorldPoint[] {
  return [...near, ...[...far].reverse()];
}

/** A rectangle around the line from one point to another. */
function rectangle(from: WorldPoint, to: WorldPoint, halfWidth: number): WorldPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const m = Math.hypot(dx, dy) || 1;
  const px = (-dy / m) * halfWidth;
  const py = (dx / m) * halfWidth;
  return [
    { x: from.x + px, y: from.y + py },
    { x: from.x - px, y: from.y - py },
    { x: to.x - px, y: to.y - py },
    { x: to.x + px, y: to.y + py },
  ];
}

/** A ring wound anticlockwise, which is the winding `src/core/geom.ts` reads. */
function wound(ring: WorldPoint[]): WorldPoint[] {
  return ringArea(ring) < 0 ? [...ring].reverse() : ring;
}

/**
 * Which beach, if any, stands on a piece of ground.
 *
 * The sand and the car parks go into a grid of cells once, so asking about a
 * point costs one lookup rather than a walk round every ring. The sand is laid
 * one quadrilateral at a time — waterline to dune line, between two
 * neighbouring samples — because a whole beach is a long thin ring whose box
 * covers a quarter of the map, and filling that box cell by cell would cost
 * more than everything else here together.
 */
export class BeachGround {
  private readonly cell: number;
  private readonly n: number;
  private readonly origin: number;
  /** Beach id plus one in each cell, or zero where there is none. */
  private readonly sand: Int16Array;
  private readonly carPark: Int16Array;

  constructor(beaches: readonly Beach[], size: number, cell: number) {
    this.cell = cell;
    this.origin = -size / 2;
    this.n = Math.max(1, Math.ceil(size / cell) + 1);
    this.sand = new Int16Array(this.n * this.n);
    this.carPark = new Int16Array(this.n * this.n);
    for (const beach of beaches) {
      for (let i = 0; i + 1 < beach.shore.length; i++) {
        const a = beach.shore[i] as WorldPoint;
        const b = beach.shore[i + 1] as WorldPoint;
        const c = beach.back[i + 1] as WorldPoint;
        const d = beach.back[i] as WorldPoint;
        this.paint(this.sand, [a, b, c, d], beach.id);
      }
      for (const park of beach.carParks) this.paint(this.carPark, park, beach.id);
    }
  }

  /** The id of the beach whose sand covers a point, or -1. */
  sandAt(x: number, y: number): number {
    return (this.sand[this.index(x, y)] as number) - 1;
  }

  /** The id of the beach whose car park covers a point, or -1. */
  carParkAt(x: number, y: number): number {
    return (this.carPark[this.index(x, y)] as number) - 1;
  }

  private index(x: number, y: number): number {
    const ix = Math.max(0, Math.min(this.n - 1, Math.round((x - this.origin) / this.cell)));
    const iy = Math.max(0, Math.min(this.n - 1, Math.round((y - this.origin) / this.cell)));
    return iy * this.n + ix;
  }

  /** Fill every cell whose centre falls inside a small ring. */
  private paint(grid: Int16Array, ring: readonly WorldPoint[], id: number): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (minX > maxX) return;
    const lo = (v: number): number => Math.max(0, Math.round((v - this.origin) / this.cell));
    const hi = (v: number): number => Math.min(this.n - 1, Math.round((v - this.origin) / this.cell));
    for (let iy = lo(minY); iy <= hi(maxY); iy++) {
      for (let ix = lo(minX); ix <= hi(maxX); ix++) {
        const p = { x: this.origin + ix * this.cell, y: this.origin + iy * this.cell };
        if (pointInRing(p, ring)) grid[iy * this.n + ix] = id + 1;
      }
    }
  }
}
