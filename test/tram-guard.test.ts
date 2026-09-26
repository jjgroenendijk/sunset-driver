import { describe, expect, it } from 'vitest';
import { footprintsTouch, type AmbientPose, type TrafficCursor } from '../src/sim/traffic.ts';
import { CAR_HALF_WIDTH, CAR_LENGTH, TRAM_CARS } from '../src/sim/tram.ts';
import { specOf } from '../src/sim/vehicle.ts';
import type { RoadEdge } from '../src/world/graph.ts';
import { signalLap } from './signal-lap.ts';
import { ring } from './tram-ring.ts';

/** Metres from a lit junction's middle within which a moving vehicle may never touch a tram. */
const NEAR_LIGHT = 30;
/** Ticks between two readings of the trams. */
const EVERY = 10;
/** The ring's traffic; the seed sweep holds the guard on real cities through `signal-lap.ts`. */
const SEED = 1;

/**
 * The turns a tram crosses (spec sections 13.1, 13.2, issue #301): traffic on
 * the tram's own green that turns across the track waits while a tram is in
 * the junction. The ring's lit junctions are 300 m apart, so no tram ever
 * stands in one and every turn has a green that is clear of the trams.
 */
describe('the tram guard', () => {
  const r = ring(SEED);
  const guard = r.traffic.guard;
  const signals = r.traffic.signals;
  const graph = r.roads.graph;

  it("holds some turns at the ring's lights", () => {
    expect(guard).toBeDefined();
    expect(signals).toBeDefined();
    const guarded = signals?.approaches.filter((approach) => guard?.guards(approach.edge) === true) ?? [];
    expect(guarded.length).toBeGreaterThan(0);
  });

  it('sends no vehicle over its line while a tram crosses its turn', () => {
    if (guard === undefined || signals === undefined) throw new Error('no guard');
    const cursor: TrafficCursor = { id: 0, step: 0, into: 0 };
    let crossings = 0;
    for (const vehicle of r.traffic.vehicles) {
      const edges = vehicle.tour.edges;
      r.traffic.cursorAt(vehicle.id, 0, cursor);
      let edge = r.traffic.edgeOf(cursor);
      let along = r.traffic.metresOf(cursor);
      for (let tick = 1; tick <= vehicle.tour.period; tick++) {
        r.traffic.advance(cursor);
        const now = r.traffic.edgeOf(cursor);
        const metres = r.traffic.metresOf(cursor);
        const approach = signals.approachOf(now);
        if (approach !== undefined && now === edge && along <= approach.stop && metres > approach.stop && guard.guards(now)) {
          const leg = vehicle.tour.stepLeg[cursor.step] as number;
          const next = edges[(leg + 1) % edges.length] as number;
          crossings++;
          // A crossing a tick or two from a window's edge is the rounding of the drive to the line.
          const inside = guard.blocks(now, next, tick - 3) && guard.blocks(now, next, tick + 3);
          expect(inside, `vehicle ${vehicle.id} crosses edge ${now} at tick ${tick}`).toBe(false);
        }
        edge = now;
        along = metres;
      }
    }
    expect(crossings).toBeGreaterThan(0);
  });

  it('lets no moving vehicle touch a tram at a light', () => {
    const tour = r.line.tour;
    if (tour === undefined || signals === undefined) throw new Error('no tram');
    const tram: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    const touches: string[] = [];
    for (let tick = 0; tick < tour.period; tick += EVERY) {
      for (let k = 0; k < r.line.trams; k++) {
        for (let car = 0; car < TRAM_CARS; car++) {
          r.line.carPose(k, car, tick, tram);
          const lit = signals.junctions.some((j) => Math.hypot(j.x - tram.x, j.y - tram.y) < NEAR_LIGHT);
          if (lit) addTouches(tram, tick, `tram ${k} car ${car}`, touches);
        }
      }
    }
    expect(touches).toEqual([]);
  });

  const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  const cursor: TrafficCursor = { id: 0, step: 0, into: 0 };
  const near: number[] = [];

  /** Add to `touches` every moving vehicle whose footprint touches the tram car at `tram`. */
  function addTouches(tram: AmbientPose, tick: number, name: string, touches: string[]): void {
    const box = { x: tram.x, y: tram.y, heading: tram.heading, halfLength: CAR_LENGTH / 2, halfWidth: CAR_HALF_WIDTH };
    r.traffic.near(tram.x - 10, tram.y - 10, tram.x + 10, tram.y + 10, near);
    for (const id of near) {
      r.traffic.cursorAt(id, tick, cursor);
      r.traffic.pose(cursor, pose);
      if (pose.speed === 0) continue;
      const spec = specOf((r.traffic.vehicles[id] as (typeof r.traffic.vehicles)[number]).cls);
      const other = { x: pose.x, y: pose.y, heading: pose.heading, halfLength: spec.halfLength, halfWidth: spec.halfWidth };
      if (footprintsTouch(box, other, 0)) touches.push(`${name} and vehicle ${id} on edge ${(graph.edges[r.traffic.edgeOf(cursor)] as RoadEdge).id} at tick ${tick}`);
    }
  }

  it('keeps every vehicle to the lights and the trams', () => {
    for (const vehicle of r.traffic.vehicles) {
      if (vehicle.tour.sync < 0) continue;
      expect(signalLap(r.traffic, vehicle).faults).toEqual([]);
    }
  });
});
