import { TerrainGenerator } from 'three/examples/jsm/generators/TerrainGenerator.js';
import { clamp, lerp, smoothstep } from '../core/math.ts';
import { Noise2D } from '../core/noise.ts';
import { genRng, Subsystem } from '../core/rng.ts';
import { Heightfield } from './heightfield.ts';
import type { Crossing, Island, Point, RiverDescription, WaterDescription } from './types.ts';

/** Metres between height samples. */
export const TERRAIN_CELL = 10;
export const SEA_LEVEL = 0;

export interface TerrainLayout {
  size: number;
  core: Point;
  islands: Island[];
  /** Half the nominal width of the straits between islands. */
  channelHalf: number;
  /** Sea band around the map edge. */
  seaMargin: number;
  harbour: { x: number; y: number; radius: number };
  river: RiverDescription;
}

/** Power-diagram distance from a point to an island's site; smaller wins the cell. */
function power(isl: Island, x: number, y: number): number {
  const dx = x - isl.x;
  const dy = y - isl.y;
  return dx * dx + dy * dy - isl.radius * isl.radius;
}

/** Index of the island whose cell contains the point. */
export function islandIndexAt(islands: readonly Island[], x: number, y: number): number {
  let best = 0;
  let bestP = Infinity;
  for (let i = 0; i < islands.length; i++) {
    const p = power(islands[i] as Island, x, y);
    if (p < bestP) {
      bestP = p;
      best = i;
    }
  }
  return best;
}

/**
 * Distance from a point inside cell `i` to the cell's boundary (positive inside),
 * taking the map's sea margin as one more boundary.
 */
function cellDepth(layout: TerrainLayout, i: number, x: number, y: number): number {
  const islands = layout.islands;
  const me = islands[i] as Island;
  const pMe = power(me, x, y);
  let depth = Infinity;
  for (let j = 0; j < islands.length; j++) {
    if (j === i) continue;
    const other = islands[j] as Island;
    const d = Math.hypot(other.x - me.x, other.y - me.y);
    if (d === 0) continue;
    const toBisector = (power(other, x, y) - pMe) / (2 * d);
    if (toBisector < depth) depth = toBisector;
  }
  const half = layout.size / 2 - layout.seaMargin;
  const edge = Math.min(half - Math.abs(x), half - Math.abs(y));
  return Math.min(depth, edge);
}

/**
 * Signed distance to the nearest coastline: negative inland, positive at sea.
 * Each island is its cell shrunk by half a channel, with a wandering shore.
 */
export function coastOffset(layout: TerrainLayout, noise: Noise2D, x: number, y: number): number {
  // Domain warp: bends the straits sideways without ever closing them, since the
  // whole partition is displaced together.
  const amp = layout.size * 0.06;
  const wx = x + noise.fbm(x / 1400 + 3.7, y / 1400 + 1.9, 2, 2, 0.5) * amp;
  const wy = y + noise.fbm(x / 1400 + 8.1, y / 1400 + 6.3, 2, 2, 0.5) * amp;
  const i = islandIndexAt(layout.islands, wx, wy);
  const depth = cellDepth(layout, i, wx, wy);
  const detail = noise.fbm(x / 150 + 9.2, y / 150 + 4.4, 2) * 16;
  return layout.channelHalf - depth + detail;
}

/** Lloyd relaxation of the outer sites (the main site stays at the core) so each sits deep inside its cell. */
function relaxSites(islands: Island[], size: number): void {
  const n = 40;
  for (let iter = 0; iter < 3; iter++) {
    const sx = new Float64Array(islands.length);
    const sy = new Float64Array(islands.length);
    const cnt = new Float64Array(islands.length);
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const x = ((ix + 0.5) / n - 0.5) * size;
        const y = ((iy + 0.5) / n - 0.5) * size;
        const k = islandIndexAt(islands, x, y);
        sx[k] = (sx[k] as number) + x;
        sy[k] = (sy[k] as number) + y;
        cnt[k] = (cnt[k] as number) + 1;
      }
    }
    for (let k = 1; k < islands.length; k++) {
      const c = cnt[k] as number;
      if (c === 0) continue;
      const isl = islands[k] as Island;
      isl.x = (sx[k] as number) / c;
      isl.y = (sy[k] as number) / c;
    }
  }
}

