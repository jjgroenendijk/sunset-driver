/**
 * How an ambient vehicle changes speed (spec section 13.1): it pulls away from
 * rest, brakes into a halt, and slows for a turn and speeds up out of it.
 *
 * Two halves use this and must agree. `traffic-timing.ts` asks
 * {@link rampTicks} how many ticks the speed changes at the ends of a drive
 * add to it, and lays the drive down that much longer. `traffic.ts` then drives
 * each step along a speed profile ({@link stepMotion}) that covers the step's
 * metres in its ticks exactly. The vehicle still starts and ends every step on
 * the same metre and tick, so the lights, the queues and the lap are kept.
 *
 * A profile is a trapezoid: the speed changes at {@link ACCEL} from the speed
 * the vehicle enters the step at to a plateau, holds, and changes again to the
 * speed it leaves at. The plateau is the speed that covers the step in its
 * ticks. That is the driver's cruising speed on a drive timed with its ramps,
 * and less on one the timing slowed to reach a light on red.
 */
import { cos } from '../../core/libm.ts';
import type { RoadGraph } from '../../world/roads/graph.ts';
import { TICK_RATE } from '../clock.ts';
import type { Tour } from './traffic-timing.ts';

/** Metres per second each second a vehicle gains pulling away and loses braking. */
export const ACCEL = 2.5;

/** Metres per second squared a vehicle takes sideways in a turn: a calm driver's. */
const LATERAL = 2.5;

/** The slowest a vehicle takes any turn, a U-turn included, in metres per second. */
const TURN_FLOOR = 2;

/** A speed an end of a drive does not hold the vehicle to: it runs through at the plateau. */
export const FREE = Infinity;

/** Where in its step a vehicle is: the share of the step's metres behind it, and its speed. */
export interface StepMotion {
  share: number;
  /** Metres per second. */
  speed: number;
}

/** The plateau of one step's profile and the rate its ramps change speed at. */
export interface Plateau {
  top: number;
  accel: number;
}

/**
 * The fastest a vehicle takes a turn through `angle` radians, when its pose is
 * smoothed over `window` metres either side. Averaging a corner over that
 * window draws a curve whose tightest bend has a curvature of
 * `sin(θ/2) / (window · cos²(θ/2))`; the speed is the one that holds the
 * sideways pull there to {@link LATERAL}. {@link FREE} for no turn at all.
 */
export function turnSpeed(angle: number, window: number): number {
  const half = cos(angle / 2);
  const curvature = Math.sqrt(Math.max(0, 1 - half * half)) / (window * Math.max(1e-6, half * half));
  if (curvature <= 0) return FREE;
  return Math.max(TURN_FLOOR, Math.sqrt(LATERAL / curvature));
}

/**
 * Ticks a drive of `metres` takes on top of driving it all at `top`, when it
 * enters at `enter` and leaves at `leave` metres per second. Both are capped at
 * `top`. A drive too short to reach `top` peaks lower. `rate` is the
 * acceleration: {@link ACCEL} for a car, less for a tram.
 */
export function rampTicks(metres: number, top: number, enter: number, leave: number, rate = ACCEL): number {
  if (metres <= 0 || top <= 0) return 0;
  if (Math.min(enter, leave) >= top) return 0;
  // Neither end faster than the other end reaches over the drive, as `throughSpeed` holds them.
  const vs = Math.min(enter, top, Math.sqrt(Math.min(leave, top) ** 2 + 2 * rate * metres));
  const ve = Math.min(leave, top, Math.sqrt(vs * vs + 2 * rate * metres));
  const ramps = (2 * top * top - vs * vs - ve * ve) / (2 * rate);
  let seconds: number;
  if (ramps <= metres) {
    seconds = metres / top + ((top - vs) ** 2 + (top - ve) ** 2) / (2 * rate * top);
  } else {
    const peak = Math.sqrt(rate * metres + (vs * vs + ve * ve) / 2);
    seconds = peak < Math.max(vs, ve) ? (2 * metres) / (vs + ve) : (2 * peak - vs - ve) / rate;
  }
  return Math.max(0, Math.ceil((seconds - metres / top) * TICK_RATE - 1e-9));
}

/**
 * The speed a vehicle crosses a point inside one leg at, where one drive over
 * it ends and the next begins: its cruising speed `top`, but no faster than it
 * can reach from `enter` in the `before` metres behind, or brake down to
 * `leave` from in the `after` metres ahead.
 */
export function throughSpeed(top: number, enter: number, before: number, leave: number, after: number, rate = ACCEL): number {
  const e = Math.min(enter, top);
  const l = Math.min(leave, top);
  return Math.min(top, Math.sqrt(e * e + 2 * rate * before), Math.sqrt(l * l + 2 * rate * after));
}

/**
 * The speed a vehicle has at the end of each step of its tour, in metres per
 * second, which is the speed it starts the next one at. It is 0 into and out
 * of a wait. Between two legs it is the cruising speed of the slower road, and
 * no faster than the turn between them allows (`tour.turns`) or than a drive
 * slowed to reach a light on red is driven at. Either way it is
 * then held to {@link throughSpeed}, so the vehicle starts braking for a halt
 * just past a join before it reaches the join. Inside one leg that is the speed
 * `traffic-timing.ts` timed the two drives at.
 */
