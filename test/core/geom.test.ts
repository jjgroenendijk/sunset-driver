import { describe, expect, it } from 'vitest';
import {
  areaOf,
  difference,
  disc,
  offsetSides,
  pointInRegion,
  pointInRegions,
  pointInRing,
  regionArea,
  regionOf,
  ringArea,
  split,
  strip,
  union,
  type Point,
  type Region,
} from '../../src/core/geom.ts';
import { crossings, edgeBox, type Edges, noEdges, pushEdge, settle } from '../../src/core/edges.ts';
import { collect } from '../../src/core/planar.ts';
import { stableJson } from '../support/helpers.ts';

/** A rectangle wound anticlockwise, with its lower left corner at (x, y). */
function rect(x: number, y: number, width: number, height: number): Point[] {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

/** A square ring wound anticlockwise, with its lower left corner at (x, y). */
function square(x: number, y: number, side: number): Point[] {
  return rect(x, y, side, side);
}

/** True when no two of the regions share any ground, sampled over a grid. */
function disjoint(regions: readonly Region[], from: number, to: number, step: number): boolean {
  for (let x = from; x <= to; x += step) {
    for (let y = from; y <= to; y += step) {
      let owners = 0;
      for (const region of regions) if (pointInRegion({ x, y }, region)) owners++;
      if (owners > 1) return false;
    }
  }
  return true;
}

describe('rings', () => {
  it('measures a ring anticlockwise positive and clockwise negative', () => {
    const ring = square(0, 0, 10);
    expect(ringArea(ring)).toBe(100);
    expect(ringArea([...ring].reverse())).toBe(-100);
  });

  it('measures a small ring far from the origin without losing it in the rounding', () => {
    const far = square(1_000_000, -1_000_000, 0.5);
    expect(ringArea(far)).toBeCloseTo(0.25, 9);
  });

  it('takes the area of a region as its outline less its holes', () => {
    const region: Region = { outer: square(0, 0, 10), holes: [[...square(2, 2, 3)].reverse()] };
    expect(regionArea(region)).toBe(91);
    expect(areaOf([region, regionOf(square(20, 0, 4))])).toBe(107);
  });

  it('says which points stand inside a ring', () => {
    const ring = square(0, 0, 10);
    expect(pointInRing({ x: 5, y: 5 }, ring)).toBe(true);
    expect(pointInRing({ x: 15, y: 5 }, ring)).toBe(false);
    expect(pointInRing({ x: -0.001, y: 5 }, ring)).toBe(false);
  });

  it('leaves the ground inside a hole to nobody', () => {
    const region: Region = { outer: square(0, 0, 10), holes: [[...square(2, 2, 3)].reverse()] };
    expect(pointInRegion({ x: 1, y: 1 }, region)).toBe(true);
    expect(pointInRegion({ x: 3, y: 3 }, region)).toBe(false);
    expect(pointInRegions({ x: 3, y: 3 }, [region, regionOf(square(2, 2, 3))])).toBe(true);
  });

  it('winds a ring given as a region anticlockwise, whichever way it came', () => {
    expect(ringArea(regionOf([...square(0, 0, 10)].reverse()).outer)).toBe(100);
  });
});

describe('offsets', () => {
  it('covers the width of a straight line each side', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const ring = strip(line, 5);
    expect(ringArea(ring)).toBeCloseTo(1000, 6);
    expect(pointInRing({ x: 50, y: 4.9 }, ring)).toBe(true);
    expect(pointInRing({ x: 50, y: 5.1 }, ring)).toBe(false);
  });

  it('mitres a corner so the two segments hand the ground over without a gap', () => {
    const bend = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
    ];
    const ring = strip(bend, 5);
    // The outside of the corner is covered right up to the mitre.
    expect(pointInRing({ x: 54, y: -4 }, ring)).toBe(true);
    expect(pointInRing({ x: 56, y: -6 }, ring)).toBe(false);
    const sides = offsetSides(bend, 5);
    expect(sides.left).toHaveLength(3);
    expect(sides.right).toHaveLength(3);
  });

  it('draws a disc that covers the whole circle of its radius', () => {
    const ring = disc(3, -7, 10, 8);
    expect(ringArea(ring)).toBeGreaterThan(Math.PI * 100);
    for (let i = 0; i < 32; i++) {
      const angle = (2 * Math.PI * i) / 32;
      expect(pointInRing({ x: 3 + 9.99 * Math.cos(angle), y: -7 + 9.99 * Math.sin(angle) }, ring)).toBe(true);
    }
  });
});

