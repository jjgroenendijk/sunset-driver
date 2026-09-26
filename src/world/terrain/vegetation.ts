/**
 * Where the plants stand (spec section 10.4).
 *
 * Vegetation is scattered content rather than laid-out content: a tree belongs
 * to a place, not to a block, so it is not cut from the map the way a parcel or
 * a lot is. It is drawn from one grid of cells anchored on the origin. A cell
 * carries at most one plant, and where that plant stands, what species it is and
 * whether it stands at all are a pure function of the cell and of the ground
 * under it. Two chunks therefore agree along the edge they share for the same
 * reason the ground does: the answer comes from the place, never from the chunk
 * being built.
 *
 * Nothing ever stands on a road or on a building. A plant is kept only where the
 * whole of its canopy stands inside one parcel, and a parcel is the land the
 * road footprint leaves (spec section 6.4), so the carriageway, the pavement,
 * the apron of a junction and the ground under a deck are all out of reach
 * before a single plant is drawn. The lots of the parcel are then subtracted the
 * same way: a canopy that would reach over a building is dropped, not moved.
 *
 * Two canopies never overlap, by construction rather than by checking: a cell is
 * {@link PLANT_CELL} metres across, a plant stands within {@link PLANT_JITTER}
 * of its middle, and no canopy is wider than {@link MAX_PLANT_RADIUS}, so two
 * plants of neighbouring cells are always at least their two radii apart.
 *
 * Built on demand from the seed, the parcels and the buildings, like the road
 * graph and the parcels themselves; it is not stored in the world description.
 */
import { pointInRegion, type Point, type Region } from '../../core/geom.ts';
import { hashInts } from '../../core/hash.ts';
import { genRng, Rng, Subsystem } from '../../core/rng.ts';
import type { Building, BuildingMap } from '../city/buildings.ts';
import type { Parcel, ParcelMap, ParcelOwner } from '../city/parcels.ts';
import type { Zone } from '../types.ts';

/**
 * What a plant is (spec section 10.4). The renderer builds a model for each.
 *
 * Ten of them, because a wood of one tree repeated reads as wallpaper. The
 * first five are the plants every world has; `columnar`, `blossom`, `dead`,
 * `agave` and `hedge` are the ones that break a stand of them up.
 */
export type PlantSpecies =
  | 'broadleaf'
  | 'conifer'
  | 'palm'
  | 'shrub'
  | 'grass'
  | 'columnar'
  | 'blossom'
  | 'dead'
  | 'agave'
  | 'hedge';

/** One plant, standing on the ground of one parcel. */
export interface Plant {
  /** Id of the parcel it stands on. */
  parcel: number;
  species: PlantSpecies;
  /**
   * The seed of this plant alone. The renderer takes its model, its size and
   * the way it is turned from it, so nothing else is needed to build the same
   * plant twice.
   */
  seed: number;
  /** Where it stands. The ground under it comes from the carve, as a building's does. */
  at: Point;
  /**
   * Metres of canopy around that point. The whole disc stands on the parcel.
   *
   * It is the species' own {@link PLANT_RADIUS} grown by this plant's share of
   * {@link GROWTH}, so a stand of one species holds saplings, ordinary trees
   * and the odd large specimen. The renderer scales its model to fill exactly
   * this much ground, which is what carries the rule through to the frame.
   */
  radius: number;
}

/**
 * Metres each way of one cell of the scatter grid: the pitch of a forest.
 *
 * It is what caps the widest canopy a plant may grow, so a large specimen tree
 * needs room here. The planting chances below are raised to match: a wider cell
 * is fewer cells over the same ground, and a wood has to stay a wood.
 */
export const PLANT_CELL = 9;

/** Metres a plant stands from the middle of its cell, at most. */
export const PLANT_JITTER = 1;

/**
 * Metres of canopy a plant of each species claims when it grows to its ordinary
 * size. One plant claims this much scaled by its own {@link GROWTH}, and the
 * renderer builds its model at exactly this radius, so the scale the frame
 * applies is `plant.radius / PLANT_RADIUS[species]`.
 */
