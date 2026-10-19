import { describe, expect, it } from 'vitest';
import { SIGNAL_CYCLE, type SignalApproach, type TrafficSignals } from '../../../src/sim/traffic/signals.ts';
import { AmbientTraffic, type AmbientVehicle, type TrafficRoads } from '../../../src/sim/traffic/traffic.ts';
import { buildRoadGraph, type RoadEdge } from '../../../src/world/roads/graph.ts';
import { buildJunctions } from '../../../src/world/junctions/junctions.ts';
import type { Point, RoadCurve, RoadTier } from '../../../src/world/types.ts';
import { sweepSeeds, withNodes } from '../../support/helpers.ts';
import { signalLap } from '../../support/signal-lap.ts';

const SEEDS = sweepSeeds(process.env.SWEEP_SEEDS ? 6 : 2);

/** Metres between the two streets that cross the arterial one short block apart. */
const BLOCK = 40;

/**
 * Metres between the streets east of that block: too far apart for their
 * lights to change in step, and too close for the whole queue of a red.
 */
const NEXT = 90;

/**
 * An arterial crossed by streets: two a short block apart, and a run of them
 * further east. Two more streets close the loops. A point every 5 m, so every
 * crossing is a point both roads share.
 */
function blockRoads(): TrafficRoads {
  const line = (tier: RoadTier, from: Point, to: Point): RoadCurve => {
    const points: Point[] = [];
    const steps = Math.round(Math.hypot(to.x - from.x, to.y - from.y) / 5);
    for (let k = 0; k <= steps; k++) points.push({ x: from.x + ((to.x - from.x) * k) / steps, y: from.y + ((to.y - from.y) * k) / steps });
    return { id: 0, tier, points, bridges: [], tunnels: [], interchanges: [], nodes: [] };
  };
  const streets = [0];
  for (let x = BLOCK; x <= BLOCK + 8 * NEXT; x += NEXT) streets.push(x);
  const roads = [
    line('arterial', { x: -300, y: 0 }, { x: 900, y: 0 }),
    line('street', { x: -300, y: -200 }, { x: 900, y: -200 }),
    line('street', { x: -300, y: 200 }, { x: 900, y: 200 }),
    ...streets.map((x) => line('street', { x, y: -200 }, { x, y: 200 })),
  ].map((road, id) => ({ ...road, id }));
  withNodes(roads);
  const graph = buildRoadGraph(roads);
  return { roads, graph, heightAt: () => 0, junctions: buildJunctions(roads, graph) };
}

function signalsOf(traffic: AmbientTraffic): TrafficSignals {
  if (traffic.signals === undefined) throw new Error('no signals');
  return traffic.signals;
}

/** True where a vehicle stands at a light of its own through that light's green, held by the light after it. */
function waitsBefore(traffic: AmbientTraffic, vehicle: AmbientVehicle): boolean {
  const signals = signalsOf(traffic);
  const tour = vehicle.tour;
  for (let step = 0; step < tour.stepTicks.length; step++) {
    if (tour.stepFrom[step] !== tour.stepTo[step] || tour.stepCall[step] === 1) continue;
    const leg = tour.stepLeg[step] as number;
    const own = signals.approachOf(tour.edges[leg] as number);
    const ahead = signals.approachOf(tour.edges[(leg + 1) % tour.edges.length] as number);
    if (own === undefined || ahead === undefined) continue;
    // Ticks of the lap run from the tour's sync, where tick 0 is its anchor's green.
    const start = (tour.stepStart[step] as number) + tour.sync;
    const late = vehicle.driver.react + 1;
    for (let k = 0; k < (tour.stepTicks[step] as number); k++) {
      const into = (((start + k - signals.greenStart(own)) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
      if (signals.light(own, start + k) === 'green' && into > late) return true;
    }
  }
  return false;
}

describe('a short block between two junctions with lights (issue #488)', () => {
  it('changes the lights at both of its ends in step along the road between them', () => {
    const roads = blockRoads();
    const signals = signalsOf(new AmbientTraffic(SEEDS[0] as number, roads));
    const junctionAt = (x: number): number => signals.junctions.findIndex((j) => j.x === x && j.y === 0);
    expect([junctionAt(0), junctionAt(BLOCK), junctionAt(BLOCK + NEXT)].every((j) => j >= 0)).toBe(true);
    // The arterial runs east from the junction at 0 into the one at BLOCK, and west back.
    const into = (x: number, east: boolean): SignalApproach => {
      const found = signals.approaches.find((a) => {
        const edge = roads.graph.edges[a.edge] as RoadEdge;
        const to = roads.graph.nodes[edge.to];
        const from = roads.graph.nodes[edge.from];
        return to?.x === x && to.y === 0 && from?.y === 0 && (east ? from.x < x : from.x > x);
      });
      if (found === undefined) throw new Error(`no approach into ${x}`);
      return found;
    };
    for (const seed of SEEDS) {
      const lights = signalsOf(new AmbientTraffic(seed, roads));
      expect(lights.greenStart(into(BLOCK, true)), `seed ${seed}`).toBe(lights.greenStart(into(0, true)));
      expect(lights.greenStart(into(0, false)), `seed ${seed}`).toBe(lights.greenStart(into(BLOCK, false)));
    }
  });

  it('holds what does not fit the block at the light before it, and keeps every lap to the lights', () => {
    let held = 0;
    for (const seed of SEEDS) {
      const traffic = new AmbientTraffic(seed, blockRoads());
      for (const vehicle of traffic.vehicles) {
        if (vehicle.tour.sync < 0 || !waitsBefore(traffic, vehicle)) continue;
        held++;
        expect(signalLap(traffic, vehicle).faults, `seed ${seed}`).toEqual([]);
      }
    }
    expect(held).toBeGreaterThan(0);
  });
});
