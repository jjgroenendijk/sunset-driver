/**
 * The ground of one chunk as a mesh (spec sections 7.1, 10.1 and 10.2).
 *
 * The heights are the ones the chunk carries, which are the natural terrain
 * with the roads carved into it (`carve.ts`). Two chunks agree on the heights
 * along the edge they share, so the tiles meet without a crack.
 *
 * The colour of each vertex is the ground's identity, and it is worked out here
 * rather than in the shader because it comes from the world description: the
 * zone the vertex stands in, whether the sea covers it, and whether it stands
 * on a parcel. Spec section 7.1 paints ground cover only onto the parcels the
 * roads leave, so the ground the footprint claims keeps the bare colour of its
 * zone until road surfaces land. Everything a shader can do without asking the
 * world — grain, patchiness, roughness — is left to the material.
 *
 * Normals are taken from the whole-map carved ground rather than from the
 * chunk's own grid, so the slope at the edge of a tile is the slope its
 * neighbour sees and the lighting does not seam.
 *
 * Geometry only: the node material lives in `terrain-material.ts`, because
 * `three/webgpu` needs a GPU and this has to stay testable in Node.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { pointInRing, type Point } from '../core/geom.ts';
import type { ChunkParcel, WorldChunk } from '../world/chunks.ts';
import { zoneAt, type ZoneLayout } from '../world/districts.ts';
import { Heightfield } from '../world/heightfield.ts';
import type { Zone } from '../world/types.ts';

/** A colour as red, green and blue in [0, 1]. */
export type Rgb = readonly [number, number, number];

/**
 * The bare ground of each zone: what is under the city before anything grows
 * on it. It grades from the grey of a paved downtown to the dry earth of the
 * outskirts and the dark loam of the wilderness (spec section 10.1).
 */
export const ZONE_GROUND: Record<Zone, Rgb> = {
  core: [0.29, 0.28, 0.3],
  inner: [0.33, 0.3, 0.29],
  industrial: [0.32, 0.3, 0.27],
  suburban: [0.38, 0.34, 0.27],
  outskirts: [0.45, 0.38, 0.26],
  wilderness: [0.31, 0.28, 0.19],
};

/**
 * What grows on the ground the roads leave in each zone: clipped green in the
 * city, dry scrub on the fringe, deep green in the hills.
 */
export const ZONE_COVER: Record<Zone, Rgb> = {
  core: [0.24, 0.34, 0.2],
  inner: [0.26, 0.37, 0.21],
  industrial: [0.3, 0.33, 0.2],
  suburban: [0.25, 0.42, 0.21],
  outskirts: [0.42, 0.44, 0.22],
  wilderness: [0.22, 0.4, 0.18],
};

/** How much of the cover colour a parcel takes. Short of 1, so the zone still reads through it. */
const COVER_STRENGTH = 0.85;

/**
 * The sea bed, at the waterline and at the depth it goes dark. Water itself is
 * spec section 7.2 and comes later; this is the ground under it, which is what
 * makes the coastline read from above until then.
 */
const SHALLOW_BED: Rgb = [0.34, 0.36, 0.28];
const DEEP_BED: Rgb = [0.05, 0.11, 0.16];
const DARK_DEPTH = 18;

/** How much darker the ground gets at the steepest slope: bare rock shows on a cliff. */
const SLOPE_DARKENING = 0.35;
const BARE_SLOPE = 0.7;

/**
 * The mesh of one chunk's ground, and where it stands. The geometry carries
 * position, normal and a `color` attribute, which is the ground's identity;
 * `terrain-material.ts` reads that attribute and adds the runtime detail.
 */
export interface TerrainTile {
  cx: number;
  cy: number;
  geometry: BufferGeometry;
}

/**
 * Build the ground of one chunk. `groundAt` answers the carved height anywhere
 * on the map, including just outside the chunk, which is what keeps the normals
 * continuous from one tile to the next.
 */
