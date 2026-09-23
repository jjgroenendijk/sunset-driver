import { describe, expect, it } from 'vitest';
import { postBoxes, shelterBoxes } from '../src/render/bus-stops.ts';
import { ARRIVAL_TICKS, boardTicks, busDwell, STOP_CAP, STOP_IN } from '../src/sim/bus.ts';
import { ALIGHT_MOST, alighting, WALK_OFF as ALIGHT_WALK } from '../src/sim/bus-alight.ts';
import { BusStops, POST_AHEAD, SHELTER_RIDERS } from '../src/sim/bus-stops.ts';
import { pavementOffset } from '../src/sim/pedestrian-route.ts';
import type { WaitingPassenger } from '../src/sim/stop-queue.ts';
import { AmbientTraffic } from '../src/sim/traffic.ts';
import type { RoadEdge } from '../src/world/graph.ts';
import { TIERS } from '../src/world/tiers.ts';
import { sweepSeeds } from './helpers.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

const SEEDS = sweepSeeds(4);

/** The stops of one seed of the traffic grid, and the traffic they were gathered from. */
function stopsOf(seed: number): { traffic: AmbientTraffic; stops: BusStops } {
  const roads = gridTrafficRoads();
  const traffic = new AmbientTraffic(seed, roads);
  return { traffic, stops: new BusStops(seed, traffic) };
}

/** Every stop of a gathering, as a list. */
function listOf(stops: BusStops): { index: number; edge: number; riders: number }[] {
  const all: { index: number; edge: number; riders: number }[] = [];
  for (let i = 0; i < stops.count; i++) {
    const stop = stops.stopAt(i);
    all.push({ index: i, edge: stop.edge, riders: stop.riders });
  }
  return all;
}

