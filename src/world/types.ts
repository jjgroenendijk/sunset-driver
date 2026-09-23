/**
 * The plain, serialisable world description. Generated headless; rendering,
 * physics and gameplay read it and never mutate it.
 */

import type { Point as GeomPoint } from '../core/geom.ts';
import type { ArchetypeName } from './archetype.ts';

export type Zone = 'core' | 'inner' | 'industrial' | 'suburban' | 'outskirts' | 'wilderness';

export type Culture =
  | 'none'
  | 'italian'
  | 'chinese'
  | 'east-european'
  | 'latin'
  | 'african-american'
  | 'outlaw'
  | 'irish'
  | 'beach';

export interface District {
  id: number;
  name: string;
  zone: Zone;
  /** Site of the district's Voronoi cell. */
  x: number;
  y: number;
  /** 0..1 */
  density: number;
  /** 0..1 */
  wealth: number;
  culture: Culture;
}

export interface HeightfieldData {
  /** Samples per side (gridSize × gridSize). */
  gridSize: number;
  /** Metres between samples. */
  cellSize: number;
  /** World coordinate of sample (0, 0). */
  originX: number;
  originY: number;
  heights: Float32Array;
}

/** A place on the map. Polygon arithmetic reads the same type (`src/core/geom.ts`). */
export type Point = GeomPoint;

export interface RiverDescription {
  /** Centreline from source to mouth. */
  path: Point[];
  /** Half-width at each path point. */
  halfWidths: number[];
}

/** A weighted site of the power diagram the land is cut from. */
export interface Site {
  x: number;
  y: number;
  /** The weight: a larger radius wins a larger cell. */
  radius: number;
}

export interface Island extends Site {
  id: number;
  /** True for the island that carries the core. */
  main: boolean;
  /**
   * The cells of the power diagram that make up this island, where it is more
   * than one. No channel runs between two cells of one island, so a landmass
   * need not be convex. Absent, the island's own site is its one cell.
   */
  cells?: Site[];
}

/** Where a road should bridge a channel: shore to shore between two islands. */
export interface Crossing {
  fromIsland: number;
  toIsland: number;
  from: Point;
  to: Point;
}

export interface WaterDescription {
  seaLevel: number;
  islands: Island[];
  crossings: Crossing[];
  /** Every river of the map; an archetype may have none. */
  rivers: RiverDescription[];
  harbour: { x: number; y: number; radius: number };
  /**
   * The direction from the core, in radians, the industrial wedge runs along:
   * towards the harbour, turned along the shore where that way is sea.
   */
  industry: number;
}

/** A pier: a deck straight out from a beach over the water (spec section 7.3). */
export interface Pier {
  /** Where the deck leaves the waterline. */
  root: Point;
  /** Its seaward end. */
  head: Point;
  /** The deck, wound anticlockwise. */
  polygon: Point[];
}

/**
 * One beach of spec section 7.3: a run of coastline the ground behind rises
 * slowly from. Planned before the roads, because the boardwalk is a road.
 *
 * The rings here are the beach as the terrain draws it, before any road is
 * traced. The ground a beach actually owns is the parcels of `parcels.ts` the
 * sand covers, so nothing is claimed twice; the boardwalk keeps the roads
 * behind the dune line, and the sweep confirms they stay there.
 */
export interface Beach {
  id: number;
  /** The waterline, in order along the shore with the land on the left. */
  shore: Point[];
  /** The dune line behind the sand: the waterline stepped inland. */
  back: Point[];
  /** Metres of waterline. */
  length: number;
  /** The sand, between the waterline and the dune line, wound anticlockwise. */
  sand: Point[];
  /** The shallow water in front of the waterline, wound anticlockwise. */
  shallows: Point[];
  /**
   * The line a boardwalk street should run along, behind the dune. Empty on a
   * beach too short to carry one; `roads.ts` lays the road on it, and
   * `Beach.boardwalkRoad` says which road that turned out to be.
   */
  boardwalk: Point[];
  /**
   * The road curve that runs along {@link Beach.boardwalk}, or -1 where the
   * ground refused one. Always -1 in the skeleton the tracer reads, since the
   * roads do not exist yet.
   */
  boardwalkRoad: number;
  /** The pier, on a beach long enough to carry one. */
  pier: Pier | undefined;
  /** Beach car parks behind the boardwalk, each wound anticlockwise. */
  carParks: Point[][];
  /** Ids of the districts the waterline runs through, ascending. */
  districts: number[];
}

