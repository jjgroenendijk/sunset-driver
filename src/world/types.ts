/**
 * The plain, serialisable world description. Generated headless; rendering,
 * physics and gameplay read it and never mutate it.
 */

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

export interface Point {
  x: number;
  y: number;
}

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

export interface WorldDescription {
  seed: number;
  /** Side length in metres; the map is square and centred on the origin. */
  size: number;
  core: Point;
  terrain: HeightfieldData;
  water: WaterDescription;
  districts: District[];
  roads: RoadCurve[];
}

/** The world before its roads: what the tensor field and the road tracer read. */
export type WorldSkeleton = Omit<WorldDescription, 'roads'>;
