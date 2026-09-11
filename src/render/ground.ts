/**
 * The ground of one chunk, as a mesh (spec sections 7.1, 10.1, 10.2).
 *
 * A chunk carries the carved heights over the ground it covers. This file turns
 * them into vertices, and paints each vertex with two things: the colour of the
 * zone it stands in, and the ground cover of the parcel it belongs to. Spec
 * section 7.1 puts ground cover only on parcels no road owns, which is every
 * parcel by construction — the footprint the roads claim is what the parcels
 * were cut out of — so a vertex carries cover exactly when it stands on one.
 *
 * A vertex asks the world which parcel and zone it stands in, never the chunk.
 * Two neighbours therefore agree along the edge they share: the answer is a
 * function of the place, not of which chunk is being built. That is the same
 * rule the chunk heights follow, and it is what keeps the seams invisible.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferAttribute, BufferGeometry, Color } from 'three';
import type { WorldChunk, WorldLayers } from '../world/chunks.ts';
import { districtAt, layoutZones } from '../world/districts.ts';
import { ParcelIndex, type Parcel, type ParcelOwner } from '../world/parcels.ts';
import type { WorldDescription, Zone } from '../world/types.ts';

/** What a vertex of the ground asks about the world beneath it. */
export interface GroundLookup {
  /** The carved height at a place, for the ring of samples around a chunk. */
  heightAt(x: number, y: number): number;
  /** The parcel a place stands on, or nothing where a road owns the ground. */
  parcelAt(x: number, y: number): Parcel | undefined;
  /** The zone a place stands in, for ground no parcel owns. */
  zoneAt(x: number, y: number): Zone;
}

/** The lookup a world answers with, built once and shared by every chunk of it. */
export function groundLookup(world: WorldDescription, layers: WorldLayers): GroundLookup {
  const index = new ParcelIndex(layers.parcels.parcels);
  const zones = layoutZones(world.size, world.core, world.water);
  return {
    heightAt: (x, y) => layers.carve.heightAt(x, y),
    parcelAt: (x, y) => index.at(x, y),
    zoneAt: (x, y) => districtAt(world.districts, zones, x, y).zone,
  };
}

/** One chunk's ground, ready to hand to a `BufferGeometry`. */
export interface GroundAttributes {
  /** Samples each way, so the grid holds `gridSize * gridSize` vertices. */
  gridSize: number;
  /** Vertex positions, relative to the chunk's near corner; height is absolute. */
  positions: Float32Array;
  normals: Float32Array;
  /** The ground colour of the zone each vertex stands in. */
  tints: Float32Array;
  /** How much ground cover a vertex carries: 1 on a parcel, 0 where a road owns the ground. */
  covers: Float32Array;
  /** The colour of that cover. */
  coverTints: Float32Array;
  indices: Uint32Array;
}

/**
 * Build the ground of one chunk.
 *
 * Heights come from the chunk, which already carries them carved (spec section
 * 7.1). Normals are taken across a ring of samples one cell beyond the chunk,
 * read from the lookup, so a vertex on a boundary has the same slope on both
 * sides of it and the shading does not crease along the seam.
 */
export function buildGroundAttributes(chunk: WorldChunk, lookup: GroundLookup): GroundAttributes {
  const n = chunk.terrain.gridSize;
  const cell = chunk.terrain.cellSize;
  const { minX, minY } = chunk.bounds;
  const heights = paddedHeights(chunk, lookup);
  const pad = n + 2;

  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const tints = new Float32Array(n * n * 3);
  const coverTints = new Float32Array(n * n * 3);
  const covers = new Float32Array(n * n);

  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const v = iy * n + ix;
      const h = heights[(iy + 1) * pad + (ix + 1)] as number;
      positions[v * 3] = ix * cell;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = iy * cell;

      // Central differences over the padded grid: the slope each way, as the
      // normal of the surface the four neighbours describe.
      const left = heights[(iy + 1) * pad + ix] as number;
      const right = heights[(iy + 1) * pad + ix + 2] as number;
      const down = heights[iy * pad + ix + 1] as number;
      const up = heights[(iy + 2) * pad + ix + 1] as number;
      const nx = left - right;
      const ny = 2 * cell;
      const nz = down - up;
      const length = Math.hypot(nx, ny, nz);
      normals[v * 3] = nx / length;
      normals[v * 3 + 1] = ny / length;
      normals[v * 3 + 2] = nz / length;

      const x = minX + ix * cell;
      const y = minY + iy * cell;
      const parcel = lookup.parcelAt(x, y);
      const zone = parcel === undefined ? lookup.zoneAt(x, y) : parcel.zone;
      writeColour(tints, v, ZONE_RGB[zone]);
      const cover = parcel === undefined ? undefined : COVER_RGB[parcel.owner];
      if (cover !== undefined) {
        covers[v] = 1;
        writeColour(coverTints, v, cover);
      }
    }
  }

  return { gridSize: n, positions, normals, tints, covers, coverTints, indices: gridIndices(n) };
}