/** Road hierarchy, widest first (spec section 6.2). */
export type RoadTier = 'highway' | 'arterial' | 'street' | 'alley' | 'dirt';

/**
 * One road as a curve. Carriageway, kerbs, rails and decks are lofted along it;
 * the road graph of spec section 6.5 is built from it.
 */
export interface RoadCurve {
  id: number;
  tier: RoadTier;
  /** Centreline, at least two points. */
  points: Point[];
  /**
   * The node of the road graph each point stands on, or -1 where the point is
   * no node, indexed like `points`. Both ends are always nodes. Two curves meet
   * where they carry the same node, and nowhere else: `road-network.ts` decides
   * it when a road is added, and `graph.ts` reads it (spec section 6.5).
   */
  nodes: number[];
  /**
   * Indices of the segments carried on a deck: segment `i` runs from
   * `points[i]` to `points[i + 1]`. Ascending. A deck spans a strait crossing,
   * a river or a dip the road may not follow down.
   */
  bridges: number[];
  /**
   * Indices of the segments bored through the ground, where a hill stands above
   * the road. Ascending, and never an index that is also a bridge. Every
   * segment in neither list lies on the ground (spec section 6.1).
   */
  tunnels: number[];
  /**
   * Indices of the points another road may join this one at. Ascending. Only a
   * highway has them: spec section 6.2 gives a highway junctions at
   * interchanges and nowhere else, and only a highway or an arterial ramp may
   * use one. The list is empty on every other tier, which takes a junction
   * anywhere along it.
   */
  interchanges: number[];
  /**
   * Indices of the segments a lower road may cross under. Ascending. Only a
   * highway has them: they are the level decks `highway-plan.ts` planned when
   * the highway was laid, and a road laid later crosses a highway there or
   * nowhere (spec section 6.2). Absent on every other tier, which any road may
   * cross.
   */
  slots?: number[];
  /**
   * Metres each point of the curve stands over the natural ground, where the
   * road is carried over something (`overpass.ts`, `highway-plan.ts`). A curve
   * without one drives on the ground everywhere, which is nearly all of them. It is the one thing
   * a curve says about its own height; `bed.ts` adds it to the ground it
   * samples, and every raised segment is in `bridges`.
   */
  lift?: number[];
}

/** What a corridor carries (spec section 6.3). */
export type CorridorKind = 'elevated' | 'tram';

/**
 * A strip of land a road stands off or runs a reserved lane down (spec section
 * 6.3). A corridor takes part in the same footprint subtraction as the roads,
 * so the ground it claims belongs to it and to nothing else.
 */
export interface Corridor {
  id: number;
  kind: CorridorKind;
  /** The road curves the corridor runs along, ascending. */
  roads: number[];
  /** Centreline of the strip, at least two points. */
  points: Point[];
  /** The strip reaches this far each side of the centreline, in metres. */
  halfWidth: number;
  /**
   * The ground the corridor claims: a closed ring wound anticlockwise, with the
   * first point not repeated at the end.
   */
  polygon: Point[];
  /**
   * Feet of the pillars that carry the deck, in pairs across the centreline and
   * always inside {@link Corridor.polygon}. Empty on a tram corridor.
   */
  pillars: Point[];
}

/** A tram stop: where the line calls, and the district it serves. */
export interface TramStop {
  id: number;
  x: number;
  y: number;
  /** Id of the district the stop stands in. */
  district: number;
  /** Index into {@link TramDescription.edges} of the run the tram drives away from the stop on. */
  leaves: number;
}

/** Where a road crosses the tram lane on the flat, so traffic and pedestrians must give way. */
export interface TramLevelCrossing {
  x: number;
  y: number;
  /** The junction of the road graph (`graph.ts`) the crossing stands at. */
  node: number;
  /** The road curves that cross the line here, ascending. */
  roads: number[];
}

