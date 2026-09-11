/**
 * Where the buildings stand (spec section 10.3, selection by spec section 8.2).
 *
 * A parcel the zone gave to a building group (`parcels.ts`) is the ground one
 * row of buildings shares, not one building. This layer cuts that ground into
 * lots and says what stands on each of them.
 *
 * A lot is laid on the frontage: the run of the parcel's boundary that stands
 * on the ground a road claims. Every lot therefore has a road along its front
 * edge, and a building is entered from the road the way a driver reaches it.
 * The ground behind the frontage is left as it is — a block keeps its back
 * gardens and its yards, because nothing can be driven into them.
 *
 * A lot never leaves its parcel. The rectangle is laid against the frontage and
 * then shortened until it stands wholly inside the parcel polygon; one too
 * shallow for its zone is dropped rather than allowed to overhang. Two lots of
 * one parcel never overlap, so a narrow block with a road each side gets one
 * row rather than two crossing ones.
 *
 * The kind comes from the zone, from the density and the wealth of the
 * district, and from how much ground the lot has. `ZONE_BUILDINGS` is the
 * table: it says which kinds a zone builds at all, so a suburban parcel can
 * never receive a tower whatever it rolls. A lot too small for the kind it
 * rolled takes the next smaller kind the zone allows, which is what puts the
 * towers on the wide core lots and the shop rows on the narrow ones.
 *
 * Built on demand from the world description and its parcels, like the road
 * graph, the footprint and the parcels themselves; it is not stored in the
 * world. Pure: the same world gives the same buildings, in the same order, with
 * the same kinds and the same seeds.
 */
import { pointInRegion, ringArea, type Point, type Region } from '../core/geom.ts';
import { genRng, Rng, Subsystem } from '../core/rng.ts';
import type { RoadEdge, RoadGraph } from './graph.ts';
import type { Parcel, ParcelMap } from './parcels.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { District, WorldDescription, Zone } from './types.ts';

/** What stands on a lot (spec section 10.3). */
export type BuildingKind = 'tower' | 'mid-rise' | 'shop-row' | 'house' | 'warehouse' | 'roadhouse';

/** One building on its own lot. */
export interface Building {
  id: number;
  /** Id of the parcel the lot was cut from. */
  parcel: number;
  kind: BuildingKind;
  /**
   * The seed of this building alone. `SkyscraperGenerator` and the other
   * generators take it, so a building's shape is a pure function of it and the
   * renderer needs nothing else to build the same thing twice.
   */
  seed: number;
  /**
   * The lot, wound anticlockwise, four corners: the two of the front edge
   * first, then the two at the back. It stands wholly inside the parcel.
   */
  lot: Point[];
  /** Square metres of the lot. */
  area: number;
  /** Metres of frontage: the length of the front edge. */
  width: number;
  /** Metres from the front edge to the back of the lot. */
  depth: number;
  /** The middle of the front edge. */
  front: Point;
  /** Which way the front faces, in radians: from the lot towards its road. */
  facing: number;
  /** The road graph edge the lot fronts. One of a two-way pair, as `Parcel.roads` lists them. */
  road: number;
  /** Id of the district the lot stands in, as its parcel reads it. */
  district: number;
  zone: Zone;
}

/** The buildings of a world. */
export interface BuildingMap {
  buildings: Building[];
  /** Square metres the lots cover together. */
  area: number;
}

/**
 * What a zone builds and how often, before the district and the lot move it.
 * The order is the order of the spec's character table for that zone, densest
 * first: a lot too small for the kind it rolled steps down this list, so the
 * kinds a zone never builds cannot be reached that way either.
 */