export const PLANT_RADIUS: Record<PlantSpecies, number> = {
  broadleaf: 2.2,
  conifer: 1.9,
  palm: 2.1,
  shrub: 1.1,
  grass: 1.4,
  columnar: 1.1,
  blossom: 1.6,
  dead: 1.7,
  agave: 1,
  hedge: 1.3,
};

/**
 * How small and how large a plant of each species grows, as a share of its
 * {@link PLANT_RADIUS}. Whatever it draws, it never claims more than
 * {@link MAX_PLANT_RADIUS}, which the sweep checks: the largest broadleaf is
 * clipped by it.
 *
 * The undergrowth is held close to its own size: a tuft of grass four metres
 * across is not a tuft of grass. A tree is given the whole range, because the
 * sapling and the specimen beside each other are what stops a wood reading as
 * one model stamped over and over.
 */
export const GROWTH: Record<PlantSpecies, readonly [small: number, large: number]> = {
  broadleaf: [0.55, 1.6],
  conifer: [0.55, 1.6],
  palm: [0.7, 1.35],
  shrub: [0.6, 1.3],
  grass: [0.7, 1.25],
  columnar: [0.7, 1.5],
  blossom: [0.6, 1.4],
  dead: [0.6, 1.5],
  agave: [0.7, 1.3],
  hedge: [0.8, 1.2],
};

/**
 * Where an ordinary plant stops and a large one starts, as a share of the range
 * between the two ends of {@link GROWTH}.
 */
const PLAIN_GROWTH = 0.45;

/**
 * How often a plant grows past {@link PLAIN_GROWTH} into the large end of its
 * range. Roughly one in twelve, so a park has a few trees that stand over it
 * and a wood has a canopy rather than a ceiling.
 */
const LANDMARK_CHANCE = 0.08;

/**
 * The widest canopy any species has. Two plants of neighbouring cells stand at
 * least `PLANT_CELL - 2 * PLANT_JITTER` apart, so keeping this at half of that
 * is what makes overlap unrepresentable.
 */
export const MAX_PLANT_RADIUS = (PLANT_CELL - 2 * PLANT_JITTER) / 2;

/**
 * Metres from the edge of its parcel a street tree stands within. A built-up
 * parcel is planted along the road rather than all over: the ground behind the
 * frontage is the building's, and the row by the pavement is what the camera
 * sees.
 */
export const STREET_REACH = 7;

/** Metres each way of one bucket of a parcel's boundary index. */
const EDGE_CELL = 8;

/** What a zone and an owner plant, and how thickly. */
interface PlantMix {
  /** How often a cell of the grid carries a plant at all. */
  chance: number;
  /** True where a plant only stands within {@link STREET_REACH} of the road. */
  street: boolean;
  /** The species it plants, and their shares. */
  species: readonly { kind: PlantSpecies; weight: number }[];
}

/** Woodland: what a park in the city plants, and what fills a wild hillside. */
const BROADLEAF_WOOD: PlantMix['species'] = [
  { kind: 'broadleaf', weight: 0.4 },
  { kind: 'conifer', weight: 0.13 },
  { kind: 'blossom', weight: 0.1 },
  { kind: 'columnar', weight: 0.06 },
  { kind: 'dead', weight: 0.03 },
  { kind: 'shrub', weight: 0.18 },
  { kind: 'grass', weight: 0.1 },
];

/** The same wood higher up and further out, where the conifers take over. */
const CONIFER_WOOD: PlantMix['species'] = [
  { kind: 'conifer', weight: 0.45 },
  { kind: 'broadleaf', weight: 0.16 },
  { kind: 'columnar', weight: 0.05 },
  { kind: 'dead', weight: 0.08 },
  { kind: 'shrub', weight: 0.16 },
  { kind: 'grass', weight: 0.1 },
];

/**
 * The wood of the dry ground between the city and the hills: fewer trees of
 * each kind, more open grass, and the rosettes that only grow out here.
 */