/** Wrap the attributes of a chunk's ground in a geometry the renderer can draw. */
export function groundGeometry(attributes: GroundAttributes): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(attributes.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(attributes.normals, 3));
  geometry.setAttribute('tint', new BufferAttribute(attributes.tints, 3));
  geometry.setAttribute('cover', new BufferAttribute(attributes.covers, 1));
  geometry.setAttribute('coverTint', new BufferAttribute(attributes.coverTints, 3));
  geometry.setIndex(new BufferAttribute(attributes.indices, 1));
  return geometry;
}

/**
 * The chunk's heights with a ring of one sample around them, so every vertex
 * has a neighbour each way. The ring is read from the lookup at the same places
 * the neighbouring chunks read their own heights.
 */
function paddedHeights(chunk: WorldChunk, lookup: GroundLookup): Float32Array {
  const n = chunk.terrain.gridSize;
  const cell = chunk.terrain.cellSize;
  const pad = n + 2;
  const out = new Float32Array(pad * pad);
  for (let iy = -1; iy <= n; iy++) {
    for (let ix = -1; ix <= n; ix++) {
      const inside = ix >= 0 && ix < n && iy >= 0 && iy < n;
      out[(iy + 1) * pad + (ix + 1)] = inside
        ? (chunk.terrain.heights[iy * n + ix] as number)
        : lookup.heightAt(chunk.bounds.minX + ix * cell, chunk.bounds.minY + iy * cell);
    }
  }
  return out;
}

/** Two triangles per cell of a `gridSize` square grid, wound to face upward. */
function gridIndices(gridSize: number): Uint32Array {
  const cells = gridSize - 1;
  const out = new Uint32Array(cells * cells * 6);
  let i = 0;
  for (let iy = 0; iy < cells; iy++) {
    for (let ix = 0; ix < cells; ix++) {
      const a = iy * gridSize + ix;
      const b = a + 1;
      const c = a + gridSize + 1;
      const d = a + gridSize;
      out[i++] = a;
      out[i++] = c;
      out[i++] = b;
      out[i++] = a;
      out[i++] = d;
      out[i++] = c;
    }
  }
  return out;
}

/** A colour as the renderer wants it: three floats in the working colour space. */
type Rgb = readonly [number, number, number];

function rgbOf(hex: number): Rgb {
  const colour = new Color(hex);
  return [colour.r, colour.g, colour.b];
}

function writeColour(into: Float32Array, vertex: number, rgb: Rgb): void {
  into[vertex * 3] = rgb[0];
  into[vertex * 3 + 1] = rgb[1];
  into[vertex * 3 + 2] = rgb[2];
}

/**
 * The ground colour of each zone (spec section 10.1). These are the earth the
 * city stands on, not the signage over it: the colour identity comes from how
 * far apart they are, and from the cover painted over them.
 */
const ZONE_RGB: Record<Zone, Rgb> = {
  core: rgbOf(0x6f6a66),
  inner: rgbOf(0x7d6a55),
  industrial: rgbOf(0x5e6167),
  suburban: rgbOf(0x6d7a56),
  outskirts: rgbOf(0x8b7b58),
  wilderness: rgbOf(0x54693f),
};

/**
 * The ground cover of each parcel owner (spec section 7.1): grass, scrub and
 * gravel, plus the sand of a beach parcel. A water parcel carries none, because
 * what covers it is the sea.
 */
const COVER_RGB: Record<ParcelOwner, Rgb | undefined> = {
  building: rgbOf(0x5b5249),
  park: rgbOf(0x4d7a37),
  'car-park': rgbOf(0x56585b),
  plaza: rgbOf(0x8a8880),
  'under-structure': rgbOf(0x4a4844),
  beach: rgbOf(0xd9c48c),
  water: undefined,
  ground: rgbOf(0x6d7a45),
};
