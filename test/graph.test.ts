import { describe, expect, it } from 'vitest';
import { buildRoadGraph, type GradeCrossing, type RoadEdge } from '../src/world/graph.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { RoadCurve, RoadTier } from '../src/world/types.ts';
import { stableJson } from './helpers.ts';

/** A hand-built curve, so a graph can be checked without generating a world. */
function curve(
  id: number,
  tier: RoadTier,
  coords: readonly [number, number][],
  bridges: number[] = [],
  tunnels: number[] = [],
): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges, tunnels };
}

/** Two streets crossing at the origin, sharing the point they meet at. */
function crossroads(): RoadCurve[] {
  return [
    curve(0, 'street', [
      [-100, 0],
      [0, 0],
      [100, 0],
    ]),
    curve(1, 'street', [
      [0, -100],
      [0, 0],
      [0, 100],
    ]),
  ];
}

describe('tier table', () => {
  it('gives every tier a width, lanes, a speed limit and permitted traffic', () => {
    const tiers: RoadTier[] = ['highway', 'arterial', 'street', 'alley', 'dirt'];
    for (const tier of tiers) {
      const spec = TIERS[tier];
      expect(spec.width, tier).toBeGreaterThan(0);
      expect(spec.lanes, tier).toBeGreaterThanOrEqual(1);
      expect(spec.speedLimit, tier).toBeGreaterThan(0);
      // Room for the lanes of one direction, at three metres each.
      expect(spec.width, `${tier} is too narrow for its lanes`).toBeGreaterThanOrEqual(3 * spec.lanes);
    }
    // The through-routes get wider the higher up the hierarchy they are, and the
    // two tiers at the bottom of it are narrower than any of them.
    expect(TIERS.highway.width).toBeGreaterThan(TIERS.arterial.width);
    expect(TIERS.arterial.width).toBeGreaterThan(TIERS.street.width);
    expect(TIERS.alley.width).toBeLessThan(TIERS.street.width);
    expect(TIERS.dirt.width).toBeLessThan(TIERS.street.width);
    // Spec section 6.2: no pedestrians on a highway, and the tram lane is on the arterials.
    expect(TIERS.highway.traffic.pedestrians).toBe(false);
    expect(TIERS.arterial.traffic.trams).toBe(true);
    expect(TIERS.highway.speedLimit).toBeGreaterThan(TIERS.street.speedLimit);
  });
});

