import { describe, expect, it } from 'vitest';
import { buildRoadGraph } from '../../../src/world/roads/graph.ts';
import { RoadNetwork, type RoadDraft } from '../../../src/world/roads/road-network.ts';
import type { RoadTier } from '../../../src/world/types.ts';

/**
 * The road network the tracer writes into (spec section 6.5): one graph, where
 * each road added is joined to the nodes it stands on, and the graph built
 * later reads those nodes and nothing else.
 */

function draft(coords: readonly [number, number][], tier: RoadTier = 'street'): RoadDraft {
  return { tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [] };
}

const network = (): RoadNetwork => new RoadNetwork(2000, () => 0);

describe('road network', () => {
  it('gives both ends of a road a node, and no other point', () => {
    const roads = network();
    const road = roads.add(
      draft([
        [-100, 0],
        [0, 0],
        [100, 0],
      ]),
    );
    expect(road?.nodes[0]).toBeGreaterThanOrEqual(0);
    expect(road?.nodes[2]).toBeGreaterThanOrEqual(0);
    expect(road?.nodes[0]).not.toBe(road?.nodes[2]);
    expect(road?.nodes[1]).toBe(-1);
  });

  it('splits an edge where a road ends on one of its points, and joins both there', () => {
    const roads = network();
    const through = roads.add(
      draft([
        [-100, 0],
        [0, 0],
        [100, 0],
      ]),
    );
    const branch = roads.add(
      draft([
        [0, 0],
        [0, 100],
      ]),
    );
    const node = through?.nodes[1] as number;
    expect(node).toBeGreaterThanOrEqual(0);
    expect(branch?.nodes[0]).toBe(node);
    expect(roads.sharedAt(0, 1)).toBe(true);
    expect(roads.curvesAt({ x: 0, y: 0 })).toEqual([0, 1]);
    // The graph reads the split: three edges each way meet at the middle.
    const graph = buildRoadGraph(roads.curves);
    expect(graph.degree(graph.nearestNode(0, 0) as number)).toBe(3);
  });

  it('snaps a road to a node that is already there', () => {
    const roads = network();
    roads.add(
      draft([
        [0, 0],
        [100, 0],
      ]),
    );
    const other = roads.add(
      draft([
        [100.004, 0.003],
        [100, 100],
      ]),
    );
    expect(other?.nodes[0]).toBe(roads.curves[0]?.nodes[1]);
    expect(other?.points[0]).toEqual({ x: 100, y: 0 });
  });

  it('refuses a road that lies over its own carriageway', () => {
    const roads = network();
    const folded = roads.add(
      draft(
        [
          [0, 0],
          [40, 0],
          [0, 6],
        ],
        'arterial',
      ),
    );
    expect(folded).toBeUndefined();
    expect(roads.curves).toHaveLength(0);
  });
});