/** Choose the archipelago: a few large islands separated by narrow straits, then the river and harbour. */
export function layoutTerrain(seed: number, size: number): TerrainLayout {
  const rng = genRng(seed, Subsystem.Water, 1);
  const noise = new Noise2D(seed ^ 0x7e44);
  const islands: Island[] = [];
  // The main island's site is the core; its weight makes it the largest cell.
  islands.push({ id: 0, x: 0, y: 0, radius: size * rng.range(0.16, 0.2), main: true });

  const count = rng.int(2, 4);
  const minSpacing = size * 0.34;
  for (let i = 1; i <= count; i++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = rng.range(-0.42, 0.42) * size;
      const y = rng.range(-0.42, 0.42) * size;
      let ok = Math.hypot(x, y) >= minSpacing;
      for (const other of islands) if (Math.hypot(other.x - x, other.y - y) < minSpacing) ok = false;
      if (!ok) continue;
      islands.push({ id: i, x, y, radius: size * rng.range(0.04, 0.1), main: false });
      break;
    }
  }

  relaxSites(islands, size);

  const layout: TerrainLayout = {
    size,
    core: { x: 0, y: 0 },
    islands,
    channelHalf: size * rng.range(0.018, 0.026),
    seaMargin: size * 0.04,
    harbour: { x: 0, y: 0, radius: size * 0.035 },
    river: { path: [], halfWidths: [] },
  };

  // River: from the main island's interior to its shore, harbour at the mouth. The mouth faces
  // the widest stretch of the main island's own coast, found by walking outward from the core.
  const mouthAngle = rng.range(-Math.PI, Math.PI);
  let mouth: Point = { x: 0, y: 0 };
  let bestReach = -Infinity;
  for (let k = 0; k < 16; k++) {
    const a = mouthAngle + (k / 16) * Math.PI * 2;
    let reach = 0;
    for (let s = 0; s < size; s += 20) {
      if (coastOffset(layout, noise, Math.cos(a) * s, Math.sin(a) * s) > 0) break;
      reach = s;
    }
    if (reach > bestReach) {
      bestReach = reach;
      mouth = { x: Math.cos(a) * reach, y: Math.sin(a) * reach };
    }
  }
  const mouthDir = Math.atan2(mouth.y, mouth.x);
  const sourceAngle = mouthDir + Math.PI + (rng.chance(0.5) ? 1 : -1) * rng.range(0.6, 1.3);
  let sourceReach = 0;
  for (let s = 0; s < size; s += 20) {
    if (coastOffset(layout, noise, Math.cos(sourceAngle) * s, Math.sin(sourceAngle) * s) > -80) break;
    sourceReach = s;
  }
  let source: Point = { x: Math.cos(sourceAngle) * sourceReach * 0.3, y: Math.sin(sourceAngle) * sourceReach * 0.3 };
  for (let f = 0.6; f >= 0.3; f -= 0.05) {
    const candidate = { x: Math.cos(sourceAngle) * sourceReach * f, y: Math.sin(sourceAngle) * sourceReach * f };
    if (coastOffset(layout, noise, candidate.x, candidate.y) < -200) {
      source = candidate;
      break;
    }
  }
  layout.river = traceRiver(seed, source, mouth, size);
  layout.harbour = { x: mouth.x, y: mouth.y, radius: size * 0.035 };
  return layout;
}

function traceRiver(seed: number, source: Point, mouth: Point, size: number): RiverDescription {
  const noise = new Noise2D(seed ^ 0x51e4);
  const steps = 96;
  const path: Point[] = [];
  const halfWidths: number[] = [];
  const dx = mouth.x - source.x;
  const dy = mouth.y - source.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Meander fades to zero at both ends so the source and mouth stay put.
    const envelope = Math.sin(t * Math.PI);
    const meander = noise.fbm(t * 3.2 + 3.1, 0.7, 2, 2, 0.35) * size * 0.05 * envelope;
    path.push({ x: source.x + dx * t + nx * meander, y: source.y + dy * t + ny * meander });
    halfWidths.push(lerp(size * 0.003, size * 0.009, smoothstep(0, 1, t)));
  }
  return { path, halfWidths };
}

