/**
 * The vehicles of the traffic that are at work (spec section 20.2, "vehicles
 * with jobs"): taxis, delivery vans, garbage trucks and street sweepers.
 *
 * A job is not a second kind of vehicle. It is drawn once for a vehicle of the
 * traffic, from a stream of its own so no other draw moves, and it changes
 * three things about the tour that vehicle is timed on: where it stands at the
 * kerb, which the timing lays down the way it lays down a bus at its stops
 * (`traffic-timing.ts`); how fast it drives, which is a crawl for the two that
 * work a street; and which roads it may take. The paint is the job's livery.
 *
 * - A taxi picks a fare up at one kerb and sets it down at another, further
 *   round the route. Its roof sign is lit while it is free and dark while it
 *   carries the fare ({@link hiredAt}).
 * - A delivery van stands at one kerb of its route for a long unloading, with
 *   its hazards going (`indicator.ts`).
 * - A garbage truck crawls along the streets of its route and stops at every
 *   kerb it passes to empty the bins. A street sweeper crawls along them and
 *   never stops. Both keep to the streets and the alleys, which bar every other
 *   truck, and both carry an amber beacon.
 *
 * Where each one stands is a pure function of its route, as a bus stop is, so
 * the same taxi picks up at the same kerb every lap.
 */
import type { Rng } from '../../core/rng.ts';
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import type { RoadTier } from '../../world/types.ts';
import { TICK_RATE } from '../clock.ts';
import { holdsStop, NO_CALL, STOP_IN, type BusRoute } from '../transit/bus.ts';
import type { VehicleClass } from '../vehicles/vehicle.ts';
import type { Driver } from './driver.ts';
import type { TrafficSignals } from './signals.ts';
import type { CallPlan, Tour } from './traffic-timing.ts';
import type { Permit } from './traffic-tour.ts';

/** What a vehicle of the traffic does besides driving. */
export type Job = 'none' | 'taxi' | 'delivery' | 'garbage' | 'sweeper';

/** Share of the saloons that are taxis. */
const TAXI_SHARE = 0.2;

/** Share of the vans that are out on a delivery. */
const DELIVERY_SHARE = 0.3;

/** Share of the vans on a street or an alley that are a garbage truck, and the same again a sweeper. */
const STREET_WORK_SHARE = 0.1;

/** The livery of each job, which replaces the paint drawn for the vehicle. */
export const JOB_PAINT: Readonly<Record<Exclude<Job, 'none'>, number>> = {
  taxi: 0xf2c230,
  delivery: 0x7a5230,
  garbage: 0x3d6e3f,
  sweeper: 0xd9702a,
};

/** The share of the speed limit a vehicle working a street crawls at. */
export const CRAWL: Readonly<Record<'garbage' | 'sweeper', number>> = { garbage: 0.45, sweeper: 0.3 };

/** Ticks a taxi stands at the kerb while the fare gets in, and while they pay and get out. */
export const PICK_UP = 5 * TICK_RATE;
export const SET_DOWN = 4 * TICK_RATE;

/** Ticks a delivery van stands at the kerb unloading. */
export const UNLOAD = 40 * TICK_RATE;

/** Ticks a garbage truck stands at each kerb while the bins are emptied. */
export const BINS = 6 * TICK_RATE;

/** The share of the route a fare rides at least, so a taxi does not set down round the corner. */
const FARE_SHARE = 1 / 3;

/** The tiers a vehicle working a street keeps to. */
const STREET_TIERS: readonly RoadTier[] = ['street', 'alley'];

/** What a vehicle placed in the traffic turns out to be. */
export interface Work {
  job: Job;
  /** The class it is drawn and driven as: a garbage truck is a truck whatever was drawn. */
  cls: VehicleClass;
}

/**
 * The job of a vehicle drawn as `cls` on a road of `tier`. One draw from
 * `rng`, whatever comes out, so a caller's stream stays in step.
 */
export function drawJob(cls: VehicleClass, tier: RoadTier, rng: Rng): Work {
  const roll = rng.float();
  if (cls === 'saloon' && roll < TAXI_SHARE) return { job: 'taxi', cls };
  if (cls !== 'van') return { job: 'none', cls };
  let at = 0;
  if (STREET_TIERS.includes(tier)) {
    at += STREET_WORK_SHARE;
    if (roll < at) return { job: 'garbage', cls: 'truck' };
    at += STREET_WORK_SHARE;
    if (roll < at) return { job: 'sweeper', cls };
  }
  if (roll < at + DELIVERY_SHARE) return { job: 'delivery', cls };
  return { job: 'none', cls };
}

