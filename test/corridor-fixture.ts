/**
 * Hand-built worlds for the corridor, pier and tram track tests, so each can be
 * checked without generating a world.
 */
import { buildCorridors, type CorridorDescription } from '../src/world/corridors.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import type { District, RoadCurve, RoadTier, WorldDescription, WorldSkeleton, Zone } from '../src/world/types.ts';
import { withNodes } from './helpers.ts';

const SIZE = 1024;
const CELL = 16;

/** A hand-built world, so corridors can be checked without generating one. */
export function world(ground: (x: number, y: number) => number, districts: District[]): WorldSkeleton {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) hf.set(ix, iy, ground(hf.worldX(ix), hf.worldY(iy)));
  }
  return {
    seed: 1,
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
    districts,
    beaches: [],
  };
}

/** Flat ground well above the sea. */
export const FLAT = (): number => 20;

export function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

export function curve(id: number, tier: RoadTier, coords: readonly [number, number][], bridges: number[] = []): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges, tunnels: [], interchanges: [], nodes: [] };
}

export function build(skeleton: WorldSkeleton, roads: RoadCurve[]): CorridorDescription {
  withNodes(roads);
  return buildCorridors(skeleton, roads, buildRoadGraph(roads));
}

/** A highway on the ground either side of a dip it is carried over. */
export function viaduct(bridges: number[]): RoadCurve {
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
export function dip(depth: number): (x: number, y: number) => number {
  return (x) => (x > -100 && x < 100 ? depth : 20);
}

/** A ring of arterials round the core, with a street meeting the south side halfway. */
export function ringRoads(): RoadCurve[] {
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
export function ringDistricts(): District[] {
  return [
    district(0, 'core', -280, -280),
    district(1, 'inner', 280, -280),
    district(2, 'inner', 280, 280),
    district(3, 'inner', -280, 280),
  ];
}

/**
 * The ring, with a highway carried over its south side on a deck. The tram
 * claims its lane down the middle of that arterial first, so the deck's claim
 * is cut where the two meet.
 */
export function deckOverRing(): RoadCurve[] {
  return [
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
}

/** A whole world description over a skeleton, with its roads and the corridors laid along them. */
export function worldOf(skeleton: WorldSkeleton, roads: RoadCurve[]): WorldDescription {
  const { corridors, tram } = build(skeleton, roads);
  return { ...skeleton, roads, corridors, tram };
}