/** Bake the full heightfield for a world. */
export function generateTerrain(seed: number, layout: TerrainLayout): Heightfield {
  const size = layout.size;
  const segments = Math.round(size / TERRAIN_CELL);
  const gridSize = segments + 1;
  const hf = Heightfield.create(gridSize, TERRAIN_CELL);
  const noise = new Noise2D(seed ^ 0x7e44);

  // Raw fractal relief from the three.js generator, normalised to [0, 1].
  const gen = new TerrainGenerator({
    seed: seed & 0x7fffffff,
    size,
    segments,
    frequency: 3.2 / size,
    octaves: 6,
    heightScale: 1,
    // A fractional valleyBias raises a slightly negative noise sum to a fractional power and yields NaN;
    // 1 keeps the generator's own maths finite.
    valleyBias: 1,
    talusPasses: 4,
  });
  gen.build();
  const raw = gen.heights as Float32Array;
  gen.dispose();
  let rawMin = Infinity;
  let rawMax = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i] as number;
    if (!Number.isFinite(v)) continue;
    if (v < rawMin) rawMin = v;
    if (v > rawMax) rawMax = v;
  }
  const rawRange = Math.max(1e-6, rawMax - rawMin);

  for (let iy = 0; iy < gridSize; iy++) {
    const y = hf.worldY(iy);
    for (let ix = 0; ix < gridSize; ix++) {
      const x = hf.worldX(ix);
      const rawH = raw[iy * gridSize + ix] as number;
      const relief = Number.isFinite(rawH) ? (rawH - rawMin) / rawRange : 0;
      const dCore = Math.hypot(x - layout.core.x, y - layout.core.y);
      const coast = coastOffset(layout, noise, x, y);

      // Land: gentle near the core, steep hills far from it and deep inland.
      const inland = smoothstep(0, size * 0.09, -coast);
      const amplitude = lerp(12, 140, smoothstep(0.1 * size, 0.42 * size, dCore)) * lerp(0.2, 1, inland);
      const base = 2.5 + 18 * smoothstep(0.06 * size, 0.4 * size, dCore) * inland;
      let land = base + relief * amplitude;
      // Fall to the shoreline over the last stretch of coast.
      land = lerp(land, 1.5, smoothstep(-220, -15, coast));

      // Sea floor deepens away from the shore; channels between islands stay shallow.
      const sea = -2 - 14 * smoothstep(0, size * 0.05, coast);
      const h = coast < 0 ? land : lerp(land, sea, smoothstep(0, 35, coast));
      hf.set(ix, iy, h);
    }
  }

  carveRiver(hf, layout.river);
  carveHarbour(hf, layout.harbour);
  return hf;
}

/** Cut the river valley: bed below sea level, banks blending into the hillside. */
function carveRiver(hf: Heightfield, river: RiverDescription): void {
  const bed = -4;
  const bank = 70;
  const path = river.path;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i] as Point;
    const b = path[i + 1] as Point;
    const hw = river.halfWidths[i] as number;
    const reach = hw + bank;
    const minX = Math.min(a.x, b.x) - reach;
    const maxX = Math.max(a.x, b.x) + reach;
    const minY = Math.min(a.y, b.y) - reach;
    const maxY = Math.max(a.y, b.y) + reach;
    const ix0 = clamp(Math.floor((minX - hf.originX) / hf.cellSize), 0, hf.gridSize - 1);
    const ix1 = clamp(Math.ceil((maxX - hf.originX) / hf.cellSize), 0, hf.gridSize - 1);
    const iy0 = clamp(Math.floor((minY - hf.originY) / hf.cellSize), 0, hf.gridSize - 1);
    const iy1 = clamp(Math.ceil((maxY - hf.originY) / hf.cellSize), 0, hf.gridSize - 1);
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = hf.worldX(ix);
        const y = hf.worldY(iy);
        const d = segmentDistance(x, y, a, b);
        if (d > reach) continue;
        const h = hf.at(ix, iy);
        const target = d < hw ? bed : lerp(bed, h, smoothstep(hw, reach, d));
        if (target < h) hf.set(ix, iy, target);
      }
    }
  }
}

function carveHarbour(hf: Heightfield, harbour: { x: number; y: number; radius: number }): void {
  const depth = -9;
  const reach = harbour.radius + 60;
  const ix0 = clamp(Math.floor((harbour.x - reach - hf.originX) / hf.cellSize), 0, hf.gridSize - 1);
  const ix1 = clamp(Math.ceil((harbour.x + reach - hf.originX) / hf.cellSize), 0, hf.gridSize - 1);
  const iy0 = clamp(Math.floor((harbour.y - reach - hf.originY) / hf.cellSize), 0, hf.gridSize - 1);
  const iy1 = clamp(Math.ceil((harbour.y + reach - hf.originY) / hf.cellSize), 0, hf.gridSize - 1);
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const d = Math.hypot(hf.worldX(ix) - harbour.x, hf.worldY(iy) - harbour.y);
      if (d > reach) continue;
      const h = hf.at(ix, iy);
      const target = d < harbour.radius ? depth : lerp(depth, h, smoothstep(harbour.radius, reach, d));
      if (target < h) hf.set(ix, iy, target);
    }
  }
}

export function segmentDistance(px: number, py: number, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((px - a.x) * vx + (py - a.y) * vy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (a.x + vx * t), py - (a.y + vy * t));
}

/**
 * Shore-to-shore crossings between neighbouring islands, along the line between
 * their sites. Only pairs whose cells touch (no third cell in between) qualify.
 */
