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

export interface WorldDescription {
  seed: number;
  /** Side length in metres; the map is square and centred on the origin. */
  size: number;
  core: Point;
  terrain: HeightfieldData;
  water: WaterDescription;
  districts: District[];
}
