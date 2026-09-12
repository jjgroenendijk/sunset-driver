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
 * The sand of a beach (spec section 7.3) is cut out before any of that. The
 * beaches were planned on the bare terrain, so a strip of sand is split off the
 * land the roads left and kept whole: it is already the width its dune line
 * gives it, and the boardwalk behind it is the road that reaches it. Because the
 * split happens after the footprint is subtracted, a beach parcel can no more
 * stand on a road than any other parcel can.
 *
 * Every parcel is then owned by exactly one thing (spec section 6.4, step 4).
 * The owner comes from the zone the parcel stands in, the density and wealth of
 * its district, and how much ground it has. Two of the eight owners the spec
 * names are not handed out yet:
 *
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
import { areaOf, difference, pointInRegion, regionArea, regionOf, split, type Point, type Region } from '../core/geom.ts';
import { genRng, Subsystem } from '../core/rng.ts';
import { compareNumbers } from '../core/sort.ts';
import { districtAt, layoutZones, zoneAt, type ZoneLayout } from './districts.ts';
import type { RoadFootprint } from './footprint.ts';
import type { RoadEdge, RoadGraph } from './graph.ts';
import { Heightfield } from './heightfield.ts';
import { landRegions } from './land.ts';
import type { TensorField } from './tensor.ts';
import { footprintHalfWidth } from './tiers.ts';
import type { Beach, District, RoadCurve, WorldDescription, Zone } from './types.ts';

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

/**
 * Where every parcel is, so a point on the ground can be asked which one it
 * stands on. Parcels never overlap (spec section 1.1), so at most one answers.
 *
 * A parcel is filed in every bucket the box around it touches. The open ground
 * of the wilderness is one parcel the size of an island and lands in thousands
 * of them, which costs a little memory and saves the scan it would otherwise
 * force on every lookup.
 */
export class ParcelIndex {
  private readonly parcels: readonly Parcel[];
  private readonly boxes: ParcelBox[];
  private readonly buckets: number[][];
  private readonly cols: number;
  private readonly rows: number;
  private readonly minX: number;
  private readonly minY: number;

  constructor(parcels: readonly Parcel[]) {
    this.parcels = parcels;
    this.boxes = parcels.map((parcel) => boxOf(parcel.region.outer));
    const bounds: ParcelBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const box of this.boxes) {
      bounds.minX = Math.min(bounds.minX, box.minX);
      bounds.minY = Math.min(bounds.minY, box.minY);
      bounds.maxX = Math.max(bounds.maxX, box.maxX);
      bounds.maxY = Math.max(bounds.maxY, box.maxY);
    }
    const empty = this.boxes.length === 0;
    this.minX = empty ? 0 : bounds.minX;
    this.minY = empty ? 0 : bounds.minY;
    this.cols = empty ? 0 : Math.floor((bounds.maxX - this.minX) / INDEX_CELL) + 1;
    this.rows = empty ? 0 : Math.floor((bounds.maxY - this.minY) / INDEX_CELL) + 1;
    this.buckets = [];
    for (let i = 0; i < this.cols * this.rows; i++) this.buckets.push([]);
    for (let i = 0; i < this.boxes.length; i++) {
      const box = this.boxes[i] as ParcelBox;
      const c1 = this.colOf(box.maxX);
      const r1 = this.rowOf(box.maxY);
      for (let r = this.rowOf(box.minY); r <= r1; r++) {
        for (let c = this.colOf(box.minX); c <= c1; c++) (this.buckets[r * this.cols + c] as number[]).push(i);
      }
    }
  }

  /** The parcel a point stands on, or nothing where the ground belongs to a road or to no one. */
  at(x: number, y: number): Parcel | undefined {
    const c = this.colOf(x);
    const r = this.rowOf(y);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return undefined;
    const p: Point = { x, y };
    for (const i of this.buckets[r * this.cols + c] as number[]) {
      const box = this.boxes[i] as ParcelBox;
      if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
      const parcel = this.parcels[i] as Parcel;
      if (pointInRegion(p, parcel.region)) return parcel;
    }
    return undefined;
  }

  /** Bucket column of a place, which is outside the index where it is out of range. */
  private colOf(x: number): number {
    return Math.floor((x - this.minX) / INDEX_CELL);
  }

  private rowOf(y: number): number {
    return Math.floor((y - this.minY) / INDEX_CELL);
  }
}