describe('road graph', () => {
  it('makes a node where curves meet and one at every free end', () => {
    const graph = buildRoadGraph(crossroads());
    // Four ends and the junction. The bends of a curve are not nodes.
    expect(graph.nodes.length).toBe(5);
    expect(graph.edges.length).toBe(8);

    const centre = graph.nearestNode(0, 0) as number;
    expect(graph.degree(centre)).toBe(4);
    for (const end of [
      [-100, 0],
      [100, 0],
      [0, -100],
      [0, 100],
    ] as const) {
      const node = graph.nearestNode(end[0], end[1]) as number;
      expect(graph.degree(node), `${end[0]},${end[1]}`).toBe(1);
    }
    expect(graph.neighbours(centre)).toEqual(graph.neighbours(centre).slice().sort((a, b) => a - b));
    expect(graph.neighbours(centre).length).toBe(4);
  });

  it('carries a curve straight through a bend', () => {
    const graph = buildRoadGraph([
      curve(0, 'street', [
        [0, 0],
        [100, 0],
        [200, 0],
      ]),
    ]);
    expect(graph.nodes.length).toBe(2);
    expect(graph.edges.length).toBe(2);
    const edge = graph.edges[0] as RoadEdge;
    expect(edge.length).toBe(200);
    expect(edge.start).toBe(0);
    expect(edge.end).toBe(2);
    expect(edge.tier).toBe('street');
    expect(edge.lanes).toBe(TIERS.street.lanes);
    expect(edge.speedLimit).toBe(TIERS.street.speedLimit);
    expect(graph.edgePoints(edge.id).length).toBe(3);
  });

  it('pairs every edge with the same run the other way', () => {
    const graph = buildRoadGraph(crossroads());
    for (const edge of graph.edges) {
      const twin = graph.edges[edge.twin] as RoadEdge;
      expect(twin.twin).toBe(edge.id);
      expect(twin.from).toBe(edge.to);
      expect(twin.to).toBe(edge.from);
      expect(twin.length).toBe(edge.length);
      expect(graph.edgePoints(twin.id).reverse()).toEqual(graph.edgePoints(edge.id));
    }
  });

  it('marks the runs that are carried on a bridge deck', () => {
    const graph = buildRoadGraph([
      curve(
        0,
        'arterial',
        [
          [0, 0],
          [100, 0],
          [300, 0],
        ],
        [1],
      ),
    ]);
    // One run: it holds the deck, so the edge is a bridge.
    expect((graph.edges[0] as RoadEdge).bridge).toBe(true);
    const dry = buildRoadGraph([
      curve(0, 'arterial', [
        [0, 0],
        [100, 0],
      ]),
    ]);
    expect((dry.edges[0] as RoadEdge).bridge).toBe(false);
  });

  it('routes by travel time, so a highway detour beats a crawl down an alley', () => {
    // Both roads join (0, 0) to (600, 0): 600 m of alley, or 1400 m of highway.
    const graph = buildRoadGraph([
      curve(0, 'alley', [
        [0, 0],
        [600, 0],
      ]),
      curve(1, 'highway', [
        [0, 0],
        [0, 400],
        [600, 400],
        [600, 0],
      ]),
    ]);
    const from = graph.nearestNode(0, 0) as number;
    const to = graph.nearestNode(600, 0) as number;
    const route = graph.shortestPath(from, to);
    expect(route).toBeDefined();
    const taken = route as NonNullable<typeof route>;
    expect(taken.edges.length).toBe(1);
    expect((graph.edges[taken.edges[0] as number] as RoadEdge).tier).toBe('highway');
    expect(taken.length).toBeCloseTo(1400, 6);
    expect(taken.time).toBeCloseTo(1400 / TIERS.highway.speedLimit, 6);
    expect(taken.nodes).toEqual([from, to]);
    expect(600 / TIERS.alley.speedLimit).toBeGreaterThan(taken.time);
  });

  it('chains the edges of a route through the nodes it visits', () => {
    const graph = buildRoadGraph([
      curve(0, 'street', [
        [0, 0],
        [100, 0],
      ]),
      curve(1, 'street', [
        [100, 0],
        [100, 100],
      ]),
      curve(2, 'street', [
        [100, 100],
        [200, 100],
      ]),
    ]);
    const from = graph.nearestNode(0, 0) as number;
    const to = graph.nearestNode(200, 100) as number;
    const route = graph.shortestPath(from, to) as NonNullable<ReturnType<typeof graph.shortestPath>>;
    expect(route.edges.length).toBe(3);
    expect(route.nodes.length).toBe(4);
    expect(route.length).toBeCloseTo(300, 6);
    for (let i = 0; i < route.edges.length; i++) {
      const edge = graph.edges[route.edges[i] as number] as RoadEdge;
      expect(edge.from).toBe(route.nodes[i]);
      expect(edge.to).toBe(route.nodes[i + 1]);
    }
  });

  it('breaks a tie between equal routes the same way every time', () => {
    // Two streets of the same length join the same pair of nodes. The route
    // takes the lower edge id, because only a strictly cheaper way replaces one
    // already found, and equal costs are settled in node order.
    const graph = buildRoadGraph([
      curve(0, 'street', [
        [0, 0],
        [0, 100],
        [200, 100],
        [200, 0],
      ]),
      curve(1, 'street', [
        [0, 0],
        [0, -100],
        [200, -100],
        [200, 0],
      ]),
    ]);
    const from = graph.nearestNode(0, 0) as number;
    const to = graph.nearestNode(200, 0) as number;
    const first = graph.shortestPath(from, to) as NonNullable<ReturnType<typeof graph.shortestPath>>;
    const second = graph.shortestPath(from, to) as NonNullable<ReturnType<typeof graph.shortestPath>>;
    expect(first.edges).toEqual([0]);
    expect(second).toEqual(first);
    expect((graph.edges[0] as RoadEdge).curve).toBe(0);
  });

  it('finds no route to a node the network does not reach', () => {
    const graph = buildRoadGraph([
      curve(0, 'street', [
        [0, 0],
        [100, 0],
      ]),
      curve(1, 'dirt', [
        [900, 900],
        [1000, 900],
      ]),
    ]);
    const from = graph.nearestNode(0, 0) as number;
    const island = graph.nearestNode(1000, 900) as number;
    expect(graph.shortestPath(from, island)).toBeUndefined();
    expect(graph.shortestPath(from, from)?.edges).toEqual([]);
  });

  it('finds the nearest point of the network to a place', () => {
    const graph = buildRoadGraph(crossroads());
    const hit = graph.nearestEdge(50, 30);
    expect(hit).toBeDefined();
    const found = hit as NonNullable<typeof hit>;
    expect((graph.edges[found.edge] as RoadEdge).curve).toBe(0);
    expect(found.x).toBeCloseTo(50, 6);
    expect(found.y).toBeCloseTo(0, 6);
    expect(found.distance).toBeCloseTo(30, 6);
    expect(graph.nearestEdge(0, 0)?.distance).toBeCloseTo(0, 6);
    expect(buildRoadGraph([]).nearestEdge(0, 0)).toBeUndefined();
  });

  it('marks the runs that are bored through the ground', () => {
    const graph = buildRoadGraph([
      curve(
        0,
        'street',
        [
          [0, 0],
          [100, 0],
          [300, 0],
        ],
        [],
        [1],
      ),
    ]);
    expect((graph.edges[0] as RoadEdge).tunnel).toBe(true);
    expect((graph.edges[0] as RoadEdge).bridge).toBe(false);
  });

  it('carries a highway over a street it crosses without making a junction', () => {
    // The two curves cross at the origin but share no point there.
    const graph = buildRoadGraph([
      curve(0, 'street', [
        [0, -100],
        [0, 100],
      ]),
      curve(1, 'highway', [
        [-100, 0],
        [100, 0],
      ]),
    ]);
    // Four free ends and nothing else: the crossing is not a place to turn.
    expect(graph.nodes.length).toBe(4);
    for (const node of graph.nodes) expect(graph.degree(node.id)).toBe(1);
    expect(graph.shortestPath(graph.nearestNode(0, -100) as number, graph.nearestNode(100, 0) as number)).toBeUndefined();

    expect(graph.crossings.length).toBe(1);
    const crossing = graph.crossings[0] as GradeCrossing;
    expect(crossing.x).toBeCloseTo(0, 6);
    expect(crossing.y).toBeCloseTo(0, 6);
    expect((graph.edges[crossing.over] as RoadEdge).tier).toBe('highway');
    expect((graph.edges[crossing.under] as RoadEdge).tier).toBe('street');
    // Both roads know about it, in both directions of travel.
    for (const id of [crossing.over, crossing.under]) {
      const edge = graph.edges[id] as RoadEdge;
      expect(edge.crossings, `edge ${id}`).toEqual([0]);
      expect((graph.edges[edge.twin] as RoadEdge).crossings, `twin of ${id}`).toEqual([0]);
    }
  });

  it('leaves a junction where the two roads share the point they cross at', () => {
    const graph = buildRoadGraph(crossroads());
    expect(graph.crossings.length).toBe(0);
    for (const edge of graph.edges) expect(edge.crossings).toEqual([]);
  });

  it('carries a deck over whatever it crosses, whatever tier that is', () => {
    // An alley on a deck crosses an arterial on the ground.
    const graph = buildRoadGraph([
      curve(0, 'arterial', [
        [-100, 0],
        [100, 0],
      ]),
      curve(
        1,
        'alley',
        [
          [0, -100],
          [0, 100],
        ],
        [0],
      ),
    ]);
    expect(graph.crossings.length).toBe(1);
    const crossing = graph.crossings[0] as GradeCrossing;
    expect((graph.edges[crossing.over] as RoadEdge).tier).toBe('alley');
    expect((graph.edges[crossing.under] as RoadEdge).tier).toBe('arterial');
  });

  it('builds the same graph from the same curves', () => {
    const a = buildRoadGraph(crossroads());
    const b = buildRoadGraph(crossroads());
    expect(stableJson({ nodes: b.nodes, edges: b.edges })).toBe(stableJson({ nodes: a.nodes, edges: a.edges }));
  });
});
