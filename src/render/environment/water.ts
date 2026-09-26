/**
 * The water surface, as geometry (spec sections 7.2, 10.1).
 *
 * The sea, the straits, the river and the harbour are one surface: every one of
 * them is ground that lies below the waterline, so a single sheet at sea level
 * covers all four and the land that stands above it hides the rest. The sheet
 * reaches {@link OPEN_SEA} past the map on every side, which is further than the
 * haze, so the edge of the map is never the edge of the water.
 *
 * A vertex carries how deep the water is beneath it. That is what gives the
 * shoreline its blend: the surface fades out as the ground rises to meet it,
 * instead of ending on a hard line across the sand. It is also what says which
 * cells are drawn at all — a cell with dry ground at all four corners carries no
 * water and is left out, so the sheet is only the wet part of the map.
 *
 * The mesh is laid flat by a quarter turn about the X axis, which sends a local
 * point `(x, y)` to the world place `(x, seaLevel, -y)`. The builder writes `-y`
 * into each vertex so that it lands on the place its depth was sampled at. The
 * turn is what puts the surface normal up, and the reflection of the water addon
 * needs that: it takes the mirror plane from the mesh's own facing.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly. {@link WaterSurface} in `water-surface.ts` draws it.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { genRng, Subsystem } from '../../core/rng.ts';
import { Heightfield } from '../../world/terrain/heightfield.ts';
import type { WorldDescription } from '../../world/types.ts';

/**
 * Metres each way of one cell of the water sheet. The sheet is flat, so this is
 * not about the shape of the surface: it is how finely the shoreline is cut, and
 * how closely the fade at a shore follows the ground under it. A whole map is a
 * few tens of thousands of cells at this size, which is one cheap draw.
 */
export const WATER_CELL = 25;

/**
 * Metres of open sea the sheet reaches past the edge of the map. Further than
 * the haze of `world-scene.ts`, so the water runs out of sight rather than out
 * of geometry.
 */
export const OPEN_SEA = 600;

/** Texels each way of the wave normal map. A power of two, so it carries mipmaps. */
export const WAVE_TEXTURE_SIZE = 256;

/**
 * Plane waves summed into the wave tile. Each has a whole number of periods
 * across the tile, so the pattern repeats without a seam wherever it is laid.
 */
const WAVE_COUNT = 24;

/** Periods across the tile of the longest and the shortest wave. */
const WAVE_LONGEST = 2;
const WAVE_SHORTEST = 14;

/** Root-mean-square slope of the summed waves: how steep the surface reads. */
const WAVE_STEEPNESS = 0.35;

/** The water sheet of a world, ready to hand to a `BufferGeometry`. */
export interface WaterAttributes {
  /** Vertices each way, so the grid holds `gridSize * gridSize` of them. */
  gridSize: number;
  /** Metres each way of one cell. */
  cell: number;
  /** World place of vertex `(0, 0)`; vertex `(i, j)` stands at `(minX + i * cell, minY + j * cell)`. */
  minX: number;
  minY: number;
  /** Vertex positions in the local plane: `(x, -y, 0)` for the world place `(x, y)`. */
  positions: Float32Array;
  /** Every normal is the local `(0, 0, 1)`, which the quarter turn sends up. */
  normals: Float32Array;
  /** Metres of water under each vertex, negative where the ground stands dry. */
  depths: Float32Array;
  /** Two triangles for each cell that carries water, and none for a dry one. */
  indices: Uint32Array;
}

/**
 * Build the water sheet of a world.
 *
 * The ground is the natural terrain, not the carved one. The carve only ever
 * raises ground to carry a road bed above the waterline, and ground that stands
 * above the sheet hides it, so the two draw the same water; reading the terrain
 * keeps this a pure function of the world description.
 */
export function buildWaterAttributes(world: WorldDescription): WaterAttributes {
  const reach = world.size / 2 + OPEN_SEA;
  const lo = Math.floor(-reach / WATER_CELL);
  const hi = Math.ceil(reach / WATER_CELL);
  const n = hi - lo + 1;
  const sea = world.water.seaLevel;
  const terrain = new Heightfield(world.terrain);

  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const depths = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const y = (lo + j) * WATER_CELL;
    for (let i = 0; i < n; i++) {
      const x = (lo + i) * WATER_CELL;
      const v = j * n + i;
      positions[v * 3] = x;
      positions[v * 3 + 1] = -y;
      normals[v * 3 + 2] = 1;
      depths[v] = sea - lowestAround(terrain, x, y);
    }
  }

  // A cell is drawn when any corner of it stands in water, so the sheet runs a
  // little way up the shore and is hidden there by the ground over it. Counted
  // first, because the index buffer is sized to exactly the cells that are kept.
  const cells = n - 1;
  let wet = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) if (cellIsWet(depths, n, i, j)) wet++;
  }
  const indices = new Uint32Array(wet * 6);
  let at = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      if (!cellIsWet(depths, n, i, j)) continue;
      const a = j * n + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = a + n;
      // Wound anticlockwise in the local plane, so the quarter turn leaves the
      // surface facing up.
      indices[at++] = a;
      indices[at++] = c;
      indices[at++] = b;
      indices[at++] = a;
      indices[at++] = d;
      indices[at++] = c;
    }
  }

  return { gridSize: n, cell: WATER_CELL, minX: lo * WATER_CELL, minY: lo * WATER_CELL, positions, normals, depths, indices };
}

