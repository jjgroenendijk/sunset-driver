import { describe, expect, it } from 'vitest';
import { buildCorridors } from '../src/world/corridors.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Corridor, District, Point, RoadCurve, RoadTier, WorldSkeleton, Zone } from '../src/world/types.ts';
import { pointInRing, ringArea, ringsOverlap } from './helpers.ts';

const SIZE = 1024;
const CELL = 16;

/** A hand-built world, so corridors can be checked without generating one. */
function world(ground: (x: number, y: number) => number, districts: District[]): WorldSkeleton {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) hf.set(ix, iy, ground(hf.worldX(ix), hf.worldY(iy)));
  }
  return {
    seed: 1,
    size: SIZE,
    core: { x: 0, y: 0 },
    terrain: hf.toData(),
    water: {
      seaLevel: 0,
      islands: [{ id: 0, x: 0, y: 0, radius: SIZE / 2, main: true }],
      crossings: [],
      river: { path: [], halfWidths: [] },
      harbour: { x: 0, y: 0, radius: 10 },
    },
    districts,
  };
}

/** Flat ground well above the sea. */
const FLAT = (): number => 20;

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, tier: RoadTier, coords: readonly [number, number][], bridges: number[] = []): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges, tunnels: [] };
}

function build(skeleton: WorldSkeleton, roads: RoadCurve[]) {
  return buildCorridors(skeleton, roads, buildRoadGraph(roads));
}

/** A highway on the ground either side of a dip it is carried over. */
function viaduct(bridges: number[]): RoadCurve {
  return curve(
    0,
    'highway',
    [
      [-200, 0],
      [-100, 0],
      [0, 0],
      [100, 0],
      [200, 0],
    ],
    bridges,
  );
}

/** Ground that falls away between two places, so a road over it needs a deck. */
function dip(depth: number): (x: number, y: number) => number {
  return (x) => (x > -100 && x < 100 ? depth : 20);
}

/** A ring of arterials round the core, with a street meeting the south side halfway. */
function ringRoads(): RoadCurve[] {
  return [
    curve(0, 'arterial', [
      [-300, -300],
      [0, -300],
      [300, -300],
    ]),
    curve(1, 'arterial', [
      [300, -300],
      [300, 0],
      [300, 300],
    ]),
    curve(2, 'arterial', [
      [300, 300],
      [0, 300],
      [-300, 300],
    ]),
    curve(3, 'arterial', [
      [-300, 300],
      [-300, 0],
      [-300, -300],
    ]),
    curve(4, 'street', [
      [0, -300],
      [0, -450],
    ]),
  ];
}

/** One district in each corner of that ring, so the loop calls at all four. */
function ringDistricts(): District[] {
  return [
    district(0, 'core', -280, -280),
    district(1, 'inner', 280, -280),
    district(2, 'inner', 280, 280),
    district(3, 'inner', -280, 280),
  ];
}

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
