/**
 * How the tram changes speed (spec section 13.2): it pulls away from a halt
 * gently, brakes into the next one, and slows for a corner.
 *
 * Two halves use this and must agree, as they do for the traffic
 * (`traffic-motion.ts`). `tram-timing.ts` asks {@link tramDriveTicks} how long
 * a drive takes with its ramps. {@link TramMotion} then drives each step along
 * a speed profile that covers the step's metres in its ticks exactly, so the
 * tram still starts and ends every step on the same metre and tick, and keeps
 * to the lights. The tram guard reads the front through the same profile.
 */
import { atan2 } from '../../core/libm.ts';
import type { Point } from '../../world/types.ts';
import type { RoadEdge, RoadGraph } from '../../world/roads/graph.ts';
import { TICK_RATE } from '../clock.ts';
import { legAt, type Tour } from '../traffic/traffic-timing.ts';
import { plateauOf, rampTicks, stepMotion, turnSpeed, type Plateau, type StepMotion } from '../traffic/traffic-motion.ts';

/**
 * Metres per second each second a tram gains pulling away and loses braking.
 * Less than a car's: people stand in a tram, and it is heavy.
 */
export const TRAM_ACCEL = 1.3;

/**
 * Metres either side of a node the tram's turn is read over. A tram is read at
 * its bogies, 7 m apart, so it takes a corner wider than a car does.
 */
const TURN_WINDOW = 8;

/** Metres of an edge's end the direction it leaves or arrives in is read over. */
const HEAD = 6;

/**
 * The speed the tram crosses from each run of its loop onto the next, in
 * metres per second: the slower of the two runs, and no faster than the
 * corner between them allows.
 */
export function tramJoins(graph: RoadGraph, route: readonly number[], speedOf: (edge: RoadEdge) => number): Float64Array {
  const count = route.length;
  const joins = new Float64Array(count);
  for (let leg = 0; leg < count; leg++) {
    const a = graph.edges[route[leg] as number] as RoadEdge;
    const b = graph.edges[route[(leg + 1) % count] as number] as RoadEdge;
    joins[leg] = Math.min(speedOf(a), speedOf(b), turnSpeed(bendOf(graph, a, b), TURN_WINDOW));
  }
  return joins;
}

/** Radians the road turns through from the end of run `a` onto the start of run `b`, 0 to π. */
export function bendOf(graph: RoadGraph, a: RoadEdge, b: RoadEdge): number {
  return Math.abs(wrap(headingOf(graph.edgePoints(b.id), true) - headingOf(graph.edgePoints(a.id), false)));
}

/** Ticks a drive of `metres` at up to `top` takes, entering at `enter` and leaving at `leave`. */
export function tramDriveTicks(metres: number, top: number, enter: number, leave: number): number {
  if (metres <= 0) return 0;
  return Math.ceil((metres / top) * TICK_RATE) + rampTicks(metres, top, enter, leave, TRAM_ACCEL);
}

/** Where the front of a tram is on its loop at a moment, along the speed profile of each step. */
export class TramMotion {
  private readonly tour: Tour;
  /** The speed the tram leaves each step at, which is the one it enters the next at. */
  private readonly ends: Float64Array;
  /** The plateau and ramp rate of each step, two to a step. */
  private readonly plateaus: Float64Array;
  private readonly plateau: Plateau = { top: 0, accel: 0 };
  private readonly motion: StepMotion = { share: 0, speed: 0 };