/**
 * True where the sheet draws any water within `radius` metres of a place.
 *
 * The mirror of `water-surface.ts` renders the whole scene a second time
 * wherever the sheet is drawn, so the sheet is worth drawing only where the
 * camera can see water. The camera of `camera.ts` looks down from a few tens
 * of metres and its view ends on the ground a couple of hundred metres out, so
 * a patch of that reach around the player is what it can cover, and this
 * answers whether any of the sheet's drawn cells falls inside it — the same
 * test that built the sheet, run over the cells the patch covers.
 *
 * The grid already reaches the open sea past every edge of the map, so a place
 * outside it is a place no geometry covers either way.
 */
export function waterNear(attributes: WaterAttributes, x: number, y: number, radius: number): boolean {
  const last = attributes.gridSize - 2;
  const loI = clampIndex(Math.floor((x - radius - attributes.minX) / attributes.cell), last);
  const hiI = clampIndex(Math.floor((x + radius - attributes.minX) / attributes.cell), last);
  const loJ = clampIndex(Math.floor((y - radius - attributes.minY) / attributes.cell), last);
  const hiJ = clampIndex(Math.floor((y + radius - attributes.minY) / attributes.cell), last);
  for (let j = loJ; j <= hiJ; j++) {
    for (let i = loI; i <= hiI; i++) if (cellIsWet(attributes.depths, attributes.gridSize, i, j)) return true;
  }
  return false;
}

/** A cell or vertex index held inside the grid, so a place past its edge reads the edge. */
function clampIndex(at: number, last: number): number {
  return Math.min(last, Math.max(0, at));
}

/** Wrap the attributes of a water sheet in a geometry the renderer can draw. */
export function waterGeometry(attributes: WaterAttributes): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(attributes.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(attributes.normals, 3));
  geometry.setAttribute('depth', new BufferAttribute(attributes.depths, 1));
  geometry.setIndex(new BufferAttribute(attributes.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The wave normal map, as RGBA texels.
 *
 * The water addon reads a tiling normal map at four scales and adds the four
 * samples to make its moving surface. Spec section 1.2 ships no image files, so
 * the map is summed here from plane waves drawn from the seed: each has a whole
 * number of periods across the tile, which is what lets the tile repeat without
 * a seam. The normal of that summed height is encoded the way a normal map
 * encodes one, with the surface's own up in the blue channel.
 */
export function waveNormalData(seed: number, size: number = WAVE_TEXTURE_SIZE): Uint8Array {
  const rng = genRng(seed, Subsystem.Water, 2);
  const waves: { kx: number; ky: number; phase: number; amplitude: number }[] = [];
  let power = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    const angle = rng.range(-Math.PI, Math.PI);
    const periods = rng.range(WAVE_LONGEST, WAVE_SHORTEST);
    const kx = Math.round(Math.cos(angle) * periods);
    const ky = Math.round(Math.sin(angle) * periods);
    if (kx === 0 && ky === 0) continue;
    // Longer waves stand higher, so the surface reads as swell with ripples on
    // it rather than as even noise.
    const length = Math.hypot(kx, ky);
    const amplitude = Math.pow(length, -1.5);
    waves.push({ kx, ky, phase: rng.range(-Math.PI, Math.PI), amplitude });
    const slope = 2 * Math.PI * length * amplitude;
    power += (slope * slope) / 2;
  }
  // Scale the sum to the steepness asked for, measured as the root mean square
  // of its slope. The waves are independent, so their powers add.
  const scale = power > 0 ? WAVE_STEEPNESS / Math.sqrt(power) : 0;

  const out = new Uint8Array(size * size * 4);
  for (let ty = 0; ty < size; ty++) {
    const v = (ty + 0.5) / size;
    for (let tx = 0; tx < size; tx++) {
      const u = (tx + 0.5) / size;
      let du = 0;
      let dv = 0;
      for (const wave of waves) {
        const angle = 2 * Math.PI * (wave.kx * u + wave.ky * v) + wave.phase;
        const d = 2 * Math.PI * wave.amplitude * Math.cos(angle);
        du += d * wave.kx;
        dv += d * wave.ky;
      }
      du *= scale;
      dv *= scale;
      const length = Math.hypot(du, dv, 1);
      const t = (ty * size + tx) * 4;
      out[t] = encode(-du / length);
      out[t + 1] = encode(-dv / length);
      out[t + 2] = encode(1 / length);
      out[t + 3] = 255;
    }
  }
  return out;
}

/** One component of a unit normal, as a normal map stores it. */
function encode(component: number): number {
  return Math.max(0, Math.min(255, Math.round((component * 0.5 + 0.5) * 255)));
}

/**
 * The deepest ground within half a cell of a place.
 *
 * A vertex takes this rather than the ground under itself. A channel narrower
 * than the grid — the upper river of a small map is a few tens of metres across
 * — would otherwise fall between two rows of vertices and be left dry. The
 * samples are half a cell apart, which is closer than anything the terrain grid
 * can hold, so no channel is missed. Where this pushes the water a little way
 * inside a bank, the bank stands over the sheet and hides it.
 */
function lowestAround(terrain: Heightfield, x: number, y: number): number {
  const step = WATER_CELL / 2;
  let lowest = Infinity;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) lowest = Math.min(lowest, terrain.sample(x + i * step, y + j * step));
  }
  return lowest;
}

/** True where any corner of a cell stands in water. */
function cellIsWet(depths: Float32Array, gridSize: number, i: number, j: number): boolean {
  const a = j * gridSize + i;
  return (
    (depths[a] as number) > 0 ||
    (depths[a + 1] as number) > 0 ||
    (depths[a + gridSize] as number) > 0 ||
    (depths[a + gridSize + 1] as number) > 0
  );
}
