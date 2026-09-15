import { AmbientTraffic, type TrafficRoads } from '../src/sim/traffic.ts';
import { TramLine } from '../src/sim/tram.ts';
import { buildCorridors } from '../src/world/corridors.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { buildJunctions } from '../src/world/junctions.ts';
import type { District, Point, RoadCurve, RoadTier, TramDescription, WorldSkeleton } from '../src/world/types.ts';
import { withNodes } from './helpers.ts';

/**
 * A made-up city the tram tests run on: a ring of arterials 600 m across round
 * the origin, a district in each corner, and a road across the middle of each
 * side. Three of those are streets and the west one is an alley, which takes a
 * light only because the tram crosses it. The corridors of `corridors.ts` plan
 * the loop on it, as they do on a generated world.
 */
export const RING = 300;
const STEP = 10;
const CROSS_REACH = 150;
const SIZE = 1024;
const CELL = 16;

/** The rolling ground the ring lies on, so a car's height means something. */
export function ringHeight(x: number, y: number): number {
  return 1.5 * Math.sin(x / 41) + Math.cos(y / 53);
}

function line(id: number, tier: RoadTier, from: Point, to: Point): RoadCurve {
  const steps = Math.round(Math.hypot(to.x - from.x, to.y - from.y) / STEP);
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) points.push({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
  return { id, tier, points, bridges: [], tunnels: [], interchanges: [], nodes: [] };
}

export function ringRoads(): RoadCurve[] {
  const r = RING;
  const far = r + CROSS_REACH;
  const near = r - CROSS_REACH;
  return withNodes([
    line(0, 'arterial', { x: -r, y: -r }, { x: r, y: -r }),
    line(1, 'arterial', { x: r, y: -r }, { x: r, y: r }),
    line(2, 'arterial', { x: r, y: r }, { x: -r, y: r }),
    line(3, 'arterial', { x: -r, y: r }, { x: -r, y: -r }),
    line(4, 'street', { x: 0, y: -far }, { x: 0, y: -near }),
    line(5, 'street', { x: far, y: 0 }, { x: near, y: 0 }),
    line(6, 'street', { x: 0, y: far }, { x: 0, y: near }),
    line(7, 'alley', { x: -far, y: 0 }, { x: -near, y: 0 }),
  ]);
}

function skeleton(): WorldSkeleton {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) for (let ix = 0; ix < gridSize; ix++) hf.set(ix, iy, 20);
  const district = (id: number, x: number, y: number): District => ({ id, name: `D${id}`, zone: id === 0 ? 'core' : 'inner', x, y, density: 0.5, wealth: 0.5, culture: 'none' });
  const d = RING - 20;
  return {
    seed: 1,
    size: SIZE,
    archetype: 'archipelago',
    core: { x: 0, y: 0 },
    terrain: hf.toData(),
    water: { seaLevel: 0, islands: [{ id: 0, x: 0, y: 0, radius: SIZE / 2, main: true }], crossings: [], rivers: [], harbour: { x: 0, y: 0, radius: 10 }, industry: 0 },
    districts: [district(0, -d, -d), district(1, d, -d), district(2, d, d), district(3, -d, d)],
    beaches: [],
  };
}

/** The ring, its tram line, the traffic on it and the trams, for a seed. */
export interface Ring {
  roads: TrafficRoads;
  tram: TramDescription;
  districts: District[];
  traffic: AmbientTraffic;
  line: TramLine;
}

export function ring(seed: number): Ring {
  const curves = ringRoads();
  const graph = buildRoadGraph(curves);
  const world = skeleton();
  const { tram } = buildCorridors(world, curves, graph);
  const roads: TrafficRoads = { roads: curves, graph, heightAt: (_c, _s, _t, x, y) => ringHeight(x, y), junctions: buildJunctions(curves, graph), tram };
  const traffic = new AmbientTraffic(seed, roads);
  const line = new TramLine(seed, roads, tram, world.districts, traffic.signals);
  return { roads, tram, districts: world.districts, traffic, line };
}