/** The box around a parcel, as {@link ParcelIndex} files them. */
interface ParcelBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Metres each way of one bucket of the parcel index. About one city block. */
const INDEX_CELL = 50;

/** The box around a set of points. */
function boxOf(points: readonly Point[]): ParcelBox {
  const box: ParcelBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of points) {
    box.minX = Math.min(box.minX, p.x);
    box.minY = Math.min(box.minY, p.y);
    box.maxX = Math.max(box.maxX, p.x);
    box.maxY = Math.max(box.maxY, p.y);
  }
  return box;
}

/** Square metres below which a piece of the subtraction is a sliver of rounding, not a parcel. */
const MIN_PARCEL_AREA = 20;
/** Square metres above which a parcel is too much open ground to pave as a square, in any zone. */
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
  /**
   * Square metres the largest park and the largest car park of the zone may
   * cover. A parcel the roll would have given to one of them, but too big for
   * it, stays ground cover: a car park is the size of a car park in every
   * zone, however much ground the roads there leave.
   */
  maxPark: number;
  maxCarPark: number;
  park: number;
  carPark: number;
  plaza: number;
  build: number;
}

const OWNERSHIP: Record<Zone, ZoneOwnership> = {
  // Downtown: towers on nearly every block, a paved square where the money is,
  // a multi-storey car park on a block at most.
  core: { maxArea: 8_000, minBuilt: 120, maxPark: 8_000, maxCarPark: 3_000, park: 0.05, carPark: 0.08, plaza: 0.1, build: 0.74 },
  inner: { maxArea: 12_000, minBuilt: 120, maxPark: 12_000, maxCarPark: 4_000, park: 0.08, carPark: 0.08, plaza: 0.05, build: 0.76 },
  // Sheds and yards: the open ground is parked on rather than planted, and a
  // lorry yard is the biggest car park there is.
  industrial: { maxArea: 24_000, minBuilt: 300, maxPark: 12_000, maxCarPark: 12_000, park: 0.02, carPark: 0.16, plaza: 0.01, build: 0.78 },
  // A supermarket's car park, and a park the size of a few blocks.
  suburban: { maxArea: 20_000, minBuilt: 150, maxPark: 20_000, maxCarPark: 6_000, park: 0.12, carPark: 0.04, plaza: 0.02, build: 0.78 },
  outskirts: { maxArea: 90_000, minBuilt: 300, maxPark: 60_000, maxCarPark: 8_000, park: 0.1, carPark: 0.03, plaza: 0.01, build: 0.4 },
  // Open country: almost everything stays as it is. A park here is a reserve
  // and may be as large as the roads leave it; a car park is a trailhead.
  wilderness: { maxArea: 250_000, minBuilt: 1500, maxPark: 250_000, maxCarPark: 6_000, park: 0.12, carPark: 0.01, plaza: 0, build: 0.05 },
};

/**
 * The most ground one owner may hold in a zone, or nothing where the owner has
 * no ceiling there: a building group takes any block up to the zone's
 * `maxArea`, and the beach, the water and the ground are whatever size they
 * come. The sweep reads this to pin what `ownerFor` hands out.
 */
export function ownerMaxArea(zone: Zone, owner: ParcelOwner): number | undefined {
  const spec = OWNERSHIP[zone];
  if (owner === 'park') return spec.maxPark;
  if (owner === 'car-park') return spec.maxCarPark;
  if (owner === 'plaza') return PLAZA_MAX_AREA;
  if (owner === 'building') return spec.maxArea;
  return undefined;
}

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
  const free = difference(land, footprint.regions);
  // The sand first, so the ground behind it is parcelled without it.
  const sand = world.beaches.map((beach) => regionOf(beach.sand));
  const shore = sand.length === 0 ? { inside: [], outside: free } : split(free, sand);
  const pieces: Piece[] = [];
  for (const region of shore.inside) {
    // A strip of sand is kept whole: the roads bound it on one side only, so
    // cutting it would leave pieces the sea surrounds on every side but one.
    const piece = pieceOf(region, reach);
    if (piece !== undefined) pieces.push({ ...piece, owner: 'beach' });
  }
  for (const region of shore.outside) cutToSize(region, zones, field, reach, pieces, 0);
  markCarParks(pieces, world.beaches, reach);

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
      owner: piece.owner ?? ownerFor(world.seed, id, district, zone, piece.area),
      district: district.id,
      zone,
      roads: piece.roads,
    });
    area += piece.area;
  }
  return { parcels, area, land: areaOf(land) };
}

