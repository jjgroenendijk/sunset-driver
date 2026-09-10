/**
 * The parcels (spec section 6.4, steps 3 to 5).
 *
 * The land is the polygon `land.ts` traces off the heightfield, so the sea, the
 * river and the harbour are already out of it. Subtracting the road footprint
 * from that land leaves the ground no road owns, and those pieces are the
 * parcels. Nothing is nudged apart afterwards: the subtraction is what makes
 * overlap unrepresentable, and the sweep only confirms it.
 *
 * A piece the roads leave can still be far bigger than a city block — the ground
 * inside a ring of arterials before the streets fill it in, or the open country
 * past the last dirt road. Such a piece is cut in two along the tensor field's
 * minor direction, across the way the roads there run, and again until each
 * piece is about the size its zone builds in.
 *
 * Every parcel is then owned by exactly one thing (spec section 6.4, step 4).
 * The owner comes from the zone the parcel stands in, the density and wealth of
 * its district, and how much ground it has. Three of the eight owners the spec
 * names are not handed out yet:
 *
 * - `beach` waits for the beach rules of spec section 7.3; coastal parcels are
 *   ground cover until then.
 * - `water` waits for a body of water inside the land rather than around it;
 *   the sea, the river and the harbour are subtracted, not parcelled.
 * - `under-structure` is the ground beneath an elevated deck, and that ground is
 *   claimed by the deck's own corridor (spec section 6.3), so it is part of the
 *   footprint rather than of the land the parcels are cut from.
 *
 * Built on demand from the world description like the road graph and the
 * footprint, not stored in it. Pure: the same world gives the same parcels, in
 * the same order, with the same owners.
 */
import { areaOf, difference, regionArea, regionOf, split, type Point, type Region } from '../core/geom.ts';
import { genRng, Subsystem } from '../core/rng.ts';
import { compareNumbers } from '../core/sort.ts';
import { districtAt, layoutZones, zoneAt, type ZoneLayout } from './districts.ts';
import type { RoadFootprint } from './footprint.ts';
import type { RoadEdge, RoadGraph } from './graph.ts';
import { Heightfield } from './heightfield.ts';
import { landRegions } from './land.ts';
import type { TensorField } from './tensor.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { District, RoadCurve, WorldDescription, Zone } from './types.ts';

/** What owns a parcel (spec section 6.4, step 4). Exactly one of these owns each. */
export type ParcelOwner =
  | 'building'
  | 'park'
  | 'car-park'
  | 'plaza'
  | 'under-structure'
  | 'beach'
  | 'water'
  | 'ground';

/** One piece of ground, owned by exactly one thing. */
export interface Parcel {
  id: number;
  /** The ground it owns. No other parcel, road or corridor stands on any of it. */
  region: Region;
  /** Square metres of that ground. */
  area: number;
  /**
   * The centre of that ground, which is what its district and its zone are read
   * at, and which chunk it belongs to (spec section 9.1). The centre of a parcel
   * bent round a corner can fall just outside it.
   */
  at: Point;
  owner: ParcelOwner;
  /** Id of the district the parcel stands in. */
  district: number;
  /** The zone ring it stands in, which is what its size and its owner come from. */
  zone: Zone;
  /**
   * The road graph edges that run along it, ascending. One of each two-way
   * pair, so an edge here reaches its other direction through `twin`. Never
   * empty: ground no road reaches is not a parcel.
   */
  roads: number[];
}

/** The parcels of a world. */
export interface ParcelMap {
  parcels: Parcel[];
  /** Square metres the parcels cover together. */
  area: number;
  /**
   * Square metres of dry land they were cut from. What is neither parcel nor
   * footprint is land no road reaches.
   */
  land: number;
}

/** Square metres below which a piece of the subtraction is a sliver of rounding, not a parcel. */
const MIN_PARCEL_AREA = 20;
/** Square metres above which a parcel is too much open ground to pave as a square. */
const PLAZA_MAX_AREA = 3000;
/** How many times a parcel may be cut in two before it is kept at whatever size it is. */
const MAX_CUTS = 6;
/**
 * How much of a parcel's boundary has to run along a road before the roads
 * count as enclosing it. A city block is enclosed on every side; the hillside
 * past the last dirt road is bounded by the shore and by nothing.
 */
