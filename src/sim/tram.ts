/**
 * The tram (spec section 13.2): the trams on the loop of `corridors.ts`, the
 * people waiting at its stops, and its bell, all as a function of the tick.
 *
 * The loop is timed once (`tram-timing.ts`), and every tram drives the same
 * timing a whole number of signal cycles behind the one before, so each keeps
 * to the lights as the first one does. A tram is {@link TRAM_CARS} cars on its
 * track, each read on its own at its two bogies, so the tram bends round a
 * corner rather than cutting across it. The track is the right-hand half of the
 * reserved lane in the middle of the arterial; the traffic keeps out of that
 * lane (`laneOffset` in `traffic.ts`).
 *
 * Nothing here is simulation state. The physics stands each car near the
 * player as a kinematic body (`tram-bodies.ts`), the renderer draws them, and
 * the audio of spec section 15 is to ring {@link TramLine.bells}.
 */
import { hashInts } from '../core/hash.ts';
import { atan2 } from '../core/libm.ts';
import { rngFor, Subsystem } from '../core/rng.ts';
import type { RoadEdge } from '../world/graph.ts';
import { TRAM_LANE } from '../world/tiers.ts';
import type { District, TramDescription } from '../world/types.ts';
import { TICK_RATE } from './clock.ts';
import { lookOf, type PedestrianLook } from './pedestrian-look.ts';
import { PAVEMENT_RISE, pavementOffset } from './pedestrian-route.ts';
import type { PedestrianPose } from './pedestrians.ts';
import { RouteSampler, type RoutePoint } from './route-sample.ts';
import { SIGNAL_CYCLE, type TrafficSignals } from './signals.ts';
import type { AmbientPose, TrafficRoads } from './traffic.ts';
import { legAt, type Tour } from './traffic-timing.ts';
import { timeTram, type TramCall } from './tram-timing.ts';

export { DWELL, TRAM_CLEAR, type TramCall } from './tram-timing.ts';

/** Cars one tram is made of. */
export const TRAM_CARS = 3;
/** Metres of one car, end to end. */
export const CAR_LENGTH = 10;
/** Metres between two cars of one tram. */
export const CAR_GAP = 0.8;
/** Metres from the middle of a car to either side and to the roof. */
export const CAR_HALF_WIDTH = 1.3;
export const CAR_HALF_HEIGHT = 1.65;
/** Metres of a whole tram, nose to tail. */
export const TRAM_LENGTH = TRAM_CARS * CAR_LENGTH + (TRAM_CARS - 1) * CAR_GAP;
/** Metres from the middle of the road to the track: the middle of the right half of the reserved lane. */
export const TRAM_TRACK = TRAM_LANE.trackSpacing / 2;
/** Metres from the middle of a car to each of its bogies, where the car is read on the track. */
export const BOGIE = 3.5;

/** Metres of loop per tram: the headway, so a long loop runs more of them. */
export const TRAM_SPACING = 3000;
/** Trams one loop runs at most. */
export const MAX_TRAMS = 8;

/** People one stop holds at most. */
export const STOP_CAP = 8;
/** Ticks between one person arriving at a stop and the next. */
export const ARRIVAL_TICKS = 60 * TICK_RATE;
/** Ticks the people at a stop take to board once the tram stands there. */
export const BOARD_TICKS = 12 * TICK_RATE;
/** Metres between two people waiting in a line along the kerb. */
const QUEUE_STEP = 2.2;

/** A tram whose bell rings on a tick, and where its front is. */
export interface TramBell {
  tram: number;
  x: number;
  y: number;
}

/** A person waiting at a stop. */
export interface WaitingPassenger {
  pose: PedestrianPose;
  look: PedestrianLook;
}

