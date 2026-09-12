/**
 * How dense a city is, as numbers rather than as an opinion.
 *
 * The sweep checks that a layout is legal: that roads connect, that grades hold
 * and that nothing overlaps. None of that says whether the city is worth
 * driving through. A map that gives three fifths of its downtown to tarmac
 * passes every one of those checks. These numbers are what says it does not.
 *
 * Everything here is read off the land-use grid of `land-use.ts`, one sample
 * per cell, because the pieces of the road footprint overlap at every junction
 * and adding their areas up counts an apron once per road that meets there.
 *
 * `test/seed-layout.ts` holds each number to the band `test/budgets.ts` pins,
 * and `landuse-preview.ts` prints them beside the picture.
 */
import { layoutZones, zoneAt } from '../src/world/districts.ts';
import type { WorldDescription, Zone } from '../src/world/types.ts';
import {
  COVER_APRON,
  COVER_CORRIDOR,
  COVER_STRIP,
  USE_LOT,
  USE_PARCEL,
  USE_ROAD,
  rasteriseLandUse,
  type LandUseGrid,
  type LandUseLayers,
} from './land-use.ts';

/** The zones the metrics are reported for, in order from the middle out. */
export const ZONES: readonly Zone[] = ['core', 'inner', 'industrial', 'suburban', 'outskirts', 'wilderness'];

/** Metres a cell of the sweep's grid covers. Coarse: the shares of a zone, not its edges. */
export const METRIC_CELL = 8;

/** What one zone of one seed came to. */
export interface ZoneMetrics {
  /** Hectares of dry land in the zone. Every share below is of this. */
  hectares: number;
  /** Share of that ground the road footprint covers. */
  roadShare: number;
  /** Share of it that is parcel of any kind, building lots included. */
  parcelShare: number;
  /** Share of it that is building lot. */
  buildingShare: number;
  /**
   * Share of it a junction apron covers and no carriageway does: the ground the
   * rounding of the corners costs on top of the roads themselves.
   */
  apronShare: number;
  /**
   * Share of it a corridor covers and no carriageway does: the ground under an
   * elevated deck and the tram's own lane (spec section 6.3).
   */
  corridorShare: number;
  /** Buildings standing in the zone, per hectare of its ground. */
  buildingsPerHectare: number;
  /** Square metres of the middle parcel of the zone, or 0 where it has none. */
  medianParcelArea: number;
  /** Buildings and parcels the two counts above come from. */
  buildings: number;
  parcels: number;
}

/** One seed's layout, zone by zone. */
export type LayoutMetrics = Record<Zone, ZoneMetrics>;

/**
 * Measure a whole map. The grid covers the map corner to corner, so a zone is
 * measured over every hectare of it that is dry land.
 */
export function measureLayout(world: WorldDescription, layers: LandUseLayers, cell = METRIC_CELL): LayoutMetrics {
  const grid = rasteriseLandUse(world, layers, { centreX: 0, centreY: 0, half: world.size / 2, cell });
  return metricsOf(world, layers, grid);
}

/** Measure the ground one grid already covers. */
export function metricsOf(world: WorldDescription, layers: LandUseLayers, grid: LandUseGrid): LayoutMetrics {
  const zones = layoutZones(world.size, world.core, world.water);
  const land = new Map<Zone, number>();
  const road = new Map<Zone, number>();
  const parcel = new Map<Zone, number>();
  const lot = new Map<Zone, number>();
  const apron = new Map<Zone, number>();
  const corridor = new Map<Zone, number>();
  const bump = (tally: Map<Zone, number>, zone: Zone): void => {
    tally.set(zone, (tally.get(zone) ?? 0) + 1);
  };
  for (let iy = 0; iy < grid.side; iy++) {
    const y = grid.worldY(iy);
    for (let ix = 0; ix < grid.side; ix++) {
      const i = iy * grid.side + ix;
      if (grid.land[i] === 0) continue;
      const zone = zoneAt(zones, grid.worldX(ix), y);
      bump(land, zone);
      const use = grid.use[i] as number;
      if (use === USE_ROAD) bump(road, zone);
      if (use === USE_PARCEL || use === USE_LOT) bump(parcel, zone);
      if (use === USE_LOT) bump(lot, zone);
      const cover = grid.cover[i] as number;
      if ((cover & COVER_STRIP) === 0) {
        if ((cover & COVER_APRON) !== 0) bump(apron, zone);
        if ((cover & COVER_CORRIDOR) !== 0) bump(corridor, zone);
      }
    }
  }

  const parcelAreas = new Map<Zone, number[]>();
  for (const p of layers.parcels.parcels) {
    const list = parcelAreas.get(p.zone);
    if (list === undefined) parcelAreas.set(p.zone, [p.area]);
    else list.push(p.area);
  }
  const buildings = new Map<Zone, number>();
  for (const b of layers.buildings.buildings) buildings.set(b.zone, (buildings.get(b.zone) ?? 0) + 1);

  const out = {} as LayoutMetrics;
  for (const zone of ZONES) {
    const cells = land.get(zone) ?? 0;
    const hectares = (cells * grid.cellArea) / 1e4;
    const share = (tally: Map<Zone, number>): number => (cells === 0 ? 0 : (tally.get(zone) ?? 0) / cells);
    const areas = parcelAreas.get(zone) ?? [];
    const count = buildings.get(zone) ?? 0;
    out[zone] = {
      hectares,
      roadShare: share(road),
      parcelShare: share(parcel),
      buildingShare: share(lot),
      apronShare: share(apron),
      corridorShare: share(corridor),
      buildingsPerHectare: hectares === 0 ? 0 : count / hectares,
      medianParcelArea: median(areas),
      buildings: count,
      parcels: areas.length,
    };
  }
  return out;
}

/** The middle of a list of areas, or 0 where there are none. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const half = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[half] as number;
  return ((sorted[half - 1] as number) + (sorted[half] as number)) / 2;
}

/** One line per zone, for a tool that prints what it measured. */
export function formatLayout(metrics: LayoutMetrics): string[] {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`.padStart(6);
  return ZONES.map((zone) => {
    const m = metrics[zone];
    return (
      `  ${zone.padEnd(11)}${m.hectares.toFixed(0).padStart(5)} ha  road ${pct(m.roadShare)}  parcel ${pct(m.parcelShare)}  ` +
      `building ${pct(m.buildingShare)}  apron ${pct(m.apronShare)}  corridor ${pct(m.corridorShare)}  ` +
      `${m.buildingsPerHectare.toFixed(1).padStart(5)} buildings/ha  median parcel ${m.medianParcelArea.toFixed(0).padStart(6)} m²  ` +
      `(${m.buildings} buildings, ${m.parcels} parcels)`
    );
  });
}
