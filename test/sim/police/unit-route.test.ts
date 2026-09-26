import { describe, expect, it } from 'vitest';
import { laneOffset } from '../../../src/sim/traffic/traffic.ts';
import { UnitRoads, type DrivePose } from '../../../src/sim/police/unit-route.ts';
import type { Point, RoadCurve } from '../../../src/world/types.ts';
import { gridTrafficRoads } from '../../support/traffic-grid.ts';

describe('the roads a unit drives (spec section 14)', () => {
  it('drives the lane nearest the kerb of its own side, on every run', () => {
    const roads = gridTrafficRoads();
    const units = new UnitRoads(roads);
    const out: DrivePose = { x: 0, y: 0, height: 0, heading: 0 };
    let wide = 0;
    for (const edge of roads.graph.edges) {
      if (edge.length < 40) continue;
      // Halfway along a straight run, clear of the corners at either end.
      const at = units.pose(edge.id, [edge.id], edge.length / 2, out);
      const curve = roads.roads[edge.curve] as RoadCurve;
      const a = curve.points[edge.start] as Point;
      const b = curve.points[edge.end] as Point;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const right = (-(at.x - a.x) * (b.y - a.y) + (at.y - a.y) * (b.x - a.x)) / length;
      expect(right, `edge ${edge.id} on ${edge.tier}`).toBeCloseTo(laneOffset(edge, edge.lanes - 1), 6);
      if (edge.lanes > 1) wide++;
    }
    expect(wide).toBeGreaterThan(0);
  });
});
