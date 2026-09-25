import { describe, expect, it } from 'vitest';
import { rngFor, Subsystem } from '../src/core/rng.ts';
import { boardTicks, busCalls, busDwell, DOOR_TICKS, NO_CALL, ridersAt, STOP_CAP, STOP_IN, STOP_ROOM, STOP_SPACING } from '../src/sim/bus.ts';
import type { SignalApproach, TrafficSignals } from '../src/sim/signals.ts';
import { CRUISE, QUEUE_CLEAR, timeTour } from '../src/sim/traffic-timing.ts';
import { ACCEL } from '../src/sim/traffic-motion.ts';
import { TICK_RATE } from '../src/sim/clock.ts';
import { walkTour } from '../src/sim/traffic-tour.ts';
import { AmbientTraffic, permitOf, type AmbientVehicle } from '../src/sim/traffic.ts';
import type { RoadEdge } from '../src/world/graph.ts';
import { TIERS } from '../src/world/tiers.ts';
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

/** True where a route has a leg a stop could stand beside: one with a pavement. */
function hasKerb(traffic: AmbientTraffic, vehicle: AmbientVehicle): boolean {
  for (const id of vehicle.tour.edges) {
    if (TIERS[(traffic.roads.graph.edges[id] as RoadEdge).tier].pavement > 0) return true;
  }
  return false;
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
    expect(busDwell(1)).toBeGreaterThan(0);
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
      if (calls.at[i] !== NO_CALL) {
        expect(calls.at[i], `leg ${i}`).toBe(STOP_IN);
        expect(TIERS[edge.tier].pavement, `leg ${i}`).toBeGreaterThan(0);
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
      for (let i = 0; i < calls.at.length; i++) {
        if (calls.at[i] === NO_CALL) continue;
        const edge = roads.graph.edges[vehicle.tour.edges[i] as number] as RoadEdge;
        expect(edge.length).toBeGreaterThanOrEqual(STOP_IN + STOP_ROOM);
        const approach = signals.approachOf(edge.id);
        if (approach !== undefined) expect((approach as SignalApproach).stop).toBeGreaterThan(STOP_IN);
      }
    }
  });

  it('stands at a kerb for as long as the people that stop gathers take to board', () => {
    // The dwell is the stop's, not the line's: the doors, and one person's
    // boarding for each of the riders `bus.ts` drew for the road.
    expect(busDwell(1)).toBe(DOOR_TICKS + boardTicks(1));
    expect(busDwell(STOP_CAP)).toBeGreaterThan(busDwell(1));
    const roads = gridTrafficRoads();
    const edge = roads.graph.edges[0] as RoadEdge;
    for (const seed of SEEDS) {
      const riders = ridersAt(seed, edge, 1);
      expect(riders).toBeGreaterThanOrEqual(1);
      expect(riders).toBeLessThanOrEqual(STOP_CAP);
      // A road nobody uses still gathers somebody, and never more than a busy one.
      expect(ridersAt(seed, edge, 0)).toBe(1);
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
        // A bus whose whole route is highway has nowhere to put a stop, since
        // a highway carries no pavement. Every other one calls.
        if (!hasKerb(traffic, vehicle)) {
          expect(calls, `bus ${vehicle.id} calls where there is no pavement`).toEqual([]);
          continue;
        }
        expect(calls.length, `bus ${vehicle.id} drives its whole route without calling`).toBeGreaterThan(0);
        for (const step of calls) {
          // A call is a halt: the same metre of the same leg, for the dwell
          // the people that stop gathers take to board.
          expect(vehicle.tour.stepFrom[step]).toBe(vehicle.tour.stepTo[step]);
          const edge = traffic.roads.graph.edges[vehicle.tour.edges[vehicle.tour.stepLeg[step] as number] as number] as RoadEdge;
          const riders = traffic.demand.riders(edge);
          expect(riders).toBeGreaterThanOrEqual(1);
          expect(riders).toBeLessThanOrEqual(STOP_CAP);
          expect(vehicle.tour.stepTicks[step], `bus ${vehicle.id}`).toBe(busDwell(riders));
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
    const calls = busCalls(roads.graph, route);
    let stops = 0;
    let dwelt = 0;
    for (let i = 0; i < calls.at.length; i++) {
      if (calls.at[i] === NO_CALL) continue;
      stops++;
      dwelt += calls.dwell[i] as number;
    }
    const straight = timeTour(roads.graph, route, undefined);
    const calling = timeTour(roads.graph, route, undefined, { calls: true });
    expect(stops).toBeGreaterThan(0);
    // Splitting a leg in two rounds each half up, so the drive costs a tick or
    // two more per call on top of the dwells themselves. Braking into the kerb
    // and pulling away from it each lose half the time the change of speed
    // takes (`traffic-motion.ts`).
    const top = Math.max(...route.map((id) => (roads.graph.edges[id] as RoadEdge).speedLimit)) * CRUISE;
    const ramps = 2 * Math.ceil((top / (2 * ACCEL)) * TICK_RATE);
    expect(calling.period - straight.period).toBeGreaterThanOrEqual(dwelt);
    expect(calling.period - straight.period).toBeLessThan(dwelt + stops * (4 + ramps));
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
