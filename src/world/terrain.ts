import { TerrainGenerator } from 'three/examples/jsm/generators/TerrainGenerator.js';
import { lerp, smoothstep } from '../core/math.ts';
import { Noise2D } from '../core/noise.ts';
import { genRng, Subsystem } from '../core/rng.ts';
import { archetypeFor, type CoastProfile, type TerrainArchetype } from './archetype.ts';
import { Heightfield } from './heightfield.ts';
import { carveHarbour, carveRiver, planWater, segmentDistance, type Harbour } from './rivers.ts';
import { placeSites } from './sites.ts';
import type { Island, Point, RiverDescription, Site } from './types.ts';

export { segmentDistance } from './rivers.ts';

/** Metres between height samples of the whole-map skeleton. */
export const TERRAIN_CELL = 10;
/**
 * Metres between height samples of a streamed chunk (spec section 9.1). The
 * camera looks down from 60 m at a street 11 m wide, so the ground under it
 * needs samples finer than the road: on the skeleton's grid a bench is one
 * cell across and the hillside between two samples cuts up through the
 * carriageway. Four samples to a skeleton cell, so the far ring can read every
 * fourth one and land back on the skeleton's grid.
 */
export const CHUNK_TERRAIN_CELL = 2.5;
export const SEA_LEVEL = 0;

/**
 * Every cell of the power diagram as flat arrays, land and sea alike, because
 * the coast reads them once per terrain sample. `mass` is the index of the
 * island a cell belongs to, or -1 for a cell of open sea.
 */
export interface PowerCells {
  x: Float64Array;
  y: Float64Array;
  /** The squared weight. */
  w2: Float64Array;
  mass: Int32Array;
}

export interface TerrainLayout {
  size: number;
  /** The bundle of numbers this layout was drawn with. */
  archetype: TerrainArchetype;
  core: Point;
  islands: Island[];
  /** Cells of open sea: a bay, a strait or a lagoon. */
  seas: Site[];
  cells: PowerCells;
  /** The ridge line the relief climbs towards, for an archetype whose relief is keyed to one. */
  spine: { from: Point; to: Point } | undefined;
  /** Half the nominal width of the straits between islands. */
  channelHalf: number;
  /** Sea band around the map edge. */
  seaMargin: number;
  harbour: Harbour;
  rivers: RiverDescription[];
}

/** Salt of the noise that draws the coastline. Everything that asks where the shore runs uses this one stream. */
const COAST_SALT = 0x7e44;
/** Reused by {@link coastOffset}, which runs once per terrain sample. Never escapes. */
const WARP_SCRATCH: Point = { x: 0, y: 0 };

/** The noise the coastline is drawn with, and the shape of coast the seed's archetype draws with it. */
export class CoastNoise extends Noise2D {
  readonly profile: CoastProfile;

  constructor(seed: number, profile: CoastProfile) {
    super(seed);
    this.profile = profile;
  }
}

/** The noise the coastline is drawn with, rebuilt from the seed. */
export function coastNoise(seed: number, archetype: TerrainArchetype = archetypeFor(seed)): CoastNoise {
  return new CoastNoise(seed ^ COAST_SALT, archetype.coast);
}

/**
 * The domain warp applied before the island partition is read. Island cells only
 * line up with the coastline in warped space, so any question about which island
 * a point belongs to has to ask here first. `out` is written and returned.
 */
export function warpPoint(noise: CoastNoise, size: number, x: number, y: number, out: Point): Point {
  const { warp, warpWavelength: w } = noise.profile;
  const amp = size * warp;
  out.x = x + noise.fbm(x / w + 3.7, y / w + 1.9, 2, 2, 0.5) * amp;
  out.y = y + noise.fbm(x / w + 8.1, y / w + 6.3, 2, 2, 0.5) * amp;
  return out;
}

/**
 * Index of the island whose cell contains the point. The sea cells take no part:
 * a point on dry land stands in the same island's cell with them or without
 * them, and a point in the water belongs to no island at all.
 */
export function islandIndexAt(islands: readonly Island[], x: number, y: number): number {
  let best = 0;
  let bestP = Infinity;
  for (let i = 0; i < islands.length; i++) {
    const isl = islands[i] as Island;
    for (const c of isl.cells ?? [isl]) {
      const p = (x - c.x) ** 2 + (y - c.y) ** 2 - c.radius * c.radius;
      if (p < bestP) {
        bestP = p;
        best = i;
      }
    }
  }
  return best;
}

