import { describe, expect, it } from 'vitest';
import { pointInRing, regionsFromRings, ringArea, type Point } from '../../../src/core/geom.ts';
import { Heightfield } from '../../../src/world/terrain/heightfield.ts';
import { landRegions, landRings } from '../../../src/world/terrain/land.ts';

/** Metres between the nodes of the test grids, and nodes per side. */
const CELL = 10;
const NODES = 21;

/** A heightfield of {@link NODES} nodes a side, filled from a function of the world point. */
function field(height: (x: number, y: number) => number): Heightfield {
  const hf = Heightfield.create(NODES, CELL);
  for (let iy = 0; iy < NODES; iy++) {
    for (let ix = 0; ix < NODES; ix++) hf.set(ix, iy, height(hf.worldX(ix), hf.worldY(iy)));
  }
  return hf;
}

/** A square plateau `reach` metres each way from the middle, standing 10 m above a sea 5 m deep. */
function plateau(reach: number): Heightfield {
  return field((x, y) => (Math.abs(x) <= reach && Math.abs(y) <= reach ? 10 : -5));
}

/**
 * The ground such a plateau claims. The waterline stands two thirds of a cell
 * past the last dry node, because that is where the heights either side of the
 * cell edge cross the sea level, and each of the four corners is chamfered off
 * where the contour turns.
 */
function plateauArea(reach: number): number {
  const out = (CELL * 2) / 3;
  const side = 2 * (reach + out);
  return side * side - 2 * out * out;
}

describe('land polygons', () => {
  it('traces a plateau as one ring wound with the land on its left', () => {
    const rings = landRings(plateau(30), 0);
    expect(rings).toHaveLength(1);
    const ring = rings[0] as Point[];
    expect(ringArea(ring)).toBeCloseTo(plateauArea(30), 6);
  });

  it('puts a pond inside its island as a hole', () => {
    const hf = field((x, y) => {
      if (Math.abs(x) > 40 || Math.abs(y) > 40) return -5;
      return Math.abs(x) <= 10 && Math.abs(y) <= 10 ? -3 : 10;
    });
    const regions = landRegions(hf, 0);
    expect(regions).toHaveLength(1);
    const region = regions[0] as (typeof regions)[number];
    expect(ringArea(region.outer)).toBeGreaterThan(0);
    expect(region.holes).toHaveLength(1);
    const hole = region.holes[0] as Point[];
    // A hole winds the other way, and stands inside the coast around it.
    expect(ringArea(hole)).toBeLessThan(0);
    expect(pointInRing(hole[0] as Point, region.outer)).toBe(true);
  });

  it('closes a coastline that runs off the edge of the grid', () => {
    // Dry everywhere: the land has no shore of its own, so the only ring is the
    // one the edge of the grid cuts.
    const regions = landRegions(field(() => 10), 0);
    expect(regions).toHaveLength(1);
    const region = regions[0] as (typeof regions)[number];
    expect(region.holes).toHaveLength(0);
    // The waterline closes on the last node of the grid, so the land is the
    // whole extent the heightfield covers.
    const extent = (NODES - 1) * CELL;
    expect(ringArea(region.outer)).toBeCloseTo(extent * extent, 0);
  });

  it('drops a rock too small to stand anything on', () => {
    // One dry node: a patch a third of a cell across, well under the smallest
    // piece of land the trace keeps.
    expect(landRings(field((x, y) => (x === 0 && y === 0 ? 1 : -5)), 0)).toHaveLength(0);
  });

  it('gathers rings into regions by the outline each one stands in', () => {
    const outer: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const hole: Point[] = [
      { x: 40, y: 40 },
      { x: 40, y: 60 },
      { x: 60, y: 60 },
      { x: 60, y: 40 },
    ];
    const regions = regionsFromRings([outer, hole]);
    expect(regions).toHaveLength(1);
    expect((regions[0] as (typeof regions)[number]).holes).toHaveLength(1);
  });
});