const DRY_WOOD: PlantMix['species'] = [
  { kind: 'conifer', weight: 0.28 },
  { kind: 'broadleaf', weight: 0.16 },
  { kind: 'agave', weight: 0.14 },
  { kind: 'dead', weight: 0.08 },
  { kind: 'shrub', weight: 0.2 },
  { kind: 'grass', weight: 0.14 },
];

/** Scrub: what open ground carries where no one planted anything. */
const SCRUB: PlantMix['species'] = [
  { kind: 'shrub', weight: 0.42 },
  { kind: 'grass', weight: 0.24 },
  { kind: 'broadleaf', weight: 0.12 },
  { kind: 'agave', weight: 0.1 },
  { kind: 'dead', weight: 0.06 },
  { kind: 'hedge', weight: 0.06 },
];

/**
 * A row of street trees. It carries no undergrowth, because the ground under it
 * is pavement and forecourt, but it is not one species either: an avenue of the
 * same tree every seven metres is what the old scatter looked like.
 */
const STREET_TREES: PlantMix['species'] = [
  { kind: 'broadleaf', weight: 0.5 },
  { kind: 'columnar', weight: 0.2 },
  { kind: 'blossom', weight: 0.22 },
  { kind: 'hedge', weight: 0.08 },
];

/** The back of a beach: dune grass, and the palms of spec section 7.3. */
const DUNE: PlantMix['species'] = [
  { kind: 'grass', weight: 0.6 },
  { kind: 'palm', weight: 0.28 },
  { kind: 'agave', weight: 0.12 },
];

/** Which wood a zone grows: broadleaf in the city, conifer on the hills, dry between. */
function wooded(zone: Zone): PlantMix['species'] {
  if (zone === 'wilderness') return CONIFER_WOOD;
  if (zone === 'outskirts') return DRY_WOOD;
  return BROADLEAF_WOOD;
}

/**
 * What a parcel plants, or nothing where it plants nothing at all. The owner
 * decides what kind of planting it is and the zone how thick it is: the same
 * park is a wood in the wilderness and a lawn with trees in the core.
 */
export function mixFor(owner: ParcelOwner, zone: Zone): PlantMix | undefined {
  switch (owner) {
    case 'park':
      return { chance: 0.9, street: false, species: wooded(zone) };
    case 'beach':
      return { chance: 0.58, street: false, species: DUNE };
    case 'ground':
      // Open ground: the forest of the wilderness thins to scrub as the city
      // takes over, because the ground between the buildings is kept.
      return {
        chance: GROUND_CHANCE[zone],
        street: false,
        species: zone === 'core' || zone === 'inner' || zone === 'industrial' ? SCRUB : wooded(zone),
      };
    case 'building':
      // A street of houses is planted in its gardens; a block of towers only
      // along the pavement, where there is no garden to plant.
      return zone === 'core' || zone === 'inner' || zone === 'industrial'
        ? { chance: 0.64, street: true, species: STREET_TREES }
        : { chance: 0.58, street: false, species: wooded(zone) };
    case 'plaza':
      return { chance: 0.5, street: true, species: STREET_TREES };
    case 'car-park':
      return { chance: 0.32, street: true, species: STREET_TREES };
    // The ground under a deck is the corridor's, and a water parcel is water.
    default:
      return undefined;
  }
}

/** How often open ground carries a plant, by the zone it stands in. */
const GROUND_CHANCE: Record<Zone, number> = {
  core: 0.18,
  inner: 0.21,
  industrial: 0.15,
  suburban: 0.35,
  outskirts: 0.5,
  wilderness: 0.74,
};

/**
 * The ground a piece of the map offers: one parcel, or the part of it that
 * piece holds. A chunk's own parcel pieces are read this way, so the point that
 * asks which parcel it stands on walks the piece rather than the whole
 * coastline the parcel was cut from.
 */
export interface PlantGround {
  /** Id of the whole-map parcel. */
  parcel: number;
  region: Region;
  owner: ParcelOwner;
  zone: Zone;
}

