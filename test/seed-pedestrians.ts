import { describe, expect, it } from 'vitest';
import { CORNER_REACH, pavementOffset } from '../src/sim/pedestrian-route.ts';
import { AmbientPedestrians, crowdDistrictsOf, type PedestrianPose } from '../src/sim/pedestrians.ts';
import { trafficRoadsOf } from '../src/sim/traffic.ts';
import type { RoadEdge } from '../src/world/graph.ts';
import type { WorldDescription } from '../src/world/types.ts';
import { bedsOf, graphOf, junctionsOf, seeds, worlds } from './seed-fixture.ts';
import { TRAFFIC_COUNT } from './seed-limits.ts';

/** People each seed reads a pose of. */
const READ = 400;

/**
 * The seed sweep of spec section 3, on the pedestrians of spec section 13.1: a
 * real city has people on its pavements, and each one stands on the pavement
 * of the road they walk, or crosses it near a junction.
 *
 * `seed-sweep.test.ts` declares these inside the one suite that generates the
 * worlds; a file of its own would generate them all again.
 */
export function pedestrianChecks(): void {
  describe('pedestrians', () => {
    it('puts people on the pavements of the city, each beside the road they walk', () => {
      const pose: PedestrianPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' };
      for (const seed of seeds.slice(0, TRAFFIC_COUNT)) {
        const world = worlds.get(seed) as WorldDescription;
        const graph = graphOf(seed);
        const crowd = new AmbientPedestrians(seed, trafficRoadsOf(world, graph, bedsOf(seed), junctionsOf(seed)), crowdDistrictsOf(world));
        expect(crowd.people.length, `seed ${seed}: nobody on the pavements`).toBeGreaterThan(500);
        const stride = Math.max(1, Math.floor(crowd.people.length / READ));
        for (let id = 0; id < crowd.people.length; id += stride) {
          const tick = id * 7919;
          const edge = graph.edges[crowd.edgeAt(id, tick)] as RoadEdge;
          crowd.poseAt(id, tick, pose);
          const off = graph.nearestEdge(pose.x, pose.y)?.distance ?? Infinity;
          expect(Number.isFinite(pose.x + pose.y + pose.height + pose.heading), `seed ${seed}: person ${id}`).toBe(true);
          // Never further from a road than a corner may stand from its junction, which is further
          // than the middle of the widest pavement.
          expect(off, `seed ${seed}: person ${id} off the ${edge.tier} they walk`).toBeLessThan(CORNER_REACH * pavementOffset({ tier: 'arterial' }));
        }
      }
    });
  });
}