/** The roads a vehicle at work may take, or undefined where its class says. */
export function jobPermit(job: Job): Permit | undefined {
  if (job === 'garbage' || job === 'sweeper') return (edge) => STREET_TIERS.includes(edge.tier);
  return undefined;
}

/** Who drives a vehicle at work: the driver drawn for it, at a crawl where the job works a street. */
export function jobDriver(job: Job, driver: Driver): Driver {
  if (job === 'garbage' || job === 'sweeper') return { ...driver, cruise: CRAWL[job] };
  return driver;
}

/** Where a vehicle at work stands along its route, or undefined for a job that never stops. */
export function jobCalls(job: Job): CallPlan | undefined {
  if (job === 'taxi') return fares;
  if (job === 'delivery') return (graph, route, signals) => kerbs(graph, route, signals, 1, UNLOAD);
  if (job === 'garbage') return (graph, route, signals) => kerbs(graph, route, signals, route.length, BINS);
  return undefined;
}

/**
 * A fare: picked up at the first kerb of the route that holds a stop, and set
 * down at the first one at least {@link FARE_SHARE} of the route further on.
 * A route with no room for both carries no fare, and the taxi drives it free.
 */
function fares(graph: RoadGraph, route: readonly number[], signals: TrafficSignals | undefined): BusRoute {
  const { at, dwell } = empty(route.length);
  let total = 0;
  for (const e of route) total += (graph.edges[e] as RoadEdge).length;
  let pick = -1;
  let since = 0;
  for (let i = 0; i < route.length; i++) {
    const edge = graph.edges[route[i] as number] as RoadEdge;
    const holds = holdsStop(edge, signals?.approachOf(edge.id));
    if (pick >= 0 && holds && since >= total * FARE_SHARE) {
      at[pick] = STOP_IN;
      dwell[pick] = PICK_UP;
      at[i] = STOP_IN;
      dwell[i] = SET_DOWN;
      break;
    }
    if (pick < 0 && holds) {
      pick = i;
      since = edge.length - STOP_IN;
    } else if (pick >= 0) since += edge.length;
  }
  return { at, dwell };
}

/** Up to `most` calls of `ticks` each, at the first kerbs of the route that hold one. */
function kerbs(graph: RoadGraph, route: readonly number[], signals: TrafficSignals | undefined, most: number, ticks: number): BusRoute {
  const { at, dwell } = empty(route.length);
  let made = 0;
  for (let i = 0; i < route.length && made < most; i++) {
    const edge = graph.edges[route[i] as number] as RoadEdge;
    if (!holdsStop(edge, signals?.approachOf(edge.id))) continue;
    at[i] = STOP_IN;
    dwell[i] = ticks;
    made++;
  }
  return { at, dwell };
}

function empty(count: number): BusRoute {
  return { at: new Float64Array(count).fill(NO_CALL), dwell: new Int32Array(count) };
}

/**
 * The stretch of a taxi's tour it carries its fare over: from the kerb it
 * picks up at to the kerb it sets down at, in metres round the tour. Undefined
 * for a tour with no fare on it. The calls are laid down in route order, so
 * the pick up is the nearer of the two to the start of the tour.
 */
export function fareOf(tour: Tour): { from: number; to: number } | undefined {
  let from = -1;
  for (let step = 0; step < tour.stepCall.length; step++) {
    if (tour.stepCall[step] !== 1) continue;
    const along = (tour.startDistance[tour.stepLeg[step] as number] as number) + (tour.stepFrom[step] as number);
    if (from < 0) from = along;
    else if (along !== from) return { from: Math.min(from, along), to: Math.max(from, along) };
  }
  return undefined;
}

/**
 * True while a taxi `along` metres round its tour carries its fare: from
 * pulling away from the pick up until it pulls away from the set down. `waiting`
 * is true while the taxi stands still, which at the pick up is still the fare
 * getting in.
 */
export function hiredAt(fare: { from: number; to: number } | undefined, along: number, waiting: boolean): boolean {
  if (fare === undefined) return false;
  if (along === fare.from) return !waiting;
  return along > fare.from && along <= fare.to;
}
