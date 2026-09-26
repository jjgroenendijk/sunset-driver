import { describe, expect, it } from 'vitest';
import { rngFor, Subsystem } from '../../../src/core/rng.ts';
import { HAZARDS, Indicators } from '../../../src/sim/traffic/indicator.ts';
import {
  BINS,
  CRAWL,
  drawJob,
  fareOf,
  hiredAt,
  JOB_PAINT,
  PICK_UP,
  SET_DOWN,
  UNLOAD,
  type Job,
} from '../../../src/sim/traffic/jobs.ts';
import type { AmbientTraffic, AmbientVehicle, TrafficCursor } from '../../../src/sim/traffic/traffic.ts';
import type { RoadEdge } from '../../../src/world/roads/graph.ts';
import { gridTraffic } from '../../support/traffic-grid.ts';

/** Seeds of the grid the jobs are looked for on. */
const SEEDS = [1, 2, 3, 4, 5, 6];

/** Every vehicle of the grids of {@link SEEDS} that has a job, with its traffic. */
function atWork(): { traffic: AmbientTraffic; vehicle: AmbientVehicle }[] {
  const found: { traffic: AmbientTraffic; vehicle: AmbientVehicle }[] = [];
  for (const seed of SEEDS) {
    const traffic = gridTraffic(seed);
    for (const vehicle of traffic.vehicles) if (vehicle.job !== 'none') found.push({ traffic, vehicle });
  }
  return found;
}

const WORK = atWork();

function ofJob(job: Job): { traffic: AmbientTraffic; vehicle: AmbientVehicle }[] {
  return WORK.filter((entry) => entry.vehicle.job === job);
}

/** The ticks of each call a tour stands at the kerb, in tour order. */
function dwells(vehicle: AmbientVehicle): number[] {
  const tour = vehicle.tour;
  const out: number[] = [];
  for (let step = 0; step < tour.stepCall.length; step++) if (tour.stepCall[step] === 1) out.push(tour.stepTicks[step] as number);
  return out;
}

describe('the vehicles of the traffic at work (spec section 20.2)', () => {
  it('draws a job with one draw, and a garbage truck only where a street is', () => {
    let garbage = 0;
    for (let i = 0; i < 2000; i++) {
      const rng = rngFor(1, 0, Subsystem.Traffic, i);
      const twin = rngFor(1, 0, Subsystem.Traffic, i);
      const work = drawJob('van', i % 2 === 0 ? 'street' : 'arterial', rng);
      twin.float();
      expect(rng.float(), 'drawJob took more than one draw').toBe(twin.float());
      if (work.job === 'garbage') {
        garbage++;
        expect(work.cls).toBe('truck');
        expect(i % 2, 'a garbage truck drawn on an arterial').toBe(0);
      }
      if (work.job === 'sweeper') expect(i % 2).toBe(0);
      expect(drawJob('compact', 'street', rngFor(1, 0, Subsystem.Traffic, i)).job).toBe('none');
    }
    expect(garbage).toBeGreaterThan(50);
  });

  it('puts every job on the grid in its own livery', () => {
    for (const job of ['taxi', 'delivery', 'garbage', 'sweeper'] as const) {
      const vehicles = ofJob(job);
      expect(vehicles.length, `no ${job} on the grids`).toBeGreaterThan(0);
      for (const { vehicle } of vehicles) expect(vehicle.paint).toBe(JOB_PAINT[job]);
    }
  });

  it('picks a taxi fare up at one kerb and sets it down at another', () => {
    let fares = 0;
    for (const { traffic, vehicle } of ofJob('taxi')) {
      const calls = dwells(vehicle);
      if (calls.length === 0) continue;
      fares++;
      expect(calls).toEqual([PICK_UP, SET_DOWN]);
      const fare = fareOf(vehicle.tour);
      expect(fare).toBeDefined();
      // Round one lap: free while it waits at the pick up, hired from there to the set down, free after.
      const cursor = traffic.cursorAt(vehicle.id, 0);
      let hired = 0;
      let turns = 0;
      let was = false;
      for (let tick = 0; tick < vehicle.tour.period; tick++) {
        const along = alongOf(traffic, cursor);
        const now = hiredAt(fare, along, traffic.isWait(cursor));
        if (now) hired++;
        if (now !== was) turns++;
        was = now;
        traffic.advance(cursor);
      }
      expect(hired, `taxi ${vehicle.id} never carried its fare`).toBeGreaterThan(0);
      expect(hired, `taxi ${vehicle.id} was never free`).toBeLessThan(vehicle.tour.period);
      expect(turns, `taxi ${vehicle.id} took more than one fare a lap`).toBeLessThanOrEqual(3);
    }
    expect(fares).toBeGreaterThan(0);
  });

  it('stands a delivery van at one kerb with its hazards on, and nowhere else', () => {
    let unloaded = 0;
    for (const { traffic, vehicle } of ofJob('delivery')) {
      const calls = dwells(vehicle);
      if (calls.length === 0) continue;
      unloaded++;
      expect(calls).toEqual([UNLOAD]);
      const indicators = new Indicators(traffic);
      const cursor = traffic.cursorAt(vehicle.id, 0);
      for (let tick = 0; tick < vehicle.tour.period; tick += 7) {
        traffic.cursorAt(vehicle.id, tick, cursor);
        const calling = vehicle.tour.stepCall[cursor.step] === 1;
        expect(indicators.sideAt(vehicle.id, tick) === HAZARDS, `tick ${tick}`).toBe(calling);
      }
    }
    expect(unloaded).toBeGreaterThan(0);
  });

  it('crawls a garbage truck and a sweeper along the streets, and stops the truck at the bins', () => {
    for (const job of ['garbage', 'sweeper'] as const) {
      for (const { traffic, vehicle } of ofJob(job)) {
        expect(vehicle.driver.cruise).toBe(CRAWL[job]);
        for (const id of vehicle.tour.edges) expect(['street', 'alley']).toContain((traffic.roads.graph.edges[id] as RoadEdge).tier);
        const calls = dwells(vehicle);
        if (job === 'sweeper') expect(calls).toEqual([]);
        else for (const ticks of calls) expect(ticks).toBe(BINS);
      }
    }
    expect(ofJob('garbage').some(({ vehicle }) => dwells(vehicle).length > 1), 'no garbage truck stops at more than one kerb').toBe(true);
  });
});

function alongOf(traffic: AmbientTraffic, cursor: TrafficCursor): number {
  const tour = (traffic.vehicles[cursor.id] as AmbientVehicle).tour;
  return (tour.startDistance[tour.stepLeg[cursor.step] as number] as number) + traffic.metresOf(cursor);
}