export function buildTerrainTile(
  chunk: WorldChunk,
  zones: ZoneLayout,
  groundAt: (x: number, y: number) => number,
): TerrainTile {
  const hf = new Heightfield(chunk.terrain);
  const n = hf.gridSize;
  const cell = hf.cellSize;
  const cover = new ParcelCover(chunk.parcels);
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);

  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const x = hf.worldX(ix);
      const y = hf.worldY(iy);
      const height = hf.at(ix, iy);
      const at = (iy * n + ix) * 3;
      // Three.js is Y up, so the world's y is the mesh's z and the height is y.
      positions[at] = x;
      positions[at + 1] = height;
      positions[at + 2] = y;

      const dx = (groundAt(x + cell, y) - groundAt(x - cell, y)) / (2 * cell);
      const dy = (groundAt(x, y + cell) - groundAt(x, y - cell)) / (2 * cell);
      const length = Math.hypot(dx, dy, 1);
      normals[at] = -dx / length;
      normals[at + 1] = 1 / length;
      normals[at + 2] = -dy / length;

      const tint = groundColour(x, y, height, chunk.seaLevel, Math.hypot(dx, dy), zones, cover);
      colors[at] = tint[0];
      colors[at + 1] = tint[1];
      colors[at + 2] = tint[2];
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(quadIndices(n), 1));
  return { cx: chunk.cx, cy: chunk.cy, geometry };
}

/**
 * The identity of the ground at one place: the zone's own colour, the cover the
 * parcels carry, the sea bed under the water, and bare rock where it is too
 * steep for anything to hold.
 */
function groundColour(
  x: number,
  y: number,
  height: number,
  seaLevel: number,
  slope: number,
  zones: ZoneLayout,
  cover: ParcelCover,
): Rgb {
  if (height < seaLevel) {
    // Under water the ground darkens with depth, which is what draws the
    // coastline and the straits from above.
    return blend(SHALLOW_BED, DEEP_BED, clamp01((seaLevel - height) / DARK_DEPTH));
  }
  const zone = zoneAt(zones, x, y);
  const bare = ZONE_GROUND[zone];
  const tint = cover.covers(x, y) ? blend(bare, ZONE_COVER[zone], COVER_STRENGTH) : bare;
  // Nothing grows on a cliff, and the rock under it is darker than the soil.
  const rock = clamp01(slope / BARE_SLOPE);
  return blend(tint, blend(bare, [0, 0, 0], SLOPE_DARKENING), rock);
}

/** The two triangles of every cell of an `n` by `n` grid of vertices. */
function quadIndices(n: number): Uint32Array {
  const out = new Uint32Array((n - 1) * (n - 1) * 6);
  let at = 0;
  for (let iy = 0; iy + 1 < n; iy++) {
    for (let ix = 0; ix + 1 < n; ix++) {
      const a = iy * n + ix;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Wound anticlockwise seen from above, which is the front face.
      out[at++] = a;
      out[at++] = c;
      out[at++] = b;
      out[at++] = b;
      out[at++] = c;
      out[at++] = d;
    }
  }
  return out;
}

/**
 * Which ground of a chunk a parcel covers. Every piece is filed by the box
 * around it, so a place on a road costs one comparison a parcel and a place on
 * a parcel costs one ring walk.
 */
class ParcelCover {
  private readonly rings: Point[][] = [];
  private readonly holes: Point[][][] = [];
  private readonly minX: number[] = [];
  private readonly minY: number[] = [];
  private readonly maxX: number[] = [];
  private readonly maxY: number[] = [];

  constructor(parcels: readonly ChunkParcel[]) {
    for (const parcel of parcels) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of parcel.region.outer) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      this.rings.push(parcel.region.outer);
      this.holes.push(parcel.region.holes);
      this.minX.push(x0);
      this.minY.push(y0);
      this.maxX.push(x1);
      this.maxY.push(y1);
    }
  }

  /** True where a parcel owns the ground, and so where cover grows. */
  covers(x: number, y: number): boolean {
    const at = { x, y };
    for (let i = 0; i < this.rings.length; i++) {
      if (x < (this.minX[i] as number) || x > (this.maxX[i] as number)) continue;
      if (y < (this.minY[i] as number) || y > (this.maxY[i] as number)) continue;
      if (!pointInRing(at, this.rings[i] as Point[])) continue;
      let inHole = false;
      for (const hole of this.holes[i] as Point[][]) {
        if (!pointInRing(at, hole)) continue;
        inHole = true;
        break;
      }
      if (!inHole) return true;
    }
    return false;
  }
}

function blend(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
