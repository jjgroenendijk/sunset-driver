/**
 * Render a top-down map of a seed's world description to a PNG for eyeballing.
 * Usage: node scripts/world-preview.ts [seed] [out.png]
 */
import { writeFileSync } from 'node:fs';
import { seedFromString } from '../src/core/rng.ts';
import { districtAt, layoutZones } from '../src/world/districts.ts';
import { Heightfield } from '../src/world/heightfield.ts';
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
    const h = hf.at(ix, iy);
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
      const shade = 0.6 + 0.4 * (1 - Math.min(1, hf.slope(x, y) * 2));
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
const elevated = world.corridors.filter((c) => c.kind === 'elevated');
console.log(
  `  corridors: ${elevated.length} elevated with ${elevated.reduce((k, c) => k + c.pillars.length, 0)} pillars, ` +
    `${world.corridors.length - elevated.length} tram; tram loop ${(world.tram.length / 1000).toFixed(1)} km, ` +
    `${world.tram.stops.length} stops, ${world.tram.crossings.length} level crossings`,
);
for (const d of world.districts) console.log(`  ${d.id}\t${d.zone.padEnd(10)}\t${d.name.padEnd(18)}\t${d.culture}`);
