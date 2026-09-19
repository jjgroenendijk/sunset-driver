import { expect } from 'vitest';
import { SIGNAL_CYCLE } from '../src/sim/signals.ts';
import type { AmbientPose, AmbientTraffic, TrafficRoads } from '../src/sim/traffic.ts';
import { DWELL, TRAM_CARS, TRAM_CLEAR, TramLine } from '../src/sim/tram.ts';
import type { RoadEdge } from '../src/world/graph.ts';
import { TIERS } from '../src/world/tiers.ts';
import type { Point, WorldDescription } from '../src/world/types.ts';
import { TRAM_LIT_SHARE } from './seed-limits.ts';

/** Ticks of the day the trams' cars are read at. */
const SAMPLE_TICKS = [0, 7919, 43_200, 86_399];

/**
 * The seed sweep of spec section 3, on the tram of spec section 13.2: the loop
 * of a real city keeps to its lights, calls at every stop and stands on its
 * arterials. `seed-traffic.test.ts` calls it with the traffic it has already placed.
 */
export function checkTram(seed: number, world: WorldDescription, roads: TrafficRoads, traffic: AmbientTraffic): void {
  const line = new TramLine(seed, roads, world.tram, world.districts, traffic.signals);
  const tour = line.tour;
  if (tour === undefined) throw new Error(`seed ${seed}: no tram runs`);
  const signals = traffic.signals;
  if (signals === undefined) throw new Error(`seed ${seed}: no traffic lights`);
  expect(line.trams, `seed ${seed}`).toBeGreaterThan(0);
  expect(tour.period % SIGNAL_CYCLE, `seed ${seed}`).toBe(0);

  expect(line.calls.map((call) => call.stop), `seed ${seed}`).toEqual(world.tram.stops.map((stop) => stop.id));
  for (const call of line.calls) expect(call.depart - call.arrive, `seed ${seed}: stop ${call.stop}`).toBeGreaterThanOrEqual(DWELL);

  const lit = new Set(signals.junctions.map((junction) => junction.node));
  const litCrossings = world.tram.crossings.filter((crossing) => lit.has(crossing.node)).length;
  expect(litCrossings, `seed ${seed}: level crossings with a light`).toBeGreaterThanOrEqual(TRAM_LIT_SHARE * world.tram.crossings.length);

  // Every drive out of a halt at a light starts on the tram's green, with time left to clear.
  for (let step = 1; step < tour.stepTicks.length; step++) {
    const leg = tour.stepLeg[step] as number;
    const approach = signals.approachOf(tour.edges[leg] as number);
    if (approach === undefined || tour.stepLeg[step - 1] !== leg || tour.stepFrom[step] !== tour.stepTo[step - 1]) continue;
    if ((tour.stepTo[step] as number) <= (tour.stepFrom[step] as number)) continue;
    const tick = (tour.stepStart[step] as number) + tour.sync;
    expect(signals.light(approach, tick), `seed ${seed}: step ${step}`).toBe('green');
    expect(signals.light(approach, tick + TRAM_CLEAR - 1), `seed ${seed}: step ${step}`).toBe('green');
  }

  // Every car stands on the carriageway of a run the loop drives.
  const pose: AmbientPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  const edges = [...new Set(world.tram.edges)].map((id) => roads.graph.edges[id] as RoadEdge);
  for (const tick of SAMPLE_TICKS) {
    for (let tram = 0; tram < line.trams; tram++) {
      for (let car = 0; car < TRAM_CARS; car++) {
        line.carPose(tram, car, tick, pose);
        let off = Infinity;
        for (const edge of edges) off = Math.min(off, distanceTo(roads.graph.edgePoints(edge.id), pose.x, pose.y));
        expect(off, `seed ${seed}: tram ${tram} car ${car} at tick ${tick}`).toBeLessThan(TIERS.arterial.width / 2);
      }
    }
  }
}

export function distanceTo(points: readonly Point[], x: number, y: number): number {
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
