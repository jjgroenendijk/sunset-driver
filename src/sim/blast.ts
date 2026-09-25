/**
 * Where a projectile went off (spec section 11.6), kept for the frames that
 * draw it and the mix that plays it.
 *
 * `gunfire.ts` sets a grenade, a rocket or a Molotov off and writes the burst
 * here through {@link markBlast}. It is part of the record for the reason the
 * tracers of `tracer.ts` are: the readers are not the simulation, and they
 * read it a frame later. `src/render/weapon-fx.ts` throws the fireball, the
 * flames or the cloud, and `src/audio/plan.ts` plays the bang. Both read every
 * burst newer than the tick they last read.
 */
import type { WeaponId } from './weapon.ts';

/** One burst, as the record carries it. */
export interface Blast {
  /** The tick it went off on. */
  tick: number;
  /** Where it went off, in map metres with `h` above sea level. */
  x: number;
  y: number;
  h: number;
  /** The weapon that threw it, which says what the burst looks and sounds like. */
  weapon: WeaponId;
  /** Metres the burst is felt over. */
  radius: number;
}

/** Ticks a burst is remembered for: long enough for a frame after a stall to see it. */
const BLAST_MEMORY = 30;

/** Bursts the record holds at once. */
export const BLAST_CAP = 16;

/** Keep a burst, dropping the oldest when the record is full. */
export function markBlast(blasts: Blast[], blast: Blast): void {
  blasts.push(blast);
  if (blasts.length > BLAST_CAP) blasts.splice(0, blasts.length - BLAST_CAP);
}

/** Forget the bursts older than {@link BLAST_MEMORY} ticks. Called once a tick. */
export function forgetBlasts(blasts: Blast[], tick: number): void {
  let keep = 0;
  while (keep < blasts.length && tick - (blasts[keep] as Blast).tick >= BLAST_MEMORY) keep++;
  if (keep > 0) blasts.splice(0, keep);
}