export function findCrossings(hf: Heightfield, layout: TerrainLayout): Crossing[] {
  const out: Crossing[] = [];
  const islands = layout.islands;
  for (let i = 0; i < islands.length; i++) {
    for (let j = i + 1; j < islands.length; j++) {
      const a = islands[i] as Island;
      const b = islands[j] as Island;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const ux = dx / len;
      const uy = dy / len;
      // Sample ownership and wetness along the line; the strait is the wet run around the ownership flip.
      const step = hf.cellSize / 2;
      const count = Math.floor(len / step);
      let flip = -1;
      let adjacent = true;
      const wet: boolean[] = [];
      for (let k = 0; k <= count; k++) {
        const x = a.x + ux * k * step;
        const y = a.y + uy * k * step;
        const owner = islandIndexAt(islands, x, y);
        if (owner !== i && owner !== j) {
          adjacent = false;
          break;
        }
        if (owner === j && flip < 0) flip = k;
        wet.push(hf.sample(x, y) < SEA_LEVEL);
      }
      if (!adjacent || flip < 0) continue;
      let lo = flip;
      let hi = flip;
      if (!wet[flip]) {
        // The flip landed on land (a wandering shore); find the nearest wet sample.
        let found = -1;
        for (let d = 1; d < count && found < 0; d++) {
          if (wet[flip - d]) found = flip - d;
          else if (wet[flip + d]) found = flip + d;
        }
        if (found < 0) continue;
        lo = hi = found;
      }
      while (lo > 0 && wet[lo - 1]) lo--;
      while (hi < count && wet[hi + 1]) hi++;
      if (lo === 0 || hi === count) continue;
      // Slide along the strait (perpendicular to the site line) looking for its narrowest point.
      const mid = (lo + hi) / 2;
      const mx = a.x + ux * mid * step;
      const my = a.y + uy * mid * step;
      let best = narrowestChord(hf, mx, my, ux, uy);
      let bestSpan = Math.hypot(best.to.x - best.from.x, best.to.y - best.from.y);
      for (const sign of [-1, 1]) {
        for (let d = 40; d <= layout.size * 0.15; d += 40) {
          const px = mx - uy * d * sign;
          const py = my + ux * d * sign;
          if (hf.sample(px, py) >= SEA_LEVEL) break;
          const candidate = narrowestChord(hf, px, py, ux, uy);
          const span = Math.hypot(candidate.to.x - candidate.from.x, candidate.to.y - candidate.from.y);
          if (span < bestSpan) {
            bestSpan = span;
            best = candidate;
          }
        }
      }
      const { from, to } = best;
      out.push({ fromIsland: a.id, toIsland: b.id, from, to });
    }
  }
  return out;
}

/** From a point in a strait, the shortest shore-to-shore chord through it, tried over a fan of directions. */
function narrowestChord(hf: Heightfield, mx: number, my: number, ux: number, uy: number): { from: Point; to: Point } {
  const step = hf.cellSize / 2;
  const base = Math.atan2(uy, ux);
  let best: { from: Point; to: Point; span: number } | undefined;
  for (let k = -6; k <= 6; k++) {
    const a = base + (k * Math.PI) / 16;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const back = shoreAlong(hf, mx, my, -dx, -dy, step);
    const fore = shoreAlong(hf, mx, my, dx, dy, step);
    if (!back || !fore) continue;
    const span = Math.hypot(fore.x - back.x, fore.y - back.y);
    if (!best || span < best.span) best = { from: back, to: fore, span };
  }
  return best ?? { from: { x: mx - ux * step, y: my - uy * step }, to: { x: mx + ux * step, y: my + uy * step } };
}

function shoreAlong(hf: Heightfield, x: number, y: number, dx: number, dy: number, step: number): Point | undefined {
  const limit = hf.extent;
  for (let s = 0; s < limit; s += step) {
    const px = x + dx * s;
    const py = y + dy * s;
    if (Math.abs(px) > hf.extent / 2 || Math.abs(py) > hf.extent / 2) return undefined;
    if (hf.sample(px, py) >= SEA_LEVEL) {
      const inland = { x: px + dx * step, y: py + dy * step };
      return hf.sample(inland.x, inland.y) >= SEA_LEVEL ? inland : { x: px, y: py };
    }
  }
  return undefined;
}

export function describeWater(hf: Heightfield, layout: TerrainLayout): WaterDescription {
  return {
    seaLevel: SEA_LEVEL,
    islands: layout.islands,
    crossings: findCrossings(hf, layout),
    river: layout.river,
    harbour: layout.harbour,
  };
}
