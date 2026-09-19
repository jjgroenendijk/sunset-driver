/**
 * The path each round took (spec section 11.6), kept for the frames that draw
 * it.
 *
 * `gunfire.ts` casts a ray per pellet and writes where it started and where it
 * stopped through {@link markTracer}. It is part of the record for the reason
 * the blows of `melee.ts` are: the readers are not the simulation, and they
 * read it a frame later. `src/render/shot-fx.ts` draws the flash, the streak
 * and the burst where the round landed; `src/ui/crosshair.ts` shows a hit
 * marker. Both read every tracer newer than the tick they last read.
 */
import type { HitSurface } from './melee.ts';

/** What a round met, or `none` where it ran out of range. */
export type TracerEnd = HitSurface | 'none';

/** One round, as the record carries it. */
export interface Tracer {
  /** The tick it was fired on. */
  tick: number;
  /** The pellet of its shot, counted from 0. Only the first throws a muzzle flash. */
  pellet: number;
  /** The muzzle, in map metres with `h` above sea level. */
  x: number;
  y: number;
  h: number;
  /** Where it stopped. */
  ex: number;
  ey: number;
  eh: number;
  end: TracerEnd;
  /**
   * Who fired it: the player, or an officer (`officer-fire.ts`). The camera
   * kicks and the crosshair marks a hit only for the player's own.
   */
  by: 'player' | 'police';
}

/** Ticks a tracer is remembered for, as long as a blow of `melee.ts` is. */
export const TRACER_MEMORY = 20;

/** Tracers the record holds at once: a few shotgun blasts' worth. */
export const TRACER_CAP = 32;

/** Keep a round's path, dropping the oldest when the record is full. */
export function markTracer(tracers: Tracer[], tracer: Tracer): void {
  tracers.push(tracer);
  if (tracers.length > TRACER_CAP) tracers.splice(0, tracers.length - TRACER_CAP);
}

/** Forget the tracers older than {@link TRACER_MEMORY} ticks. Called once a tick. */
export function forgetTracers(tracers: Tracer[], tick: number): void {
  let keep = 0;
  while (keep < tracers.length && tick - (tracers[keep] as Tracer).tick >= TRACER_MEMORY) keep++;
  if (keep > 0) tracers.splice(0, keep);
}

/** True where a round met somebody or something a player shoots at on purpose. */
export function struck(end: TracerEnd): boolean {
  return end === 'person' || end === 'vehicle';
}