const MIN_ENCLOSED = 0.6;
/** Metres past the ground a road claims that a parcel still counts as running along it. */
const ROAD_REACH = 2;
/** Metres between the points of a parcel's boundary that are asked which roads run along them. */
const EDGE_STEP = 8;
/** Metres of one bucket of the road index. Small enough that a bucket holds a handful of segments. */
const REACH_CELL = 48;
/**
 * Metres between the corners of the rectangle a cut clips with. The boolean
 * engine files an edge by the box around it, so one long diagonal side would
 * land in every bucket of a square kilometres across and cost more than the
 * parcel it cuts. Short steps keep each side in the buckets it really crosses.
 */
const CLIP_STEP = 16;

/**
 * What a zone does with the ground its roads leave. The chances are what a
 * parcel of the zone gets before the density and the wealth of its district
 * move them; whatever is left over is ground cover.
 */
interface ZoneOwnership {
  /**
   * Square metres above which a parcel is cut in two. About twice the block the
   * zone's own street spacing cuts, so a block the streets already made is kept
   * whole and a stretch they never reached is broken up.
   */
  maxArea: number;
  /** Square metres a building group needs; a smaller parcel is left as ground cover. */
  minBuilt: number;
  park: number;
  carPark: number;
  plaza: number;
  build: number;
}

const OWNERSHIP: Record<Zone, ZoneOwnership> = {
  // Downtown: towers on nearly every block, a paved square where the money is.
  core: { maxArea: 8_000, minBuilt: 120, park: 0.05, carPark: 0.08, plaza: 0.1, build: 0.74 },
  inner: { maxArea: 12_000, minBuilt: 120, park: 0.08, carPark: 0.08, plaza: 0.05, build: 0.76 },
  // Sheds and yards: the open ground is parked on rather than planted.
  industrial: { maxArea: 24_000, minBuilt: 300, park: 0.02, carPark: 0.16, plaza: 0.01, build: 0.78 },
  suburban: { maxArea: 20_000, minBuilt: 150, park: 0.12, carPark: 0.04, plaza: 0.02, build: 0.78 },
  outskirts: { maxArea: 90_000, minBuilt: 300, park: 0.1, carPark: 0.03, plaza: 0.01, build: 0.4 },
  // Open country: almost everything stays as it is.
  wilderness: { maxArea: 250_000, minBuilt: 1500, park: 0.12, carPark: 0.01, plaza: 0, build: 0.05 },
};

/**
 * Cut the land a world's roads leave into parcels. The footprint and the graph
 * are passed in because a caller that already has them should not pay for them
 * twice; the tensor field is the one the roads were traced from, and says which
 * way an oversized parcel is cut.
 */
export function buildParcels(
  world: WorldDescription,
  footprint: RoadFootprint,
  graph: RoadGraph,
  field: TensorField,
): ParcelMap {
  const land = landRegions(new Heightfield(world.terrain), world.water.seaLevel);
  const zones = layoutZones(world.size, world.core, world.water);
  const reach = new RoadReach(world.roads, graph);
  const pieces: Piece[] = [];
  for (const region of difference(land, footprint.regions)) {
    cutToSize(region, zones, field, reach, pieces, 0);
  }

  const parcels: Parcel[] = [];
  let area = 0;
  for (const piece of pieces) {
    const zone = zoneAt(zones, piece.at.x, piece.at.y);
    const district = districtAt(world.districts, zones, piece.at.x, piece.at.y);
    const id = parcels.length;
    parcels.push({
      id,
      region: piece.region,
      area: piece.area,
      at: piece.at,
      owner: ownerFor(world.seed, id, district, zone, piece.area),
      district: district.id,
      zone,
      roads: piece.roads,
    });
    area += piece.area;
  }
  return { parcels, area, land: areaOf(land) };
}

/** A parcel before it is given an owner: its ground, its centre and the roads along it. */
interface Piece {
  region: Region;
  area: number;
  /** The centre of that ground, which says which district and zone it is in. */
  at: Point;
  roads: number[];
}