/**
 * Which island's land a point stands on: the cell of the warped point, since
 * that is the partition the coastline was cut from. Callers that classify world
 * points — roads picking a bridge head, a test asking where a district is —
 * must use this rather than {@link islandIndexAt}, which reads the raw cells.
 */
export function islandAt(islands: readonly Island[], size: number, noise: CoastNoise, x: number, y: number): number {
  const w = warpPoint(noise, size, x, y, WARP_SCRATCH);
  return islandIndexAt(islands, w.x, w.y);
}

/** Flatten the land cells of every island and the sea cells into one table. */
function powerCells(islands: readonly Island[], seas: readonly Site[]): PowerCells {
  const all: { site: Site; mass: number }[] = [];
  islands.forEach((isl, i) => {
    for (const site of isl.cells ?? [isl]) all.push({ site, mass: i });
  });
  for (const site of seas) all.push({ site, mass: -1 });
  const cells: PowerCells = {
    x: new Float64Array(all.length),
    y: new Float64Array(all.length),
    w2: new Float64Array(all.length),
    mass: new Int32Array(all.length),
  };
  all.forEach(({ site, mass }, k) => {
    cells.x[k] = site.x;
    cells.y[k] = site.y;
    cells.w2[k] = site.radius * site.radius;
    cells.mass[k] = mass;
  });
  return cells;
}

/**
 * Signed distance to the nearest coastline: negative inland, positive at sea.
 * Each island is the union of its cells, shrunk by half a channel wherever it
 * meets another island or a cell of sea, with a wandering shore. A cell of sea
 * reads the same distance with the sign turned, so the coast is continuous
 * across the boundary between the two.
 */
export function coastOffset(layout: TerrainLayout, noise: CoastNoise, x: number, y: number): number {
  // Domain warp: bends the straits sideways without ever closing them, since the
  // whole partition is displaced together.
  const { x: wx, y: wy } = warpPoint(noise, layout.size, x, y, WARP_SCRATCH);
  const cells = layout.cells;
  const n = cells.mass.length;
  let k = 0;
  let pk = Infinity;
  for (let j = 0; j < n; j++) {
    const p = (wx - (cells.x[j] as number)) ** 2 + (wy - (cells.y[j] as number)) ** 2 - (cells.w2[j] as number);
    if (p < pk) {
      pk = p;
      k = j;
    }
  }
  // Distance to the nearest bisector with a cell of another island or of the sea.
  const mass = cells.mass[k] as number;
  const kx = cells.x[k] as number;
  const ky = cells.y[k] as number;
  let depth = Infinity;
  for (let j = 0; j < n; j++) {
    const other = cells.mass[j] as number;
    // Two cells of one island are one land, and two cells of sea are one water.
    if (other === mass) continue;
    const d = Math.hypot((cells.x[j] as number) - kx, (cells.y[j] as number) - ky);
    if (d === 0) continue;
    const pj = (wx - (cells.x[j] as number)) ** 2 + (wy - (cells.y[j] as number)) ** 2 - (cells.w2[j] as number);
    const toBisector = (pj - pk) / (2 * d);
    if (toBisector < depth) depth = toBisector;
  }
  const { wavelength, amplitude } = noise.profile;
  const detail = noise.fbm(x / wavelength + 9.2, y / wavelength + 4.4, 2) * amplitude;
  if (mass < 0) return layout.channelHalf + depth + detail;
  const half = layout.size / 2 - layout.seaMargin;
  const edge = Math.min(half - Math.abs(wx), half - Math.abs(wy));
  return layout.channelHalf - Math.min(depth, edge) + detail;
}

/** Choose the islands and seas the seed's archetype asks for, then its rivers and its harbour. */
export function layoutTerrain(seed: number, size: number, archetype: TerrainArchetype = archetypeFor(seed)): TerrainLayout {
  const rng = genRng(seed, Subsystem.Water, 1);
  const noise = coastNoise(seed, archetype);
  const sites = placeSites(archetype, rng, size);
  const layout: TerrainLayout = {
    size,
    archetype,
    core: { x: 0, y: 0 },
    islands: sites.islands,
    seas: sites.seas,
    cells: powerCells(sites.islands, sites.seas),
    spine: sites.spine,
    channelHalf: size * rng.range(archetype.sites.channelHalf.min, archetype.sites.channelHalf.max),
    seaMargin: size * archetype.sites.seaMargin,
    harbour: { x: 0, y: 0, radius: 0 },
    rivers: [],
  };
  for (let i = 0; i < layout.islands.length; i++) standOnLand(layout, noise, i);
  const water = planWater(seed, archetype, sites, rng, size, (x, y) => coastOffset(layout, noise, x, y));
  layout.rivers = water.rivers;
  layout.harbour = water.harbour;
  return layout;
}

