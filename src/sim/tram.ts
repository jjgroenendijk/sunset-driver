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
import { heightOff, RouteSampler, type RouteLegs, type RoutePoint } from './route-sample.ts';
import { layQueue, queueMisses, waitingAt, writeQueue, type StopQueue, type WaitingPassenger } from './stop-queue.ts';
import { SIGNAL_CYCLE, type TrafficSignals } from './signals.ts';
import type { AmbientPose, TrafficRoads } from './traffic.ts';
import { legAt, type Tour } from './traffic-timing.ts';
import { timeTram, type TramCall } from './tram-timing.ts';

export { DWELL, TRAM_CLEAR, type TramCall } from './tram-timing.ts';
export type { WaitingPassenger } from './stop-queue.ts';

/**
 * The two fleets the city runs (`render/tram-mesh.ts`). A tram whose lap starts
 * at a core stop is one of the old cars the core kept; every other tram is one
 * of the articulated ones the inner districts took.
 */
export type TramDesign = 'modern' | 'heritage';

/**
 * The route number each fleet runs under, painted on the destination boards
 * and on the stop panels. The old cars keep the core's line 1 and the new ones
 * work line 2, which is the pair of liveries read as a pair of routes.
 */
export const ROUTE_OF: Record<TramDesign, number> = { heritage: 1, modern: 2 };

/**
 * Ticks of one minute of a countdown. The trams run in real time as the traffic
 * does, so the wait a panel counts down is the player's own minute and not the
 * game clock's, which runs sixty times faster.
 */
const COUNTDOWN_MINUTE = TICK_RATE * 60;

/** The most minutes a countdown panel shows. A longer wait than this reads as "or more". */
export const COUNTDOWN_CAP = 15;

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

/**
 * Metres of loop per tram: the headway, so a long loop runs more of them. A
 * 15 km loop runs ten trams, which is one every 1.5 km and a tram every three
 * or four minutes at a stop — a city service, and often enough that a player
 * driving down an arterial meets one.
 */
export const TRAM_SPACING = 1500;
/** Trams one loop runs at most. */
export const MAX_TRAMS = 16;

/** People one stop holds at most. */
export const STOP_CAP = 8;
/**
 * Ticks between one person arriving at a stop and the next. At the headway
 * {@link TRAM_SPACING} gives, a stop fills to about half its cap between two
 * trams, so a platform is never empty and never always full.
 */
export const ARRIVAL_TICKS = 25 * TICK_RATE;
/** Ticks the people at a stop take to board once the tram stands there. */
export const BOARD_TICKS = 12 * TICK_RATE;
/** Ticks a tram's doors take to slide open, and to shut again before it pulls away. */
export const DOOR_TICKS = Math.round(1.5 * TICK_RATE);
/** Metres between two people waiting in a line along the platform. */
const QUEUE_STEP = 2.2;
/**
 * Metres right of the centreline the people at a stop stand: the middle of the
 * island platform, which the traffic gives up (`laneOffset` in `traffic.ts`)
 * and `render/tram-stops.ts` draws.
 */
export const PLATFORM_STAND = TRAM_TRACK + 1.45 + TRAM_LANE.platform / 2;

/**
 * Where a stop's island platform stands: the middle of it, on the track, with
 * the heading the tram arrives on. The platform itself is drawn across from
 * there (`render/tram-stops.ts`).
 */
export interface TramStopPlace {
  stop: number;
  x: number;
  y: number;
  height: number;
  heading: number;
}

/** A tram whose bell rings on a tick, and where its front is. */
export interface TramBell {
  tram: number;
  x: number;
  y: number;
}

/** One stop of the loop and the line of people waiting at it. */
interface TramStop {
  call: TramCall;
  queue: StopQueue;
  /** The zone of the district the stop stands in, which decides the fleet that starts there. */
  zone: District['zone'];
  /** What the stop is called, which is the name of the district it stands in. */
  name: string;
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
  private readonly stops: TramStop[] = [];
  /** The fleet each tram belongs to, decided by the stop its lap starts from. */
  private readonly fleet: TramDesign[] = [];
  /** Where each stop's platform stands, laid down once with the queues. */
  private readonly places: TramStopPlace[] = [];
  private readonly point: RoutePoint;
  private readonly behind: RoutePoint;
  private readonly ahead: RoutePoint;

  /** `signals` are the lights the traffic keeps to, which the tram keeps to as well. */
  constructor(seed: number, roads: TrafficRoads, tram: TramDescription, districts: readonly Pick<District, 'id' | 'zone' | 'name'>[], signals?: TrafficSignals) {
    const graph = roads.graph;
    this.sampler = new RouteSampler(roads.roads, graph, roads.heightAt, roads.tiltAt);
    const blank = (): RoutePoint => ({ x: 0, y: 0, height: 0, tiltX: 0, tiltY: 0, rightX: 0, rightY: 0, edge: graph.edges[0] as RoadEdge });
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
    for (const call of this.calls) this.stops.push(this.stopOf(seed, call, districts, tram));
    for (const call of this.calls) {
      // The platform is as long as a tram and ends where the tram's front does.
      const at = this.track(call.front - TRAM_LENGTH / 2, this.point);
      this.places.push({ stop: call.stop, x: at.x, y: at.y, height: at.height, heading: atan2(at.rightX, -at.rightY) });
    }
    for (let k = 0; k < this.trams; k++) this.fleet.push(this.fleetOf(k));
  }

  /** Which fleet a tram belongs to. */
  design(tram: number): TramDesign {
    return this.fleet[tram] ?? 'modern';
  }

