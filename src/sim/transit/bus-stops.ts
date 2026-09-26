/**
 * The bus stops of a world: the kerbs the buses call at, the post on the
 * pavement that says so, and the people waiting there (spec section 20.2).
 *
 * `bus.ts` decides where a bus calls, and the call is a halt in the middle of
 * a leg. Every call stands the same metres into its leg, so two buses that
 * call on the same directed edge call on the same metre: the stops of a world
 * are the directed edges its buses call on, gathered here once and then read
 * from the tick. The metre comes off the halt itself rather than from the
 * constant, so a stop is drawn where the bus really stops.
 *
 * Nothing is stepped. Every bus that calls at a stop repeats its lap for ever,
 * so the tick each one arrives and pulls away is a residue of its own period,
 * and the ticks since the kerb was last free is the smallest of those residues.
 * That is what fills the queue ({@link BusStops.waiting}), the same way the
 * ticks since the last tram left fill a tram stop's.
 *
 * The queue holds as many people as the stop was built to gather, which is
 * also what the timing stood the bus there for, so a bus pulls away from an
 * empty kerb. A few people get off each bus at the back door and walk away
 * (`bus-alight.ts`).
 */
import { hashInts } from '../../core/hash.ts';
import { atan2 } from '../../core/libm.ts';
import { rngFor, Subsystem } from '../../core/rng.ts';
import type { RoadEdge } from '../../world/roads/graph.ts';
import { ALIGHT_GAP, ALIGHT_SPAN, alighterLook, DOORS_OPEN, alighting, alightPose, type AlightSite } from './bus-alight.ts';
import { ARRIVAL_TICKS, boardTicks } from './bus.ts';
import { lookOf, type PedestrianLook } from '../crowd/pedestrian-look.ts';
import { PAVEMENT_RISE, pavementOffset } from '../crowd/pedestrian-route.ts';
import { emptyPose } from '../crowd/pedestrians.ts';
import { TIERS } from '../../world/roads/tiers.ts';
import type { DistrictAt } from '../crowd/pedestrians.ts';
import { RouteSampler, type RouteLegs, type RoutePoint } from '../traffic/route-sample.ts';
import { layQueue, queueMisses, waitingAt, writeQueue, type StopQueue, type WaitingPassenger } from './stop-queue.ts';
import type { AmbientTraffic } from '../traffic/traffic.ts';

/** Metres past the call the post stands: just off the nose of a bus at the kerb. */
export const POST_AHEAD = 7;

/** Metres past the call the head of the queue stands, and metres between two people in it. */
const QUEUE_HEAD = 4;
const QUEUE_STEP = 1.6;

/** People a stop needs before it is given a shelter rather than a bare post. */
export const SHELTER_RIDERS = 4;

/** The stream the looks of a queue are drawn from, kept off the one the demand uses. */
const LOOK_STREAM = 0x5d09;
/** The stream the looks of the people getting off are drawn from, and how many a stop draws. */
const ALIGHT_LOOK_STREAM = 0x5d0b;
const ALIGHT_LOOKS = 7;

/** One kerb the buses of a world call at. */
export interface BusStop {
  /** The directed edge it stands on. */
  edge: number;
  /** Metres into that edge the bus halts. */
  call: number;
  /** Where the post stands, the ground under it, and the way it faces: out of the road. */
  x: number;
  y: number;
  height: number;
  heading: number;
  /** People the stop gathers before it is full, which is how long a bus stands here. */
  riders: number;
}

/** When one bus calls at a stop, in the ticks of the world rather than of its own tour. */
interface BusCall {
  arrive: number;
  depart: number;
  period: number;
}

/** One stop, the line of people at it, and every bus that calls there. */
interface StopRecord {
  stop: BusStop;
  queue: StopQueue;
  calls: BusCall[];
  /** Where the people getting off step down and walk, and how they look. */
  site: AlightSite;
  alighters: readonly PedestrianLook[];
}

export class BusStops {
  private readonly records: StopRecord[] = [];
  private readonly seed: number;
  private readonly sampler: RouteSampler;
  private readonly point: RoutePoint;

  /**
   * Gather the stops of a traffic. `districtAt` dresses the people waiting for
   * the district they stand in, as the crowd around them is dressed; without
   * it they are all dressed for the core.
   */
  constructor(seed: number, traffic: AmbientTraffic, districtAt?: DistrictAt) {
    const graph = traffic.roads.graph;
    const sampler = new RouteSampler(traffic.roads.roads, graph, traffic.roads.heightAt, traffic.roads.tiltAt);
    const point: RoutePoint = { x: 0, y: 0, height: 0, tiltX: 0, tiltY: 0, rightX: 0, rightY: 0, edge: graph.edges[0] as RoadEdge };
    this.seed = seed;
    this.sampler = sampler;
    this.point = point;
    // The record of each directed edge, or -1 on an edge no bus calls on. An
    // array rather than a map, because `src/sim` may not walk one.
    const found = new Int32Array(graph.edges.length).fill(-1);
    for (const vehicle of traffic.vehicles) {
      const tour = vehicle.tour;
      for (let step = 0; step < tour.stepCall.length; step++) {
        if (tour.stepCall[step] !== 1) continue;
        const edge = graph.edges[tour.edges[tour.stepLeg[step] as number] as number] as RoadEdge;
        let at = found[edge.id] as number;
        if (at < 0) {
          at = this.records.length;
          found[edge.id] = at;
          this.records.push(recordOf(seed, sampler, point, edge, tour.stepFrom[step] as number, traffic.demand.riders(edge), districtAt));
        }
        const period = tour.period;
        // A vehicle stands at tour tick `a` on every world tick that leaves
        // `a - phase` over its period, which is how `cursorAt` reads it.
        const arrive = mod((tour.stepStart[step] as number) - vehicle.phase, period);
        (this.records[at] as StopRecord).calls.push({ arrive, depart: arrive + (tour.stepTicks[step] as number), period });
      }
    }
  }

