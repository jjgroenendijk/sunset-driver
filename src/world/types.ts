/**
 * The plain, serialisable world description. Generated headless; rendering,
 * physics and gameplay read it and never mutate it.
 */

import type { Point as GeomPoint } from '../core/geom.ts';

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

export interface Island {
  id: number;
  x: number;
  y: number;
  /** Nominal radius; the coastline wanders around it. */
  radius: number;
  /** True for the island that carries the core. */
  main: boolean;
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
  river: RiverDescription;
  harbour: { x: number; y: number; radius: number };
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
   * Indices of the segments carried on a deck: segment `i` runs from
   * `points[i]` to `points[i + 1]`. Ascending. A deck spans a strait crossing
   * or a dip the road may not follow down.
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
}

/** Where a road crosses the tram lane on the flat, so traffic and pedestrians must give way. */
export interface TramLevelCrossing {
  x: number;
  y: number;
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
  core: Point;
  terrain: HeightfieldData;
  water: WaterDescription;
  districts: District[];
  /** The beaches of spec section 7.3, in the order the coastline was walked. */
  beaches: Beach[];
  roads: RoadCurve[];
  corridors: Corridor[];
  tram: TramDescription;
}

/** The world before its roads: what the tensor field and the road tracer read. */
export type WorldSkeleton = Omit<WorldDescription, 'roads' | 'corridors' | 'tram'>;