/**
 * Cut a parcel down to the size its zone builds in, then cut the halves the
 * same way. The cut runs along the field's minor direction, across the way the
 * roads there run, so a long block is shortened rather than split down its
 * length.
 *
 * Only a block the roads enclose is cut. Open country the network merely
 * borders — the hillside past the last dirt road, the far end of an island — is
 * left whole, because a cut across it would leave pieces in the middle that no
 * road reaches. Ground no road reaches at all is dropped for the same reason:
 * nothing can be driven to it, so nothing is placed on it.
 */
function cutToSize(
  region: Region,
  zones: ZoneLayout,
  field: TensorField,
  reach: RoadReach,
  out: Piece[],
  cuts: number,
): void {
  const area = regionArea(region);
  if (area < MIN_PARCEL_AREA) return;
  const along = reach.along(region);
  if (along.roads.length === 0) return;
  const at = centroid(region);
  const piece: Piece = { region, area, at, roads: along.roads };
  // Whether the roads enclose this ground is asked of the piece they left, not
  // of the halves a cut makes: a cut adds a side that is not a road, and asking
  // again would stop the cutting halfway down a block.
  const enclosed = cuts > 0 || along.enclosed >= MIN_ENCLOSED;
  if (!enclosed || cuts >= MAX_CUTS || area <= OWNERSHIP[zoneAt(zones, at.x, at.y)].maxArea) {
    out.push(piece);
    return;
  }
  const halves = cutInTwo(region, at, field.sample(at.x, at.y).minor);
  // A cut that leaves everything on one side has cut nothing.
  if (halves.length < 2) {
    out.push(piece);
    return;
  }
  for (const half of halves) cutToSize(half, zones, field, reach, out, cuts + 1);
}

/**
 * A region cut by the line through a point at an angle. The clip is a rectangle
 * covering everything on one side of that line and reaching past the region;
 * splitting by it gives the ground each side of the line in one pass, so both
 * sides are bounded by the same edges and neither overlaps the other. A side
 * the line leaves empty simply gives no pieces.
 */
function cutInTwo(region: Region, at: Point, angle: number): Region[] {
  const reach = radiusAround(region.outer, at) + 1;
  const dx = Math.cos(angle) * reach;
  const dy = Math.sin(angle) * reach;
  const corners: Point[] = [
    { x: at.x - dx, y: at.y - dy },
    { x: at.x + dx, y: at.y + dy },
    { x: at.x + dx - dy, y: at.y + dy + dx },
    { x: at.x - dx - dy, y: at.y - dy + dx },
  ];
  const halves = split([region], [regionOf(stepped(corners))]);
  return [...halves.inside, ...halves.outside];
}

/** A ring with every side laid in steps of at most {@link CLIP_STEP} metres. */
function stepped(corners: readonly Point[]): Point[] {
  const ring: Point[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i] as Point;
    const b = corners[(i + 1) % corners.length] as Point;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / CLIP_STEP));
    for (let k = 0; k < steps; k++) {
      ring.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
    }
  }
  return ring;
}

/** Who owns one parcel, given its zone, its district and how much ground it has. */
function ownerFor(seed: number, id: number, district: District, zone: Zone, area: number): ParcelOwner {
  const spec = OWNERSHIP[zone];
  // Ground the roads never cut down to a block is open country, whatever the
  // zone ring around it says: it is far too much land to build a group on.
  if (area > spec.maxArea) return 'ground';
  // A dense district keeps less of its ground open; a poor one parks on what is
  // left, and a rich one paves it as a square.
  const park = spec.park * (1.4 - 0.8 * district.density);
  const carPark = spec.carPark * (1.3 - 0.6 * district.wealth);
  const plaza = area <= PLAZA_MAX_AREA ? spec.plaza * (0.5 + district.wealth) : 0;
  const roll = genRng(seed, Subsystem.Parcels, id).float();
  if (roll < park) return 'park';
  if (roll < park + carPark) return 'car-park';
  if (roll < park + carPark + plaza) return 'plaza';
  if (roll < park + carPark + plaza + spec.build && area >= spec.minBuilt) return 'building';
  return 'ground';
}

