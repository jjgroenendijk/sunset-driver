import { describe, expect, it } from 'vitest';
import { rngFor, Subsystem } from '../src/core/rng.ts';
import { BUS_DWELL, busCalls, NO_CALL, STOP_IN, STOP_ROOM, STOP_SPACING } from '../src/sim/bus.ts';
import type { SignalApproach, TrafficSignals } from '../src/sim/signals.ts';
import { QUEUE_CLEAR, timeTour } from '../src/sim/traffic-timing.ts';
import { walkTour } from '../src/sim/traffic-tour.ts';
import { AmbientTraffic, permitOf, type AmbientVehicle } from '../src/sim/traffic.ts';
import type { RoadEdge } from '../src/world/graph.ts';
import { sweepSeeds } from './helpers.ts';
import { signalLap } from './signal-lap.ts';
import { gridTraffic, gridTrafficRoads } from './traffic-grid.ts';

const SEEDS = sweepSeeds(4);

function signalsOf(traffic: AmbientTraffic): TrafficSignals {
  if (traffic.signals === undefined) throw new Error('no signals');
  return traffic.signals;
}

/** Every bus of a traffic, which is every vehicle that calls at stops. */
function busesOf(traffic: AmbientTraffic): AmbientVehicle[] {
  return traffic.vehicles.filter((vehicle) => vehicle.cls === 'bus');
}

/** The steps of a tour that are a call at a stop. */
function callSteps(vehicle: AmbientVehicle): number[] {
  const steps: number[] = [];
  for (let i = 0; i < vehicle.tour.stepCall.length; i++) if (vehicle.tour.stepCall[i] === 1) steps.push(i);
  return steps;
}

describe('a bus calling at its stops (spec section 20.2)', () => {
  it('stands a stop clear of the queue a signalled approach keeps room for', () => {
    // `bus.ts` places a stop this far into a leg and leans on the halt for a
    // light never coming back past it. That holds only while this is true.
    expect(STOP_IN).toBeLessThan(QUEUE_CLEAR);
    expect(STOP_ROOM).toBeGreaterThan(0);
    expect(BUS_DWELL).toBeGreaterThan(0);
  });

  it('calls at the first leg that can hold a stop, and then every spacing round the route', () => {
    const roads = gridTrafficRoads();
    const walk = rngFor(11, 0, Subsystem.Traffic, 5);
    const route = walkTour(roads.graph, 0, walk, permitOf('bus'));
    const calls = busCalls(roads.graph, route);
    const at: number[] = [];
    let along = 0;
    for (let i = 0; i < route.length; i++) {
      const edge = roads.graph.edges[route[i] as number] as RoadEdge;
      if (calls[i] !== NO_CALL) {
        expect(calls[i], `leg ${i}`).toBe(STOP_IN);
        expect(edge.length, `leg ${i}`).toBeGreaterThanOrEqual(STOP_IN + STOP_ROOM);
        at.push(along + STOP_IN);
      }
      along += edge.length;
    }
    expect(at.length, 'a route with no stop is not a line').toBeGreaterThan(0);
    for (let i = 1; i < at.length; i++) {
      expect((at[i] as number) - (at[i - 1] as number), `stops ${i - 1} and ${i}`).toBeGreaterThanOrEqual(STOP_SPACING);
    }
  });

  it('keeps a stop off a leg that is too short, and off one whose stop line is too near', () => {
    const roads = gridTrafficRoads();
    const traffic = new AmbientTraffic(SEEDS[0] as number, roads);
    const signals = signalsOf(traffic);
    for (const vehicle of busesOf(traffic)) {
      const calls = busCalls(roads.graph, Array.from(vehicle.tour.edges), signals);
      for (let i = 0; i < calls.length; i++) {
        if (calls[i] === NO_CALL) continue;
        const edge = roads.graph.edges[vehicle.tour.edges[i] as number] as RoadEdge;
        expect(edge.length).toBeGreaterThanOrEqual(STOP_IN + STOP_ROOM);
        const approach = signals.approachOf(edge.id);
        if (approach !== undefined) expect((approach as SignalApproach).stop).toBeGreaterThan(STOP_IN);
      }
    }
  });

  it('puts buses on the city streets and nothing else at a kerb', () => {
    let buses = 0;
    for (const seed of SEEDS) {
      const traffic = gridTraffic(seed);
      for (const vehicle of traffic.vehicles) {
        const calls = callSteps(vehicle);
        if (vehicle.cls !== 'bus') {
          expect(calls, `${vehicle.cls} ${vehicle.id} calls at a stop`).toEqual([]);
          continue;
        }
        expect(calls.length, `bus ${vehicle.id} drives its whole route without calling`).toBeGreaterThan(0);
        for (const step of calls) {
          // A call is a halt: the same metre of the same leg, for the dwell.
          expect(vehicle.tour.stepFrom[step]).toBe(vehicle.tour.stepTo[step]);
          expect(vehicle.tour.stepTicks[step], `bus ${vehicle.id}`).toBe(BUS_DWELL);
        }
        buses++;
      }
    }
    expect(buses, 'no bus in any of the seeds').toBeGreaterThan(0);
  });

  it('spends the dwell of every call on top of the route it would otherwise drive', () => {
    const roads = gridTrafficRoads();
    const walk = rngFor(13, 0, Subsystem.Traffic, 9);
    const route = walkTour(roads.graph, 0, walk, permitOf('bus'));
    const stops = busCalls(roads.graph, route).filter((call) => call !== NO_CALL).length;
    const straight = timeTour(roads.graph, route, undefined);
    const calling = timeTour(roads.graph, route, undefined, { calls: true });
    expect(stops).toBeGreaterThan(0);
    // Splitting a leg in two rounds each half up, so the drive costs a tick or
    // two more per call on top of the dwells themselves.
    expect(calling.period - straight.period).toBeGreaterThanOrEqual(stops * BUS_DWELL);
    expect(calling.period - straight.period).toBeLessThan(stops * (BUS_DWELL + 4));
    expect(calling.length).toBe(straight.length);
  });

  it('still keeps a calling bus to the lights all the way round its lap', () => {
    let called = 0;
    for (const seed of SEEDS) {
      const traffic = gridTraffic(seed);
      for (const vehicle of busesOf(traffic)) {
        if (vehicle.tour.sync < 0) continue;
        const lap = signalLap(traffic, vehicle);
        expect(lap.faults, `seed ${seed} bus ${vehicle.id}`).toEqual([]);
        called += lap.calling;
      }
    }
    // The buses that meet a light still stand at their kerbs as well.
    expect(called).toBeGreaterThan(0);
  });
});
