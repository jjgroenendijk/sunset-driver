/**
 * Which vehicles of the traffic are out on the road at a tick (spec sections
 * 13.1 and 20.5): the traffic thickens at rush hour and thins at night, and it
 * keeps off a street an event has closed.
 *
 * `traffic.ts` places every vehicle once for a world and times its tour once,
 * so the vehicles themselves never change. This decides only who is out, as a
 * pure function of `(seed, tick)`, as the hour decides who of the crowd is
 * drawn (`crowd-hours.ts`).
 *
 * A vehicle decides when it turns onto a leg of its tour, and keeps to that
 * choice until the leg ends. So a vehicle comes onto the road or leaves it at
 * a junction, never halfway down a street, and a car on a leg is never
 * dropped under the eyes of the player because the clock struck the hour.
 *
 * - Each vehicle carries a rank from its own stream. It is out on a leg while
 *   the share of {@link TRAFFIC_HOURS} at the tick it turned onto the leg is
 *   above that rank. The ranks do not change, so the same cars are the ones
 *   that stay at home at night.
 * - A bus keeps its timetable at every hour: people wait at its stops.
 * - Nobody is out on a leg whose road an event has shut (`closes` in
 *   `city-events.ts`) at any tick the vehicle would drive it.
 */
import { hashInts } from '../../core/hash.ts';
import { rngFor, Subsystem } from '../../core/rng.ts';
import type { Point } from '../../world/types.ts';
import type { RoadGraph } from '../../world/roads/graph.ts';
import { EVENT_ORDER, EVENTS, eventOn, type EventKind, type Venues } from '../city/city-events.ts';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../clock.ts';
import type { VehicleClass } from '../vehicles/vehicle.ts';
import type { Tour } from './traffic-tour.ts';

/**
 * The share of the traffic out at each hour, from midnight. The hours of
 * `rushHourAt` are 1, which is every vehicle placed.
 */
export const TRAFFIC_HOURS: readonly number[] = [
  0.3, 0.22, 0.18, 0.15, 0.15, 0.25, 0.55, 1, 1, 0.8, 0.75, 0.75, 0.8, 0.8, 0.75, 0.8, 1, 1, 1, 0.75, 0.6,
  0.55, 0.45, 0.38,
];

/** The key of the stream a vehicle's rank is drawn from. `traffic.ts` holds 1 to 3. */
const RANK_STREAM = 4;

/** The share of the traffic out at a tick, 0 to 1. */
export function trafficAtHour(tick: number): number {
  const inDay = ((tick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  return TRAFFIC_HOURS[Math.floor(inDay / TICKS_PER_HOUR)] as number;
}

/** What {@link TrafficHours} reads of one vehicle. */
interface Out {
  id: number;
  cls: VehicleClass;
  tour: Tour;
}

/** Where a vehicle is on its tour: the step, and the ticks it has spent on it. */
interface Place {
  id: number;
  step: number;
  into: number;
}

/** The kinds of event that close a street, in the order of `EVENT_ORDER`. */
const CLOSING: readonly EventKind[] = EVENT_ORDER.filter((kind) => EVENTS[kind].closes);

export class TrafficHours {
  private readonly seed: number;
  private readonly vehicles: readonly Out[];
  private readonly graph: RoadGraph;
  /** Each vehicle's rank, 0 to 1: it is out while the hour's share is above it. */
  private readonly ranks: Float64Array;
  private venues: Venues = {};
  /** For each kind in {@link CLOSING}, 1 on each edge the event shuts; undefined where it has no venue. */
  private closed: (Uint8Array | undefined)[] = [];

  constructor(seed: number, vehicles: readonly Out[], graph: RoadGraph) {
    this.seed = seed;
    this.vehicles = vehicles;
    this.graph = graph;
    this.ranks = new Float64Array(vehicles.length);
    for (const vehicle of vehicles) {
      this.ranks[vehicle.id] = rngFor(seed, 0, Subsystem.Traffic, hashInts(RANK_STREAM, vehicle.id)).float();
    }
  }

  /**
   * Shut the streets of the events held at `venues`: every edge that passes
   * within an event's radius of its venue. It is called once, when the places
   * of the world are known and before the first tick is stepped.
   */
  close(venues: Venues): void {
    this.venues = venues;
    this.closed = CLOSING.map((kind) => {
      const at = venues[kind];
      return at === undefined ? undefined : this.edgesWithin(at, EVENTS[kind].radius);
    });
  }

  /** True while the vehicle at `place`, which it stands at on `tick`, is out on the road. */
  isOut(place: Place, tick: number): boolean {
    const vehicle = this.vehicles[place.id] as Out;
    const tour = vehicle.tour;
    const leg = tour.stepLeg[place.step] as number;
    let first = place.step;
    while (first > 0 && tour.stepLeg[first - 1] === leg) first--;
    let last = place.step;
    while (last < tour.stepLeg.length - 1 && tour.stepLeg[last + 1] === leg) last++;
    const begin = tour.stepStart[first] as number;
    const enter = tick - ((tour.stepStart[place.step] as number) + place.into - begin);
    const leave = enter + (tour.stepStart[last] as number) + (tour.stepTicks[last] as number) - begin;
    if (vehicle.cls !== 'bus' && (this.ranks[place.id] as number) >= trafficAtHour(enter)) return false;
    return !this.shut(tour.edges[leg] as number, enter, leave);
  }

  /** True where an event has shut an edge at any tick from `enter` up to `leave`. */
  private shut(edge: number, enter: number, leave: number): boolean {
    for (let k = 0; k < CLOSING.length; k++) {
      if (this.closed[k]?.[edge] !== 1) continue;
      // An event past midnight belongs to the day it opened on, as in `eventsAt`.
      const last = Math.floor(leave / TICKS_PER_DAY);
      for (let day = Math.max(0, Math.floor(enter / TICKS_PER_DAY) - 1); day <= last; day++) {
        const event = eventOn(this.seed, CLOSING[k] as EventKind, day, this.venues);
        if (event !== undefined && event.from < leave && enter < event.to) return true;
      }
    }
    return false;
  }

  /** 1 on every edge whose line passes within `radius` of a point. */
  private edgesWithin(at: Point, radius: number): Uint8Array {
    const graph = this.graph;
    const out = new Uint8Array(graph.edges.length);
    for (const edge of graph.edges) {
      const points = graph.edgePoints(edge.id);
      for (let i = 0; i + 1 < points.length && out[edge.id] === 0; i++) {
        if (segmentDistance(at, points[i] as Point, points[i + 1] as Point) <= radius) out[edge.id] = 1;
      }
    }
    return out;
  }
}

/** Metres from a point to the nearest point of a segment. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
  const ex = a.x + dx * t - p.x;
  const ey = a.y + dy * t - p.y;
  return Math.sqrt(ex * ex + ey * ey);
}
