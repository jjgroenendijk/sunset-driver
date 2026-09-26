import { beforeAll, describe, expect, it } from 'vitest';
import {
  ALWAYS_SHOWN,
  clampScale,
  easeScale,
  MapPois,
  MAX_SCALE,
  MIN_SCALE,
  poiCounts,
  wheelScale,
} from '../../../src/ui/map/map.ts';
import { findRoute, Navigator, pathLength } from '../../../src/ui/map/map-route.ts';
import { buildRoadGraph, type RoadGraph } from '../../../src/world/roads/graph.ts';
import type { Point, RoadCurve, RoadTier, WorldDescription } from '../../../src/world/types.ts';
import { sharedWorld } from '../../sweep/world-pool.ts';

function curve(id: number, tier: RoadTier, coords: readonly [number, number][], nodes: number[]): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [], nodes };
}

/**
 * A square block: four streets round a building, so the straight line from one
 * corner to the opposite one runs through the block and the route must not.
 */
function block(): RoadGraph {
  return buildRoadGraph([
    curve(0, 'street', [[0, 0], [50, 0], [100, 0]], [0, -1, 1]),
    curve(1, 'street', [[100, 0], [100, 50], [100, 100]], [1, -1, 2]),
    curve(2, 'street', [[100, 100], [50, 100], [0, 100]], [2, -1, 3]),
    curve(3, 'street', [[0, 100], [0, 50], [0, 0]], [3, -1, 0]),
  ]);
}

/** True when a point lies on the ring of streets of {@link block}. */
function onBlock(p: Point): boolean {
  const near = (v: number, to: number): boolean => Math.abs(v - to) < 1e-6;
  return near(p.x, 0) || near(p.x, 100) || near(p.y, 0) || near(p.y, 100);
}

describe('the smooth zoom of the full map (spec section 12)', () => {
  it('zooms by a small factor for one notch of a wheel, not a whole step', () => {
    const next = wheelScale(4, -100, 0, false);
    expect(next).toBeLessThan(4);
    expect(next).toBeGreaterThan(4 / 1.5);
  });

  it('zooms a trackpad the same distance as a wheel for the same travel', () => {
    let pad = 4;
    for (let i = 0; i < 25; i++) pad = wheelScale(pad, 4, 0, false);
    expect(pad).toBeCloseTo(wheelScale(4, 100, 0, false), 6);
  });

  it('caps one fast flick, and keeps the scale inside the zoom range', () => {
    expect(wheelScale(4, 5000, 0, false)).toBe(wheelScale(4, 120, 0, false));
    expect(wheelScale(MAX_SCALE, 100, 0, false)).toBe(MAX_SCALE);
    expect(wheelScale(MIN_SCALE, -100, 0, false)).toBe(MIN_SCALE);
    expect(clampScale(1000)).toBe(MAX_SCALE);
  });

  it('eases toward the target over a few frames and then lands on it', () => {
    let scale = 4;
    const seen: number[] = [];
    for (let i = 0; i < 60 && scale !== 1; i++) {
      scale = easeScale(scale, 1, 1 / 60);
      seen.push(scale);
    }
    expect(seen.length).toBeGreaterThan(4);
    expect(scale).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeLessThanOrEqual(seen[i - 1]!);
  });
});

describe('the route to the waypoint (spec section 12)', () => {
  it('goes round the block along the streets, not through it', () => {
    const route = findRoute(block(), { x: 5, y: -3 }, { x: 95, y: 103 });
    expect(route.road.length).toBeGreaterThan(2);
    for (const p of route.road) expect(onBlock(p)).toBe(true);
    // Round two sides of a 100-metre block, give or take the ends.
    expect(pathLength(route.road)).toBeGreaterThan(180);
    expect(route.lead).toHaveLength(2);
    expect(route.tail).toHaveLength(2);
  });

  it('drives along one street when both ends are on it', () => {
    const route = findRoute(block(), { x: 10, y: 2 }, { x: 90, y: -2 });
    expect(route.road.map((p) => p.y)).toEqual(route.road.map(() => 0));
    expect(pathLength(route.road)).toBeCloseTo(80, 6);
  });

  it('walks straight where the roads are further than the mark', () => {
    const route = findRoute(block(), { x: 45, y: 45 }, { x: 55, y: 55 });
    expect(route.road).toHaveLength(0);
    expect(route.lead).toHaveLength(2);
  });

  it('cuts the driven part off the front as the player follows it', () => {
    const graph = block();
    const nav = new Navigator(() => graph);
    const mark = { x: 95, y: 103 };
    nav.update({ x: 5, y: -3 }, mark);
    const first = nav.route!.length;
    nav.update({ x: 60, y: 0 }, mark);
    expect(nav.route!.length).toBeLessThan(first - 40);
    expect(nav.route!.road[0]).toEqual({ x: 60, y: 0 });
    nav.update({ x: 60, y: 0 }, null);
    expect(nav.route).toBeNull();
  });

  describe('on a generated world', () => {
    let world: WorldDescription;
    let graph: RoadGraph;
    beforeAll(async () => {
      world = await sharedWorld(1);
      graph = buildRoadGraph(world.roads);
    });

    it('follows the road curves between two far places', () => {
      const from = { x: -world.size / 5, y: -world.size / 6 };
      const to = { x: world.size / 6, y: world.size / 5 };
      const route = findRoute(graph, from, to);
      // A route over the roads is longer than the crow flies, and every bend
      // of it is a point of some road the world traced.
      expect(route.road.length).toBeGreaterThan(10);
      expect(route.length).toBeGreaterThan(Math.hypot(to.x - from.x, to.y - from.y));
      const on = new Set<string>();
      for (const road of world.roads) for (const p of road.points) on.add(`${p.x},${p.y}`);
      const inner = route.road.slice(1, -1);
      const off = inner.filter((p) => !on.has(`${p.x},${p.y}`));
      expect(off).toEqual([]);
    });
  });
});

describe('the legend of the full map (spec section 12)', () => {
  let world: WorldDescription;
  beforeAll(async () => {
    world = await sharedWorld(1);
  });

  it('counts the kinds of place a city has, in the order of the icon table', () => {
    const pois = new MapPois(world);
    pois.extra = [
      { type: 'clinic', x: 0, y: 0 },
      { type: 'clinic', x: 10, y: 0 },
    ];
    const counts = poiCounts([pois.fixed, pois.extra]);
    expect(counts.find((c) => c.type === 'clinic')?.count).toBe(2);
    expect(counts.find((c) => c.type === 'harbour')?.count).toBe(1);
    expect(counts.some((c) => c.type === 'gun-shop')).toBe(false);
    expect(ALWAYS_SHOWN).toContain('player');
  });

  it('leaves a kind the player switched off off both maps', () => {
    const pois = new MapPois(world);
    const box = { minX: -world.size, minY: -world.size, maxX: world.size, maxY: world.size };
    expect(pois.visible(box, 1).some((p) => p.type === 'car-park')).toBe(true);
    pois.hidden.add('car-park');
    expect(pois.visible(box, 1).some((p) => p.type === 'car-park')).toBe(false);
  });
});
