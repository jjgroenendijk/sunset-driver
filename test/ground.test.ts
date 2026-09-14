import { describe, expect, it } from 'vitest';
import { pointInRegion, regionOf, type Point } from '../src/core/geom.ts';
import { buildGroundAttributes, groundGeometry, groundLookup, type GroundAttributes } from '../src/render/ground.ts';
import { buildLayers, ChunkSource, CHUNK_SIZE } from '../src/world/chunks.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { ParcelIndex, type Parcel } from '../src/world/parcels.ts';
import type { District, RoadCurve, WorldDescription, Zone } from '../src/world/types.ts';

const SIZE = 800;
const CELL = 10;
/** Metres between the streets of the hand-built grid. */
const BLOCK = 150;

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, coords: readonly [number, number][]): RoadCurve {
  return { id, tier: 'street', points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [] };
}

/**
 * A hand-built world: a square island under a grid of streets, so the ground
 * mesh can be checked without generating one. The ground rises across the map,
 * so a vertex taken from the wrong place would show in its height and a normal
 * taken from the wrong neighbours would show in its slope.
 */
function gridWorld(): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) {
      hf.set(ix, iy, 20 + hf.worldX(ix) * 0.02 + hf.worldY(iy) * 0.05);
    }
  }
  const roads: RoadCurve[] = [];
  const line = -2 * BLOCK;
  for (let i = 0; i <= 4; i++) {
    const at = line + i * BLOCK;
    roads.push(curve(roads.length, [[at, line], [at, -line]]));
    roads.push(curve(roads.length, [[line, at], [-line, at]]));
  }
  return {
    seed: 11,
    size: SIZE,
    archetype: 'archipelago',
    core: { x: 0, y: 0 },
    terrain: hf.toData(),
    water: {
      seaLevel: 0,
      islands: [{ id: 0, x: 0, y: 0, radius: SIZE / 2, main: true }],
      crossings: [],
      rivers: [],
      harbour: { x: 0, y: 0, radius: 10 },
      industry: 0,
    },
    districts: [district(0, 'inner', 0, 0), district(1, 'suburban', 250, 250)],
    beaches: [],
    roads,
    corridors: [],
    tram: { route: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

const world = gridWorld();
const layers = buildLayers(world);
const source = new ChunkSource(world, layers);
const lookup = groundLookup(world, layers);

/** The world place of one vertex of a chunk's ground. */
function placeOf(attributes: GroundAttributes, vertex: number, minX: number, minY: number): Point {
  return {
    x: minX + (attributes.positions[vertex * 3] as number),
    y: minY + (attributes.positions[vertex * 3 + 2] as number),
  };
}

describe('ground mesh', () => {
  const chunk = source.chunk(0, 0);
  const attributes = buildGroundAttributes(chunk, lookup);
  const n = attributes.gridSize;

  it('stands every vertex on the carved ground under it', () => {
    expect(n).toBe(chunk.terrain.gridSize);
    expect(attributes.positions).toHaveLength(n * n * 3);
    let complaint: string | undefined;
    for (let v = 0; v < n * n; v++) {
      const place = placeOf(attributes, v, chunk.bounds.minX, chunk.bounds.minY);
      // The heights are kept as 32-bit floats, so they agree to a tenth of a
      // millimetre rather than to the last bit.
      const height = attributes.positions[v * 3 + 1] as number;
      const carved = layers.carve.heightAt(place.x, place.y);
      if (!(Math.abs(height - carved) < 5e-5)) complaint ??= `vertex ${v} stands at ${height}, not ${carved}`;
    }
    expect(complaint).toBeUndefined();
    // The grid spans the whole chunk and no more.
    expect(attributes.positions[0]).toBe(0);
    expect(attributes.positions[(n * n - 1) * 3]).toBeCloseTo(CHUNK_SIZE, 6);
    expect(attributes.positions[(n * n - 1) * 3 + 2]).toBeCloseTo(CHUNK_SIZE, 6);
  });

  it('takes an upward unit normal from the slope around each vertex', () => {
    let complaint: string | undefined;
    for (let v = 0; v < n * n; v++) {
      const x = attributes.normals[v * 3] as number;
      const y = attributes.normals[v * 3 + 1] as number;
      const z = attributes.normals[v * 3 + 2] as number;
      const length = Math.hypot(x, y, z);
      if (!(Math.abs(length - 1) < 5e-6)) complaint ??= `vertex ${v} has a normal of length ${length}`;
      if (!(y > 0)) complaint ??= `vertex ${v} has a normal facing down`;
    }
    expect(complaint).toBeUndefined();
    // The hand-built ground rises with x and faster with y, so away from the
    // roads the normal leans back against both. The vertex is well clear of
    // every road: a bench and the blend beside it leave the ground level.
    const middle = 13 * n + 13;
    expect(attributes.normals[middle * 3] as number).toBeLessThan(0);
    expect(attributes.normals[middle * 3 + 2] as number).toBeLessThan(
      (attributes.normals[middle * 3] as number) + 1e-6,
    );
  });

  it('winds every triangle to face upward', () => {
    const indices = attributes.indices;
    expect(indices).toHaveLength((n - 1) * (n - 1) * 6);
    let complaint: string | undefined;
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] as number;
      const b = indices[i + 1] as number;
      const c = indices[i + 2] as number;
      if (Math.max(a, b, c) >= n * n) complaint ??= `triangle ${i / 3} points past the grid`;
      const p = attributes.positions;
      const abx = (p[b * 3] as number) - (p[a * 3] as number);
      const abz = (p[b * 3 + 2] as number) - (p[a * 3 + 2] as number);
      const acx = (p[c * 3] as number) - (p[a * 3] as number);
      const acz = (p[c * 3 + 2] as number) - (p[a * 3 + 2] as number);
      // The y of the cross product: positive where the face is seen from above.
      if (!(acx * abz - acz * abx > 0)) complaint ??= `triangle ${i / 3} faces down`;
    }
    expect(complaint).toBeUndefined();
  });

  it('paints ground cover on the parcels and nowhere else', () => {
    let covered = 0;
    let bare = 0;
    let complaint: string | undefined;
    for (let v = 0; v < n * n; v++) {
      const place = placeOf(attributes, v, chunk.bounds.minX, chunk.bounds.minY);
      const parcel = lookup.parcelAt(place.x, place.y);
      if (attributes.covers[v] === 1) {
        covered++;
        if (parcel === undefined) complaint ??= `vertex ${v} is covered off every parcel`;
      } else {
        bare++;
        // The only parcel without cover is a water one, and this island has none.
        if (parcel !== undefined) complaint ??= `vertex ${v} is bare on parcel ${parcel.id}`;
      }
    }
    expect(complaint).toBeUndefined();
    // Both happen: a chunk of a gridded city is part parcel and part road.
    expect(covered).toBeGreaterThan(0);
    expect(bare).toBeGreaterThan(0);
  });

  it('wraps the attributes in a geometry', () => {
    const geometry = groundGeometry(attributes);
    expect(geometry.getAttribute('position').count).toBe(n * n);
    expect(geometry.getAttribute('cover').itemSize).toBe(1);
    expect(geometry.getAttribute('coverTint').itemSize).toBe(3);
    expect(geometry.getIndex()?.count).toBe(attributes.indices.length);
  });
});