/** The centre of a region's ground: its outer ring less its holes. */
function centroid(region: Region): Point {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (const ring of ringsOf(region)) {
    const origin = ring[0];
    if (origin === undefined) continue;
    for (let i = 1; i + 1 < ring.length; i++) {
      const a = ring[i] as Point;
      const b = ring[i + 1] as Point;
      const cross = (a.x - origin.x) * (b.y - origin.y) - (b.x - origin.x) * (a.y - origin.y);
      twiceArea += cross;
      x += (cross * (origin.x + a.x + b.x)) / 3;
      y += (cross * (origin.y + a.y + b.y)) / 3;
    }
  }
  const head = region.outer[0] as Point;
  return twiceArea === 0 ? { x: head.x, y: head.y } : { x: x / twiceArea, y: y / twiceArea };
}

/** The outer ring of a region and the rings of its holes, outer first. */
function ringsOf(region: Region): Point[][] {
  const rings: Point[][] = [region.outer];
  for (const hole of region.holes) rings.push(hole);
  return rings;
}

/** How far the farthest corner of a ring stands from a point. */
function radiusAround(ring: readonly Point[], at: Point): number {
  let far = 0;
  for (const p of ring) far = Math.max(far, Math.hypot(p.x - at.x, p.y - at.y));
  return far;
}

/** What the boundary of a piece of ground runs along. */
interface RoadsAlong {
  /** The graph edges that run along it, ascending. One of each two-way pair. */
  roads: number[];
  /** How much of the boundary stands on the ground a road claims, in [0, 1]. */
  enclosed: number;
}

/**
 * Which roads run along a piece of ground.
 *
 * A parcel borders a road when its boundary stands on the edge of the ground
 * that road claims, so the question is which road centrelines pass within their
 * own footprint half-width of a point. Only the runs a road stands on are
 * indexed: a deck or a bore claims no ground, and neither borders a parcel.
 *
 * Segments sit in a uniform grid of buckets by the ground they cover, widened
 * by that half-width, so a query costs a handful of distance tests.
 */
class RoadReach {
  private readonly graph: RoadGraph;
  private readonly ax: number[] = [];
  private readonly ay: number[] = [];
  private readonly bx: number[] = [];
  private readonly by: number[] = [];
  /** The graph edge each segment belongs to, and how far its ground reaches, squared. */
  private readonly edge: number[] = [];
  private readonly reachSquared: number[] = [];
  private readonly buckets = new Map<number, number[]>();
  private readonly minColumn: number;
  private readonly minRow: number;
  private readonly columns: number;
  private readonly rows: number;
  /** Which query last claimed each edge, so one parcel never lists a road twice. */
  private readonly claimed: Int32Array;
  private queries = 0;

