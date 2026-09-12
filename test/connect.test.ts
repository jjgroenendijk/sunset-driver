import { describe, expect, it } from 'vitest';
import { connectCrossings, CROSSING_SNAP, type CanRun } from '../src/world/connect.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import type { Point, RoadCurve, RoadTier } from '../src/world/types.ts';

/** Ground that refuses nothing, so only the crossings themselves decide. */
const anywhere: CanRun = () => true;

function curve(id: number, coords: readonly [number, number][], tier: RoadTier = 'street'): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [] };
}

/** The points of a curve as pairs, so a whole line can be compared at once. */
function pointsOf(road: RoadCurve): [number, number][] {
  return road.points.map((p) => [p.x, p.y]);
}

/** True where both curves have a point at the same place. */
function share(a: RoadCurve, b: RoadCurve, at: Point): boolean {
  const has = (road: RoadCurve): boolean =>
    road.points.some((p) => Math.abs(p.x - at.x) < 1e-9 && Math.abs(p.y - at.y) < 1e-9);
  return has(a) && has(b);
}

describe('roads that cross on the ground', () => {
  it('gives both of them a point where they cross', () => {
    const roads = connectCrossings(
      [
        curve(0, [
          [-50, 0],
          [50, 0],
        ]),
        curve(1, [
          [0, -50],
          [0, 50],
        ]),
      ],
      anywhere,
    );
    expect(pointsOf(roads[0] as RoadCurve)).toEqual([
      [-50, 0],
      [0, 0],
      [50, 0],
    ]);
    expect(pointsOf(roads[1] as RoadCurve)).toEqual([
      [0, -50],
      [0, 0],
      [0, 50],
    ]);
  });

  it('turns the crossing into a node of the graph and leaves none behind', () => {
    const before = [
      curve(0, [
        [-50, 0],
        [50, 0],
      ]),
      curve(1, [
        [0, -50],
        [0, 50],
      ]),
    ];
    expect(buildRoadGraph(before).crossings).toHaveLength(1);
    const after = buildRoadGraph(connectCrossings(before, anywhere));
    expect(after.crossings).toHaveLength(0);
    const node = after.nodes.find((n) => n.x === 0 && n.y === 0);
    expect(node?.edges).toHaveLength(4);
  });

  it('takes a point a curve already has rather than making a second one beside it', () => {
    const nudge = CROSSING_SNAP / 4;
    const roads = connectCrossings(
      [
        curve(0, [
          [-50, 0],
          [nudge, 0],
          [50, 0],
        ]),
        curve(1, [
          [0, -50],
          [0, 50],
        ]),
      ],
      anywhere,
    );
    // The road that has a point beside the crossing keeps its line, and the
    // other one is bent onto it. Two junctions a quarter of a metre apart would
    // stand inside each other.
    expect(pointsOf(roads[0] as RoadCurve)).toEqual([
      [-50, 0],
      [nudge, 0],
      [50, 0],
    ]);
    expect(pointsOf(roads[1] as RoadCurve)).toEqual([
      [0, -50],
      [nudge, 0],
      [0, 50],
    ]);
  });

  it('leaves a highway crossing alone, because it takes junctions only at interchanges', () => {
    const before = [
      curve(0, [
        [-50, 0],
        [50, 0],
      ], 'highway'),
      curve(1, [
        [0, -50],
        [0, 50],
      ]),
    ];
    const roads = connectCrossings(before, anywhere);
    expect(pointsOf(roads[0] as RoadCurve)).toEqual(pointsOf(before[0] as RoadCurve));
    expect(pointsOf(roads[1] as RoadCurve)).toEqual(pointsOf(before[1] as RoadCurve));
    expect(buildRoadGraph(roads).crossings).toHaveLength(1);
  });

  it('leaves a crossing under a deck or over a bore alone', () => {
    const deck = curve(0, [
      [-50, 0],
      [50, 0],
    ]);
    deck.bridges = [0];
    const bore = curve(2, [
      [-50, 20],
      [50, 20],
    ]);
    bore.tunnels = [0];
    const roads = connectCrossings(
      [
        deck,
        curve(1, [
          [0, -50],
          [0, 50],
        ]),
        bore,
      ],
      anywhere,
    );
    expect(pointsOf(roads[0] as RoadCurve)).toHaveLength(2);
    expect(pointsOf(roads[2] as RoadCurve)).toHaveLength(2);
    // The road across them takes neither of the two crossings.
    expect(pointsOf(roads[1] as RoadCurve)).toHaveLength(2);
  });

  it('leaves a crossing alone where the ground refuses the junction', () => {
    // A junction cuts a segment in two, and the two halves can climb harder
    // than the whole did. The ground has the last word.
    const refuse: CanRun = (a, b) => !(a.x === 0 && a.y === 0) && !(b.x === 0 && b.y === 0);
    const roads = connectCrossings(
      [
        curve(0, [
          [-50, 0],
          [50, 0],
        ]),
        curve(1, [
          [0, -50],
          [0, 50],
        ]),
      ],
      refuse,
    );
    expect(pointsOf(roads[0] as RoadCurve)).toHaveLength(2);
    expect(pointsOf(roads[1] as RoadCurve)).toHaveLength(2);
  });

  it('moves the decks, bores and interchanges of a curve with its points', () => {
    const along = curve(0, [
      [-50, 0],
      [0, 0],
      [40, 0],
      [80, 0],
      [120, 0],
    ]);
    along.bridges = [2];
    along.tunnels = [3];
    along.interchanges = [0, 4];
    const roads = connectCrossings(
      [
        along,
        curve(1, [
          [-25, -50],
          [-25, 50],
        ]),
      ],
      anywhere,
    );
    const cut = roads[0] as RoadCurve;
    // One point went in on the first segment, so everything after it moves on
    // by one and stands on the same ground as before.
    expect(pointsOf(cut)).toEqual([
      [-50, 0],
      [-25, 0],
      [0, 0],
      [40, 0],
      [80, 0],
      [120, 0],
    ]);
    expect(cut.bridges).toEqual([3]);
    expect(cut.tunnels).toEqual([4]);
    expect(cut.interchanges).toEqual([0, 5]);
    expect(share(cut, roads[1] as RoadCurve, { x: -25, y: 0 })).toBe(true);
  });

  it('gives one point to a place two crossings meet at', () => {
    // Three roads through nearly the same place: the second and third crossings
    // stand within a snap of the first, so all three share one point.
    const roads = connectCrossings(
      [
        curve(0, [
          [-50, 0],
          [50, 0],
        ]),
        curve(1, [
          [0, -50],
          [0, 50],
        ]),
        curve(2, [
          [-50, -50],
          [50, 50],
        ]),
      ],
      anywhere,
    );
    for (const road of roads) expect(pointsOf(road)).toHaveLength(3);
    const graph = buildRoadGraph(roads);
    expect(graph.crossings).toHaveLength(0);
    const node = graph.nodes.find((n) => n.x === 0 && n.y === 0);
    expect(node?.edges).toHaveLength(6);
  });
});