/**
 * The largest chance any mix plants with. A cell whose roll is above this
 * carries nothing whatever it stands on, so the ground under it is never looked
 * up. The sweep checks that no mix passes it.
 */
export const MAX_PLANT_CHANCE = 0.9;

/**
 * The plants of a world, answered a piece of ground at a time.
 *
 * The parcels and the buildings are passed in because a caller that already has
 * them should not pay for them twice. Nothing is written back: asking for one
 * piece of ground twice, or for the pieces in any order, gives the same plants.
 */
export class Vegetation {
  private readonly seed: number;
  /** Every parcel by its id, for the boundary each plant keeps its distance from. */
  private readonly parcels = new Map<number, Parcel>();
  /** The lots of each parcel that has any, so a canopy can be kept off them. */
  private readonly lots = new Map<number, Point[][]>();
  /** The boundary index of each parcel asked about so far, built on first use. */
  private readonly edges = new Map<number, EdgeIndex>();

  constructor(seed: number, parcels: ParcelMap, buildings: BuildingMap) {
    this.seed = seed;
    for (const parcel of parcels.parcels) this.parcels.set(parcel.id, parcel);
    for (const building of buildings.buildings) {
      const here = this.lots.get(building.parcel);
      if (here === undefined) this.lots.set(building.parcel, [lotOf(building)]);
      else here.push(lotOf(building));
    }
  }

  /**
   * The plants standing on a piece of ground, in grid order. The piece owns its
   * near edges and not its far ones, as a chunk does, so a plant on a boundary
   * is counted once.
   *
   * `ground` is the parcel ground inside those bounds. A plant stands where a
   * piece of it says it does, and keeps its distance from the boundary of the
   * whole parcel that piece came from, so where the piece was cut makes no
   * difference to what grows.
   */
  plantsIn(bounds: { minX: number; minY: number; maxX: number; maxY: number }, ground: readonly PlantGround[]): Plant[] {
    const out: Plant[] = [];
    const boxes = ground.map((piece) => boxOf(piece.region.outer));
    // A cell's plant stands within the jitter of its middle, so the cells whose
    // plant can fall inside the bounds reach one cell past them.
    const fromX = Math.floor(bounds.minX / PLANT_CELL) - 1;
    const toX = Math.floor(bounds.maxX / PLANT_CELL) + 1;
    const fromY = Math.floor(bounds.minY / PLANT_CELL) - 1;
    const toY = Math.floor(bounds.maxY / PLANT_CELL) + 1;
    for (let cellY = fromY; cellY <= toY; cellY++) {
      for (let cellX = fromX; cellX <= toX; cellX++) {
        const plant = this.plantAt(cellX, cellY, bounds, ground, boxes);
        if (plant !== undefined) out.push(plant);
      }
    }
    return out;
  }

  /**
   * The plant of one cell of the grid, or nothing where the cell carries none.
   *
   * The draws are made in a fixed order, so a cell that is turned down still
   * turns down the same way wherever it is asked from.
   */
  private plantAt(
    cellX: number,
    cellY: number,
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    ground: readonly PlantGround[],
    boxes: readonly PlantBox[],
  ): Plant | undefined {
    const rng = genRng(this.seed, Subsystem.Vegetation, hashInts(cellX, cellY));
    const x = (cellX + 0.5) * PLANT_CELL + rng.range(-PLANT_JITTER, PLANT_JITTER);
    const y = (cellY + 0.5) * PLANT_CELL + rng.range(-PLANT_JITTER, PLANT_JITTER);
    if (x < bounds.minX || x >= bounds.maxX || y < bounds.minY || y >= bounds.maxY) return undefined;
    // The roll before the ground: a cell that plants nothing however rich the
    // ground is never asks which parcel it stands on, and that lookup is what
    // the scatter costs.
    const roll = rng.float();
    if (roll >= MAX_PLANT_CHANCE) return undefined;
    const here = pieceAt(x, y, ground, boxes);
    if (here === undefined) return undefined;
    const mix = mixFor(here.owner, here.zone);
    if (mix === undefined || roll >= mix.chance) return undefined;
    const species = speciesOf(mix, rng);
    const radius = radiusOf(species, rng);
    const parcel = this.parcels.get(here.parcel);
    if (parcel === undefined) return undefined;
    // The whole canopy stands on the parcel, so no part of it reaches over the
    // road the parcel was cut from.
    const room = this.edgesOf(parcel).distanceTo(x, y);
    if (room < radius) return undefined;
    if (mix.street && room > STREET_REACH) return undefined;
    for (const lot of this.lots.get(parcel.id) ?? []) if (distanceToRing(x, y, lot) < radius) return undefined;
    return { parcel: parcel.id, species, seed: rng.nextU32(), at: { x, y }, radius };
  }

