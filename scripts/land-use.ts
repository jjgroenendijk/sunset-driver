/**
 * The land use of a world, rasterised: one code per cell of a square grid
 * saying what stands on that ground.
 *
 * Two tools read it. `landuse-preview.ts` paints the grid into a picture, and
 * `layout-metrics.ts` counts the cells of each code to say how much of a zone
 * is road, parcel and building lot.
 *
 * The grid is the reason both of them sample rather than add polygon areas up.
 * The pieces of the footprint overlap each other at every junction, so their
 * areas added together count an apron once per road that meets there. A cell is
 * covered or it is not, however many pieces cover it.
 *
 * Headless and pure: the same world gives the same grid.
 */
import type { Point, Region } from '../src/core/geom.ts';
import { footprintParts, type FootprintParts } from '../src/world/footprint.ts';
import type { RoadGraph } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import type { BuildingKind, BuildingMap } from '../src/world/buildings.ts';
import type { ParcelMap, ParcelOwner } from '../src/world/parcels.ts';
import type { WorldDescription } from '../src/world/types.ts';

/** What stands on a cell. The later codes cover the earlier ones. */
export const USE_GROUND = 0;
export const USE_ROAD = 1;
export const USE_PARCEL = 2;
export const USE_LOT = 3;

/** Which piece of the footprint covers a cell, as bits, so overlap is kept. */
export const COVER_STRIP = 1;
export const COVER_APRON = 2;
export const COVER_CORRIDOR = 4;
/** The ground under a deck the road claims, because no elevated corridor holds it. */
export const COVER_DECK = 8;

/** The parcel owners a cell's tint indexes, in this order. */
export const OWNERS: readonly ParcelOwner[] = [
  'building',
  'park',
  'car-park',
  'plaza',
  'under-structure',
  'beach',
  'water',
  'ground',
];

/** The building kinds a cell's tint indexes, in this order. */
export const KINDS: readonly BuildingKind[] = [
  'tower',
  'mid-rise',
  'parking-garage',
  'shop-row',
  'house',
  'warehouse',
  'roadhouse',
];

/** The ground a grid covers: a square of `2 * half` metres around a place. */
export interface LandUseView {
  centreX: number;
  centreY: number;
  /** Metres from the middle to each edge. */
  half: number;
  /** Metres a cell covers. */
  cell: number;
}

/**
 * One code per cell of a square of ground, with the parcel owner or building
 * kind of that cell beside it. Row 0 is the south edge.
 */
export class LandUseGrid {
  readonly side: number;
  readonly cell: number;
  /** World place of the middle of cell (0, 0). */
  readonly originX: number;
  readonly originY: number;
  /** One of the `USE_` codes per cell. */
  readonly use: Uint8Array;
  /** Dry land, as the heightfield reads it: 1 on land, 0 in the water. */
  readonly land: Uint8Array;
  /** The `OWNERS` index of a parcel cell, or the `KINDS` index of a lot cell. */
  readonly tint: Uint8Array;
  /** The `COVER_` bits of the footprint pieces over a cell. */
  readonly cover: Uint8Array;

  private readonly rowX: number[][] = [];
  private readonly touched: number[] = [];

  constructor(view: LandUseView) {
    this.cell = view.cell;
    this.side = Math.max(1, Math.round((view.half * 2) / view.cell));
    this.originX = view.centreX - view.half + view.cell / 2;
    this.originY = view.centreY - view.half + view.cell / 2;
    const cells = this.side * this.side;
    this.use = new Uint8Array(cells);
    this.land = new Uint8Array(cells);
    this.tint = new Uint8Array(cells);
    this.cover = new Uint8Array(cells);
    for (let i = 0; i < this.side; i++) this.rowX.push([]);
  }

  worldX(ix: number): number {
    return this.originX + ix * this.cell;
  }

  worldY(iy: number): number {
    return this.originY + iy * this.cell;
  }

  /** Square metres one cell stands for. */
  get cellArea(): number {
    return this.cell * this.cell;
  }

  /** Paint a region with a use code and a tint. */
  paint(region: Region, use: number, tint: number): void {
    this.scan(region, (i) => {
      this.use[i] = use;
      this.tint[i] = tint;
    });
  }

  /** Add a cover bit over a region, leaving the bits already there. */
  mark(region: Region, bit: number): void {
    this.scan(region, (i) => {
      this.cover[i] = (this.cover[i] as number) | bit;
    });
  }

