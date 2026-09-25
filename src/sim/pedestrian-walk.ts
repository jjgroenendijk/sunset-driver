/**
 * When a pedestrian walks and when they stand (spec sections 13.1 and 20.1).
 *
 * A loop of pavement (`pedestrian-route.ts`) is walked as a list of steps, the
 * way a vehicle's tour is driven in `traffic-timing.ts`. A step walks from one
 * distance round the loop to another in a whole number of ticks, or stands at
 * one. A person stands for three reasons:
 *
 * - The light. At a crossing under traffic lights (`pedestrian-crossing.ts`)
 *   they wait at the kerb until the crossing opens.
 * - A pause of their own: a call on the phone, a cigarette, a look in a shop
 *   window, or a visit through a door, where they step off the pavement and
 *   are gone until they come back out.
 * - The lap. A light is a function of the tick, so a walk that waits for one
 *   agrees with it for ever only when the lap is a whole number of signal
 *   cycles. The walk after the last light is slowed a little, and what is
 *   still missing is spent standing at the end of the lap.
 *
 * A step that walks is taken at the person's own pace, or faster over a
 * jaywalker's slant across a road. The walk cycle is read from the distance,
 * never from the tick, so it stands still while the person does and comes
 * round with the loop.
 */
import type { Rng } from '../core/rng.ts';
import { TIERS } from '../world/tiers.ts';
import type { RoadEdge, RoadGraph } from '../world/graph.ts';
import type { Zone } from '../world/types.ts';
import { TICK_RATE } from './clock.ts';
import type { Crossing } from './pedestrian-crossing.ts';
import type { Gait } from './pedestrian-look.ts';
import type { WalkRoute } from './pedestrian-route.ts';
import { SIGNAL_CYCLE, type TrafficSignals } from './signals.ts';

/** What a step does. */
const WALK = 0;
/** Waits at the kerb for the light. */
export const KERB = 1;
/** Stands in their lane: a call, a cigarette, a wait. */
export const PAUSE = 2;
/** Steps sideways off their lane, to a shop window or a door. */
export const STEP_IN = 3;
/** Stands at the window. */
export const LINGER = 4;
/** Is inside, and is not drawn. */
export const INSIDE = 5;
/** Steps back from the window or the door into their lane. */
export const STEP_OUT = 6;
/** Walks faster: over a jaywalker's slant. */
export const HURRY = 7;

/** The gaits a standing step can take, by the index a plan stores. */
export const IDLES: readonly Gait[] = ['stand', 'phone', 'smoke', 'window', 'fold', 'talk'];

/** How much faster than their own pace a jaywalker crosses. */
const HURRY_PACE = 1.9;

/** The most the walk after the last light is slowed by to close a lap: this share of its time. */
const STRETCH = 0.35;

/** Seconds a sideways step to a window or a door takes. */
const STEP_SECONDS = 1.4;

/** Metres of pavement a pause needs on each side of it before a corner. */
const PAUSE_ROOM = 12;

/** How often a person pauses on one leg of their loop, by zone. */
const PAUSE_CHANCE: Record<Zone, number> = {
  core: 0.16,
  inner: 0.18,
  industrial: 0.1,
  suburban: 0.12,
  outskirts: 0.08,
  wilderness: 0.05,
};

/** The pauses of a zone: how often each comes up, and the least and most seconds it lasts. */
interface PauseKind {
  kind: typeof PAUSE | typeof LINGER | typeof INSIDE;
  idle: number;
  seconds: readonly [number, number];
  weight: Partial<Record<Zone, number>>;
}

const PAUSES: readonly PauseKind[] = [
  { kind: PAUSE, idle: 1, seconds: [8, 25], weight: { core: 3, inner: 3, industrial: 2, suburban: 2, outskirts: 1, wilderness: 1 } },
  { kind: PAUSE, idle: 2, seconds: [20, 50], weight: { core: 1, inner: 2, industrial: 3, suburban: 1, outskirts: 1 } },
  { kind: PAUSE, idle: 4, seconds: [6, 18], weight: { core: 1, inner: 1, industrial: 1, suburban: 1, outskirts: 1, wilderness: 1 } },
  { kind: LINGER, idle: 3, seconds: [4, 12], weight: { core: 3, inner: 3, suburban: 1 } },
  { kind: INSIDE, idle: 0, seconds: [20, 90], weight: { core: 3, inner: 2, suburban: 1 } },
];

/** A person's walk round their loop, step by step. */
export interface WalkPlan {
  /** The tick of the loop each step starts on, and how many it takes: at least one. */
  start: Int32Array;
  ticks: Int32Array;
  /** Metres round the loop each step starts and ends at; the same for one that stands. */
  from: Float64Array;
  to: Float64Array;
  /** What each step does: {@link WALK} and the rest. */
  kind: Uint8Array;
  /** The gait a standing step takes, as an index into {@link IDLES}. */
  idle: Uint8Array;
  /** Metres right of their lane a step stands at, or steps to or back from. */
  aside: Float32Array;
  /** Ticks once round. */
  period: number;
  /** Metres one walk cycle covers, which goes a whole number of times into the loop. */
  stride: number;
}