export const ZONE_BUILDINGS: Record<Zone, readonly { kind: BuildingKind; weight: number }[]> = {
  // Dense downtown: tall towers on the wide lots, shops on what is left.
  core: [
    { kind: 'tower', weight: 0.6 },
    { kind: 'mid-rise', weight: 0.3 },
    { kind: 'shop-row', weight: 0.1 },
  ],
  // Mid-rise with commercial strips, and the odd tower where the money is.
  inner: [
    { kind: 'tower', weight: 0.1 },
    { kind: 'mid-rise', weight: 0.5 },
    { kind: 'shop-row', weight: 0.25 },
    { kind: 'house', weight: 0.15 },
  ],
  // Warehouses and freight yards; nobody lives here.
  industrial: [{ kind: 'warehouse', weight: 1 }],
  // Low buildings and gardens. A tower is not on this list, so a suburban
  // parcel can never receive one.
  suburban: [
    { kind: 'shop-row', weight: 0.2 },
    { kind: 'house', weight: 0.8 },
  ],
  // Sparse: filling stations and roadhouses between isolated properties.
  outskirts: [
    { kind: 'warehouse', weight: 0.15 },
    { kind: 'roadhouse', weight: 0.25 },
    { kind: 'house', weight: 0.6 },
  ],
  // Farmland: a farmhouse, and a roadhouse where the dirt roads meet.
  wilderness: [
    { kind: 'roadhouse', weight: 0.4 },
    { kind: 'house', weight: 0.6 },
  ],
};

/**
 * Square metres of lot each kind needs. A lot below the figure for the kind it
 * rolled takes the next kind down its zone's list; one below every figure on
 * that list carries no building at all.
 */
export const MIN_LOT_AREA: Record<BuildingKind, number> = {
  // A downtown tower stands on a tight lot: it buys its room upwards.
  tower: 320,
  warehouse: 600,
  'mid-rise': 220,
  roadhouse: 200,
  'shop-row': 130,
  house: 90,
};

/** How a zone cuts its frontage into lots. Metres throughout. */
export interface LotSpec {
  /** Frontage one lot wants. The run is divided into whole lots about this wide. */
  width: number;
  /** Frontage below which the run is left uncut rather than divided again. */
  minWidth: number;
  /** How far back from the road a lot reaches when the parcel has the room. */
  depth: number;
  /** Depth below which a lot is dropped rather than squeezed in. */
  minDepth: number;
  /** How far the front edge stands back from the parcel boundary. */
  setback: number;
  /** Metres of open ground between one lot and the next along the frontage. */
  gap: number;
}

export const ZONE_LOTS: Record<Zone, LotSpec> = {
  core: { width: 24, minWidth: 13, depth: 28, minDepth: 14, setback: 0.5, gap: 1 },
  inner: { width: 22, minWidth: 12, depth: 26, minDepth: 11, setback: 1, gap: 1.5 },
  industrial: { width: 45, minWidth: 20, depth: 45, minDepth: 15, setback: 3, gap: 4 },
  // Gardens and driveways: a deep setback and room between the houses.
  suburban: { width: 16, minWidth: 9, depth: 20, minDepth: 8, setback: 4, gap: 3 },
  outskirts: { width: 30, minWidth: 12, depth: 28, minDepth: 10, setback: 6, gap: 8 },
  wilderness: { width: 34, minWidth: 14, depth: 30, minDepth: 12, setback: 8, gap: 20 },
};

/** Metres between the points of a parcel boundary that are asked which road runs along them. */
const FRONT_STEP = 4;
/**
 * Metres past the ground a road claims that a boundary still counts as
 * frontage. `parcels.ts` allows the same slack when it asks which roads run
 * along a parcel, so the two agree on where a parcel meets its road.
 */
export const FRONT_REACH = 2;
/** Samples a frontage run needs before a lot is laid on it: a corner is not a frontage. */
const MIN_RUN_SAMPLES = 2;
/**
 * The depths a lot is tried at, as a share of the depth its zone asks for. A
 * lot that does not fit the parcel is shortened rather than moved, so its front
 * stays on the road; the last try is the zone's own minimum.
 */
