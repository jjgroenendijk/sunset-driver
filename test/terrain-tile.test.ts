import { describe, expect, it } from 'vitest';
import { regionOf } from '../src/core/geom.ts';
import { buildTerrainTile, ZONE_COVER, ZONE_GROUND } from '../src/render/terrain.ts';
import type { ChunkParcel, WorldChunk } from '../src/world/chunks.ts';
import { layoutZones, type ZoneLayout } from '../src/world/districts.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import type { Point, WaterDescription } from '../src/world/types.ts';

/** A small chunk: 5 by 5 samples, 10 m apart, centred on the origin. */
const CELLS = 4;
const CELL = 10;
const SIZE = CELLS * CELL;
/** `Heightfield.create` centres its grid, so the tile runs from -SIZE/2 to +SIZE/2. */
const MIN = -SIZE / 2;
const MAX = SIZE / 2;
const SEA_LEVEL = 0;

const WATER: WaterDescription = {
  seaLevel: SEA_LEVEL,
  islands: [{ id: 0, x: 0, y: 0, radius: 400, main: true }],
  crossings: [],
  river: { path: [], halfWidths: [] },
  harbour: { x: 10_000, y: 10_000, radius: 10 },
};

/**
 * One chunk of ground with the heights `heightAt` gives it, and the parcels
 * passed in. The world around it is a single flat island, so the zone of every
 * vertex is the core: the colours are then the only thing that varies.
 */
function chunkOf(heightAt: (x: number, y: number) => number, parcels: ChunkParcel[] = []): WorldChunk {
  const hf = Heightfield.create(CELLS + 1, CELL);
  for (let iy = 0; iy <= CELLS; iy++) {
    for (let ix = 0; ix <= CELLS; ix++) hf.set(ix, iy, heightAt(hf.worldX(ix), hf.worldY(iy)));
  }
  return {
    seed: 1,
    cx: 0,
    cy: 0,
    bounds: { minX: hf.originX, minY: hf.originY, maxX: hf.originX + SIZE, maxY: hf.originY + SIZE },
    terrain: hf.toData(),
    seaLevel: SEA_LEVEL,
    roads: [],
    parcels,
  };
}

