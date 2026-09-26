import { describe, expect, it } from 'vitest';
import { pointInRegions } from '../src/core/geom.ts';
import { buildFootprint } from '../src/world/footprint.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Corridor, Point, RoadCurve } from '../src/world/types.ts';
import { build, curve, deckOverRing, dip, FLAT, ringDistricts, ringRoads, shore, viaduct, world, worldOf } from './corridor-fixture.ts';
import { pointInRing, ringArea, ringsOverlap } from './helpers.ts';


describe('elevated corridors', () => {
  it('claims the ground under a deck and stands its pillars inside it', () => {
    const { corridors } = build(world(dip(2), []), [viaduct([1, 2])]);
    expect(corridors).toHaveLength(1);
    const corridor = corridors[0] as Corridor;
    expect(corridor.kind).toBe('elevated');
    expect(corridor.roads).toEqual([0]);
    expect(corridor.halfWidth).toBeGreaterThan(TIERS.highway.width / 2);

    // The strip runs the length of the deck and is twice its half-width across.
    expect(corridor.points).toHaveLength(3);
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
    expect(tram.stops).toHaveLength(4);
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
    expect(tram.crossings).toHaveLength(1);
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
    const { corridors } = build(world(FLAT, ringDistricts()), deckOverRing());
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

  it('leaves the ground a cut gave up to the footprint, so no parcel stands under a deck', () => {
    // The same deck over the same lane. Two of its four segments lose their
    // claim, and the ground under them belongs to the road instead: were it
    // nobody's, `buildParcels` would hand it to a parcel (issue #288).
    const w = worldOf(world(FLAT, ringDistricts()), deckOverRing());
    const footprint = buildFootprint(w, buildRoadGraph(w.roads));
    const deck = w.roads[5] as RoadCurve;
    const elevated = w.corridors.filter((corridor) => corridor.kind === 'elevated');
    expect(elevated).toHaveLength(2);
    for (const i of deck.bridges) {
      const a = deck.points[i] as Point;
      const b = deck.points[i + 1] as Point;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const owned = elevated.some((corridor) => pointInRing(mid, corridor.polygon)) || pointInRegions(mid, footprint.regions);
      expect(owned, `the ground under segment ${i} at ${mid.x}, ${mid.y} is nobody's`).toBe(true);
    }
  });

  it('claims the dry half of the deck segment that leaves the shore, and none of the wet half', () => {
    // The shoreline falls at x = -50, halfway along the deck segment that runs
    // from x = -100 to x = 0. `overWater` calls that segment wet whole, so no
    // corridor claims it, and the 50 m of dry land under it belonged to nobody
    // until the footprint cut the deck at the waterline (issue #531).
    const w = worldOf(world(shore(-5, -50), []), [viaduct([0, 1, 2, 3])]);
    const footprint = buildFootprint(w, buildRoadGraph(w.roads));
    const elevated = w.corridors.filter((corridor) => corridor.kind === 'elevated');
    const held = (p: Point): boolean =>
      elevated.some((corridor) => pointInRing(p, corridor.polygon)) || pointInRegions(p, footprint.regions);

    // The segment before the shore stands on land, so its corridor holds it.
    expect(held({ x: -150, y: 0 }), 'the ground under the dry segment is nobody\'s').toBe(true);
    // The dry half of the segment that crosses the shoreline.
    expect(held({ x: -75, y: 0 }), 'the dry ground under the shore segment is nobody\'s').toBe(true);
    // The wet half of it, and the open water past it, are not ground at all.
    expect(held({ x: -25, y: 0 }), 'the sea under the shore segment is claimed').toBe(false);
    expect(held({ x: 50, y: 0 }), 'the sea under the deck is claimed').toBe(false);
  });
});