const DEPTH_TRIES = [1, 0.7, 0.45];
/** Metres of the grid the lot corners are rounded onto, as `src/core/geom.ts` rounds its own. */
const MM = 1e-3;
/**
 * Metres of open ground two lots of one parcel keep between them. A lot that
 * comes closer than this to one already laid is dropped, so no two of them
 * touch and the sweep can ask for daylight rather than for overlap.
 */
export const LOT_CLEARANCE = 0.1;

/**
 * Lay the buildings of a world on its parcels. The parcels and the graph are
 * passed in because a caller that already has them should not pay for them
 * twice.
 */
export function buildBuildings(world: WorldDescription, parcels: ParcelMap, graph: RoadGraph): BuildingMap {
  const buildings: Building[] = [];
  let area = 0;
  for (const parcel of parcels.parcels) {
    if (parcel.owner !== 'building') continue;
    const district = world.districts[parcel.district] as District;
    const rng = genRng(world.seed, Subsystem.Buildings, parcel.id);
    for (const lot of lotsOf(parcel, graph)) {
      const kind = kindFor(parcel.zone, district, lot.area, rng);
      if (kind === undefined) continue;
      buildings.push({
        id: buildings.length,
        parcel: parcel.id,
        kind,
        seed: rng.nextU32(),
        lot: lot.corners,
        area: lot.area,
        width: lot.width,
        depth: lot.depth,
        front: lot.front,
        facing: lot.facing,
        road: lot.road,
        district: parcel.district,
        zone: parcel.zone,
      });
      area += lot.area;
    }
  }
  return { buildings, area };
}

/** A lot before it is given a building. */
interface Lot {
  corners: Point[];
  area: number;
  width: number;
  depth: number;
  front: Point;
  facing: number;
  road: number;
}

/**
 * Cut one parcel's frontage into lots, in the order the boundary runs.
 *
 * Each run of boundary along one road is divided into whole lots of about the
 * width the zone wants, so a frontage is covered evenly rather than left with a
 * stub at its far end. A lot that will not fit the parcel is shortened, and
 * dropped if even the zone's minimum depth overhangs.
 */
function lotsOf(parcel: Parcel, graph: RoadGraph): Lot[] {
  const spec = ZONE_LOTS[parcel.zone];
  const out: Lot[] = [];
  for (const run of frontagesOf(parcel, graph)) {
    const count = lotCount(run.length, spec);
    if (count === 0) continue;
    const pitch = run.length / count;
    const width = pitch - spec.gap;
    for (let i = 0; i < count; i++) {
      const from = i * pitch + spec.gap / 2;
      const lot = lotAt(parcel.region, run, from, width, spec);
      if (lot !== undefined && !overlapsAny(lot.corners, out)) out.push(lot);
    }
  }
  return out;
}

/** How many lots a run of frontage is divided into; none when it is too short for one. */
function lotCount(length: number, spec: LotSpec): number {
  let count = Math.max(1, Math.round(length / spec.width));
  while (count > 1 && length / count - spec.gap < spec.minWidth) count--;
  return length / count - spec.gap >= spec.minWidth ? count : 0;
}

/**
 * One lot on a run of frontage, or nothing where no depth the zone accepts
 * stands inside the parcel. The rectangle is laid against the frontage, set
 * back from it, and reaches into the parcel; the deepest try that fits wins, so
 * a shallow strip of ground carries a shallow building rather than none.
 */