describe('ground seams', () => {
  it('gives two neighbours the same vertices along the edge they share', () => {
    const left = source.chunk(0, 0);
    const right = source.chunk(1, 0);
    const a = buildGroundAttributes(left, lookup);
    const b = buildGroundAttributes(right, lookup);
    const n = a.gridSize;
    for (let iy = 0; iy < n; iy++) {
      const far = iy * n + (n - 1);
      const near = iy * n;
      const placeA = placeOf(a, far, left.bounds.minX, left.bounds.minY);
      const placeB = placeOf(b, near, right.bounds.minX, right.bounds.minY);
      // The positions are local to each chunk's own corner, so the vertices
      // meet in the world rather than in the arrays.
      expect(placeA).toEqual(placeB);
      expect(a.positions[far * 3 + 1]).toBe(b.positions[near * 3 + 1]);
      for (let k = 0; k < 3; k++) {
        expect(a.normals[far * 3 + k]).toBe(b.normals[near * 3 + k]);
        expect(a.tints[far * 3 + k]).toBe(b.tints[near * 3 + k]);
        expect(a.coverTints[far * 3 + k]).toBe(b.coverTints[near * 3 + k]);
      }
      expect(a.covers[far]).toBe(b.covers[near]);
    }
  });
});

describe('parcel index', () => {
  it('answers as a scan of every parcel would', () => {
    const index = new ParcelIndex(layers.parcels.parcels);
    let hits = 0;
    for (let y = -SIZE / 2; y <= SIZE / 2; y += 17) {
      for (let x = -SIZE / 2; x <= SIZE / 2; x += 19) {
        const point = { x, y };
        const wanted = layers.parcels.parcels.find((parcel) => pointInRegion(point, parcel.region));
        const found = index.at(x, y);
        expect(found?.id).toBe(wanted?.id);
        if (found !== undefined) hits++;
      }
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('holds no parcel where there are none', () => {
    const index = new ParcelIndex([]);
    expect(index.at(0, 0)).toBeUndefined();
    const one: Parcel = {
      id: 0,
      region: regionOf([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ]),
      area: 100,
      owner: 'park',
      district: 0,
      zone: 'inner',
      roads: [0],
    };
    const small = new ParcelIndex([one]);
    expect(small.at(5, 5)?.id).toBe(0);
    expect(small.at(-5, 5)).toBeUndefined();
    expect(small.at(5, 500)).toBeUndefined();
  });
});