/** A pause a person makes, before it is laid into a plan. */
export interface Stop {
  /** Metres round the loop. */
  at: number;
  kind: typeof PAUSE | typeof LINGER | typeof INSIDE;
  ticks: number;
  idle: number;
  /** Metres right of the lane the window or the door stands at. */
  aside: number;
}

/** What a plan is laid down from. */
export interface PlanInput {
  route: WalkRoute;
  /** Metres a second. */
  pace: number;
  /** Metres of one walk cycle at the person's own gait and height. */
  stride: number;
  crossings: readonly Crossing[];
  stops: readonly Stop[];
  signals?: TrafficSignals;
  /** The tick of the signal cycle that tick 0 of the loop falls on. */
  sync: number;
}

/** Where a person is in their plan at a moment of their loop. */
export interface PlanPoint {
  step: number;
  /** Ticks into the step, which may fall between two. */
  into: number;
  /** Metres round the loop. */
  distance: number;
}

/** Lay a walk down: the steps of one lap and the ticks it takes. */
export function planWalk(input: PlanInput): WalkPlan {
  const { route, pace, crossings, stops, signals, sync } = input;
  const steps = new PlanBuilder(pace);
  const hurries = hurriesOf(route);
  let d = 0;
  let lastLight = -1;
  let c = 0;
  let s = 0;
  while (c < crossings.length || s < stops.length) {
    const crossing = crossings[c];
    const stop = stops[s];
    if (crossing !== undefined && (stop === undefined || crossing.at <= stop.at)) {
      c++;
      // A crossing met twice, or inside a stretch already walked, is not waited at again.
      if (crossing.at < d || signals === undefined) continue;
      steps.walkTo(d, crossing.at, hurries);
      d = crossing.at;
      const need = Math.round(((crossing.end - crossing.at + route.length) % route.length) / pace * TICK_RATE);
      const wait = signals.crossingWait(crossing.junction, crossing.axis, sync + steps.time, need);
      if (wait > 0) steps.stand(KERB, d, wait, 0, 0);
      lastLight = steps.count;
      continue;
    }
    s++;
    if (stop === undefined || stop.at < d) continue;
    steps.walkTo(d, stop.at, hurries);
    d = stop.at;
    if (stop.kind === PAUSE) {
      steps.stand(PAUSE, d, stop.ticks, stop.idle, 0);
    } else {
      const side = Math.round(STEP_SECONDS * TICK_RATE);
      steps.stand(STEP_IN, d, side, 0, stop.aside);
      steps.stand(stop.kind, d, stop.ticks, stop.idle, stop.aside);
      steps.stand(STEP_OUT, d, side, 0, stop.aside);
    }
  }
  steps.walkTo(d, route.length, hurries);
  if (lastLight >= 0) steps.closeLap(lastLight, route.length);
  const strides = Math.max(1, Math.round(route.length / input.stride));
  return steps.build(route.length / strides);
}

/** The step a moment of the loop falls in, how far into it, and the distance round the loop there. */
export function planAt(plan: WalkPlan, at: number, out: PlanPoint): PlanPoint {
  const start = plan.start;
  let lo = 0;
  let hi = start.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((start[mid] as number) <= at) lo = mid;
    else hi = mid - 1;
  }
  const into = at - (start[lo] as number);
  const from = plan.from[lo] as number;
  const f = Math.min(1, into / (plan.ticks[lo] as number));
  out.step = lo;
  out.into = into;
  out.distance = from + ((plan.to[lo] as number) - from) * f;
  return out;
}

/** True for a step that moves the person along the loop. */
export function walks(kind: number): boolean {
  return kind === WALK || kind === HURRY;
}

/**
 * The pauses a person makes round their loop, drawn from their stream. A leg's
 * pause stands in the middle of its pavement, clear of both corners, and a
 * window or a door stands at the edge of the pavement away from the road.
 */
export function stopsOf(graph: RoadGraph, route: WalkRoute, zone: Zone, rng: Rng): Stop[] {
  const stops: Stop[] = [];
  const chance = PAUSE_CHANCE[zone];
  for (let i = 0; i < route.edges.length; i++) {
    const room = (route.toCorner[i] as number) - (route.start[i] as number);
    if (route.jay[i] === 1 || room < 2 * PAUSE_ROOM || !rng.chance(chance)) continue;
    const pause = pickPause(zone, rng);
    if (pause === undefined) continue;
    const at = (route.start[i] as number) + rng.range(PAUSE_ROOM, room - PAUSE_ROOM);
    const edge = graph.edges[route.edges[i] as number] as RoadEdge;
    const side = route.sides[i] as number;
    // The far edge of the pavement from the road, from the lane they walk; a door is a step past it.
    const edgeOf = (side * TIERS[edge.tier].pavement) / 2 - route.shift;
    // Inside is a step past the edge; at a window they stand a little short of it.
    const aside = pause.kind === INSIDE ? edgeOf + side * 0.45 : edgeOf - side * 0.5;
    const ticks = Math.round(rng.range(pause.seconds[0], pause.seconds[1]) * TICK_RATE);
    stops.push({ at, kind: pause.kind, ticks, idle: pause.idle, aside });
  }
  return stops;
}