describe('union', () => {
  it('leaves regions that do not touch alone', () => {
    const out = union([regionOf(square(0, 0, 10)), regionOf(square(20, 0, 10))]);
    expect(out).toHaveLength(2);
    expect(areaOf(out)).toBe(200);
  });

  it('counts ground two regions share only once', () => {
    const out = union([regionOf(square(0, 0, 10)), regionOf(square(5, 5, 10))]);
    expect(out).toHaveLength(1);
    expect(areaOf(out)).toBe(175);
  });

  it('joins two regions that share an edge into one', () => {
    const out = union([regionOf(square(0, 0, 10)), regionOf(square(10, 0, 10))]);
    expect(out).toHaveLength(1);
    expect(out[0]?.outer).toHaveLength(4);
    expect(areaOf(out)).toBe(200);
  });

  it('swallows a region that stands wholly inside another, and a repeat of one', () => {
    expect(areaOf(union([regionOf(square(0, 0, 30)), regionOf(square(10, 10, 10))]))).toBe(900);
    expect(areaOf(union([regionOf(square(0, 0, 30)), regionOf(square(0, 0, 30))]))).toBe(900);
  });

  it('gives the blocks between crossing strips back as holes', () => {
    const bars: Region[] = [];
    for (let i = 0; i < 4; i++) {
      const at = i * 60 - 90;
      bars.push(regionOf(strip([{ x: -100, y: at }, { x: 100, y: at }], 4)));
      bars.push(regionOf(strip([{ x: at, y: -100 }, { x: at, y: 100 }], 4)));
    }
    const out = union(bars);
    expect(out).toHaveLength(1);
    // Four lines each way leave nine blocks enclosed between them.
    expect(out[0]?.holes).toHaveLength(9);
    expect(regionArea(out[0] as Region)).toBeCloseTo(8 * 200 * 8 - 16 * 64, 6);
  });

  it('keeps a strip solid where it folds back over itself', () => {
    const hairpin = strip(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 3 },
        { x: 0, y: 3 },
      ],
      6,
    );
    const out = union([regionOf(hairpin)]);
    expect(out).toHaveLength(1);
    expect(out[0]?.holes).toHaveLength(0);
    expect(pointInRegion({ x: 20, y: 1.5 }, out[0] as Region)).toBe(true);
  });

  it('gives the same answer whichever order the regions come in', () => {
    const parts = [regionOf(square(0, 0, 10)), regionOf(square(5, 5, 10)), regionOf(square(9, 0, 6))];
    const forwards = union(parts);
    const backwards = union([...parts].reverse());
    expect(areaOf(backwards)).toBeCloseTo(areaOf(forwards), 9);
    expect(backwards).toHaveLength(forwards.length);
  });

  it('is a pure function of its input', () => {
    const parts = [regionOf(square(0, 0, 10)), regionOf(square(5, 5, 10))];
    expect(stableJson(union(parts))).toBe(stableJson(union(parts)));
  });

  it('has nothing to give for no regions at all', () => {
    expect(union([])).toEqual([]);
  });
});

describe('difference', () => {
  it('cuts a hole where the clip stands inside the subject', () => {
    const out = difference([regionOf(square(0, 0, 30))], [regionOf(square(10, 10, 10))]);
    expect(out).toHaveLength(1);
    expect(out[0]?.holes).toHaveLength(1);
    expect(areaOf(out)).toBe(800);
    expect(pointInRegions({ x: 15, y: 15 }, out)).toBe(false);
    expect(pointInRegions({ x: 5, y: 15 }, out)).toBe(true);
  });

  it('cuts the subject in two where the clip runs across it', () => {
    const out = difference([regionOf(square(0, 0, 30))], [regionOf(rect(-5, 10, 40, 10))]);
    expect(out).toHaveLength(2);
    expect(areaOf(out)).toBe(600);
    expect(disjoint(out, 0, 30, 1)).toBe(true);
  });

  it('leaves nothing where the clip covers the subject', () => {
    expect(difference([regionOf(square(0, 0, 10))], [regionOf(square(-5, -5, 20))])).toEqual([]);
  });

  it('leaves the subject alone where the clip stands elsewhere', () => {
    const out = difference([regionOf(square(0, 0, 10))], [regionOf(square(20, 20, 10))]);
    expect(areaOf(out)).toBe(100);
  });

  it('gives back the ground the subject and the clip do not share', () => {
    const land = regionOf(square(0, 0, 100));
    const roads = union([
      regionOf(strip([{ x: -10, y: 50 }, { x: 110, y: 50 }], 5)),
      regionOf(strip([{ x: 50, y: -10 }, { x: 50, y: 110 }], 5)),
    ]);
    const parcels = difference([land], roads);
    expect(parcels).toHaveLength(4);
    // The two ten-metre strips cover 1900 m² of the land, counting their crossing once.
    expect(areaOf(parcels)).toBeCloseTo(10000 - 1900, 6);
    expect(disjoint(parcels, 0, 100, 2)).toBe(true);
  });
});