/** A square parcel, given as its two opposite corners. */
function parcelOf(minX: number, minY: number, maxX: number, maxY: number): ChunkParcel {
  const ring: Point[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  return {
    parcel: 0,
    region: regionOf(ring),
    area: (maxX - minX) * (maxY - minY),
    owner: 'ground',
    district: 0,
    zone: 'core',
    roads: [0],
  };
}

function zonesFor(): ZoneLayout {
  return layoutZones(2000, { x: 0, y: 0 }, WATER);
}

/** The three numbers of vertex `i` of an attribute. */
function tripleAt(values: ArrayLike<number>, i: number): [number, number, number] {
  return [values[i * 3] as number, values[i * 3 + 1] as number, values[i * 3 + 2] as number];
}

describe('terrain tile', () => {
  const zones = zonesFor();

  it('builds one vertex per height sample and two triangles per cell', () => {
    const chunk = chunkOf(() => 5);
    const tile = buildTerrainTile(chunk, zones, () => 5);
    const vertices = (CELLS + 1) * (CELLS + 1);
    expect(tile.cx).toBe(0);
    expect(tile.cy).toBe(0);
    expect(tile.geometry.getAttribute('position').count).toBe(vertices);
    expect(tile.geometry.getAttribute('normal').count).toBe(vertices);
    expect(tile.geometry.getAttribute('color').count).toBe(vertices);
    expect(tile.geometry.getIndex()?.count).toBe(CELLS * CELLS * 6);
  });

  it('stands every vertex on its own height sample', () => {
    // A ramp, so a vertex on the wrong sample shows up as the wrong height.
    const height = (x: number, y: number): number => 4 + x * 0.05 + y * 0.02;
    const chunk = chunkOf(height);
    const tile = buildTerrainTile(chunk, zones, height);
    const positions = tile.geometry.getAttribute('position').array;
    const hf = new Heightfield(chunk.terrain);
    for (let iy = 0; iy <= CELLS; iy++) {
      for (let ix = 0; ix <= CELLS; ix++) {
        // Three.js is Y up: the world's y is the mesh's z, and the height is y.
        const [x, h, z] = tripleAt(positions, iy * (CELLS + 1) + ix);
        expect(x).toBeCloseTo(hf.worldX(ix), 6);
        expect(z).toBeCloseTo(hf.worldY(iy), 6);
        expect(h).toBeCloseTo(hf.at(ix, iy), 5);
      }
    }
  });

  it('faces its normals up, and tilts them down the slope', () => {
    // Ground that climbs one in ten toward +x and is level along y.
    const height = (x: number): number => 10 + x * 0.1;
    const tile = buildTerrainTile(chunkOf(height), zones, (x) => height(x));
    const normals = tile.geometry.getAttribute('normal').array;
    for (let i = 0; i < normals.length / 3; i++) {
      const [nx, ny, nz] = tripleAt(normals, i);
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 6);
      // Up, and leaning back down the hill it climbs.
      expect(ny).toBeGreaterThan(0);
      expect(nx).toBeCloseTo(-0.1 / Math.hypot(0.1, 1), 6);
      expect(nz).toBeCloseTo(0, 6);
    }
  });

  it('winds every triangle to face upward', () => {
    const tile = buildTerrainTile(chunkOf(() => 3), zones, () => 3);
    const positions = tile.geometry.getAttribute('position').array;
    const index = tile.geometry.getIndex()?.array as ArrayLike<number>;
    for (let t = 0; t < index.length; t += 3) {
      const a = tripleAt(positions, index[t] as number);
      const b = tripleAt(positions, index[t + 1] as number);
      const c = tripleAt(positions, index[t + 2] as number);
      // The y of the cross product of the two edges: positive means the front
      // face looks at the camera, which is always above.
      const up = (c[0] - a[0]) * (b[2] - a[2]) - (c[2] - a[2]) * (b[0] - a[0]);
      expect(up, `triangle ${t / 3}`).toBeGreaterThan(0);
    }
  });

  it('takes its normals from the whole-map ground, so two tiles agree on the edge they share', () => {
    // A tile's own grid stops at its edge, and a one-sided difference there
    // would light the seam differently from the tile beside it. So the slope
    // comes from the ground the whole map carries, which reaches past the edge.
    // Here that ground is a ramp and the tile's own grid is flat: every normal
    // should follow the ramp, the corners included.
    const slope = 0.2;
    const tile = buildTerrainTile(chunkOf(() => 5), zones, (x) => 5 + x * slope);
    const normals = tile.geometry.getAttribute('normal').array;
    const wanted = -slope / Math.hypot(slope, 1);
    for (let i = 0; i < normals.length / 3; i++) {
      const [nx, , nz] = tripleAt(normals, i);
      expect(nx, `vertex ${i}`).toBeCloseTo(wanted, 6);
      expect(nz, `vertex ${i}`).toBeCloseTo(0, 6);
    }
  });

  it('paints the sea bed under the water and darkens it with depth', () => {
    // Under water all the way across, and deeper toward +x.
    const bed = (x: number): number => -2 - (x - MIN) / 4;
    const tile = buildTerrainTile(chunkOf(bed), zones, bed);
    const colors = tile.geometry.getAttribute('color').array;
    const shallow = tripleAt(colors, 0);
    const deep = tripleAt(colors, CELLS);
    // Blue enough to read as water, and darker the deeper it goes.
    expect(shallow[2]).toBeGreaterThan(0);
    expect(deep[0] + deep[1] + deep[2]).toBeLessThan(shallow[0] + shallow[1] + shallow[2]);
  });

  it('grows ground cover on the parcels and leaves the ground the roads claim bare', () => {
    // A parcel over the left half of the tile; the right half is road.
    const parcel = parcelOf(MIN - 1, MIN - 1, -1, MAX + 1);
    const tile = buildTerrainTile(chunkOf(() => 6, [parcel]), zones, () => 6);
    const colors = tile.geometry.getAttribute('color').array;
    const onParcel = tripleAt(colors, 0);
    const onRoad = tripleAt(colors, CELLS);
    expect(onRoad[0]).toBeCloseTo(ZONE_GROUND.core[0], 6);
    expect(onRoad[1]).toBeCloseTo(ZONE_GROUND.core[1], 6);
    // The cover pulls the ground toward the zone's green without reaching it.
    expect(onParcel[1]).toBeGreaterThan(onRoad[1]);
    expect(onParcel[1]).toBeLessThan(ZONE_COVER.core[1]);
  });

  it('leaves the hole in a parcel to the road that made it', () => {
    // A parcel with a hole in the middle is a block with something inside it
    // the parcel does not own, and nothing grows there.
    const outer: Point[] = [
      { x: MIN - 1, y: MIN - 1 },
      { x: MAX + 1, y: MIN - 1 },
      { x: MAX + 1, y: MAX + 1 },
      { x: MIN - 1, y: MAX + 1 },
    ];
    // A hole around the middle vertex of the grid, which stands at the origin.
    const hole: Point[] = [
      { x: -CELL / 2, y: -CELL / 2 },
      { x: -CELL / 2, y: CELL / 2 },
      { x: CELL / 2, y: CELL / 2 },
      { x: CELL / 2, y: -CELL / 2 },
    ];
    const parcel = { ...parcelOf(MIN - 1, MIN - 1, MAX + 1, MAX + 1), region: { outer, holes: [hole] } };
    const tile = buildTerrainTile(chunkOf(() => 6, [parcel]), zones, () => 6);
    const colors = tile.geometry.getAttribute('color').array;
    const middle = CELLS / 2;
    const inHole = tripleAt(colors, middle * (CELLS + 1) + middle);
    const outside = tripleAt(colors, 0);
    expect(inHole[1]).toBeCloseTo(ZONE_GROUND.core[1], 6);
    expect(outside[1]).toBeGreaterThan(inHole[1]);
  });
});
