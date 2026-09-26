import { expect, it } from 'vitest';
import { compareStrings } from '../../src/core/sort.ts';
import { AmbientTraffic, footprintsTouch, SMOOTH, trafficRoadsOf, type AmbientPose, type Footprint, type TrafficCursor } from '../../src/sim/traffic/traffic.ts';
import { specOf } from '../../src/sim/vehicles/vehicle.ts';
import type { RoadEdge, RoadGraph } from '../../src/world/roads/graph.ts';
import { TIERS } from '../../src/world/roads/tiers.ts';
import type { RoadTier, WorldDescription } from '../../src/world/types.ts';
import { TICKS_PER_HOUR } from '../../src/sim/clock.ts';
import { bedsOf, graphOf, junctionsOf, seeds, worlds } from './seed-fixture.ts';
import { TRAFFIC_COUNT, TRAFFIC_OVERLAP, TRAFFIC_STACKED, TRAFFIC_TIER_MIN } from './seed-limits.ts';
import { signalLap } from '../support/signal-lap.ts';
import { checkTram, distanceTo } from './seed-tram.ts';
import { sweepSuite } from './seed-suite.ts';

/** Vehicles timed to the lights each seed follows round a whole lap. */
const SIGNAL_LAPS = 8;

/**
 * The seed sweep of spec section 3, on the traffic of spec section 13.1: every
 * tier of a real city carries vehicles, and every vehicle stands on its road.
 */
sweepSuite('traffic', () => {
  it('puts traffic on every tier of the city, stopping on red, and runs the tram round its lights', () => {
    const cursor: TrafficCursor = { id: 0, step: 0, into: 0 };
    const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    for (const seed of seeds.slice(0, TRAFFIC_COUNT)) {
      const world = worlds.get(seed) as WorldDescription;
      const graph = graphOf(seed);
      const roads = trafficRoadsOf(world, graph, bedsOf(seed), junctionsOf(seed));
      const traffic = new AmbientTraffic(seed, roads);

      const length: Partial<Record<RoadTier, number>> = {};
      // A two-way run is two edges on one road; a ramp is one.
      for (const edge of graph.edges) length[edge.tier] = (length[edge.tier] ?? 0) + (edge.twin >= 0 ? edge.length / 2 : edge.length);

      // At the start of the day and at noon: a tier is not empty at one moment and full at another.
      for (const tick of [0, 12 * TICKS_PER_HOUR]) checkMoment(seed, graph, traffic, length, tick, cursor, pose);

      // The traffic gets on and off the highway over the ramps of its
      // interchanges (spec section 6.2), so some tour drives one.
      if (graph.edges.some((e) => e.tier === 'ramp')) {
        const drives = traffic.vehicles.some((v) => v.tour.edges.some((e) => graph.edges[e]?.tier === 'ramp'));
        expect(drives, `seed ${seed}: no vehicle drives a ramp`).toBe(true);
      }

      // A city with arterials has traffic lights, and the vehicles timed to
      // them keep to them on its real, crooked junctions.
      if ((length.arterial ?? 0) < TRAFFIC_TIER_MIN) continue;
      checkSignals(seed, traffic);
      checkTram(seed, world, roads, traffic);
    }
  });
});

/**
 * Checks the traffic at one moment: each vehicle stands on its road, each tier
 * long enough carries some, and the vehicles do not stand in piles.
 */
function checkMoment(
  seed: number,
  graph: RoadGraph,
  traffic: AmbientTraffic,
  length: Partial<Record<RoadTier, number>>,
  tick: number,
  cursor: TrafficCursor,
  pose: AmbientPose,
): void {
  const carried: Partial<Record<RoadTier, number>> = {};
  const standing: Footprint[] = [];
  const stopped: Footprint[] = [];
  for (const vehicle of traffic.vehicles) {
    traffic.cursorAt(vehicle.id, tick, cursor);
    const edge = graph.edges[traffic.edgeOf(cursor)] as RoadEdge;
    carried[edge.tier] = (carried[edge.tier] ?? 0) + 1;
    traffic.pose(cursor, pose);
    const spec = specOf(vehicle.cls);
    const box = { x: pose.x, y: pose.y, heading: pose.heading, halfLength: spec.halfLength, halfWidth: spec.halfWidth };
    standing.push(box);
    if (pose.speed === 0) stopped.push(box);
    if (vehicle.id % 7 !== 0) continue;
    // A vehicle takes a corner inside the junction, so it may stand a
    // few metres off its own run there; it never leaves the carriageway.
    const off = distanceTo(graph.edgePoints(edge.id), pose.x, pose.y);
    expect(off, `seed ${seed}: vehicle ${vehicle.id} off its ${edge.tier}`).toBeLessThan(TIERS[edge.tier].width / 2 + SMOOTH);
  }
  for (const tier of Object.keys(TIERS).sort(compareStrings) as RoadTier[]) {
    if ((length[tier] ?? 0) < TRAFFIC_TIER_MIN) continue;
    expect(carried[tier] ?? 0, `seed ${seed}: no traffic on ${Math.round(length[tier] ?? 0)} m of ${tier} at tick ${tick}`).toBeGreaterThan(0);
  }
  // The city's traffic is spread over its roads, not stood in piles:
  // the timing of the tours is the only thing that keeps two vehicles
  // apart, since neither ever reads the other.
  const piled = overlaps(standing) / standing.length;
  expect(piled, `seed ${seed}: ${piled.toFixed(2)} overlapping pairs a vehicle at tick ${tick}`).toBeLessThan(TRAFFIC_OVERLAP);
  // Nor do the vehicles waiting at a light stand on one another.
  const stacked = overlaps(stopped) / standing.length;
  expect(stacked, `seed ${seed}: ${stacked.toFixed(3)} stopped pairs a vehicle at tick ${tick}`).toBeLessThan(TRAFFIC_STACKED);
}

/** Checks that a city has lights, and that the vehicles timed to them keep to them round a lap. */
function checkSignals(seed: number, traffic: AmbientTraffic): void {
  expect(traffic.signals?.junctions.length ?? 0, `seed ${seed}: no traffic lights`).toBeGreaterThan(0);
  const timed = traffic.vehicles.filter((v) => v.tour.sync >= 0);
  expect(timed.length, `seed ${seed}: no vehicle meets a light`).toBeGreaterThan(0);
  const stride = Math.max(1, Math.floor(timed.length / SIGNAL_LAPS));
  for (let i = 0; i < timed.length; i += stride) {
    expect(signalLap(traffic, timed[i] as (typeof timed)[number]).faults, `seed ${seed}`).toEqual([]);
  }
}

/** Metres each way of one bucket of the grid the overlapping pairs are counted over. */
const PILE_CELL = 20;

/**
 * Pairs of footprints that stand on the same ground. Each is filed under the
 * cell its middle is in and read against the nine cells around it, since a
 * vehicle is far shorter than a cell.
 */
function overlaps(boxes: readonly Footprint[]): number {
  const cells = new Map<string, number[]>();
  boxes.forEach((box, id) => {
    const key = `${Math.floor(box.x / PILE_CELL)}:${Math.floor(box.y / PILE_CELL)}`;
    const cell = cells.get(key);
    if (cell === undefined) cells.set(key, [id]);
    else cell.push(id);
  });
  let pairs = 0;
  boxes.forEach((box, id) => {
    const cx = Math.floor(box.x / PILE_CELL);
    const cy = Math.floor(box.y / PILE_CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (other > id && footprintsTouch(box, boxes[other] as Footprint, 0)) pairs++;
        }
      }
    }
  });
  return pairs;
}