export function endSpeeds(tour: Tour, graph: RoadGraph, cruise: number): Float64Array {
  const count = tour.stepTicks.length;
  const out = new Float64Array(count);
  const top = (step: number): number => (graph.edges[tour.edges[tour.stepLeg[step] as number] as number] as RoadGraph['edges'][number]).speedLimit * cruise;
  for (let s = 0; s < count; s++) {
    const n = (s + 1) % count;
    if (isWait(tour, s) || isWait(tour, n)) continue;
    let speed = Math.min(top(s), top(n));
    if (tour.stepLeg[s] !== tour.stepLeg[n]) speed = Math.min(speed, tour.turns[tour.stepLeg[s] as number] as number);
    // A drive the timing slowed, to reach a light on red, is driven slowly
    // throughout: neither end faster than half of it can change speed to its
    // mean from.
    out[s] = Math.min(speed, slowEnd(tour, s), slowEnd(tour, n));
  }
  for (let s = 0; s < count; s++) {
    const n = (s + 1) % count;
    if (out[s] === 0) continue;
    const enter = out[(s + count - 1) % count] as number;
    out[s] = throughSpeed(out[s] as number, enter, metresOf(tour, s), out[n] as number, metresOf(tour, n));
  }
  return out;
}

/**
 * The plateau that covers `metres` in `ticks` from `enter` to `leave` metres
 * per second. The distance a profile covers grows with its plateau, so it is
 * found by halving. Where no plateau fits at `rate`, {@link ACCEL} unless the
 * caller says, the ramps are made harder until one does.
 */
export function plateauOf(metres: number, ticks: number, enter: number, leave: number, out: Plateau, rate = ACCEL): Plateau {
  const span = ticks / TICK_RATE;
  let accel = rate;
  for (let tries = 0; tries < 40; tries++) {
    // The plateaus whose two ramps fit in the step.
    const lo = Math.max(0, (enter + leave - accel * span) / 2);
    const hi = (enter + leave + accel * span) / 2;
    const fits = Math.abs(leave - enter) <= accel * span;
    if (fits && lo <= hi && covered(lo, span, enter, leave, accel) <= metres && covered(hi, span, enter, leave, accel) >= metres) {
      let a = lo;
      let b = hi;
      for (let i = 0; i < 48; i++) {
        const mid = (a + b) / 2;
        if (covered(mid, span, enter, leave, accel) < metres) a = mid;
        else b = mid;
      }
      out.top = (a + b) / 2;
      out.accel = accel;
      return out;
    }
    accel *= 1.5;
  }
  out.top = metres / span;
  out.accel = Infinity;
  return out;
}

/** Metres a profile with plateau `top` covers in `span` seconds. */
function covered(top: number, span: number, enter: number, leave: number, accel: number): number {
  const rise = Math.abs(top - enter) / accel;
  const fall = Math.abs(top - leave) / accel;
  return ((enter + top) / 2) * rise + ((leave + top) / 2) * fall + top * Math.max(0, span - rise - fall);
}

/**
 * The share of a step's `metres` a vehicle has driven `into` ticks of its
 * `ticks`, and its speed there, along the profile of `plateau`.
 */
export function stepMotion(metres: number, ticks: number, into: number, enter: number, leave: number, plateau: Plateau, out: StepMotion): StepMotion {
  if (metres <= 0) {
    out.share = 0;
    out.speed = 0;
    return out;
  }
  const { top, accel } = plateau;
  const span = ticks / TICK_RATE;
  const t = into / TICK_RATE;
  if (accel === Infinity) {
    out.share = Math.min(1, Math.max(0, into / ticks));
    out.speed = top;
    return out;
  }
  const rise = Math.abs(top - enter) / accel;
  const fall = Math.abs(top - leave) / accel;
  const up = top >= enter ? accel : -accel;
  const down = top >= leave ? accel : -accel;
  let driven: number;
  if (t <= rise) {
    driven = enter * t + (up * t * t) / 2;
    out.speed = enter + up * t;
  } else if (t < span - fall) {
    driven = enter * rise + (up * rise * rise) / 2 + top * (t - rise);
    out.speed = top;
  } else {
    const left = Math.max(0, span - t);
    driven = metres - (leave * left + (down * left * left) / 2);
    out.speed = leave + down * left;
  }
  out.share = Math.min(1, Math.max(0, driven / metres));
  out.speed = Math.max(0, out.speed);
  return out;
}

/** The fastest an end of a drive may be for half the drive to change speed to its mean. */
function slowEnd(tour: Tour, step: number): number {
  const metres = metresOf(tour, step);
  const mean = (metres / (tour.stepTicks[step] as number)) * TICK_RATE;
  return Math.sqrt(mean * mean + ACCEL * metres);
}

/** Metres a step of a tour drives. */
function metresOf(tour: Tour, step: number): number {
  return (tour.stepTo[step] as number) - (tour.stepFrom[step] as number);
}

/** True when a step of a tour stands still. */
function isWait(tour: Tour, step: number): boolean {
  return tour.stepFrom[step] === tour.stepTo[step];
}
