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
 * A diamond interchange (spec section 6.2): where a highway exchanges traffic
 * with the arterial carried over it, and the four one-way ramps that do the
 * exchanging.
 *
 * The highway holds its line and stays on the ground here; the arterial is
 * raised over it, so the two share no point. Every turn between them is a ramp:
 * one off and one on for each direction of the highway, laid in the four
 * quadrants of the crossing (`ramps.ts`). An interchange with no ramps is a
 * place a highway may still be joined by another highway, which is what the
 * list meant before the ramps existed.
 */
export interface Interchange {
  /** Index into {@link RoadCurve.points} of the point the interchange stands at. */
  at: number;
  /** The ramp curves, ascending. Empty where no arterial crossed here. */
  ramps: number[];
  /**
   * Indices of the points of this highway the ramps meet it at, ascending. A
   * road other than a ramp may not be joined there: the merge is shallower
   * than a junction can be built at.
   */
  heads: number[];
}

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
   * The interchanges along this road, in the order their points come. Only a
   * highway has them: spec section 6.2 gives a highway junctions at
   * interchanges and nowhere else. The list is empty on every other tier,
   * which takes a junction anywhere along it.
   */
  interchanges: Interchange[];
  /**
   * True where the curve carries traffic one way only, from its first point to
   * its last: the ramp of an interchange. The road graph gives such a curve one
   * edge per run instead of a pair, and that edge's `twin` is -1.
   */
  oneWay?: boolean;
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
  roads: RoadCurve[];
  corridors: Corridor[];
  tram: TramDescription;
}

/** The world before its roads: what the tensor field and the road tracer read. */
export type WorldSkeleton = Omit<WorldDescription, 'roads' | 'corridors' | 'tram'>;