  /** `ends` is the speed each step of `tour` is left at, 0 into a halt, as `tram-timing.ts` timed it. */
  constructor(tour: Tour, ends: Float64Array) {
    this.tour = tour;
    this.ends = ends;
    const count = tour.stepTicks.length;
    // No step is left faster than the tram can brake from over the next one. Twice
    // round, since the loop closes on itself.
    for (let k = 2 * count - 1; k >= 0; k--) {
      const s = k % count;
      const n = (s + 1) % count;
      ends[s] = Math.min(ends[s] as number, Math.sqrt((ends[n] as number) ** 2 + 2 * TRAM_ACCEL * metresOf(tour, n)));
    }
    this.plateaus = new Float64Array(count * 2);
    for (let s = 0; s < count; s++) {
      plateauOf(metresOf(tour, s), tour.stepTicks[s] as number, this.enterOf(s), ends[s] as number, this.plateau, TRAM_ACCEL);
      this.plateaus[s * 2] = this.plateau.top;
      this.plateaus[s * 2 + 1] = this.plateau.accel;
    }
  }

  /** Metres round the loop the front stands at on a tick of the loop, which may fall between two. */
  frontAt(at: number): number {
    const step = legAt(this.tour.stepStart, at);
    const motion = this.stepAt(step, at - (this.tour.stepStart[step] as number));
    const from = this.tour.stepFrom[step] as number;
    return (this.tour.startDistance[this.tour.stepLeg[step] as number] as number) + from + motion.share * ((this.tour.stepTo[step] as number) - from);
  }

  /** Metres per second the tram is running at on a tick of the loop. */
  speedAt(at: number): number {
    const step = legAt(this.tour.stepStart, at);
    return this.stepAt(step, at - (this.tour.stepStart[step] as number)).speed;
  }

  /** The first tick of the loop on which the front is `distance` metres round it or further. */
  tickAt(distance: number): number {
    const tour = this.tour;
    const at = mod(distance, tour.length);
    const leg = legAt(tour.startDistance, at);
    const metres = at - (tour.startDistance[leg] as number);
    let fallback = 0;
    for (let s = 0; s < tour.stepLeg.length; s++) {
      if (tour.stepLeg[s] !== leg) continue;
      const from = tour.stepFrom[s] as number;
      const to = tour.stepTo[s] as number;
      if (to <= from) continue;
      fallback = tour.stepStart[s] as number;
      if (metres < from || metres >= to) continue;
      // The share of a step grows with the tick, so the first tick past it is found by halving.
      const want = (metres - from) / (to - from);
      let lo = 0;
      let hi = tour.stepTicks[s] as number;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.stepAt(s, mid).share < want) lo = mid + 1;
        else hi = mid;
      }
      return (tour.stepStart[s] as number) + lo;
    }
    return fallback;
  }

  private enterOf(step: number): number {
    const count = this.ends.length;
    return this.ends[(step + count - 1) % count] as number;
  }

  private stepAt(step: number, into: number): StepMotion {
    this.plateau.top = this.plateaus[step * 2] as number;
    this.plateau.accel = this.plateaus[step * 2 + 1] as number;
    const tour = this.tour;
    return stepMotion(metresOf(tour, step), tour.stepTicks[step] as number, into, this.enterOf(step), this.ends[step] as number, this.plateau, this.motion);
  }
}

/** The heading an edge's polyline arrives in at its end, or leaves in from its start. */
function headingOf(points: readonly Point[], start: boolean): number {
  const n = points.length;
  if (n < 2) return 0;
  let i = start ? 0 : n - 1;
  let j = i;
  // Walk in until the two points are far enough apart to give a direction.
  const a = points[i] as Point;
  for (let k = 1; k < n; k++) {
    j = start ? k : n - 1 - k;
    const b = points[j] as Point;
    if (Math.abs(b.x - a.x) + Math.abs(b.y - a.y) >= HEAD) break;
  }
  if (!start) [i, j] = [j, i];
  const from = points[i] as Point;
  const to = points[j] as Point;
  return atan2(to.y - from.y, to.x - from.x);
}

function metresOf(tour: Tour, step: number): number {
  return (tour.stepTo[step] as number) - (tour.stepFrom[step] as number);
}

/** An angle in radians brought into -π to π. */
function wrap(angle: number): number {
  return mod(angle + Math.PI, 2 * Math.PI) - Math.PI;
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}
