import { describe, expect, it } from 'vitest';
import { AmbientTraffic, SMOOTH, trafficRoadsOf, type AmbientPose, type TrafficCursor } from '../src/sim/traffic.ts';
import type { RoadEdge } from '../src/world/graph.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Point, RoadTier, WorldDescription } from '../src/world/types.ts';
import { TICKS_PER_HOUR } from '../src/sim/clock.ts';
import { bedsOf, graphOf, seeds, worlds } from './seed-fixture.ts';
import { TRAFFIC_COUNT, TRAFFIC_TIER_MIN } from './seed-limits.ts';

/**
 * The seed sweep of spec section 3, on the traffic of spec section 13.1: every
 * tier of a real city carries vehicles, and every vehicle stands on its road.
 *
 * `seed-sweep.test.ts` declares these inside the one suite that generates the
 * worlds; a file of its own would generate them all again.
 */
export function trafficChecks(): void {
  describe('traffic', () => {
    it('puts traffic on every tier of the city, standing on the road it drives', () => {
      const cursor: TrafficCursor = { id: 0, leg: 0, into: 0 };
      const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
      for (const seed of seeds.slice(0, TRAFFIC_COUNT)) {
        const world = worlds.get(seed) as WorldDescription;
        const graph = graphOf(seed);
        const traffic = new AmbientTraffic(seed, trafficRoadsOf(world, graph, bedsOf(seed)));

        const length: Partial<Record<RoadTier, number>> = {};
        for (const edge of graph.edges) length[edge.tier] = (length[edge.tier] ?? 0) + edge.length / 2;

        // At the start of the day and at noon: a tier is not empty at one moment and full at another.
        for (const tick of [0, 12 * TICKS_PER_HOUR]) {
          const carried: Partial<Record<RoadTier, number>> = {};
          for (const vehicle of traffic.vehicles) {
            traffic.cursorAt(vehicle.id, tick, cursor);
            const edge = graph.edges[traffic.edgeOf(cursor)] as RoadEdge;
            carried[edge.tier] = (carried[edge.tier] ?? 0) + 1;
            if (vehicle.id % 7 !== 0) continue;
            traffic.pose(cursor, pose);
            // A vehicle takes a corner inside the junction, so it may stand a
            // few metres off its own run there; it never leaves the carriageway.
            const off = distanceTo(graph.edgePoints(edge.id), pose.x, pose.y);
            expect(off, `seed ${seed}: vehicle ${vehicle.id} off its ${edge.tier}`).toBeLessThan(TIERS[edge.tier].width / 2 + SMOOTH);
          }
          for (const tier of Object.keys(TIERS).sort() as RoadTier[]) {
            if ((length[tier] ?? 0) < TRAFFIC_TIER_MIN) continue;
            expect(carried[tier] ?? 0, `seed ${seed}: no traffic on ${Math.round(length[tier] ?? 0)} m of ${tier} at tick ${tick}`).toBeGreaterThan(0);
          }
        }
      }
    });
  });
}

function distanceTo(points: readonly Point[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const l2 = vx * vx + vy * vy;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * vx + (y - a.y) * vy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - a.x - vx * t, y - a.y - vy * t));
  }
  return best;
}
