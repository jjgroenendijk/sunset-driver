import { describe, expect, it } from 'vitest';
import { TIERS } from '../src/world/tiers.ts';
import type { Corridor, Point, RoadCurve } from '../src/world/types.ts';
import { build, curve, dip, FLAT, ringDistricts, ringRoads, viaduct, world } from './corridor-fixture.ts';
import { pointInRing, ringArea, ringsOverlap } from './helpers.ts';


describe('elevated corridors', () => {
  it('claims the ground under a deck and stands its pillars inside it', () => {
    const { corridors } = build(world(dip(2), []), [viaduct([1, 2])]);
    expect(corridors.length).toBe(1);
    const corridor = corridors[0] as Corridor;
    expect(corridor.kind).toBe('elevated');
    expect(corridor.roads).toEqual([0]);
    expect(corridor.halfWidth).toBeGreaterThan(TIERS.highway.width / 2);

    // The strip runs the length of the deck and is twice its half-width across.
    expect(corridor.points.length).toBe(3);
    expect(ringArea(corridor.polygon), 'the ring is wound anticlockwise').toBeGreaterThan(0);
    expect(ringArea(corridor.polygon)).toBeCloseTo(200 * 2 * corridor.halfWidth, 0);

    // Pillars come in pairs across the deck, and all of them stand on the ground it claims.
    expect(corridor.pillars.length).toBeGreaterThanOrEqual(2);
    expect(corridor.pillars.length % 2).toBe(0);
    for (const foot of corridor.pillars) expect(pointInRing(foot, corridor.polygon), `${foot.x},${foot.y}`).toBe(true);
  });

  it('leaves a deck over water without a corridor, because it covers no ground', () => {
    const { corridors } = build(world(dip(-5), []), [viaduct([1, 2])]);
    expect(corridors).toEqual([]);
  });

  it('gives a road on the ground no corridor at all', () => {
    const { corridors } = build(world(FLAT, []), [viaduct([])]);
    expect(corridors).toEqual([]);
  });
});

describe('the tram', () => {
  it('runs one loop of arterials through the core and inner districts', () => {
    const roads = ringRoads();
    const { corridors, tram } = build(world(FLAT, ringDistricts()), roads);

    // A stop for every district, called at in the order they stand round the core.
    expect(tram.stops.length).toBe(4);
    expect(tram.stops.map((s) => s.district)).toEqual([0, 1, 2, 3]);
    expect(tram.length).toBeGreaterThan(4 * 600 - 1);

    // The loop closes: the last leg comes back to where the first one left.
    const head = tram.route[0] as Point;
    const tail = tram.route[tram.route.length - 1] as Point;
    expect(Math.hypot(head.x - tail.x, head.y - tail.y)).toBeLessThan(1e-6);

    // The lane it reserves is on the arterials, never on the street.
    expect(tram.corridors.length).toBeGreaterThan(0);
    for (const id of tram.corridors) {
      const corridor = corridors[id] as Corridor;
      expect(corridor.kind).toBe('tram');
      for (const road of corridor.roads) expect((roads[road] as RoadCurve).tier).toBe('arterial');
    }
  });

  it('marks a level crossing where another road meets the line, and nowhere else', () => {
    const { tram } = build(world(FLAT, ringDistricts()), ringRoads());
    expect(tram.crossings.length).toBe(1);
    const crossing = tram.crossings[0] as { x: number; y: number; roads: number[] };
    expect(crossing.x).toBeCloseTo(0);
    expect(crossing.y).toBeCloseTo(-300);
    expect(crossing.roads).toEqual([4]);
  });

  it('runs no tram where the arterials come nowhere near the districts', () => {
    const roads = [
      curve(0, 'arterial', [
        [-300, 0],
        [300, 0],
      ]),
    ];
    const { corridors, tram } = build(world(FLAT, ringDistricts()), roads);
    expect(tram.stops).toEqual([]);
    expect(tram.route).toEqual([]);
    expect(corridors).toEqual([]);
  });
});

describe('claiming ground', () => {
  it('cuts the strip under a deck around the tram lane rather than sharing the ground', () => {
    // A highway carried over the south side of the ring on a deck. The tram
    // claims its lane first, so the strip under the deck stops either side of it.
    const roads = [
      ...ringRoads(),
      curve(
        5,
        'highway',
        [
          [150, -450],
          [150, -375],
          [150, -300],
          [150, -225],
          [150, -150],
        ],
        [0, 1, 2, 3],
      ),
    ];
    const { corridors } = build(world(FLAT, ringDistricts()), roads);
    const elevated = corridors.filter((c) => c.kind === 'elevated');
    expect(elevated.length, 'the deck owns the ground either side of the lane').toBe(2);

    for (let i = 0; i < corridors.length; i++) {
      for (let j = i + 1; j < corridors.length; j++) {
        const a = corridors[i] as Corridor;
        const b = corridors[j] as Corridor;
        expect(ringsOverlap(a.polygon, b.polygon), `corridor ${i} overlaps corridor ${j}`).toBe(false);
      }
    }
  });
});
