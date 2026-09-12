/**
 * Where the buildings stand (spec section 10.3, selection by spec section 8.2).
 *
 * A parcel the zone gave to a building group (`parcels.ts`) is the ground one
 * row of buildings shares, not one building. This file is the door onto that
 * cut: `lots.ts` divides the parcel's frontage into lots and this says what
 * stands on each of them.
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
import type { Point } from '../core/geom.ts';
import { genRng, Rng, Subsystem } from '../core/rng.ts';
import type { RoadGraph } from './graph.ts';
import { lotsOf, type Shared } from './lots.ts';
import type { ParcelMap } from './parcels.ts';
import type { District, WorldDescription, Zone } from './types.ts';

// The lots are cut in `lots.ts`; this is the door callers already import.
export { FRONT_REACH, LOT_CLEARANCE, ZONE_LOTS, type Lot, type LotSpec, type Shared } from './lots.ts';

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
   * first, then the two at the back. It stands wholly inside the parcel. The
   * side edges lean where the frontage bends, so it is a quadrilateral and not
   * always a rectangle.
   */
  lot: Point[];
  /** Square metres of the lot. */
  area: number;
  /**
   * Metres across the lot: the shorter of its front and back edges, which is
   * the widest building that stands inside it. See `lots.ts`.
   */
  width: number;
  /** Metres from the front edge to the back of the lot. */
  depth: number;
  /** The middle of the front edge. */
  front: Point;
  /** Which way the front faces, in radians: from the lot towards its road. */
  facing: number;
  /**
   * Which of the lot's two side edges carry a neighbour's wall: the edge at the
   * first corner of the front edge, and the edge at the second. Where a zone
   * builds a street wall the two lots at a boundary take the same edge, so the
   * building may reach it; every other edge keeps its margin. See `lots.ts`.
   */
  shared: Shared;
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
        shared: lot.shared,
        district: parcel.district,
        zone: parcel.zone,
      });
      area += lot.area;
    }
  }
  return { buildings, area };
}

/**
 * The middle of a lot: where the building on it stands, and the one place that
 * says which chunk owns it. A lot is a quadrilateral, so this is the middle of
 * its corners.
 */
export function lotMiddle(lot: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const corner of lot) {
    x += corner.x;
    y += corner.y;
  }
  return { x: x / lot.length, y: y / lot.length };
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
