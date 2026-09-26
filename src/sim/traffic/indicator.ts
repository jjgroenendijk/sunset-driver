/**
 * The indicators of the ambient traffic (spec section 20.2).
 *
 * A vehicle of the traffic drives a tour, so the turn at the end of the leg it
 * is on is already known: the tour holds the legs and the graph the angle
 * between them. Which way a vehicle indicates is therefore a pure function of
 * the tour, the driver and where on the tour the vehicle stands, and nothing
 * here is stepped or stored in the record.
 *
 * A driver puts the indicator on {@link Driver.indicates} metres before the
 * junction and keeps it on for {@link THROUGH} metres into the road they turn
 * onto, since the lamp goes off only when the wheel comes back. A driver whose
 * row says 0 turns with no warning. Only a turn at a junction is indicated: a
 * node where two runs meet is a bend in one road, and a driver follows it.
 */
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import type { Driver } from './driver.ts';
import type { AmbientTraffic, TrafficCursor } from './traffic.ts';
import type { Tour } from './traffic-timing.ts';

/** Radians a road has to turn through at a junction for the driver to indicate: about 20 degrees. */
const TURN = 0.35;

/** Metres into the road turned onto that the indicator stays on. */
export const THROUGH = 8;

/** Ticks the lamp is lit and then dark: 0.4 s each, so it flashes 75 times a minute. */
export const BLINK = 24;

/**
 * The side of the turn at the end of each leg of a route: 1 for a turn to the
 * right, -1 for one to the left and 0 where the driver goes straight on,
 * follows a bend, or turns back at a dead end.
 */
export function turnSides(graph: RoadGraph, edges: Int32Array): Int8Array {
  const count = edges.length;
  const sides = new Int8Array(count);
  for (let i = 0; i < count; i++) {
    const from = edges[i] as number;
    const to = edges[(i + 1) % count] as number;
    if (graph.degree((graph.edges[from] as RoadEdge).to) < 3) continue;
    const bend = graph.bend(from, to);
    if (Math.abs(bend) < TURN || Math.abs(bend) > Math.PI - TURN) continue;
    sides[i] = bend > 0 ? 1 : -1;
  }
  return sides;
}

/**
 * The side a vehicle indicates standing `metres` along leg `leg` of its tour:
 * 1 for right, -1 for left and 0 for none. The turn ahead is shown before the
 * one just taken, where a short leg puts the two close together.
 */
export function sideOn(tour: Tour, sides: Int8Array, driver: Driver, leg: number, metres: number): number {
  if (driver.indicates <= 0) return 0;
  const count = tour.edges.length;
  const end = leg + 1 < count ? (tour.startDistance[leg + 1] as number) : tour.length;
  const left = end - (tour.startDistance[leg] as number) - metres;
  const ahead = sides[leg] as number;
  if (ahead !== 0 && left <= driver.indicates) return ahead;
  if (metres < THROUGH) return sides[(leg + count - 1) % count] as number;
  return 0;
}

/**
 * True while a vehicle's lamp is lit at a moment, which may fall between two
 * ticks. Each vehicle flashes at its own phase, so a queue at a light does not
 * blink as one.
 */
export function blinkLit(id: number, time: number): boolean {
  return Math.floor((time + id * 7) / BLINK) % 2 === 0;
}

/** The indicators of a whole traffic, with the sides of each tour read once and kept. */
export class Indicators {
  private readonly traffic: AmbientTraffic;
  private readonly sides: (Int8Array | undefined)[];
  private readonly cursor: TrafficCursor = { id: 0, step: 0, into: 0 };

  constructor(traffic: AmbientTraffic) {
    this.traffic = traffic;
    this.sides = new Array<Int8Array | undefined>(traffic.vehicles.length);
  }

  /** The side a vehicle indicates at a moment of its tour, lit or not: 1 right, -1 left, 0 none. */
  sideAt(id: number, time: number): number {
    const vehicle = this.traffic.vehicles[id] as AmbientTraffic['vehicles'][number];
    const tour = vehicle.tour;
    let sides = this.sides[id];
    if (sides === undefined) {
      sides = turnSides(this.traffic.roads.graph, tour.edges);
      this.sides[id] = sides;
    }
    const cursor = this.traffic.cursorAt(id, time, this.cursor);
    return sideOn(tour, sides, vehicle.driver, tour.stepLeg[cursor.step] as number, this.traffic.metresOf(cursor));
  }

  /** The side whose lamps are lit at a moment: {@link sideAt} while the lamp is on, and 0 while it is dark. */
  litAt(id: number, time: number): number {
    const side = this.sideAt(id, time);
    return side !== 0 && blinkLit(id, time) ? side : 0;
  }
}