/** Where the people of one stop stand: `x`, `y`, `height` and `heading` for each place in the queue. */
interface StopQueue {
  call: TramCall;
  places: Float64Array;
  looks: PedestrianLook[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class TramLine {
  /** How many trams run the loop. */
  readonly trams: number;
  /** The timing every tram drives. Empty when the world has no loop. */
  readonly tour: Tour | undefined;
  /** The calls the loop makes, in stop order. */
  readonly calls: readonly TramCall[];
  private readonly bell: Uint8Array;
  /** Ticks each tram is ahead of the first, all whole signal cycles. */
  private readonly phases: Int32Array;
  private readonly sampler: RouteSampler;
  private readonly queues: StopQueue[] = [];
  private readonly point: RoutePoint;
  private readonly behind: RoutePoint;
  private readonly ahead: RoutePoint;

  /** `signals` are the lights the traffic keeps to, which the tram keeps to as well. */
  constructor(seed: number, roads: TrafficRoads, tram: TramDescription, districts: readonly Pick<District, 'id' | 'zone'>[], signals?: TrafficSignals) {
    const graph = roads.graph;
    this.sampler = new RouteSampler(roads.roads, graph, roads.heightAt);
    const blank = (): RoutePoint => ({ x: 0, y: 0, height: 0, rightX: 0, rightY: 0, edge: graph.edges[0] as RoadEdge });
    this.point = blank();
    this.behind = blank();
    this.ahead = blank();
    if (tram.edges.length < 2 || tram.stops.length === 0) {
      this.trams = 0;
      this.tour = undefined;
      this.bell = new Uint8Array(0);
      this.calls = [];
      this.phases = new Int32Array(0);
      return;
    }
    const crossings = tram.crossings.map((crossing) => crossing.node);
    const timing = timeTram(graph, tram.edges, TRAM_LENGTH, tram.stops, crossings, signals);
    this.tour = timing.tour;
    this.bell = timing.bell;
    this.calls = timing.calls;
    const period = timing.tour.period;
    this.trams = Math.max(1, Math.min(MAX_TRAMS, Math.round(tram.length / TRAM_SPACING), Math.floor(period / SIGNAL_CYCLE)));
    this.phases = new Int32Array(this.trams);
    for (let k = 0; k < this.trams; k++) this.phases[k] = Math.round((k * period) / this.trams / SIGNAL_CYCLE) * SIGNAL_CYCLE;
    for (const call of this.calls) this.queues.push(this.queueOf(seed, call, districts, tram));
  }

  /** The tick of the loop a tram stands at on a tick, which may fall between two. */
  loopTick(tram: number, time: number): number {
    const tour = this.tour as Tour;
    return mod(time - tour.sync + (this.phases[tram] as number), tour.period);
  }

  /** Metres round the loop the front of a tram stands at. */
  frontAt(tram: number, time: number): number {
    const tour = this.tour as Tour;
    const at = this.loopTick(tram, time);
    const step = legAt(tour.stepStart, at);
    const from = tour.stepFrom[step] as number;
    const into = (at - (tour.stepStart[step] as number)) / (tour.stepTicks[step] as number);
    return (tour.startDistance[tour.stepLeg[step] as number] as number) + from + Math.min(1, into) * ((tour.stepTo[step] as number) - from);
  }

  /** The pose of one car of a tram at a moment. `height` is the rail, `y` is the map's. */
  carPose(tram: number, car: number, time: number, out: AmbientPose): AmbientPose {
    const tour = this.tour as Tour;
    const middle = this.frontAt(tram, time) - CAR_LENGTH / 2 - car * (CAR_LENGTH + CAR_GAP);
    const behind = this.track(middle - BOGIE, this.behind);
    const ahead = this.track(middle + BOGIE, this.ahead);
    out.x = (behind.x + ahead.x) / 2;
    out.y = (behind.y + ahead.y) / 2;
    out.height = (behind.height + ahead.height) / 2;
    out.heading = atan2(ahead.y - behind.y, ahead.x - behind.x);
    const at = this.loopTick(tram, time);
    const step = legAt(tour.stepStart, at);
    out.speed = (((tour.stepTo[step] as number) - (tour.stepFrom[step] as number)) / (tour.stepTicks[step] as number)) * TICK_RATE;
    return out;
  }

  /** Every tram whose bell rings on a whole tick: the ones pulling away from a halt on it. */
  bells(tick: number, out: TramBell[] = []): TramBell[] {
    out.length = 0;
    const tour = this.tour;
    if (tour === undefined) return out;
    for (let k = 0; k < this.trams; k++) {
      const at = this.loopTick(k, tick);
      const step = legAt(tour.stepStart, at);
      if (this.bell[step] !== 1 || tour.stepStart[step] !== at) continue;
      const front = this.track(this.frontAt(k, tick), this.point);
      out.push({ tram: k, x: front.x, y: front.y });
    }
    return out;
  }

  /** How many people wait at a stop on a tick. They gather between trams and board while one stands there. */
  waiting(stop: number, tick: number): number {
    const tour = this.tour;
    const call = this.calls[stop];
    if (tour === undefined || call === undefined) return 0;
    const dwell = call.depart - call.arrive;
    let since = Infinity;
    let boarding = -1;
    for (let k = 0; k < this.trams; k++) {
      const at = Math.floor(this.loopTick(k, tick));
      since = Math.min(since, mod(at - call.depart, tour.period));
      const into = mod(at - call.arrive, tour.period);
      if (into < dwell) boarding = into;
    }
    if (boarding < 0) return gathered(since);
    return Math.ceil(gathered(since - boarding) * Math.max(0, 1 - boarding / BOARD_TICKS));
  }

  /** The people waiting at the stops inside a box on a tick. */
  passengers(minX: number, minY: number, maxX: number, maxY: number, tick: number, out: WaitingPassenger[]): number {
    let count = 0;
    for (const queue of this.queues) {
      if (queue.maxX < minX || queue.minX > maxX || queue.maxY < minY || queue.minY > maxY) continue;
      const people = this.waiting(queue.call.stop, Math.floor(tick));
      for (let i = 0; i < people; i++) {
        const entry = out[count] ?? { pose: { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' }, look: queue.looks[i] as PedestrianLook };
        const p = entry.pose;
        p.x = queue.places[i * 4] as number;
        p.y = queue.places[i * 4 + 1] as number;
        p.height = queue.places[i * 4 + 2] as number;
        p.heading = queue.places[i * 4 + 3] as number;
        p.speed = 0;
        p.cycle = 0;
        p.gait = 'stand';
        entry.look = queue.looks[i] as PedestrianLook;
        out[count++] = entry;
      }
    }
    return count;
  }

  /** The point of the track a distance round the loop. */
  private track(distance: number, out: RoutePoint): RoutePoint {
    const at = this.sampler.sample(this.tour as Tour, distance, out);
    at.x += at.rightX * TRAM_TRACK;
    at.y += at.rightY * TRAM_TRACK;
    return at;
  }

  /** The places of a stop's queue: a line along the pavement to the right of where the tram calls, facing the road. */
  private queueOf(seed: number, call: TramCall, districts: readonly Pick<District, 'id' | 'zone'>[], tram: TramDescription): StopQueue {
    const stop = tram.stops[call.stop] as TramDescription['stops'][number];
    const zone = districts.find((d) => d.id === stop.district)?.zone ?? 'inner';
    const places = new Float64Array(STOP_CAP * 4);
    const looks: PedestrianLook[] = [];
    const queue: StopQueue = { call, places, looks, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (let i = 0; i < STOP_CAP; i++) {
      const at = this.sampler.sample(this.tour as Tour, call.front - CAR_LENGTH / 2 - i * QUEUE_STEP, this.point);
      const offset = pavementOffset(at.edge);
      const x = at.x + at.rightX * offset;
      const y = at.y + at.rightY * offset;
      places.set([x, y, at.height + PAVEMENT_RISE, atan2(-at.rightY, -at.rightX)], i * 4);
      looks.push(lookOf(zone, rngFor(seed, 0, Subsystem.Tram, hashInts(call.stop, i))));
      queue.minX = Math.min(queue.minX, x);
      queue.minY = Math.min(queue.minY, y);
      queue.maxX = Math.max(queue.maxX, x);
      queue.maxY = Math.max(queue.maxY, y);
    }
    return queue;
  }
}

/** People who have come to a stop in the ticks since the last tram left it. */
function gathered(ticks: number): number {
  return Math.min(STOP_CAP, Math.floor(Math.max(0, ticks) / ARRIVAL_TICKS));
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}
