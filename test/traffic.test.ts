import { describe, expect, it } from 'vitest';
import {
  AmbientTraffic,
  footprintsTouch,
  laneOffset,
  permitOf,
  SMOOTH,
  type AmbientPose,
  type TrafficCursor,
} from '../src/sim/traffic.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Point, RoadCurve } from '../src/world/types.ts';
import { sweepSeeds, stableJson } from './helpers.ts';
import { gridTraffic, gridTrafficRoads } from './traffic-grid.ts';

/** Vehicles each seed follows tick by tick: every one would be millions of steps. */
const FOLLOWED = process.env.SWEEP_SEEDS ? 60 : 12;
const SEEDS = sweepSeeds(process.env.SWEEP_SEEDS ? 8 : 2);

const pose = (): AmbientPose => ({ x: 0, y: 0, height: 0, heading: 0, speed: 0 });

describe('ambient traffic (spec sections 5.3, 13.1)', () => {
  it('evaluates a vehicle on demand at tick N exactly where stepping it from tick 0 puts it', () => {
    for (const seed of SEEDS) {
      const traffic = gridTraffic(seed);
      expect(traffic.vehicles.length, `seed ${seed}`).toBeGreaterThan(40);
      const stride = Math.max(1, Math.floor(traffic.vehicles.length / FOLLOWED));
      for (let id = 0; id < traffic.vehicles.length; id += stride) {
        const tour = (traffic.vehicles[id] as AmbientTraffic['vehicles'][number]).tour;
        const cursor: TrafficCursor = traffic.cursorAt(id, 0);
        const end = tour.period + 997;
        for (let tick = 1; tick <= end; tick++) {
          traffic.advance(cursor);
          // A check every few hundred ticks and at the end, which is past a
          // whole lap, so the wrap back to the first leg is covered.
          if (tick % 331 !== 0 && tick !== end) continue;
          expect(cursor, `seed ${seed}, vehicle ${id}, tick ${tick}`).toEqual(traffic.cursorAt(id, tick));
          expect(traffic.pose(cursor, pose())).toEqual(traffic.poseAt(id, tick, pose()));
        }
      }
    }
  });

  it('is the same traffic for the same seed and different traffic for another', () => {
    const [a, b] = SEEDS as [number, number];
    const summary = (traffic: AmbientTraffic): string =>
      stableJson(traffic.vehicles.map((v) => [v.cls, v.paint, v.lane, v.phase, Array.from(v.tour.edges)]));
    expect(summary(gridTraffic(a))).toBe(summary(gridTraffic(a)));
    expect(summary(gridTraffic(a))).not.toBe(summary(gridTraffic(b)));
  });

  it('drives closed tours of connected roads, and keeps trucks and buses off the tiers that bar them', () => {
    for (const seed of SEEDS) {
      const traffic = gridTraffic(seed);
      const graph = gridTrafficRoads().graph;
      for (const vehicle of traffic.vehicles) {
        const edges = Array.from(vehicle.tour.edges);
        for (let i = 0; i < edges.length; i++) {
          const edge = graph.edges[edges[i] as number];
          const next = graph.edges[edges[(i + 1) % edges.length] as number];
          expect(edge?.to, `seed ${seed}, vehicle ${vehicle.id}, leg ${i}`).toBe(next?.from);
          expect(permitOf(vehicle.cls)(edge as (typeof graph.edges)[number]), `${vehicle.cls} on ${edge?.tier}`).toBe(true);
        }
        expect(vehicle.tour.period).toBe(Array.from(vehicle.tour.legTicks).reduce((s, t) => s + t, 0));
      }
    }
  });

  it('keeps to its lane on the right of the road, in the direction of travel, at the speed limit', () => {
    const roads = gridTrafficRoads();
    const traffic = new AmbientTraffic(SEEDS[0] as number, roads);
    const cursor: TrafficCursor = { id: 0, leg: 0, into: 0 };
    let checked = 0;
    for (const vehicle of traffic.vehicles) {
      for (let tick = 0; tick < 20_000; tick += 1733) {
        traffic.cursorAt(vehicle.id, tick, cursor);
        const edge = roads.graph.edges[traffic.edgeOf(cursor)] as (typeof roads.graph.edges)[number];
        const ticks = vehicle.tour.legTicks[cursor.leg] as number;
        const along = (cursor.into / ticks) * edge.length;
        // Near either end of a leg the vehicle is taking the corner.
        if (along < SMOOTH * 2 || along > edge.length - SMOOTH * 2) continue;
        const at = traffic.pose(cursor, pose());
        const curve = roads.roads[edge.curve] as RoadCurve;
        const a = curve.points[edge.start] as Point;
        const b = curve.points[edge.end] as Point;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const dx = (b.x - a.x) / length;
        const dy = (b.y - a.y) / length;
        // The grid's roads are straight, so the lane is a fixed distance to the right.
        const right = -(at.x - a.x) * dy + (at.y - a.y) * dx;
        expect(right, `vehicle ${vehicle.id} on ${edge.tier}`).toBeCloseTo(laneOffset(edge, vehicle.lane), 6);
        expect(Math.cos(at.heading) * dx + Math.sin(at.heading) * dy).toBeGreaterThan(0.999);
        expect(at.speed).toBeLessThanOrEqual(edge.speedLimit * 1.001);
        expect(at.speed).toBeGreaterThan(edge.speedLimit * 0.8);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('puts traffic on every tier, as dense as the tier and the district call for', () => {
    const seed = SEEDS[0] as number;
    const roads = gridTrafficRoads();
    const traffic = new AmbientTraffic(seed, roads);
    let expected = 0;
    for (const edge of roads.graph.edges) expected += (edge.length / 1000) * edge.lanes * TIERS[edge.tier].density;
    expect(traffic.vehicles.length).toBeGreaterThan(expected * 0.85);
    expect(traffic.vehicles.length).toBeLessThan(expected * 1.15);

    const cursor: TrafficCursor = { id: 0, leg: 0, into: 0 };
    const tiers = new Set<string>();
    for (const vehicle of traffic.vehicles) tiers.add(roads.graph.edges[traffic.edgeOf(traffic.cursorAt(vehicle.id, 0, cursor))]?.tier ?? '');
    expect([...tiers].sort()).toEqual(['alley', 'arterial', 'dirt', 'highway', 'street']);

    // A quiet district carries a fraction of the traffic of a busy one: with
    // the western roads of the grid at a tenth, well under the whole is left.
    const quiet = new AmbientTraffic(seed, gridTrafficRoads((x) => (x < 0 ? 0.1 : 1)));
    expect(quiet.vehicles.length).toBeLessThan(traffic.vehicles.length * 0.8);
    expect(quiet.vehicles.length).toBeGreaterThan(traffic.vehicles.length * 0.4);
    expect(new AmbientTraffic(seed, gridTrafficRoads(() => 0)).vehicles.length).toBe(0);
  });

  it('finds every vehicle that is in a box among the ones it says are near it', () => {
    const traffic = gridTraffic(SEEDS[1] as number);
    const near: number[] = [];
    for (const tick of [0, 5000, 77_777]) {
      traffic.near(30, -60, 150, 60, near);
      for (const vehicle of traffic.vehicles) {
        const at = traffic.poseAt(vehicle.id, tick, pose());
        if (at.x < 30 || at.x > 150 || at.y < -60 || at.y > 60) continue;
        expect(near, `vehicle ${vehicle.id} at tick ${tick}`).toContain(vehicle.id);
      }
    }
    expect(near.length).toBeLessThan(traffic.vehicles.length);
  });

  it('says two footprints touch only when they overlap or nearly do', () => {
    const car = { x: 0, y: 0, heading: 0, halfLength: 2.2, halfWidth: 0.9 };
    expect(footprintsTouch(car, { ...car, x: 4.3 }, 0.1)).toBe(true);
    expect(footprintsTouch(car, { ...car, x: 4.7 }, 0.1)).toBe(false);
    // Side by side in two lanes 3.5 m apart is not a touch.
    expect(footprintsTouch(car, { ...car, y: 3.5 }, 0.1)).toBe(false);
    // Turned a quarter, the other car's length reaches across.
    expect(footprintsTouch(car, { ...car, y: 3, heading: Math.PI / 2 }, 0.1)).toBe(true);
    // Only the turned car's own axis tells these two apart.
    expect(footprintsTouch(car, { ...car, x: 4, y: 3, heading: Math.PI / 4 }, 0.1)).toBe(false);
  });
});
