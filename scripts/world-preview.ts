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
import type { Zone } from '../src/world/types.ts';
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
for (const d of world.districts) mark(d.x, d.y, d.culture === 'none' ? [255, 255, 255] : [255, 0, 255]);
for (const c of world.water.crossings) {
  mark(c.from.x, c.from.y, [255, 255, 0]);
  mark(c.to.x, c.to.y, [255, 255, 0]);
}

writeFileSync(out, encodePng(n, n, rgb));
console.log(
  `seed ${seedText} size ${world.size} m, ${n}x${n}, ${world.water.islands.length} islands, ${world.water.crossings.length} crossings, ` +
    `generated in ${genMs.toFixed(0)} ms, tensor field in ${fieldMs.toFixed(0)} ms → ${out}`,
);
for (const d of world.districts) console.log(`  ${d.id}\t${d.zone.padEnd(10)}\t${d.name.padEnd(18)}\t${d.culture}`);
