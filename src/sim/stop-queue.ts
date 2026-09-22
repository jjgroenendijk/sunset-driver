/**
 * The line of people waiting at a stop, and how it fills and empties.
 *
 * The tram (`tram.ts`) and the buses (`bus-stops.ts`) both stand people along
 * a pavement behind where the vehicle calls, and clear them as it boards them.
 * Neither is stepped, so nobody is ever counted on or off: the places of a
 * queue are laid down once for a world, and how many of them are filled on a
 * tick is read from the ticks since the last vehicle pulled away.
 *
 * A place is to the right of the direction of travel, facing the road: on the
 * pavement by default, or wherever the caller says. The heights are the road's
 * own plus {@link PAVEMENT_RISE}, which is where `pedestrian-route.ts` walks
 * the crowd.
 */
import { atan2 } from '../core/libm.ts';
import type { PedestrianLook } from './pedestrian-look.ts';
import { PAVEMENT_RISE, pavementOffset } from './pedestrian-route.ts';
import type { PedestrianPose } from './pedestrians.ts';
import { RouteSampler, type RouteLegs, type RoutePoint } from './route-sample.ts';

/** A person waiting at a stop. */
export interface WaitingPassenger {
  pose: PedestrianPose;
  look: PedestrianLook;
}

/** Somewhere people stand and wait for something that calls there: a tram stop or a bus stop. */
export interface WaitingCrowd {
  /** The people waiting inside a box on a tick, written into `out` from 0, and how many there are. */
  passengers(minX: number, minY: number, maxX: number, maxY: number, tick: number, out: WaitingPassenger[]): number;
}

/** Where the people of one stop stand: `x`, `y`, `height` and `heading` for each place in the queue. */
export interface StopQueue {
  places: Float64Array;
  looks: readonly PedestrianLook[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Stand one person per look along the pavement, the first `head` metres round
 * `route` and each next one `step` metres further back. `point` is scratch the
 * caller owns, so laying a queue allocates nothing but the queue.
 *
 * `across` is metres right of the centreline to stand them at, for a stop whose
 * people wait somewhere other than the pavement: the tram's island platform
 * (`render/tram-stops.ts`) rather than the kerb the buses call at.
 */
export function layQueue(
  sampler: RouteSampler,
  route: RouteLegs,
  head: number,
  step: number,
  looks: readonly PedestrianLook[],
  point: RoutePoint,
  across?: number,
): StopQueue {
  const places = new Float64Array(looks.length * 4);
  const queue: StopQueue = { places, looks, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < looks.length; i++) {
    const at = sampler.sample(route, head - i * step, point);
    const offset = across ?? pavementOffset(at.edge);
    const x = at.x + at.rightX * offset;
    const y = at.y + at.rightY * offset;
    places.set([x, y, at.height + PAVEMENT_RISE, atan2(-at.rightY, -at.rightX)], i * 4);
    queue.minX = Math.min(queue.minX, x);
    queue.minY = Math.min(queue.minY, y);
    queue.maxX = Math.max(queue.maxX, x);
    queue.maxY = Math.max(queue.maxY, y);
  }
  return queue;
}

/** True when a queue is far enough from a box that none of its people can be in it. */
export function queueMisses(queue: StopQueue, minX: number, minY: number, maxX: number, maxY: number): boolean {
  return queue.maxX < minX || queue.minX > maxX || queue.maxY < minY || queue.minY > maxY;
}

/**
 * Write the first `people` of a queue into `out` from `count` on, and give back
 * how many `out` now holds. Entries already in `out` are written over rather
 * than replaced, so a frame allocates nothing.
 *
 * `moved` is how far each of them has walked towards the place in front of
 * them, 0 where the queue stands still and 1 where everyone has taken a whole
 * step. It is what makes a queue move up as a tram boards it rather than simply
 * losing people off its head.
 */
export function writeQueue(queue: StopQueue, people: number, out: WaitingPassenger[], count: number, moved = 0): number {
  let at = count;
  for (let i = 0; i < people; i++) {
    const entry = out[at] ?? { pose: { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' }, look: queue.looks[i] as PedestrianLook };
    const p = entry.pose;
    p.x = towards(queue, i, 0, moved);
    p.y = towards(queue, i, 1, moved);
    p.height = towards(queue, i, 2, moved);
    p.heading = queue.places[i * 4 + 3] as number;
    p.speed = 0;
    p.cycle = 0;
    p.gait = moved > 0 ? 'amble' : 'stand';
    entry.look = queue.looks[i] as PedestrianLook;
    out[at++] = entry;
  }
  return at;
}

/**
 * One field of the place person `i` stands at, `moved` of the way towards the
 * place in front of them. The person at the head has nobody in front, so they
 * walk on by the same step again, which is towards the door.
 */
function towards(queue: StopQueue, i: number, field: number, moved: number): number {
  const here = queue.places[i * 4 + field] as number;
  if (moved <= 0) return here;
  const ahead = i > 0 ? (queue.places[(i - 1) * 4 + field] as number) : 2 * here - (queue.places[4 + field] as number);
  return here + (ahead - here) * moved;
}

/**
 * How many people stand at a stop: everyone who has come to it in the `since`
 * ticks a vehicle last pulled away from it, up to `cap`, less those already
 * aboard the one standing there now. `boarding` is ticks into that halt, or -1
 * where the kerb is clear; `board` is the ticks the whole queue takes to board.
 */
export function waitingAt(since: number, boarding: number, board: number, cap: number, arrival: number): number {
  if (boarding < 0) return gathered(since, cap, arrival);
  return Math.ceil(gathered(since - boarding, cap, arrival) * Math.max(0, 1 - boarding / board));
}

/** People who have come to a stop in the ticks since the last vehicle left it. */
function gathered(ticks: number, cap: number, arrival: number): number {
  return Math.min(cap, Math.floor(Math.max(0, ticks) / arrival));
}
