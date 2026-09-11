/**
 * Render a top-down map of a seed's world description to a PNG for eyeballing.
 * Usage: node scripts/world-preview.ts [seed] [out.png]
 */
import { writeFileSync } from 'node:fs';
import type { Region } from '../src/core/geom.ts';
import { seedFromString } from '../src/core/rng.ts';
import { buildCarve, carvedTerrain } from '../src/world/carve.ts';
import { districtAt, layoutZones } from '../src/world/districts.ts';
import { buildFootprint } from '../src/world/footprint.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { buildParcels, type ParcelOwner } from '../src/world/parcels.ts';
import { buildTensorField } from '../src/world/tensor.ts';
import { generateWorld } from '../src/world/world.ts';
import type { Point, RoadTier, Zone } from '../src/world/types.ts';
import { encodePng } from './png.ts';

const seedText = process.argv[2] ?? 'sunset';
const out = process.argv[3] ?? `preview-${seedText}.png`;
const t0 = performance.now();
const world = generateWorld(seedFromString(seedText));
const genMs = performance.now() - t0;
const hf = new Heightfield(world.terrain);
const zones = layoutZones(world.size, world.core, world.water);
const t1 = performance.now();
const tensor = buildTensorField(world);
const fieldMs = performance.now() - t1;
// The ground the roads leave (spec section 7.1). The relief below is shaded off
// this rather than off the natural terrain, because this is the ground the game
// shows: benches under the roads, cut and fill blending back into the hillside.
const t1b = performance.now();
const carve = buildCarve(world.terrain, world.roads);
const ground = carvedTerrain(world.terrain, carve);
const carveMs = performance.now() - t1b;

const ZONE_TINT: Record<Zone, [number, number, number]> = {
  core: [255, 90, 90],
  inner: [255, 170, 80],
  industrial: [160, 120, 200],
  suburban: [120, 200, 120],
  outskirts: [200, 200, 120],
  wilderness: [90, 140, 90],
};

const n = hf.gridSize;
const rgb = new Uint8Array(n * n * 3);
for (let iy = 0; iy < n; iy++) {
  for (let ix = 0; ix < n; ix++) {
    const x = hf.worldX(ix);
    const y = hf.worldY(iy);
    const h = ground.at(ix, iy);
    let r: number;
    let g: number;
    let b: number;
    if (h < world.water.seaLevel) {
      const d = Math.min(1, -h / 16);
      r = 30;
      g = 90 - d * 40;
      b = 160 - d * 60;
    } else {
      const t = Math.min(1, h / 120);
      const shade = 0.6 + 0.4 * (1 - Math.min(1, ground.slope(x, y) * 2));
      const tint = ZONE_TINT[districtAt(world.districts, zones, x, y).zone];
      r = (90 + t * 130) * 0.6 * shade + tint[0] * 0.4 * shade;
      g = (140 - t * 40) * 0.6 * shade + tint[1] * 0.4 * shade;
      b = (60 + t * 40) * 0.6 * shade + tint[2] * 0.4 * shade;
    }
    const o = ((n - 1 - iy) * n + ix) * 3;
    rgb[o] = r;
    rgb[o + 1] = g;
    rgb[o + 2] = b;
  }
}
const plot = (px: number, py: number, col: [number, number, number]): void => {
  if (px < 0 || py < 0 || px >= n || py >= n) return;
  const o = (py * n + px) * 3;
  rgb[o] = col[0];
  rgb[o + 1] = col[1];
  rgb[o + 2] = col[2];
};

// The tensor field's major direction, as a short stroke every few cells. Dark
// where the field is decided, pale where the influences cancel out.
const STROKE_STRIDE = 12;
const STROKE_HALF = 4.5;
for (let iy = STROKE_STRIDE; iy < n - STROKE_STRIDE; iy += STROKE_STRIDE) {
  for (let ix = STROKE_STRIDE; ix < n - STROKE_STRIDE; ix += STROKE_STRIDE) {
    const x = hf.worldX(ix);
    const y = hf.worldY(iy);
    if (hf.at(ix, iy) < world.water.seaLevel) continue;
    const s = tensor.sample(x, y);
    const v = Math.round(230 * (1 - Math.min(1, s.strength)));
    const col: [number, number, number] = [v, v, v];
    const dx = Math.cos(s.major);
    const dy = Math.sin(s.major);
    for (let t = -STROKE_HALF; t <= STROKE_HALF; t += 0.5) {
      plot(Math.round(ix + dx * t), n - 1 - Math.round(iy + dy * t), col);
    }
  }
}

