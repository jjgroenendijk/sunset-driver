import type { Ground } from '../src/sim/physics.ts';
import { AmbientTraffic, type TrafficRoads } from '../src/sim/traffic.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import type { Point, RoadCurve, RoadTier } from '../src/world/types.ts';
import { DRY } from './helpers.ts';

/**
 * A made-up road network the traffic tests drive on: five roads each way, 120 m
 * apart, crossing at shared points, one of every tier. The simulation tests
 * read the world through a {@link Ground}, so a generated city would measure
 * the city; this measures the traffic. `seed-traffic.ts` checks the real ones.
 */
export const GRID_SPACING = 120;
const LINES = [-2, -1, 0, 1, 2];
const STEP = 10;
const ROWS: RoadTier[] = ['street', 'street', 'arterial', 'street', 'dirt'];
const COLUMNS: RoadTier[] = ['alley', 'street', 'highway', 'street', 'street'];

/** The grid as curves. A point every 10 m, so every crossing is a point both roads share. */
export function gridRoads(): RoadCurve[] {
  const roads: RoadCurve[] = [];
  const reach = 2 * GRID_SPACING;
  const along = (fixed: number, horizontal: boolean): Point[] => {
    const points: Point[] = [];
    for (let s = -reach; s <= reach; s += STEP) points.push(horizontal ? { x: s, y: fixed } : { x: fixed, y: s });
    return points;
  };
  for (const [i, line] of LINES.entries()) {
    const tier = ROWS[i] as RoadTier;
    roads.push({ id: roads.length, tier, points: along(line * GRID_SPACING, true), bridges: [], tunnels: [], interchanges: [] });
  }
  for (const [i, line] of LINES.entries()) {
    const tier = COLUMNS[i] as RoadTier;
    roads.push({ id: roads.length, tier, points: along(line * GRID_SPACING, false), bridges: [], tunnels: [], interchanges: [] });
  }
  return roads;
}

/** The rolling ground the grid lies on, the same shape as the hillside of `sim-harness.ts`. */
export function gridHeight(x: number, y: number): number {
  return 2.5 * Math.sin(x / 37) + 1.5 * Math.cos(y / 51) + 0.35 * Math.sin(x / 8 + y / 11);
}

export function gridTrafficRoads(busyAt?: (x: number, y: number) => number): TrafficRoads {
  const roads = gridRoads();
  return { roads, graph: buildRoadGraph(roads), busyAt, heightAt: (_c, _s, _t, x, y) => gridHeight(x, y) };
}

/** The grid's traffic for a seed. */
export function gridTraffic(seed: number): AmbientTraffic {
  return new AmbientTraffic(seed, gridTrafficRoads());
}

/** A ground with the grid's traffic on it. */
export function gridGround(traffic: AmbientTraffic): Ground {
  return { heightAt: gridHeight, surfaceAt: () => 'asphalt', seaLevel: DRY, traffic };
}