  /** The boundary index of a parcel, built the first time the parcel is planted on. */
  private edgesOf(parcel: Parcel): EdgeIndex {
    const known = this.edges.get(parcel.id);
    if (known !== undefined) return known;
    const built = new EdgeIndex(parcel);
    this.edges.set(parcel.id, built);
    return built;
  }
}

/** The box around a piece of parcel ground. */
interface PlantBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boxOf(ring: readonly Point[]): PlantBox {
  const box: PlantBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of ring) {
    box.minX = Math.min(box.minX, p.x);
    box.minY = Math.min(box.minY, p.y);
    box.maxX = Math.max(box.maxX, p.x);
    box.maxY = Math.max(box.maxY, p.y);
  }
  return box;
}

/** The piece of ground a point stands on. Pieces never overlap, so at most one answers. */
function pieceAt(x: number, y: number, ground: readonly PlantGround[], boxes: readonly PlantBox[]): PlantGround | undefined {
  const p: Point = { x, y };
  for (let i = 0; i < ground.length; i++) {
    const box = boxes[i] as PlantBox;
    if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
    const piece = ground[i] as PlantGround;
    if (pointInRegion(p, piece.region)) return piece;
  }
  return undefined;
}

/** The lot of a building as a ring, which is what a canopy is kept off. */
function lotOf(building: Building): Point[] {
  return building.lot.map((corner) => ({ x: corner.x, y: corner.y }));
}

/**
 * How much canopy one plant claims: its species' radius grown by its own share
 * of {@link GROWTH}, and never past {@link MAX_PLANT_RADIUS}, which is what
 * keeps two neighbouring canopies apart.
 */
function radiusOf(species: PlantSpecies, rng: Rng): number {
  const [small, large] = GROWTH[species];
  const plain = small + (large - small) * PLAIN_GROWTH;
  const growth = rng.float() < LANDMARK_CHANCE ? rng.range(plain, large) : rng.range(small, plain);
  return Math.min(MAX_PLANT_RADIUS, PLANT_RADIUS[species] * growth);
}

/** Which species a mix plants this time. */
function speciesOf(mix: PlantMix, rng: Rng): PlantSpecies {
  let total = 0;
  for (const entry of mix.species) total += entry.weight;
  let roll = rng.float() * total;
  let picked = mix.species[0] as { kind: PlantSpecies };
  for (const entry of mix.species) {
    picked = entry;
    roll -= entry.weight;
    if (roll < 0) break;
  }
  return picked.kind;
}

/**
 * How far a point stands from the boundary of one parcel.
 *
 * Only the metres near the boundary matter — a canopy is a couple of them wide
 * and a street tree stands within a few — so the index answers up to
 * {@link EDGE_CELL} and says no more than that. Each edge is filed in every
 * bucket the box around it touches, and a query reads the nine buckets around
 * the point, which together cover everything within that distance of it.
 */
class EdgeIndex {
  private readonly ax: number[] = [];
  private readonly ay: number[] = [];
  private readonly bx: number[] = [];
  private readonly by: number[] = [];
  private readonly buckets = new Map<number, number[]>();
  private readonly minColumn: number;
  private readonly minRow: number;
  private readonly columns: number;
  private readonly rows: number;

