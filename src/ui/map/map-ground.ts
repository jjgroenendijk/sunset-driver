/**
 * The ground of the map of spec section 12: the land and the sea as one bitmap,
 * one pixel to a terrain cell. `MapArt` builds it once for a session and draws
 * it scaled at every zoom; the coastline is the one thing on the map a soft
 * edge suits.
 *
 * Four things go into a pixel. The sea darkens with depth, so a channel reads
 * as a channel. The land takes the colour of the kind of district it is in, so
 * the dense core reads apart from the green edge of the map. The hills are
 * lit from the north-west, so a ridge has a shape. And a thin pale rim runs
 * along every shore, so the coast is sharp even where the land is flat.
 */
import type { WorldDescription, Zone } from '../../world/types.ts';

type Rgb = readonly [number, number, number];

/** The open sea, and the colour the sea past the edge of the world is filled with. */
export const DEEP_SEA = '#0f2940';
const DEEP_RGB: Rgb = [0x0f, 0x29, 0x40];
const SHALLOWS_RGB: Rgb = [0x22, 0x5a, 0x78];
const SHORE_RGB: Rgb = [0x8a, 0x78, 0x66];

/** The land of each kind of district: warm grey in the city, green at the edge. */
const ZONE_RGB: Readonly<Record<Zone, Rgb>> = Object.freeze({
  core: [0x4c, 0x3d, 0x48],
  inner: [0x46, 0x39, 0x43],
  industrial: [0x40, 0x3c, 0x40],
  suburban: [0x3b, 0x40, 0x3a],
  outskirts: [0x37, 0x43, 0x35],
  wilderness: [0x31, 0x42, 0x2f],
});

/** Metres of depth over which the sea darkens from the shore to its deepest. */
const DEPTH_RANGE = 24;

/** Metres of height over which the land pales toward its highest. */
const HEIGHT_RANGE = 140;

/** Cells from the edge of the grid over which the sea fades to the open sea outside it. */
const EDGE_FADE = 48;

/** How hard the hills are lit: 0 is flat, 1 is black on the far side of a cliff. */
const RELIEF = 0.55;

export function renderGround(world: WorldDescription): HTMLCanvasElement {
  const hf = world.terrain;
  const n = hf.gridSize;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(n, n);
  const data = image.data;
  const sea = world.water.seaLevel;
  const heights = hf.heights;
  const zones = zoneGrid(world);
  const at = (ix: number, iy: number): number =>
    heights[Math.min(n - 1, Math.max(0, iy)) * n + Math.min(n - 1, Math.max(0, ix))] as number;

  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const h = heights[iy * n + ix] as number;
      const o = (iy * n + ix) * 4;
      let rgb: [number, number, number];
      if (h < sea) {
        const edge = Math.min(ix, iy, n - 1 - ix, n - 1 - iy);
        const depth = Math.min(1, (sea - h) / DEPTH_RANGE);
        const open = Math.max(0, 1 - edge / EDGE_FADE);
        const t = Math.max(depth, open * open * (3 - 2 * open));
        rgb = mix(SHALLOWS_RGB, DEEP_RGB, t);
      } else {
        const base = ZONE_RGB[zones[iy * n + ix] as Zone];
        const pale = Math.min(1, (h - sea) / HEIGHT_RANGE);
        rgb = mix(base, [0x8a, 0x80, 0x84], pale * 0.55);
        // Light from the north-west and above: the slope facing it is lit.
        const dx = (at(ix + 1, iy) - at(ix - 1, iy)) / (2 * hf.cellSize);
        const dy = (at(ix, iy + 1) - at(ix, iy - 1)) / (2 * hf.cellSize);
        const lit = (-dx - dy) / Math.SQRT2 / Math.hypot(dx, dy, 1);
        const shade = 1 + Math.max(-1, Math.min(1, lit * 2.5)) * RELIEF;
        rgb = [rgb[0] * shade, rgb[1] * shade, rgb[2] * shade];
        if (at(ix - 1, iy) < sea || at(ix + 1, iy) < sea || at(ix, iy - 1) < sea || at(ix, iy + 1) < sea) {
          rgb = mix(rgb, SHORE_RGB, 0.7);
        }
      }
      data[o] = clampByte(rgb[0]);
      data[o + 1] = clampByte(rgb[1]);
      data[o + 2] = clampByte(rgb[2]);
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * The kind of district each cell of the terrain grid is in: the district whose
 * site is nearest, as the districts are Voronoi cells of their sites. Worked
 * out on a coarser grid and read back, since a district is hundreds of metres
 * across and a cell is ten.
 */
function zoneGrid(world: WorldDescription): Zone[] {
  const hf = world.terrain;
  const n = hf.gridSize;
  const step = 4;
  const coarse = Math.ceil(n / step) + 1;
  const near: Zone[] = [];
  const districts = world.districts;
  for (let cy = 0; cy < coarse; cy++) {
    for (let cx = 0; cx < coarse; cx++) {
      const x = hf.originX + cx * step * hf.cellSize;
      const y = hf.originY + cy * step * hf.cellSize;
      let best: Zone = 'wilderness';
      let bestD = Infinity;
      for (const d of districts) {
        const dist = (d.x - x) ** 2 + (d.y - y) ** 2;
        if (dist < bestD) {
          bestD = dist;
          best = d.zone;
        }
      }
      near.push(best);
    }
  }
  const out: Zone[] = new Array(n * n);
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      out[iy * n + ix] = near[Math.round(iy / step) * coarse + Math.round(ix / step)] as Zone;
    }
  }
  return out;
}

function mix(a: Rgb, b: Rgb, t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