/**
 * Cut the beach car parks of spec section 7.3 out of the ground behind their
 * boardwalk. A car park is a small rectangle and the piece it lands in can be a
 * whole headland, so it is cut out rather than allowed to own what it stands
 * in. A resort has two of them, so the world holds a handful.
 *
 * A car park no road runs along is not a parcel, and the ground it would have
 * taken stays with the piece it came out of.
 */
function markCarParks(pieces: Piece[], beaches: readonly Beach[], reach: RoadReach): void {
  for (const beach of beaches) {
    for (const park of beach.carParks) {
      const at = middleOf(park);
      const host = pieces.findIndex((piece) => piece.owner === undefined && pointInRegion(at, piece.region));
      if (host < 0) continue;
      const halves = split([(pieces[host] as Piece).region], [regionOf(park)]);
      const cut: Piece[] = [];
      for (const region of halves.inside) {
        const piece = pieceOf(region, reach);
        if (piece !== undefined) cut.push({ ...piece, owner: 'car-park' });
      }
      if (cut.length === 0) continue;
      for (const region of halves.outside) {
        const piece = pieceOf(region, reach);
        if (piece !== undefined) cut.push(piece);
      }
      pieces.splice(host, 1, ...cut);
    }
  }
}

/** The middle of a ring's corners. */
function middleOf(ring: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / ring.length, y: y / ring.length };
}

/** A parcel before it is given an owner: its ground, its centre and the roads along it. */
interface Piece {
  region: Region;
  area: number;
  /** The centre of that ground, which says which district and zone it is in. */
  at: Point;
  roads: number[];
  /** How much of its boundary runs along a road, in [0, 1]. Read while cutting. */
  enclosed: number;
  /** An owner the ground itself forces, whatever the zone would have rolled. */
  owner?: ParcelOwner;
}

/**
 * One piece of ground as a parcel, or nothing where it is a sliver of rounding
 * or ground no road reaches. Nothing is placed on ground nothing can drive to.
 */
function pieceOf(region: Region, reach: RoadReach): Piece | undefined {
  const area = regionArea(region);
  if (area < MIN_PARCEL_AREA) return undefined;
  const along = reach.along(region);
  if (along.roads.length === 0) return undefined;
  return { region, area, at: centroid(region), roads: along.roads, enclosed: along.enclosed };
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
  const piece = pieceOf(region, reach);
  if (piece === undefined) return;
  const at = piece.at;
  // Whether the roads enclose this ground is asked of the piece they left, not
  // of the halves a cut makes: a cut adds a side that is not a road, and asking
  // again would stop the cutting halfway down a block.
  const enclosed = cuts > 0 || piece.enclosed >= MIN_ENCLOSED;
  if (!enclosed || cuts >= MAX_CUTS || piece.area <= OWNERSHIP[zoneAt(zones, at.x, at.y)].maxArea) {
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
  const halves = split([region], [regionOf(corners)]);
  return [...halves.inside, ...halves.outside];
}

/** Who owns one parcel, given its zone, its district and how much ground it has. */
function ownerFor(seed: number, id: number, district: District, zone: Zone, area: number): ParcelOwner {
  const spec = OWNERSHIP[zone];
  // Ground the roads never cut down to a block is open country, whatever the
  // zone ring around it says: it is far too much land to build a group on.
  if (area > spec.maxArea) return 'ground';
  // A dense district keeps less of its ground open; a poor one parks on what is
  // left, and a rich one paves it as a square. Each owner has a size it comes
  // in: a parcel the roll gives to an owner too small for it stays ground
  // cover rather than becoming a car park of twenty hectares.
  const park = spec.park * (1.4 - 0.8 * district.density);
  const carPark = spec.carPark * (1.3 - 0.6 * district.wealth);
  const plaza = spec.plaza * (0.5 + district.wealth);
  const roll = genRng(seed, Subsystem.Parcels, id).float();
  if (roll < park) return area <= spec.maxPark ? 'park' : 'ground';
  if (roll < park + carPark) return area <= spec.maxCarPark ? 'car-park' : 'ground';
  if (roll < park + carPark + plaza) return area <= PLAZA_MAX_AREA ? 'plaza' : 'ground';
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
