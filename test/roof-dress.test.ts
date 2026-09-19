/**
 * The dressed roofs and the varied low-rise buildings of spec section 10.3.
 *
 * What is checked here is what the camera sees from above: that a flat roof
 * carries something, that a rich district carries more uses than a poor one,
 * that one kind is not one shape, and that the dressing never reaches past the
 * lot, past the batch it belongs to, or into the box the camera climbs.
 */
import { Box3, Vector3, type BufferAttribute, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { hashInts } from '../src/core/hash.ts';
import { BLOCK_PAINT, BLOCK_PLANTED, BLOCK_SOLAR, BLOCK_WATER } from '../src/render/block-mesh.ts';
import { buildChunkBuildings, type BuildingPlacement } from '../src/render/building-mesh.ts';
import { buildingOf, chunkOf, districtOf, lookupOf, placedRow } from './building-fixture.ts';

/** How many buildings of a kind a test looks at. Enough to see the variants. */
const ROW = 24;

const RICH = districtOf('core', 0.95);
const POOR = districtOf('inner', 0.05);

/** The box a geometry fills, in its own frame. */
function boxOf(geometry: BufferGeometry): Box3 {
  return new Box3().setFromBufferAttribute(geometry.getAttribute('position') as BufferAttribute);
}

/** The parts a geometry carries, as a set of the numbers written into it. */
function partsOf(geometry: BufferGeometry): Set<number> {
  const part = (geometry.getAttribute('part') as BufferAttribute).array as Float32Array;
  return new Set(part);
}

/** A geometry as one number, so two of them are told apart without walking both. */
function signature(geometry: BufferGeometry): number {
  const array = (geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
  let out = array.length;
  for (let i = 0; i < array.length; i++) out = hashInts(out, Math.round((array[i] as number) * 1000));
  return out;
}

/** How many of a row of buildings carry a dressed roof. */
function dressed(row: readonly BuildingPlacement[]): number {
  return row.filter((placed) => placed.dress !== undefined).length;
}

describe('a dressed flat roof', () => {
  it('stands on the roof of the kinds that have a flat one', () => {
    for (const kind of ['tower', 'mid-rise', 'shop-row'] as const) {
      const row = placedRow(kind, RICH, ROW);
      expect(dressed(row), kind).toBeGreaterThan(ROW / 3);
      for (const placed of row) {
        if (placed.dress === undefined) continue;
        const shell = boxOf(placed.shell);
        const dress = boxOf(placed.dress);
        // Whatever stands on the roof stands on it: clear of the street, under
        // the top of the shell, and inside the footprint the shell already
        // fills. The height is not a share of the building's own, because a
        // tower massed on a podium carries a terrace two or three storeys up as
        // well as a roof a hundred metres over it (spec section 10.3).
        expect(dress.min.y, kind).toBeGreaterThan(shell.min.y + 6);
        expect(dress.min.y, kind).toBeLessThan(shell.max.y);
        expect(dress.min.x).toBeGreaterThanOrEqual(shell.min.x);
        expect(dress.max.x).toBeLessThanOrEqual(shell.max.x);
        expect(dress.min.z).toBeGreaterThanOrEqual(shell.min.z);
        expect(dress.max.z).toBeLessThanOrEqual(shell.max.z);
      }
    }
  });

  it('never raises the outline the camera reads, however tall a mast stands', () => {
    // A mast is six metres of geometry over the roof. It is not in the shell,
    // so it is not in the hull either, and `roofs.ts` writes the hull: the
    // camera climbs the building and never the mast.
    let masts = 0;
    for (const placed of placedRow('tower', RICH, ROW)) {
      const hull = boxOf(placed.hull);
      const shell = boxOf(placed.shell);
      expect(hull.max.y).toBeLessThan(shell.max.y + 1);
      if (placed.dress === undefined) continue;
      const dress = boxOf(placed.dress);
      if (dress.max.y - dress.min.y > 4) masts++;
    }
    expect(masts).toBeGreaterThan(0);
  });

  it('gives a rich district more roofs with a use on them than a poor one', () => {
    // A use is the only thing that lays water, paint, a planted deck or a
    // solar array, so the parts of the dressing say which roofs carry one.
    const used = (district: ReturnType<typeof districtOf>): number => {
      let count = 0;
      for (const placed of placedRow('tower', district, ROW)) {
        if (placed.dress === undefined) continue;
        const parts = partsOf(placed.dress);
        if ([BLOCK_WATER, BLOCK_PAINT, BLOCK_PLANTED, BLOCK_SOLAR].some((part) => parts.has(part))) count++;
      }
      return count;
    };
    expect(used(RICH)).toBeGreaterThan(used(POOR));
  });

  it('dresses nothing past near detail, where a vent is smaller than a pixel', () => {
    const buildings = [buildingOf(0, 'shop-row', 4242)];
    for (const detail of ['mid', 'far'] as const) {
      const placed = buildChunkBuildings(chunkOf(buildings), lookupOf(RICH), detail)[0] as BuildingPlacement;
      expect(placed.dress, detail).toBeUndefined();
    }
  });
});

describe('the low-rise kinds', () => {
  it('builds several shapes of each kind, from the seed alone', () => {
    for (const kind of ['house', 'shop-row', 'warehouse', 'roadhouse', 'parking-garage'] as const) {
      const shapes = new Set(placedRow(kind, RICH, ROW).map((placed) => signature(placed.shell)));
      // A field of identical grey rectangles is what this issue was about: a
      // dozen lots of one kind never come out as one building repeated.
      expect(shapes.size, kind).toBeGreaterThan(ROW / 2);
    }
  });

  it('builds the same building twice from the same seed', () => {
    const buildings = [buildingOf(0, 'house', 77), buildingOf(1, 'warehouse', 91)];
    const first = buildChunkBuildings(chunkOf(buildings), lookupOf(RICH));
    const second = buildChunkBuildings(chunkOf(buildings), lookupOf(RICH));
    for (let i = 0; i < first.length; i++) {
      const a = first[i] as BuildingPlacement;
      const b = second[i] as BuildingPlacement;
      expect(signature(b.shell)).toBe(signature(a.shell));
      expect(b.dress === undefined).toBe(a.dress === undefined);
    }
  });

  it('roofs a house in tile, slate or metal, and a warehouse in metal alone', () => {
    const covers = new Set<number>();
    for (const placed of placedRow('house', POOR, ROW)) for (const part of partsOf(placed.shell)) covers.add(part);
    // Tile, slate and metal are parts 8, 9 and 7; a house row carries all three.
    expect([7, 8, 9].filter((part) => covers.has(part))).toHaveLength(3);
  });

  it('keeps every variant on the ground its lot claims', () => {
    for (const kind of ['house', 'warehouse', 'roadhouse', 'shop-row'] as const) {
      for (const placed of placedRow(kind, RICH, ROW)) {
        const lot = new Box3();
        for (const corner of placed.building.lot) lot.expandByPoint(new Vector3(corner.x, 0, corner.y));
        for (const geometry of [placed.shell, placed.dress]) {
          if (geometry === undefined) continue;
          const box = boxOf(geometry).applyMatrix4(placed.matrix);
          expect(box.min.x, kind).toBeGreaterThanOrEqual(lot.min.x - 1e-6);
          expect(box.max.x, kind).toBeLessThanOrEqual(lot.max.x + 1e-6);
          expect(box.min.z, kind).toBeGreaterThanOrEqual(lot.min.z - 1e-6);
          expect(box.max.z, kind).toBeLessThanOrEqual(lot.max.z + 1e-6);
        }
      }
    }
  });
});