/**
 * Move the named site of an outer island of several cells, or of one cell
 * weighted apart from its size, to the place deepest inside its own land. The
 * power diagram reads the cells, never this site, so nothing about the land
 * moves; what moves is where a district or a crossing search looks for the
 * island, which has to be dry ground.
 */
function standOnLand(layout: TerrainLayout, noise: CoastNoise, index: number): void {
  const isl = layout.islands[index] as Island;
  const cells = isl.cells;
  if (isl.main || cells === undefined) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cells) {
    minX = Math.min(minX, c.x - c.radius);
    minY = Math.min(minY, c.y - c.radius);
    maxX = Math.max(maxX, c.x + c.radius);
    maxY = Math.max(maxY, c.y + c.radius);
  }
  const half = layout.size / 2;
  const step = layout.size / 120;
  let best = coastOffset(layout, noise, isl.x, isl.y);
  if (islandAt(layout.islands, layout.size, noise, isl.x, isl.y) !== index) best = Infinity;
  for (let y = Math.max(-half, minY); y <= Math.min(half, maxY); y += step) {
    for (let x = Math.max(-half, minX); x <= Math.min(half, maxX); x += step) {
      const coast = coastOffset(layout, noise, x, y);
      if (coast >= best || islandAt(layout.islands, layout.size, noise, x, y) !== index) continue;
      best = coast;
      isl.x = x;
      isl.y = y;
    }
  }
}

/** Bake the full heightfield for a world. */
export function generateTerrain(seed: number, layout: TerrainLayout): Heightfield {
  const size = layout.size;
  const segments = Math.round(size / TERRAIN_CELL);
  const gridSize = segments + 1;
  const hf = Heightfield.create(gridSize, TERRAIN_CELL);
  const noise = coastNoise(seed, layout.archetype);

  // Raw fractal relief from the three.js generator, normalised to [0, 1].
  const relief = layout.archetype.relief;
  const gen = new TerrainGenerator({
    seed: seed & 0x7fffffff,
    size,
    segments,
    frequency: relief.frequency / size,
    octaves: relief.octaves,
    heightScale: 1,
    // A fractional valleyBias raises a slightly negative noise sum to a fractional power and yields NaN;
    // 1 keeps the generator's own maths finite.
    valleyBias: 1,
    talusPasses: relief.talusPasses,
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
  // From the core the relief climbs outward; from a spine it climbs inward.
  const spine = relief.keyedTo === 'spine' ? layout.spine : undefined;

  for (let iy = 0; iy < gridSize; iy++) {
    const y = hf.worldY(iy);
    for (let ix = 0; ix < gridSize; ix++) {
      const x = hf.worldX(ix);
      const rawH = raw[iy * gridSize + ix] as number;
      const rough = Number.isFinite(rawH) ? (rawH - rawMin) / rawRange : 0;
      const coast = coastOffset(layout, noise, x, y);

      // Land: gentle near the core, or far from the spine; steep far from the one or close to the other, and deep inland.
      const inland = smoothstep(0, size * 0.09, -coast);
      let ramp: number;
      let rise: number;
      if (spine === undefined) {
        const d = Math.hypot(x - layout.core.x, y - layout.core.y);
        ramp = smoothstep(relief.rampFrom * size, relief.rampTo * size, d);
        rise = smoothstep(relief.baseFrom * size, relief.baseTo * size, d);
      } else {
        const d = segmentDistance(x, y, spine.from, spine.to);
        ramp = 1 - smoothstep(relief.rampFrom * size, relief.rampTo * size, d);
        rise = 1 - smoothstep(relief.baseFrom * size, relief.baseTo * size, d);
      }
      const amplitude = lerp(relief.nearAmplitude, relief.farAmplitude, ramp) * lerp(0.2, 1, inland);
      const base = 2.5 + relief.baseRise * rise * inland;
      let land = base + rough * amplitude;
      // Fall to the shoreline over the last stretch of coast.
      land = lerp(land, 1.5, smoothstep(-220, -15, coast));

      // Sea floor deepens away from the shore; channels between islands stay shallow.
      const sea = -2 - 14 * smoothstep(0, size * 0.05, coast);
      const h = coast < 0 ? land : lerp(land, sea, smoothstep(0, 35, coast));
      hf.set(ix, iy, h);
    }
  }

  for (const river of layout.rivers) carveRiver(hf, river);
  carveHarbour(hf, layout.harbour);
  return hf;
}