  constructor(roads: readonly RoadCurve[], graph: RoadGraph) {
    this.graph = graph;
    this.claimed = new Int32Array(graph.edges.length).fill(-1);
    const offGround = groundMasks(roads);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const edge of graph.edges) {
      // One of a two-way pair is enough; the twin stands on the same ground.
      if (edge.twin >= 0 && edge.twin < edge.id) continue;
      const road = roads[edge.curve] as RoadCurve;
      const off = offGround[edge.curve] as Uint8Array;
      const reach = footprintHalfWidth(edge.tier) + ROAD_REACH;
      for (let i = Math.min(edge.start, edge.end); i < Math.max(edge.start, edge.end); i++) {
        if (off[i] === 1) continue;
        const a = road.points[i] as Point;
        const b = road.points[i + 1] as Point;
        this.ax.push(a.x);
        this.ay.push(a.y);
        this.bx.push(b.x);
        this.by.push(b.y);
        this.edge.push(edge.id);
        this.reachSquared.push(reach * reach);
        minX = Math.min(minX, a.x - reach, b.x - reach);
        minY = Math.min(minY, a.y - reach, b.y - reach);
        maxX = Math.max(maxX, a.x + reach, b.x + reach);
        maxY = Math.max(maxY, a.y + reach, b.y + reach);
      }
    }
    const empty = this.ax.length === 0;
    this.minColumn = empty ? 0 : columnOf(minX);
    this.minRow = empty ? 0 : columnOf(minY);
    this.columns = empty ? 1 : columnOf(maxX) - this.minColumn + 1;
    this.rows = empty ? 1 : columnOf(maxY) - this.minRow + 1;
    for (let s = 0; s < this.ax.length; s++) {
      const reach = Math.sqrt(this.reachSquared[s] as number);
      const loX = columnOf(Math.min(this.ax[s] as number, this.bx[s] as number) - reach);
      const hiX = columnOf(Math.max(this.ax[s] as number, this.bx[s] as number) + reach);
      const loY = columnOf(Math.min(this.ay[s] as number, this.by[s] as number) - reach);
      const hiY = columnOf(Math.max(this.ay[s] as number, this.by[s] as number) + reach);
      for (let cx = loX; cx <= hiX; cx++) {
        for (let cy = loY; cy <= hiY; cy++) {
          const key = this.keyOf(cx, cy);
          const bucket = this.buckets.get(key);
          if (bucket === undefined) this.buckets.set(key, [s]);
          else bucket.push(s);
        }
      }
    }
  }

  /**
   * One bucket as a single number. Every segment stands inside the bounds the
   * index was built with, so its row is in range and no two buckets share a key.
   * A point outside them is clamped onto the edge, where the distance test
   * turns it away.
   */
  private keyOf(column: number, row: number): number {
    const across = Math.max(0, Math.min(this.columns - 1, column - this.minColumn));
    const down = Math.max(0, Math.min(this.rows - 1, row - this.minRow));
    return across * this.rows + down;
  }

  /** What runs along the boundary of a region. */
  along(region: Region): RoadsAlong {
    const query = this.queries++;
    const roads: number[] = [];
    let asked = 0;
    let onRoad = 0;
    for (const ring of ringsOf(region)) {
      // Every {@link EDGE_STEP} metres round the ring, wherever its corners fall.
      let since = EDGE_STEP;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i] as Point;
        const b = ring[(i + 1) % ring.length] as Point;
        const span = Math.hypot(b.x - a.x, b.y - a.y);
        let at = 0;
        while (since + (span - at) >= EDGE_STEP) {
          at += EDGE_STEP - since;
          since = 0;
          const t = span > 0 ? at / span : 0;
          asked++;
          if (this.gather(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, query, roads)) onRoad++;
        }
        since += span - at;
      }
    }
    roads.sort(compareNumbers);
    return { roads, enclosed: asked === 0 ? 0 : onRoad / asked };
  }

  /**
   * Add the edges whose ground covers one point to `roads`, and say whether any
   * did. An edge already found for this query is not listed twice, but the
   * point still counts as standing on a road.
   */
  private gather(x: number, y: number, query: number, roads: number[]): boolean {
    let hit = false;
    for (const s of this.buckets.get(this.keyOf(columnOf(x), columnOf(y))) ?? []) {
      if (distanceSquaredToSegment(x, y, this.ax[s] as number, this.ay[s] as number, this.bx[s] as number, this.by[s] as number) > (this.reachSquared[s] as number)) {
        continue;
      }
      hit = true;
      const edge = this.edge[s] as number;
      if (this.claimed[edge] === query) continue;
      this.claimed[edge] = query;
      roads.push(this.pairOf(edge));
    }
    return hit;
  }

  /** The lower of a two-way pair, so both directions of a road name one edge. */
  private pairOf(edge: number): number {
    const twin = (this.graph.edges[edge] as RoadEdge).twin;
    return twin >= 0 && twin < edge ? twin : edge;
  }
}

/** Which column or row of the road index a coordinate falls in. */
function columnOf(v: number): number {
  return Math.floor(v / REACH_CELL);
}

/** One mask per curve: 1 where the segment stands off the ground, on a deck or in a bore. */
function groundMasks(roads: readonly RoadCurve[]): Uint8Array[] {
  const masks: Uint8Array[] = [];
  for (const road of roads) {
    const mask = new Uint8Array(Math.max(0, road.points.length - 1));
    for (const i of road.bridges) if (i >= 0 && i < mask.length) mask[i] = 1;
    for (const i of road.tunnels) if (i >= 0 && i < mask.length) mask[i] = 1;
    masks.push(mask);
  }
  return masks;
}

function distanceSquaredToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const lengthSquared = vx * vx + vy * vy;
  let t = lengthSquared > 0 ? ((px - ax) * vx + (py - ay) * vy) / lengthSquared : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return dx * dx + dy * dy;
}