// The ground the roads claim (spec section 6.4), filled in tarmac. The blocks
// between the roads are the holes in it, and become the parcels.
const t2 = performance.now();
const footprint = buildFootprint(world.roads, world.corridors, buildRoadGraph(world.roads));
const footprintMs = performance.now() - t2;
const FOOTPRINT_COL: [number, number, number] = [64, 62, 70];
const fill = (region: Region, col: [number, number, number]): void => {
  const rings = [region.outer, ...region.holes];
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of region.outer) {
    lo = Math.min(lo, p.y);
    hi = Math.max(hi, p.y);
  }
  const crossX: number[] = [];
  for (let iy = Math.floor((lo - hf.originY) / hf.cellSize); iy <= Math.ceil((hi - hf.originY) / hf.cellSize); iy++) {
    const y = hf.worldY(iy);
    crossX.length = 0;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i] as Point;
        const b = ring[j] as Point;
        if (a.y > y === b.y > y) continue;
        crossX.push(a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y));
      }
    }
    crossX.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossX.length; k += 2) {
      const from = Math.ceil(((crossX[k] as number) - hf.originX) / hf.cellSize);
      const to = Math.floor(((crossX[k + 1] as number) - hf.originX) / hf.cellSize);
      for (let ix = from; ix <= to; ix++) plot(ix, n - 1 - iy, col);
    }
  }
};
for (const region of footprint.regions) fill(region, FOOTPRINT_COL);

// The parcels (spec section 6.4): the land the footprint leaves, one colour per
// owner. Every one of them is filled, so ground the roads never reach shows
// through as the bare terrain underneath.
const t2b = performance.now();
const parcels = buildParcels(world, footprint, buildRoadGraph(world.roads), tensor);
const parcelMs = performance.now() - t2b;
const OWNER_COL: Record<ParcelOwner, [number, number, number]> = {
  building: [200, 175, 150],
  park: [70, 150, 70],
  'car-park': [130, 130, 140],
  plaza: [220, 210, 180],
  'under-structure': [110, 90, 70],
  beach: [235, 220, 160],
  water: [40, 100, 170],
  ground: [120, 140, 95],
};
for (const parcel of parcels.parcels) fill(parcel.region, OWNER_COL[parcel.owner] as [number, number, number]);

// Roads: one colour per tier, highways heavy and dark, bridge decks in orange
// so the strait crossings stand out, and bores through the ground in cyan.
const ROAD_STYLE = {
  highway: { col: [20, 20, 24] as [number, number, number], half: 1 },
  arterial: { col: [150, 30, 30] as [number, number, number], half: 0 },
  street: { col: [40, 60, 150] as [number, number, number], half: 0 },
  alley: { col: [20, 130, 80] as [number, number, number], half: 0 },
  dirt: { col: [190, 160, 90] as [number, number, number], half: 0 },
};
const BRIDGE_COL: [number, number, number] = [255, 140, 40];
const TUNNEL_COL: [number, number, number] = [60, 230, 230];
const cellOf = (x: number, y: number): [number, number] => [
  Math.round((x - hf.originX) / hf.cellSize),
  Math.round((y - hf.originY) / hf.cellSize),
];
const stroke = (a: Point, b: Point, col: [number, number, number], half: number): void => {
  const [ax, ay] = cellOf(a.x, a.y);
  const [bx, by] = cellOf(b.x, b.y);
  const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
  for (let i = 0; i <= steps; i++) {
    const px = Math.round(ax + ((bx - ax) * i) / steps);
    const py = Math.round(ay + ((by - ay) * i) / steps);
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) plot(px + dx, n - 1 - (py + dy), col);
    }
  }
};
// Beaches (spec section 7.3): the shallows in front of the sand, the dune line
// at its back, and the pier reaching out over the water. The sand itself is
// already filled, because it is a parcel; these are the outlines around it.
const SHALLOWS_COL: [number, number, number] = [90, 200, 210];
const DUNE_COL: [number, number, number] = [210, 190, 120];
const PIER_COL: [number, number, number] = [250, 250, 250];
for (const beach of world.beaches) {
  for (let i = 0; i + 1 < beach.shallows.length; i++) {
    stroke(beach.shallows[i] as Point, beach.shallows[i + 1] as Point, SHALLOWS_COL, 0);
  }
  for (let i = 0; i + 1 < beach.back.length; i++) {
    stroke(beach.back[i] as Point, beach.back[i + 1] as Point, DUNE_COL, 0);
  }
  const pier = beach.pier;
  if (pier === undefined) continue;
  for (let i = 0; i < pier.polygon.length; i++) {
    stroke(pier.polygon[i] as Point, pier.polygon[(i + 1) % pier.polygon.length] as Point, PIER_COL, 0);
  }
}

// Widest tier last, so a highway is never hidden under the streets beside it.
const TIER_ORDER: RoadTier[] = ['alley', 'dirt', 'street', 'arterial', 'highway'];
for (const road of [...world.roads].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))) {
  const style = ROAD_STYLE[road.tier];
  for (let i = 0; i + 1 < road.points.length; i++) {
    const bridge = road.bridges.includes(i);
    const tunnel = road.tunnels.includes(i);
    const col = bridge ? BRIDGE_COL : tunnel ? TUNNEL_COL : style.col;
    stroke(road.points[i] as Point, road.points[i + 1] as Point, col, bridge || tunnel ? 1 : style.half);
  }
}