function lotAt(region: Region, run: Frontage, from: number, width: number, spec: LotSpec): Lot | undefined {
  const a = pointAlong(run.points, from);
  const b = pointAlong(run.points, from + width);
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  if (span < spec.minWidth) return undefined;
  // Across the frontage, into the parcel: the outer ring is wound anticlockwise,
  // so the ground it encloses is on the left of the way it is walked.
  const tx = (b.x - a.x) / span;
  const ty = (b.y - a.y) / span;
  const nx = -ty;
  const ny = tx;
  const f0 = { x: a.x + nx * spec.setback, y: a.y + ny * spec.setback };
  const f1 = { x: b.x + nx * spec.setback, y: b.y + ny * spec.setback };
  const depths = [...DEPTH_TRIES.map((share) => spec.depth * share), spec.minDepth];
  for (const depth of depths) {
    if (depth < spec.minDepth) continue;
    const corners = [
      round(f0),
      round(f1),
      round({ x: f1.x + nx * depth, y: f1.y + ny * depth }),
      round({ x: f0.x + nx * depth, y: f0.y + ny * depth }),
    ];
    if (!insideRegion(corners, region)) continue;
    return {
      corners,
      area: ringArea(corners),
      width: span,
      depth,
      front: round({ x: (f0.x + f1.x) / 2, y: (f0.y + f1.y) / 2 }),
      // The front looks out of the lot, across the frontage, at the road.
      facing: Math.atan2(-ny, -nx),
      road: run.road,
    };
  }
  return undefined;
}

/** A point rounded onto the millimetre grid the polygon arithmetic uses. */
function round(p: Point): Point {
  return { x: Math.round(p.x / MM) * MM, y: Math.round(p.y / MM) * MM };
}

/** One run of a parcel's boundary that stands along a single road. */
interface Frontage {
  /** The boundary itself, sampled every {@link FRONT_STEP} metres. */
  points: Point[];
  /** Metres of it. */
  length: number;
  /** The graph edge that runs along it. */
  road: number;
}

/**
 * The runs of a parcel's boundary that stand along a road.
 *
 * Only the outer ring is walked: a hole is ground the parcel encloses, and
 * nothing reaches it. The boundary is sampled at a fixed step rather than at
 * its corners, because a straight stretch of frontage can be one long edge and
 * a rounded one a crowd of short ones.
 *
 * A sample belongs to the nearest of the roads the parcel already lists, and a
 * run ends where that road changes, so a corner lot gives one run per road and
 * each lot fronts one of them.
 */
function frontagesOf(parcel: Parcel, graph: RoadGraph): Frontage[] {
  const ring = parcel.region.outer;
  const samples = sampleRing(ring, FRONT_STEP);
  if (samples.length < MIN_RUN_SAMPLES) return [];
  const roads = parcel.roads.map((edge) => ({
    edge,
    points: graph.edgePoints(edge),
    reachSquared: (footprintHalfWidth((graph.edges[edge] as RoadEdge).tier) + FRONT_REACH) ** 2,
  }));
  const along: number[] = [];
  for (const sample of samples) {
    let found = -1;
    let best = Infinity;
    for (const road of roads) {
      const d = distanceSquaredToLine(sample, road.points);
      if (d > road.reachSquared || d >= best) continue;
      best = d;
      found = road.edge;
    }
    along.push(found);
  }

  // The ring is a loop, so a run may pass its first sample. Start where the
  // frontage breaks, and take the whole loop as one run where it never does.
  const count = samples.length;
  let start = 0;
  while (start < count && (along[start] as number) === (along[(start + count - 1) % count] as number)) start++;
  if (start === count) start = 0;

  const out: Frontage[] = [];
  let run: Point[] = [];
  let road = -1;
  const flush = (): void => {
    if (road >= 0 && run.length >= MIN_RUN_SAMPLES) out.push({ points: run, length: lengthOf(run), road });
    run = [];
  };
  for (let i = 0; i < count; i++) {
    const at = (start + i) % count;
    const edge = along[at] as number;
    if (edge !== road) {
      flush();
      road = edge;
    }
    run.push(samples[at] as Point);
  }
  flush();
  return out;
}

/** A ring walked at a fixed step, starting at its first corner. */
function sampleRing(ring: readonly Point[], step: number): Point[] {
  const out: Point[] = [];
  let since = step;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    let at = 0;
    while (since + (span - at) >= step) {
      at += step - since;
      since = 0;
      const t = span > 0 ? at / span : 0;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    since += span - at;
  }
  return out;
}

