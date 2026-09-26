import { describe, expect, it } from 'vitest';
import { driverNamed } from '../../../src/sim/traffic/driver.ts';
import { blinkLit, BLINK, Indicators, sideOn, THROUGH, turnSides } from '../../../src/sim/traffic/indicator.ts';
import type { AmbientPose } from '../../../src/sim/traffic/traffic.ts';
import type { RoadEdge } from '../../../src/world/roads/graph.ts';
import { gridTraffic, gridTrafficRoads } from '../../support/traffic-grid.ts';

/** Vehicles followed, and the ticks each is followed for. */
const FOLLOWED = 30;
const TICKS = 3000;

describe('the indicators of the ambient traffic (spec section 20.2)', () => {
  it('reads a turn towards +y from a road heading +x as a turn to the right', () => {
    const graph = gridTrafficRoads().graph;
    // Find a node where a run heading east arrives and a run heading south, +y, leaves.
    let checked = 0;
    for (const edge of graph.edges) {
      const a = graph.nodes[edge.from];
      const b = graph.nodes[edge.to];
      if (a === undefined || b === undefined || b.x - a.x <= 0 || Math.abs(b.y - a.y) > 1e-6) continue;
      if (graph.degree(edge.to) < 3) continue;
      for (const out of graph.edgesFrom(edge.to)) {
        const next = graph.edges[out] as RoadEdge;
        const c = graph.nodes[next.to];
        if (c === undefined || Math.abs(c.x - b.x) > 1e-6) continue;
        const sides = turnSides(graph, Int32Array.of(edge.id, out));
        expect(sides[0], `edge ${edge.id} onto ${out}`).toBe(c.y > b.y ? 1 : -1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it('puts the indicator on as far back as the driver says, and keeps it through the turn', () => {
    const traffic = gridTraffic(3);
    const tour = (traffic.vehicles[0] as (typeof traffic.vehicles)[number]).tour;
    const sides = new Int8Array(tour.edges.length);
    sides[0] = -1;
    const leg = (tour.startDistance[1] as number) - (tour.startDistance[0] as number);
    const steady = driverNamed('steady');
    expect(sideOn(tour, sides, steady, 0, leg - steady.indicates - 1)).toBe(0);
    expect(sideOn(tour, sides, steady, 0, leg - steady.indicates + 1)).toBe(-1);
    expect(sideOn(tour, sides, steady, 1, THROUGH / 2)).toBe(-1);
    expect(sideOn(tour, sides, steady, 1, THROUGH * 2)).toBe(0);
    // A driver whose row says 0 turns with no warning.
    expect(driverNamed('tailgater').indicates).toBe(0);
    expect(sideOn(tour, sides, driverNamed('tailgater'), 0, leg - 1)).toBe(0);
  });

  it('flashes each lamp on and off, at the phase of its own vehicle', () => {
    expect(blinkLit(0, 0)).toBe(true);
    expect(blinkLit(0, BLINK)).toBe(false);
    expect(blinkLit(0, 2 * BLINK)).toBe(true);
    let differ = 0;
    for (let id = 0; id < 20; id++) if (blinkLit(id, 0) !== blinkLit(0, 0)) differ++;
    expect(differ).toBeGreaterThan(4);
  });

  it('shows the side a vehicle then turns to, and never on a driver who does not indicate', () => {
    const traffic = gridTraffic(5);
    const indicators = new Indicators(traffic);
    const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
    let turns = 0;
    let silent = 0;
    for (let id = 0; id < Math.min(FOLLOWED, traffic.vehicles.length); id++) {
      const driver = (traffic.vehicles[id] as (typeof traffic.vehicles)[number]).driver;
      let side = 0;
      let start = 0;
      let turned = 0;
      let last = traffic.poseAt(id, 0, pose).heading;
      for (let tick = 0; tick < TICKS; tick++) {
        const now = indicators.sideAt(id, tick);
        const heading = traffic.poseAt(id, tick, pose).heading;
        turned += Math.atan2(Math.sin(heading - last), Math.cos(heading - last));
        last = heading;
        if (driver.indicates === 0) {
          expect(now, `vehicle ${id} tick ${tick}`).toBe(0);
          silent++;
          continue;
        }
        // A span already on at tick 0 began before the vehicle was watched, so it is not judged.
        if (now !== side && side !== 0 && start > 0) {
          // Over the ticks the indicator was on, the vehicle turned the way it said.
          expect(Math.sign(turned), `vehicle ${id} ticks ${start}-${tick}`).toBe(side);
          expect(Math.abs(turned), `vehicle ${id} ticks ${start}-${tick}`).toBeGreaterThan(0.2);
          turns++;
        }
        if (now !== side) {
          side = now;
          start = tick;
          turned = 0;
        }
      }
    }
    expect(turns).toBeGreaterThan(10);
    expect(silent, 'no driver who never indicates was followed').toBeGreaterThan(0);
  });
});