  /** The fleet of the tram that starts its lap at a stop: the core's cars are the old ones. */
  private fleetOf(tram: number): TramDesign {
    const at = this.loopTick(tram, 0);
    let last = this.stops[this.stops.length - 1];
    for (const stop of this.stops) {
      if (stop.call.arrive <= at) last = stop;
    }
    return last?.zone === 'core' ? 'heritage' : 'modern';
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

  /**
   * How far the doors of a tram stand open at a moment: 0 shut, 1 wide. They
   * slide open when it comes to a stand and shut again before it pulls away.
   */
  doorsAt(tram: number, time: number): number {
    const tour = this.tour;
    if (tour === undefined) return 0;
    const at = this.loopTick(tram, time);
    for (const call of this.calls) {
      const dwell = call.depart - call.arrive;
      const into = mod(at - call.arrive, tour.period);
      if (into >= dwell) continue;
      return Math.max(0, Math.min(1, into / DOOR_TICKS, (dwell - into) / DOOR_TICKS));
    }
    return 0;
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
    return waitingAt(since, boarding, BOARD_TICKS, STOP_CAP, ARRIVAL_TICKS);
  }

  /**
   * The people waiting at the stops inside a box on a tick. While a tram stands
   * at a stop the queue moves up towards its doors as it loses people off the
   * head, rather than simply shrinking where it stands.
   */
  passengers(minX: number, minY: number, maxX: number, maxY: number, tick: number, out: WaitingPassenger[]): number {
    let count = 0;
    for (const stop of this.stops) {
      if (queueMisses(stop.queue, minX, minY, maxX, maxY)) continue;
      const at = Math.floor(tick);
      count = writeQueue(stop.queue, this.waiting(stop.call.stop, at), out, count, this.boarding(stop.call, tick));
    }
    return count;
  }

  /**
   * How far the queue at a stop has moved up towards the doors, 0 to 1. It is
   * how far into the boarding a tram standing there is, and 0 where none is.
   */
  private boarding(call: TramCall, time: number): number {
    const tour = this.tour;
    if (tour === undefined) return 0;
    const dwell = call.depart - call.arrive;
    let moved = 0;
    for (let k = 0; k < this.trams; k++) {
      const into = mod(this.loopTick(k, time) - call.arrive, tour.period);
      if (into < dwell) moved = Math.max(moved, Math.min(1, into / BOARD_TICKS));
    }
    return moved;
  }

  /** What the stop at a call is called. */
  stopName(stop: number): string {
    return this.stops[stop]?.name ?? '';
  }

  /**
   * The call a tram is running towards at a moment: the next one it arrives at,
   * or the one it stands at while it stands there. It is what its destination
   * board shows.
   */
  nextCall(tram: number, time: number): number {
    const tour = this.tour;
    if (tour === undefined) return 0;
    const at = this.loopTick(tram, time);
    let best = 0;
    let soonest = Infinity;
    for (let i = 0; i < this.calls.length; i++) {
      const call = this.calls[i] as TramCall;
      const dwell = call.depart - call.arrive;
      const into = mod(at - call.arrive, tour.period);
      // A tram standing at a stop still shows it; one between stops shows the next.
      const away = into < dwell ? 0 : tour.period - into;
      if (away < soonest) {
        soonest = away;
        best = i;
      }
    }
    return best;
  }

  /**
   * Minutes until the next tram calls at a stop, capped at
   * {@link COUNTDOWN_CAP}. A tram standing there now reads 0, which the panel
   * shows as the tram being due.
   */
  minutesTo(stop: number, time: number): number {
    const tour = this.tour;
    const call = this.calls[stop];
    if (tour === undefined || call === undefined) return COUNTDOWN_CAP;
    let soonest = Infinity;
    for (let k = 0; k < this.trams; k++) {
      const dwell = call.depart - call.arrive;
      const into = mod(this.loopTick(k, time) - call.arrive, tour.period);
      soonest = Math.min(soonest, into < dwell ? 0 : tour.period - into);
    }
    return Math.min(COUNTDOWN_CAP, Math.round(soonest / COUNTDOWN_MINUTE));
  }

  /** Where each stop's platform stands, in the order the tram calls. */
  stopPlaces(): readonly TramStopPlace[] {
    return this.places;
  }

  /** The point of the track a distance round the loop. */
  private track(distance: number, out: RoutePoint): RoutePoint {
    const at = this.sampler.sample(this.tour as Tour, distance, out);
    at.height = heightOff(at, TRAM_TRACK);
    at.x += at.rightX * TRAM_TRACK;
    at.y += at.rightY * TRAM_TRACK;
    return at;
  }

  /** One stop and its queue: a line along the pavement back from where the tram calls, facing the road. */
  private stopOf(seed: number, call: TramCall, districts: readonly Pick<District, 'id' | 'zone' | 'name'>[], tram: TramDescription): TramStop {
    const place = tram.stops[call.stop] as TramDescription['stops'][number];
    const district = districts.find((d) => d.id === place.district);
    const zone = district?.zone ?? 'inner';
    const looks: PedestrianLook[] = [];
    for (let i = 0; i < STOP_CAP; i++) looks.push(lookOf(zone, rngFor(seed, 0, Subsystem.Tram, hashInts(call.stop, i))));
    const queue = layQueue(this.sampler, this.tour as RouteLegs, call.front - CAR_LENGTH / 2, QUEUE_STEP, looks, this.point, PLATFORM_STAND);
    return { call, queue, zone, name: district?.name ?? 'Terminus' };
  }
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}