/** Metres along a line. */
function lengthOf(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** The point a given distance along a line. Past its end is its end. */
function pointAlong(points: readonly Point[], distance: number): Point {
  let left = Math.max(0, distance);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= span || i + 2 === points.length) {
      const t = span > 0 ? Math.min(1, left / span) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= span;
  }
  return points[points.length - 1] as Point;
}

/**
 * True when a convex ring stands wholly inside a region. Every corner is in the
 * region and no side of the ring crosses a side of it, which together leave the
 * ring nowhere to go but inside.
 */
function insideRegion(ring: readonly Point[], region: Region): boolean {
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

/** True when a lot stands too close to one already laid on the same parcel. */
function overlapsAny(ring: readonly Point[], placed: readonly Lot[]): boolean {
  for (const lot of placed) if (!separates(ring, lot.corners) && !separates(lot.corners, ring)) return true;
  return false;
}

/**
 * True when some side of the first ring has the whole of the second at least
 * {@link LOT_CLEARANCE} beyond it. Separating axis: two convex shapes stand
 * apart exactly when a side of one of them has all of the other outside it.
 * Asking for daylight rather than for nothing shared is what keeps two lots
 * from meeting along an edge.
 */
function separates(ring: readonly Point[], other: readonly Point[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    if (span === 0) continue;
    let apart = true;
    for (const p of other) {
      // The rings are wound anticlockwise, so their own ground is to the left.
      const distance = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / span;
      if (distance > -LOT_CLEARANCE) {
        apart = false;
        break;
      }
    }
    if (apart) return true;
  }
  return false;
}

/** The squared distance from a point to a line. */
function distanceSquaredToLine(p: Point, points: readonly Point[]): number {
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
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = p.x - (a.x + vx * t);
  const dy = p.y - (a.y + vy * t);
  return dx * dx + dy * dy;
}

/**
 * What stands on one lot, or nothing where the lot is too small for anything
 * its zone builds.
 *
 * The roll is over the zone's own table, so a kind the zone does not build is
 * never reached. A dense district builds taller and a rich one builds dearer:
 * both move the weights rather than the table. The lot then has the last word —
 * a kind that does not fit steps down the table until one does.
 */
function kindFor(zone: Zone, district: District, area: number, rng: Rng): BuildingKind | undefined {
  const table = ZONE_BUILDINGS[zone];
  const weights = table.map((entry) => entry.weight * demandFor(entry.kind, district));
  let total = 0;
  for (const weight of weights) total += weight;
  let roll = rng.float() * total;
  let picked = 0;
  for (let i = 0; i < weights.length; i++) {
    picked = i;
    roll -= weights[i] as number;
    if (roll < 0) break;
  }
  // Down the table from the kind that was rolled: the list runs densest first,
  // so the next entry is the next smaller thing the zone builds.
  for (let i = picked; i < table.length; i++) {
    const kind = (table[i] as { kind: BuildingKind }).kind;
    if (area >= MIN_LOT_AREA[kind]) return kind;
  }
  return undefined;
}

/** How much more or less of a kind a district wants than the zone's own share. */
function demandFor(kind: BuildingKind, district: District): number {
  switch (kind) {
    // Height follows the crowd, and a tower goes up where the money is.
    case 'tower':
      return 1 + 0.8 * (district.density - 0.5) + 0.6 * (district.wealth - 0.5);
    case 'mid-rise':
      return 1 + 0.4 * (district.density - 0.5);
    // A poor, busy district is where the strip of shops is.
    case 'shop-row':
      return 1 + 0.4 * (district.density - 0.5) - 0.3 * (district.wealth - 0.5);
    case 'house':
      return 1 - 0.4 * (district.density - 0.5);
    default:
      return 1;
  }
}