function pickPause(zone: Zone, rng: Rng): PauseKind | undefined {
  let total = 0;
  for (const pause of PAUSES) total += pause.weight[zone] ?? 0;
  if (total <= 0) return undefined;
  let pick = rng.float() * total;
  for (const pause of PAUSES) {
    pick -= pause.weight[zone] ?? 0;
    if (pick < 0) return pause;
  }
  return undefined;
}

/** The stretches round a loop a jaywalker crosses a road on, as pairs of distances. */
function hurriesOf(route: WalkRoute): number[] {
  const out: number[] = [];
  for (let i = 0; i < route.edges.length; i++) {
    if (route.jay[i] !== 1) continue;
    const next = (i + 1) % route.edges.length;
    out.push(route.toCorner[i] as number, next === 0 ? route.length : (route.start[next] as number));
  }
  return out;
}

/** The steps of a plan while they are laid down. */
class PlanBuilder {
  readonly start: number[] = [];
  readonly ticks: number[] = [];
  readonly from: number[] = [];
  readonly to: number[] = [];
  readonly kind: number[] = [];
  readonly idle: number[] = [];
  readonly aside: number[] = [];
  time = 0;
  private readonly pace: number;

  constructor(pace: number) {
    this.pace = pace;
  }

  get count(): number {
    return this.kind.length;
  }

  /** Walk from one distance to another, faster over any slant across a road on the way. */
  walkTo(from: number, to: number, hurries: readonly number[]): void {
    let d = from;
    for (let h = 0; h < hurries.length; h += 2) {
      const a = hurries[h] as number;
      const b = hurries[h + 1] as number;
      if (b <= d || a >= to) continue;
      if (a > d) this.walk(WALK, d, a);
      this.walk(HURRY, Math.max(a, d), Math.min(b, to));
      d = Math.min(b, to);
    }
    if (to > d) this.walk(WALK, d, to);
  }

  stand(kind: number, at: number, ticks: number, idle: number, aside: number): void {
    this.push(kind, at, at, Math.max(1, ticks), idle, aside);
  }

  /**
   * Make the lap a whole number of signal cycles: stretch the walks after the
   * last light by up to {@link STRETCH} of their time, then stand at the end
   * of the lap for the rest. Nothing before the last light moves, so every
   * light is still met on the tick it was timed for.
   */
  closeLap(after: number, length: number): void {
    let pad = (SIGNAL_CYCLE - (this.time % SIGNAL_CYCLE)) % SIGNAL_CYCLE;
    if (pad === 0) return;
    const walking: number[] = [];
    let walked = 0;
    for (let i = after; i < this.count; i++) {
      if (this.kind[i] !== WALK) continue;
      walking.push(i);
      walked += this.ticks[i] as number;
    }
    const stretch = Math.min(pad, Math.floor(walked * STRETCH));
    let left = stretch;
    for (const i of walking) {
      const add = Math.min(left, Math.floor(((this.ticks[i] as number) * stretch) / walked));
      this.ticks[i] = (this.ticks[i] as number) + add;
      left -= add;
    }
    pad -= stretch - left;
    if (pad > 0) this.stand(PAUSE, length, pad, 0, 0);
    let t = 0;
    for (let i = 0; i < this.count; i++) {
      this.start[i] = t;
      t += this.ticks[i] as number;
    }
    this.time = t;
  }

  build(stride: number): WalkPlan {
    if (this.count === 0) this.stand(PAUSE, 0, 1, 0, 0);
    return {
      start: Int32Array.from(this.start),
      ticks: Int32Array.from(this.ticks),
      from: Float64Array.from(this.from),
      to: Float64Array.from(this.to),
      kind: Uint8Array.from(this.kind),
      idle: Uint8Array.from(this.idle),
      aside: Float32Array.from(this.aside),
      period: this.time,
      stride,
    };
  }

  private walk(kind: number, from: number, to: number): void {
    const pace = kind === HURRY ? this.pace * HURRY_PACE : this.pace;
    this.push(kind, from, to, Math.max(1, Math.round(((to - from) / pace) * TICK_RATE)), 0, 0);
  }

  private push(kind: number, from: number, to: number, ticks: number, idle: number, aside: number): void {
    this.start.push(this.time);
    this.ticks.push(ticks);
    this.from.push(from);
    this.to.push(to);
    this.kind.push(kind);
    this.idle.push(idle);
    this.aside.push(aside);
    this.time += ticks;
  }
}