/** The tram line of spec section 13.2: one fixed loop through the core and inner districts. */
export interface TramDescription {
  /**
   * The line the tram drives, stop to stop and back to the first, with the last
   * point standing on the first. Empty when the arterials carry no loop.
   */
  route: Point[];
  /**
   * The runs of the road graph (`graph.ts`) the loop drives, in order; the last
   * one ends where the first one starts. The graph is built from the roads on
   * demand, and the same roads give the same ids.
   */
  edges: number[];
  /**
   * The corridors the reserved lane is made of, ascending. Where the loop runs
   * down one street twice the lane is claimed once, so there are fewer of these
   * than there are legs between stops.
   */
  corridors: number[];
  /** The stops, in the order the tram calls at them. */
  stops: TramStop[];
  crossings: TramLevelCrossing[];
  /** Metres around the loop. */
  length: number;
}

export interface WorldDescription {
  seed: number;
  /** Side length in metres; the map is square and centred on the origin. */
  size: number;
  /** The name of the terrain archetype the seed drew (spec section 7.2), for the tools and a bug report. */
  archetype: ArchetypeName;
  core: Point;
  terrain: HeightfieldData;
  water: WaterDescription;
  districts: District[];
  /** The beaches of spec section 7.3, in the order the coastline was walked. */
  beaches: Beach[];
  /**
   * The airfields of spec section 8.4: the airport every seed has, the rural
   * airstrips, the ground helipads and the seaplane dock. Planned before the
   * roads, because the roads keep off them.
   */
  airfields: Airfield[];
  roads: RoadCurve[];
  corridors: Corridor[];
  tram: TramDescription;
}

/** The world before its roads: what the tensor field and the road tracer read. */
export type WorldSkeleton = Omit<WorldDescription, 'roads' | 'corridors' | 'tram'>;

/**
 * The aircraft of spec section 11.3, as the world names them: a stand says
 * which one waits on it. `src/sim/roster.ts` holds what each one is made of.
 */
export type AircraftClass =
  | 'heli-light'
  | 'heli-police'
  | 'heli-transport'
  | 'heli-attack'
  | 'plane-light'
  | 'seaplane'
  | 'biplane'
  | 'bizjet'
  | 'fighter';

/** Every aircraft, in picker order. Nothing else should list them. */
export const AIRCRAFT_CLASSES: readonly AircraftClass[] = [
  'heli-light',
  'heli-police',
  'heli-transport',
  'heli-attack',
  'plane-light',
  'seaplane',
  'biplane',
  'bizjet',
  'fighter',
];

/** What an airfield is (spec section 8.4). */
export type AirfieldKind = 'airport' | 'airstrip' | 'heliport' | 'dock';

/**
 * A piece of an airfield, as a box in the airfield's own frame: `u` runs along
 * the runway's heading and `v` across it, to the left.
 */
export interface AirfieldPart {
  kind:
    | 'runway'
    | 'taxiway'
    | 'apron'
    | 'forecourt'
    | 'pad'
    | 'terminal'
    | 'tower'
    | 'hangar'
    | 'shed'
    | 'fence'
    | 'windsock'
    | 'deck'
    /** The military compound: no surface of its own, only the ground the police guard. */
    | 'compound';
  u: number;
  v: number;
  halfU: number;
  halfV: number;
  /** Metres it stands over the airfield's level: zero for a surface. */
  height: number;
}

/** Where an aircraft waits, on the map. */
export interface AircraftStand {
  cls: AircraftClass;
  x: number;
  y: number;
  heading: number;
  /** The ground or the water it rests on, in metres. */
  height: number;
  /** True inside the fence of the military compound: taking it is a serious crime (spec section 14). */
  military: boolean;
}

/**
 * One airfield: a levelled rectangle of ground the roads and the parcels keep
 * off, with the parts drawn on it and the aircraft that wait there. A dock
 * levels nothing; its rectangle is the water the seaplane is moored on.
 */
export interface Airfield {
  id: number;
  kind: AirfieldKind;
  /** The middle of the rectangle, and the way the runway runs. */
  x: number;
  y: number;
  heading: number;
  /** Half the rectangle along the heading and across it, in metres. */
  halfU: number;
  halfV: number;
  /** The height the ground is levelled to, or the sea level on a dock. */
  level: number;
  /** Where the road that serves it starts, just outside the rectangle. */
  gate: Point;
  /** The road laid from the gate, or -1 where none reached the network. */
  road: number;
  parts: AirfieldPart[];
  stands: AircraftStand[];
}