describe('the bus stops of a world (spec section 20.2)', () => {
  it('stands one stop on every kerb a bus calls at, and none anywhere else', () => {
    let found = 0;
    for (const seed of SEEDS) {
      const { traffic, stops } = stopsOf(seed);
      const called = new Set<number>();
      for (const vehicle of traffic.vehicles) {
        const tour = vehicle.tour;
        for (let step = 0; step < tour.stepCall.length; step++) {
          if (tour.stepCall[step] === 1) called.add(tour.edges[tour.stepLeg[step] as number] as number);
        }
      }
      const edges = listOf(stops).map((stop) => stop.edge);
      expect(new Set(edges).size, `seed ${seed} stands two stops on one kerb`).toBe(edges.length);
      expect([...edges].sort((a, b) => a - b)).toEqual([...called].sort((a, b) => a - b));
      found += edges.length;
    }
    expect(found, 'no seed of the grid has a bus stop').toBeGreaterThan(0);
  });

  it('stands the post on the pavement beside the kerb the bus pulls in at', () => {
    for (const seed of SEEDS) {
      const { traffic, stops } = stopsOf(seed);
      const graph = traffic.roads.graph;
      for (let i = 0; i < stops.count; i++) {
        const stop = stops.stopAt(i);
        const edge = graph.edges[stop.edge] as RoadEdge;
        const spec = TIERS[edge.tier];
        // The pavement is the only ground a stop may stand on, and the post
        // stands on the middle of it: half its width either side is road or parcel.
        expect(spec.pavement, `stop on a ${edge.tier}`).toBeGreaterThan(0);
        expect(pavementOffset(edge)).toBeGreaterThan(spec.width / 2);
        // The post is off the nose of a bus at the kerb, still on the leg.
        expect(stop.call).toBe(STOP_IN);
        expect(stop.call + POST_AHEAD).toBeLessThan(edge.length);
        expect(Number.isFinite(stop.x) && Number.isFinite(stop.y) && Number.isFinite(stop.height)).toBe(true);
      }
    }
  });

  it('fills a stop between buses and empties it as one boards', () => {
    const { traffic, stops } = stopsOf(SEEDS[1] as number);
    expect(stops.count).toBeGreaterThan(0);
    let emptied = 0;
    let filled = 0;
    for (let i = 0; i < stops.count; i++) {
      const riders = stops.stopAt(i).riders;
      expect(riders).toBeGreaterThanOrEqual(1);
      expect(riders).toBeLessThanOrEqual(STOP_CAP);
      let most = 0;
      let least = STOP_CAP;
      for (let tick = 0; tick < 12_000; tick += 7) {
        const people = stops.waiting(i, tick);
        expect(people, `stop ${i} at tick ${tick}`).toBeGreaterThanOrEqual(0);
        expect(people, `stop ${i} at tick ${tick}`).toBeLessThanOrEqual(riders);
        most = Math.max(most, people);
        least = Math.min(least, people);
      }
      if (least === 0) emptied++;
      if (most > 0) filled++;
    }
    // Every stop is cleared by the bus that calls there, and every stop that
    // is waited at fills again afterwards.
    expect(emptied).toBe(stops.count);
    expect(filled).toBeGreaterThan(0);
    // A stop takes longer to fill than a bus takes to empty it, or nobody
    // would ever be seen standing at one.
    expect(ARRIVAL_TICKS).toBeGreaterThan(boardTicks(STOP_CAP));
    expect(traffic.vehicles.length).toBeGreaterThan(0);
  });

  it('is a pure function of the seed and the tick, and stands its people still', () => {
    const seed = SEEDS[2] as number;
    const first = stopsOf(seed).stops;
    const again = stopsOf(seed).stops;
    expect(again.count).toBe(first.count);
    for (let i = 0; i < first.count; i++) {
      expect(again.stopAt(i)).toEqual(first.stopAt(i));
      for (const tick of [0, 811, 5_003, 40_000]) expect(again.waiting(i, tick)).toBe(first.waiting(i, tick));
    }
    const at = first.stopAt(0);
    const out: WaitingPassenger[] = [];
    // A tick the stop is not empty on, so there is somebody to read.
    let people = 0;
    for (let tick = 0; tick < 12_000 && people === 0; tick += 13) {
      people = first.passengers(at.x - 60, at.y - 60, at.x + 60, at.y + 60, tick, out);
    }
    expect(people, 'nobody ever waits near a stop').toBeGreaterThan(0);
    for (let i = 0; i < people; i++) {
      const passenger = out[i] as WaitingPassenger;
      // Somebody off a bus walks away; the next test follows them.
      if (passenger.pose.gait === 'stroll') continue;
      expect(passenger.pose.gait).toBe('stand');
      expect(passenger.pose.speed).toBe(0);
      expect(Math.hypot(passenger.pose.x - at.x, passenger.pose.y - at.y)).toBeLessThan(40);
    }
  });

  it('lets a few people off each bus, who walk away from the queue and turn in', () => {
    const seed = SEEDS[1] as number;
    const { stops } = stopsOf(seed);
    const out: WaitingPassenger[] = [];
    let seen = 0;
    for (let i = 0; i < stops.count; i++) {
      const at = stops.stopAt(i);
      const box = [at.x - 60, at.y - 60, at.x + 60, at.y + 60] as const;
      for (let tick = 0; tick < 6_000; tick += 3) {
        const people = stops.passengers(...box, tick, out);
        for (let k = 0; k < people; k++) {
          const pose = (out[k] as WaitingPassenger).pose;
          if (pose.gait !== 'stroll') continue;
          seen++;
          // Never further off the stop than the walk away takes them.
          expect(Math.hypot(pose.x - at.x, pose.y - at.y)).toBeLessThan(POST_AHEAD + ALIGHT_WALK + 6);
          expect(pose.speed).toBeGreaterThan(0);
        }
      }
    }
    expect(seen, 'nobody ever gets off a bus').toBeGreaterThan(0);
    // Who gets off is the seed's and the lap's.
    expect(alighting(3, 0, 5, seed)).toBe(alighting(3, 0, 5, seed));
    expect(alighting(3, 0, 5, seed)).toBeLessThanOrEqual(ALIGHT_MOST);
  });

  it('gives the busiest stops a shelter, and draws every part of one on the pavement', () => {
    expect(SHELTER_RIDERS).toBeGreaterThan(1);
    expect(SHELTER_RIDERS).toBeLessThanOrEqual(STOP_CAP);
    // A stop is drawn in its own frame, `+x` at the road. Nothing may reach
    // past half the narrowest pavement a bus route runs along, or a shelter
    // would stand in the road or in the parcel behind it.
    const half = TIERS.arterial.pavement / 2;
    for (const part of [...postBoxes(), ...shelterBoxes()]) {
      expect(Math.abs(part.x) + part.length / 2, 'a part reaches off the pavement').toBeLessThanOrEqual(half);
      expect(part.y - part.height / 2, 'a part reaches under the pavement').toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('stands a bus at a kerb for as long as that stop takes to board', () => {
    for (let riders = 1; riders <= STOP_CAP; riders++) {
      expect(busDwell(riders)).toBeGreaterThan(boardTicks(riders));
      if (riders > 1) expect(busDwell(riders)).toBeGreaterThan(busDwell(riders - 1));
    }
  });
});