  constructor(parcel: Parcel) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const rings = [parcel.region.outer, ...parcel.region.holes];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i] as Point;
        const b = ring[(i + 1) % ring.length] as Point;
        this.ax.push(a.x);
        this.ay.push(a.y);
        this.bx.push(b.x);
        this.by.push(b.y);
        minX = Math.min(minX, a.x);
        minY = Math.min(minY, a.y);
        maxX = Math.max(maxX, a.x);
        maxY = Math.max(maxY, a.y);
      }
    }
    const empty = this.ax.length === 0;
    this.minColumn = empty ? 0 : columnOf(minX);
    this.minRow = empty ? 0 : columnOf(minY);
    this.columns = empty ? 1 : columnOf(maxX) - this.minColumn + 1;
    this.rows = empty ? 1 : columnOf(maxY) - this.minRow + 1;
    for (let e = 0; e < this.ax.length; e++) this.file(e);
  }

  /** File edge `e` in every bucket the box around it touches. */
  private file(e: number): void {
    const loX = columnOf(Math.min(this.ax[e] as number, this.bx[e] as number));
    const hiX = columnOf(Math.max(this.ax[e] as number, this.bx[e] as number));
    const loY = columnOf(Math.min(this.ay[e] as number, this.by[e] as number));
    const hiY = columnOf(Math.max(this.ay[e] as number, this.by[e] as number));
    for (let column = loX; column <= hiX; column++) {
      for (let row = loY; row <= hiY; row++) {
        const key = this.keyOf(column, row);
        const bucket = this.buckets.get(key);
        if (bucket === undefined) this.buckets.set(key, [e]);
        else bucket.push(e);
      }
    }
  }

  /**
   * Metres from a point to the nearest edge of the parcel, or {@link EDGE_CELL}
   * where none stands within that distance. A caller only ever asks whether
   * there is room, so an answer further out than that is not worth finding.
   */
  distanceTo(x: number, y: number): number {
    const column = columnOf(x);
    const row = columnOf(y);
    let best = EDGE_CELL * EDGE_CELL;
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        for (const e of this.buckets.get(this.keyOf(column + dc, row + dr)) ?? []) {
          const ax = this.ax[e] as number;
          const ay = this.ay[e] as number;
          const d = distanceSquaredToSegment(x, y, ax, ay, this.bx[e] as number, this.by[e] as number);
          if (d < best) best = d;
        }
      }
    }
    return Math.sqrt(best);
  }

  /**
   * One bucket as a single number. Every edge stands inside the bounds the index
   * was built with, so no two buckets share a key; a query outside them is
   * clamped onto the edge of the index, where the distance test turns it away.
   */
  private keyOf(column: number, row: number): number {
    const across = Math.max(0, Math.min(this.columns - 1, column - this.minColumn));
    const down = Math.max(0, Math.min(this.rows - 1, row - this.minRow));
    return across * this.rows + down;
  }
}

/** Which column or row of a boundary index a coordinate falls in. */
function columnOf(v: number): number {
  return Math.floor(v / EDGE_CELL);
}

/** Metres from a point to a closed ring, which is zero inside it. */
function distanceToRing(x: number, y: number, ring: readonly Point[]): number {
  if (pointInConvexRing(x, y, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    best = Math.min(best, distanceSquaredToSegment(x, y, a.x, a.y, b.x, b.y));
  }
  return Math.sqrt(best);
}

/** True when a point stands inside a ring wound anticlockwise, as a lot is. */
function pointInConvexRing(x: number, y: number, ring: readonly Point[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as Point;
    const b = ring[(i + 1) % ring.length] as Point;
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
  }
  return true;
}

function distanceSquaredToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const lengthSquared = vx * vx + vy * vy;
  let t = lengthSquared > 0 ? ((px - ax) * vx + (py - ay) * vy) / lengthSquared : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return dx * dx + dy * dy;
}