  /**
   * Call `paint` once per cell inside a region.
   *
   * Every edge files its crossing under the rows it spans, and only the rows
   * the grid holds, so a region off the side of the view costs its own edges
   * and nothing else. Testing every edge on every row instead is what makes a
   * whole-map raster slow: a road strip spans a few rows and the grid has
   * hundreds.
   */
  private scan(region: Region, paint: (index: number) => void): void {
    const touched = this.touched;
    touched.length = 0;
    for (const ring of [region.outer, ...region.holes]) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) this.fileEdge(ring[i] as Point, ring[j] as Point);
    }
    this.fillRows(paint);
  }

  /** File the crossings of the edge `a`–`b` under each row of the grid it spans. */
  private fileEdge(a: Point, b: Point): void {
    if (a.y === b.y) return;
    const from = Math.max(0, Math.ceil((Math.min(a.y, b.y) - this.originY) / this.cell));
    const to = Math.min(this.side - 1, Math.floor((Math.max(a.y, b.y) - this.originY) / this.cell));
    for (let iy = from; iy <= to; iy++) {
      const y = this.worldY(iy);
      if (a.y > y === b.y > y) continue;
      const bucket = this.rowX[iy] as number[];
      if (bucket.length === 0) this.touched.push(iy);
      bucket.push(a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y));
    }
  }

  /** Paint the cells between each pair of filed crossings, and empty the rows. */
  private fillRows(paint: (index: number) => void): void {
    for (const iy of this.touched) {
      const bucket = this.rowX[iy] as number[];
      bucket.sort((p, q) => p - q);
      const row = iy * this.side;
      for (let k = 0; k + 1 < bucket.length; k += 2) {
        const lo = Math.max(0, Math.ceil(((bucket[k] as number) - this.originX) / this.cell));
        const hi = Math.min(this.side - 1, Math.floor(((bucket[k + 1] as number) - this.originX) / this.cell));
        for (let ix = lo; ix <= hi; ix++) paint(row + ix);
      }
      bucket.length = 0;
    }
  }
}

/** The layers a grid is painted from. The pool builds all three next to the world. */
export interface LandUseLayers {
  parts: FootprintParts;
  parcels: ParcelMap;
  buildings: BuildingMap;
}

/** The footprint pieces, the parcels and the lots of a world, ready to raster. */
export function landUseLayers(world: WorldDescription, graph: RoadGraph, parcels: ParcelMap, buildings: BuildingMap): LandUseLayers {
  return { parts: footprintParts(world, graph), parcels, buildings };
}

/**
 * Raster a square of ground, in the order the layers cover each other: the road
 * footprint, then the parcels the roads left, then the building lots on them.
 */
export function rasteriseLandUse(world: WorldDescription, layers: LandUseLayers, view: LandUseView): LandUseGrid {
  const grid = new LandUseGrid(view);
  const hf = new Heightfield(world.terrain);
  for (let iy = 0; iy < grid.side; iy++) {
    const y = grid.worldY(iy);
    for (let ix = 0; ix < grid.side; ix++) {
      grid.land[iy * grid.side + ix] = hf.sample(grid.worldX(ix), y) >= world.water.seaLevel ? 1 : 0;
    }
  }
  const { parts, parcels, buildings } = layers;
  for (const strip of parts.strips) {
    grid.paint(strip, USE_ROAD, 0);
    grid.mark(strip, COVER_STRIP);
  }
  for (const apron of parts.aprons) {
    grid.paint(apron, USE_ROAD, 0);
    grid.mark(apron, COVER_APRON);
  }
  for (const corridor of parts.corridors) {
    grid.paint(corridor, USE_ROAD, 0);
    grid.mark(corridor, COVER_CORRIDOR);
  }
  for (const deck of parts.decks) {
    grid.paint(deck, USE_ROAD, 0);
    grid.mark(deck, COVER_DECK);
  }
  for (const parcel of parcels.parcels) grid.paint(parcel.region, USE_PARCEL, Math.max(0, OWNERS.indexOf(parcel.owner)));
  for (const building of buildings.buildings) {
    grid.paint({ outer: building.lot, holes: [] }, USE_LOT, Math.max(0, KINDS.indexOf(building.kind)));
  }
  return grid;
}
