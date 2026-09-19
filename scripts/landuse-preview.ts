/**
 * A close look at how a city uses its land, as a PNG.
 *
 * `world-preview.ts` draws the whole map, where a downtown block is a few
 * pixels wide. This draws a few hundred metres of it, so what the picture shows
 * is how much of the ground is road, how much is empty parcel and how much
 * carries a building.
 *
 * Usage: node scripts/landuse-preview.ts [seed] [out.png] [--half=350] [--x=0] [--y=0] [--width=900]
 */
import { writeFileSync } from 'node:fs';
import { seedFromString } from '../src/core/rng.ts';
import { buildBuildings, type BuildingKind } from '../src/world/buildings.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { buildFootprint } from '../src/world/footprint.ts';
import { buildParcels } from '../src/world/parcels.ts';
import { buildTensorField } from '../src/world/tensor.ts';
import { generateWorld } from '../src/world/world.ts';
import {
  KINDS,
  OWNERS,
  USE_LOT,
  USE_PARCEL,
  USE_ROAD,
  landUseLayers,
  rasteriseLandUse,
} from './land-use.ts';
import { formatLayout, measureLayout } from './layout-metrics.ts';
import { encodePng } from './png.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const positional = args.filter((a) => !a.startsWith('--'));
const seedText = positional[0] ?? 'sunset';
const out = positional[1] ?? `landuse-${seedText}.png`;
const half = Number(flag('half') ?? 350);
const width = Math.max(64, Number(flag('width') ?? 900));

const world = generateWorld(seedFromString(seedText));
const graph = buildRoadGraph(world.roads);
const footprint = buildFootprint(world, graph);
const tensor = buildTensorField(world);
const parcels = buildParcels(world, footprint, graph, tensor);
const buildings = buildBuildings(world, parcels, graph);
const layers = landUseLayers(world, graph, parcels, buildings);

const centreX = Number(flag('x') ?? world.core.x);
const centreY = Number(flag('y') ?? world.core.y);
const t0 = performance.now();
const grid = rasteriseLandUse(world, layers, { centreX, centreY, half, cell: (half * 2) / width });
const rasterMs = performance.now() - t0;

/** Water, and the dry ground no road and no parcel claims. */
const WATER: [number, number, number] = [30, 70, 130];
const BARE: [number, number, number] = [92, 104, 78];
const ROAD: [number, number, number] = [64, 62, 70];
const OWNER_COL: Record<string, [number, number, number]> = {
  building: [200, 175, 150],
  park: [70, 150, 70],
  'car-park': [130, 130, 140],
  plaza: [220, 210, 180],
  'under-structure': [110, 90, 70],
  beach: [235, 220, 160],
  water: [40, 100, 170],
  ground: [120, 140, 95],
};
const KIND_COL: Record<BuildingKind, [number, number, number]> = {
  tower: [245, 245, 255],
  'mid-rise': [195, 200, 220],
  'parking-garage': [120, 125, 135],
  'shop-row': [235, 165, 80],
  house: [225, 130, 120],
  warehouse: [140, 145, 160],
  roadhouse: [200, 115, 205],
};

const n = grid.side;
const rgb = new Uint8Array(n * n * 3);
for (let iy = 0; iy < n; iy++) {
  for (let ix = 0; ix < n; ix++) {
    const i = iy * n + ix;
    const use = grid.use[i] as number;
    const tint = grid.tint[i] as number;
    let col = BARE;
    if (grid.land[i] === 0 && use !== USE_ROAD) col = WATER;
    else if (use === USE_ROAD) col = ROAD;
    else if (use === USE_PARCEL) col = OWNER_COL[OWNERS[tint] as string] as [number, number, number];
    else if (use === USE_LOT) col = KIND_COL[KINDS[tint] as BuildingKind] as [number, number, number];
    // Row 0 of the grid is the south edge; row 0 of the picture is the north one.
    const o = ((n - 1 - iy) * n + ix) * 3;
    rgb[o] = col[0];
    rgb[o + 1] = col[1];
    rgb[o + 2] = col[2];
  }
}
writeFileSync(out, encodePng(n, n, rgb));

console.log(
  `seed ${seedText} at ${centreX.toFixed(0)}, ${centreY.toFixed(0)}: ${(half * 2).toFixed(0)} m across, ` +
    `${n}x${n} at ${grid.cell.toFixed(2)} m a pixel, rastered in ${rasterMs.toFixed(0)} ms → ${out}`,
);
// The picture is one corner of the map; the numbers below are the whole of it,
// zone by zone, because a share read off 700 m of downtown is one block's luck.
for (const line of formatLayout(measureLayout(world, layers))) console.log(line);