// Corridors (spec section 6.3): the outline of the ground each one claims. The
// tram's reserved lane is drawn over its route, the pillar feet under a deck as
// single dots, and a level crossing as a small mark.
const CORRIDOR_COL = { elevated: [255, 200, 60] as [number, number, number], tram: [230, 60, 230] as [number, number, number] };
const PILLAR_COL: [number, number, number] = [40, 40, 40];
for (const corridor of world.corridors) {
  const col = CORRIDOR_COL[corridor.kind];
  for (let i = 0; i < corridor.polygon.length; i++) {
    stroke(corridor.polygon[i] as Point, corridor.polygon[(i + 1) % corridor.polygon.length] as Point, col, 0);
  }
  for (const p of corridor.pillars) {
    const [px, py] = cellOf(p.x, p.y);
    plot(px, n - 1 - py, PILLAR_COL);
  }
}
for (let i = 0; i + 1 < world.tram.route.length; i++) {
  stroke(world.tram.route[i] as Point, world.tram.route[i + 1] as Point, CORRIDOR_COL.tram, 0);
}

const mark = (x: number, y: number, col: [number, number, number], size = 3): void => {
  const ix = Math.round((x - hf.originX) / hf.cellSize);
  const iy = Math.round((y - hf.originY) / hf.cellSize);
  for (let dy = -size; dy <= size; dy++) {
    for (let dx = -size; dx <= size; dx++) {
      const px = ix + dx;
      const py = n - 1 - (iy + dy);
      if (px < 0 || py < 0 || px >= n || py >= n) continue;
      const o = (py * n + px) * 3;
      rgb[o] = col[0];
      rgb[o + 1] = col[1];
      rgb[o + 2] = col[2];
    }
  }
};
// The interchanges of the highways: the only points a highway takes a junction at.
for (const road of world.roads) {
  for (const at of road.interchanges) mark((road.points[at] as Point).x, (road.points[at] as Point).y, [180, 255, 60], 2);
}
for (const d of world.districts) mark(d.x, d.y, d.culture === 'none' ? [255, 255, 255] : [255, 0, 255]);
for (const c of world.water.crossings) {
  mark(c.from.x, c.from.y, [255, 255, 0]);
  mark(c.to.x, c.to.y, [255, 255, 0]);
}
for (const c of world.tram.crossings) mark(c.x, c.y, [255, 255, 255], 1);
for (const s of world.tram.stops) mark(s.x, s.y, [255, 60, 160], 2);

writeFileSync(out, encodePng(n, n, rgb));
const perTier = TIER_ORDER.map((t) => `${t} ${world.roads.filter((r) => r.tier === t).length}`).join(', ');
console.log(
  `seed ${seedText} size ${world.size} m, ${n}x${n}, ${world.water.islands.length} islands, ${world.water.crossings.length} crossings, ` +
    `generated in ${genMs.toFixed(0)} ms, tensor field in ${fieldMs.toFixed(0)} ms → ${out}`,
);
console.log(`  roads: ${perTier}`);
let movedNodes = 0;
let deepestCut = 0;
let highestFill = 0;
for (let i = 0; i < ground.heights.length; i++) {
  const change = (ground.heights[i] as number) - (world.terrain.heights[i] as number);
  if (change === 0) continue;
  movedNodes++;
  deepestCut = Math.max(deepestCut, -change);
  highestFill = Math.max(highestFill, change);
}
console.log(
  `  carve: ${carve.segments} segments on the ground moved ${((movedNodes / ground.heights.length) * 100).toFixed(0)} % of the grid, ` +
    `deepest cut ${deepestCut.toFixed(1)} m, highest fill ${highestFill.toFixed(1)} m, built in ${carveMs.toFixed(0)} ms`,
);
console.log(
  `  footprint: ${footprint.regions.length} pieces with ` +
    `${footprint.regions.reduce((k, r) => k + r.holes.length, 0)} blocks inside them, ` +
    `${(footprint.area / 1e6).toFixed(2)} km² claimed, built in ${footprintMs.toFixed(0)} ms`,
);
const owners = parcels.parcels.reduce<Partial<Record<ParcelOwner, number>>>((tally, p) => {
  tally[p.owner] = (tally[p.owner] ?? 0) + 1;
  return tally;
}, {});
console.log(
  `  parcels: ${parcels.parcels.length} covering ${(parcels.area / 1e6).toFixed(2)} km², ` +
    `cut in ${parcelMs.toFixed(0)} ms — ` +
    (['building', 'park', 'car-park', 'plaza', 'beach', 'ground'] as ParcelOwner[])
      .map((o) => `${o} ${owners[o] ?? 0}`)
      .join(', '),
);
const elevated = world.corridors.filter((c) => c.kind === 'elevated');
console.log(
  `  corridors: ${elevated.length} elevated with ${elevated.reduce((k, c) => k + c.pillars.length, 0)} pillars, ` +
    `${world.corridors.length - elevated.length} tram; tram loop ${(world.tram.length / 1000).toFixed(1)} km, ` +
    `${world.tram.stops.length} stops, ${world.tram.crossings.length} level crossings`,
);
for (const d of world.districts) console.log(`  ${d.id}\t${d.zone.padEnd(10)}\t${d.name.padEnd(18)}\t${d.culture}`);