  /** How many stops the world has. */
  get count(): number {
    return this.records.length;
  }

  /** The stop at an index, in the order they were gathered. */
  stopAt(index: number): BusStop {
    return (this.records[index] as StopRecord).stop;
  }

  /** The stops inside a box, for the renderer to stand a post at each of them. */
  near(minX: number, minY: number, maxX: number, maxY: number, out: BusStop[]): number {
    let count = 0;
    for (const record of this.records) {
      const stop = record.stop;
      if (stop.x < minX || stop.x > maxX || stop.y < minY || stop.y > maxY) continue;
      out[count++] = stop;
    }
    out.length = count;
    return count;
  }

  /**
   * How many people wait at a stop on a tick. They gather between buses and
   * board while one stands there.
   */
  waiting(index: number, tick: number): number {
    const record = this.records[index] as StopRecord;
    let since = Infinity;
    let boarding = -1;
    for (const call of record.calls) {
      since = Math.min(since, mod(tick - call.depart, call.period));
      const into = mod(tick - call.arrive, call.period);
      if (into < call.depart - call.arrive) boarding = into;
    }
    const riders = record.stop.riders;
    return waitingAt(since, boarding, boardTicks(riders), riders, ARRIVAL_TICKS);
  }

  /** The people waiting at the stops inside a box on a tick. */
  passengers(minX: number, minY: number, maxX: number, maxY: number, tick: number, out: WaitingPassenger[]): number {
    let count = 0;
    for (let i = 0; i < this.records.length; i++) {
      const record = this.records[i] as StopRecord;
      if (queueMisses(record.queue, minX, minY, maxX, maxY)) continue;
      count = writeQueue(record.queue, this.waiting(i, Math.floor(tick)), out, count);
      count = this.alighted(record, Math.floor(tick), out, count);
    }
    return count;
  }

  /** The people getting off the buses at one stop on a tick, written into `out` from `count` on. */
  private alighted(record: StopRecord, tick: number, out: WaitingPassenger[], count: number): number {
    let at = count;
    for (const [c, call] of record.calls.entries()) {
      const into = mod(tick - call.arrive, call.period);
      if (into >= ALIGHT_SPAN) continue;
      const lap = Math.floor((tick - call.arrive) / call.period);
      const off = alighting(record.stop.edge, c, lap, this.seed);
      for (let k = 0; k < off; k++) {
        const entry = out[at] ?? { pose: emptyPose(), look: record.alighters[0] as PedestrianLook };
        if (!alightPose(this.sampler, record.site, into - alightStart(k), this.point, entry.pose)) continue;
        entry.look = alighterLook(record.alighters, lap, k);
        out[at++] = entry;
      }
    }
    return at;
  }
}

/**
 * One stop of a leg: the post beside the kerb, and the queue that waits behind
 * it. Both are read off a route of the one leg, so a stop needs no tour: the
 * call and everything round it lie on the same edge, which `holdsStop` in
 * `bus.ts` keeps long enough to hold them.
 */
function recordOf(seed: number, sampler: RouteSampler, point: RoutePoint, edge: RoadEdge, call: number, riders: number, districtAt?: DistrictAt): StopRecord {
  const leg: RouteLegs = { edges: Int32Array.of(edge.id), startDistance: Float64Array.of(0), length: edge.length };
  const at = sampler.sample(leg, call + POST_AHEAD, point);
  const offset = pavementOffset(edge);
  const x = at.x + at.rightX * offset;
  const y = at.y + at.rightY * offset;
  const zone = districtAt?.(x, y).zone ?? 'core';
  const looks: PedestrianLook[] = [];
  for (let i = 0; i < riders; i++) looks.push(lookOf(zone, rngFor(seed, 0, Subsystem.Bus, hashInts(LOOK_STREAM, edge.id, i))));
  const stop: BusStop = { edge: edge.id, call, x, y, height: at.height + PAVEMENT_RISE, heading: atan2(-at.rightY, -at.rightX), riders };
  const alighters: PedestrianLook[] = [];
  for (let i = 0; i < ALIGHT_LOOKS; i++) alighters.push(lookOf(zone, rngFor(seed, 0, Subsystem.Bus, hashInts(ALIGHT_LOOK_STREAM, edge.id, i))));
  // The kerb, the middle of the pavement, and its far side, where the buildings start.
  const pavement = TIERS[edge.tier].pavement;
  const site: AlightSite = { leg, call, kerb: offset - pavement / 2 + 0.2, lane: offset, wall: offset + pavement / 2 };
  return { stop, queue: layQueue(sampler, leg, call + QUEUE_HEAD, QUEUE_STEP, looks, point), calls: [], site, alighters };
}

/** Ticks after a bus arrives that its `k`th passenger off steps down. */
function alightStart(k: number): number {
  return DOORS_OPEN + k * ALIGHT_GAP;
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}