describe('settling the edges', () => {
  /** How many places two of the edges still cross away from their ends. */
  function crossingsLeft(edges: Edges): number {
    let count = 0;
    crossings(edges, edgeBox(edges), () => count++);
    return count;
  }

  it('cuts two one-unit diagonals that cross in the middle of a cell', () => {
    // Each diagonal passes as near the other two corners of the cell as the
    // snap reaches. Routing one through both corners gave the opposite
    // diagonal, so every pass swapped one crossing for another.
    const edges = noEdges();
    pushEdge(edges, 0, 0, 1, 1, 0);
    pushEdge(edges, 1, 0, 0, 1, 1);
    expect(crossingsLeft(settle(edges))).toBe(0);
  });

  it('leaves no crossing where a street and an alley kerb meet a pavement claim', () => {
    // Seed 2246342428 at junction 1495, cut down to the three rings that still
    // made the crossing. The pavement came out over the junction.
    const ring = (points: number[][]): Point[] => points.map(([x, y]) => ({ x: x as number, y: y as number }));
    const edges = noEdges();
    collect([regionOf(ring([[478.6774080120396, -65.96097627256287], [315.38678047756866, -44.710397007525486], [301.5417311456, -42.742547910527904]]))], 0, edges);
    collect(
      [
        regionOf(ring([[313.81632946872713, 39.90349964052439], [312.2294691378916, -44.261636427231345], [316.22944601128944, -44.27520803231767]])),
        regionOf(ring([[312.24852953875023, -38.64392415324521], [312.19941243247075, -53.12027370560471], [316.1993894088476, -53.13384531034895]])),
      ],
      1,
      edges,
    );
    expect(crossingsLeft(settle(edges))).toBe(0);
  });
});

describe('split', () => {
  it('gives the two sides of a cut, with all the ground and none of it twice', () => {
    const subject = regionOf(square(0, 0, 30));
    const { inside, outside } = split([subject], [regionOf(rect(-5, -5, 40, 20))]);
    expect(areaOf(inside)).toBe(450);
    expect(areaOf(outside)).toBe(450);
    expect(disjoint([...inside, ...outside], 0, 30, 1)).toBe(true);
  });

  it('keeps a hole in whichever side it falls on', () => {
    const subject = difference([regionOf(square(0, 0, 30))], [regionOf(square(4, 4, 6))]);
    const { inside, outside } = split(subject, [regionOf(rect(-5, -5, 40, 20))]);
    expect((inside[0] as Region).holes).toHaveLength(1);
    expect(areaOf(outside)).toBe(450);
    expect(areaOf(inside)).toBe(450 - 36);
  });

  it('cuts with a clip whose sides each run kilometres across the map', () => {
    // The shape an oversized block is cut down with: a rectangle covering one
    // side of a line, reaching far past the subject, so every side of it is one
    // long diagonal edge. The engine files such an edge in the buckets it
    // really crosses, so this costs what the subject is worth and not what the
    // clip spans.
    const reach = 3000;
    const dx = Math.cos(Math.PI / 6) * reach;
    const dy = Math.sin(Math.PI / 6) * reach;
    const clip = regionOf([
      { x: 15 - dx, y: 15 - dy },
      { x: 15 + dx, y: 15 + dy },
      { x: 15 + dx - dy, y: 15 + dy + dx },
      { x: 15 - dx - dy, y: 15 - dy + dx },
    ]);
    const { inside, outside } = split([regionOf(square(0, 0, 30))], [clip]);
    expect(areaOf(inside)).toBeGreaterThan(0);
    expect(areaOf(outside)).toBeGreaterThan(0);
    expect(areaOf(inside) + areaOf(outside)).toBeCloseTo(900, 6);
    expect(disjoint([...inside, ...outside], 0, 30, 1)).toBe(true);
  });

  it('gives one side everything where the clip misses the subject', () => {
    const subject = regionOf(square(0, 0, 10));
    const { inside, outside } = split([subject], [regionOf(square(20, 20, 10))]);
    expect(inside).toEqual([]);
    expect(areaOf(outside)).toBe(100);
  });

  it('has nothing to give for no regions at all', () => {
    expect(split([], [])).toEqual({ inside: [], outside: [] });
  });
});
