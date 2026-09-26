/**
 * What giving way (`give-way.ts`) knows of one tick round the player: each
 * car of the traffic and each person of the crowd in the box, and what they
 * stop for. The files that decide a part of the tick — `swerve.ts` for the
 * cars that steer round something, `detour.ts` for the people who walk round
 * it — read the same records.
 */
import type { Swerve } from './hold.ts';
import type { Footprint } from './traffic.ts';

/** What a car stopped for, where it is not a car of the traffic. */
export const FREE = -1;
export const OTHER = -2;
export const PERSON = -3;
export const LIGHT = -4;

/** A car does not stop for one it meets head on: that one is in the other lane. */
export const HEAD_ON = -0.5;

/** Metres per second under which something counts as standing. */
export const STANDING = 0.5;

/** One car of the traffic in the box, for one tick. */
export interface Car {
  id: number;
  lag: number;
  waited: number;
  /** Where it stands, swerve and all. */
  box: Footprint;
  /** The cosine and sine of the box's heading. */
  cos: number;
  sin: number;
  speed: number;
  /** The middle of its lane where it stands, and the cosine and sine of the lane's heading. */
  laneX: number;
  laneY: number;
  laneCos: number;
  laneSin: number;
  /** True where its tour stands it still: at a light, in a queue or at a stop. */
  waiting: boolean;
  /** How far off its lane it steers, or undefined for a car on its lane. */
  swerve: Swerve | undefined;
  /** What it stops for: the index of a car, or one of the kinds above. */
  blocker: number;
  /** The index of the person it stops for, or -1. */
  person: number;
  stop: boolean;
  slow: boolean;
  /** True when it waits at the mouth of a junction without lights, which a ring never releases it from. */
  yields: boolean;
  /** True when the player, their car or a wreck stands in the lane ahead. */
  facing: boolean;
  next: Footprint;
  /** The cosine and sine of the next footprint's heading. */
  nextCos: number;
  nextSin: number;
  nextSpeed: number;
}

/** One person of the crowd in the box, for one tick. */
export interface Person {
  id: number;
  /** False for someone off their loop: frightened, they go where the fright takes them. */
  walking: boolean;
  lag: number;
  waited: number;
  x: number;
  y: number;
  height: number;
  /** The heading they walk at, and their speed: 0 while they stand. */
  heading: number;
  speed: number;
  /** Metres east and north they stand off their loop, keeping out of a car's way (`detour.ts`). */
  dodgeX: number;
  dodgeY: number;
  nextX: number;
  nextY: number;
  held: boolean;
  /** What they stand for: the index of a car, {@link OTHER}, or {@link FREE}. */
  by: number;
}

/** The side of a car that stands off its lane, 0 for one on it. */
export function sideOf(car: Car): number {
  return car.swerve?.side ?? 0;
}
