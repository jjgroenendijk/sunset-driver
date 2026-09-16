/**
 * Heat: what the player has done and how much of it the police remember
 * (spec section 14).
 *
 * Heat is one number on the record, and every crime adds to it a weight for
 * how bad the crime is. A punch barely registers; killing an officer escalates
 * hard. The HUD reads it as stars (`src/ui/hud.ts`) and `police.ts` reads it as
 * how many cars come and what kind.
 *
 * Heat only falls while nobody is looking. {@link decayHeat} is given the tick
 * the player was last in sight of a police unit: for {@link COOL_DELAY} ticks
 * after that nothing happens, and then the heat runs down at
 * {@link COOL_PER_SECOND}. That is the first of the two exits the spec allows.
 * The second one — destroying the pursuers — is the same rule reached another
 * way: a wrecked car sees nothing, so the cooling starts.
 *
 * Nothing here reads a clock or a random stream, so a replayed run cools at
 * exactly the same tick.
 */
import { TICK_RATE } from './clock.ts';

/** The most heat a player can draw, which is the stars the HUD has room for. */
export const HEAT_CAP = 6;

/** Ticks out of sight before the heat starts to fall: half a minute of hiding. */
export const COOL_DELAY = 20 * TICK_RATE;

/** Heat lost per second once the cooling has started. A full six stars runs out in a minute. */
export const COOL_PER_SECOND = 0.1;

/** A crime the police weigh (spec section 14). */
export type Crime =
  /** A punch or a kick at somebody on the street. */
  | 'brawl'
  /** Driving over the pavement, through a fence or into the traffic. */
  | 'reckless'
  /** Taking a car that is not yours. */
  | 'theft'
  /** Shooting at a person. */
  | 'assault'
  /** Killing a person. */
  | 'killing'
  /** Shooting at an officer. */
  | 'officerAssault'
  /** Killing an officer. */
  | 'officerKilling';

/**
 * What each crime adds to the heat. A brawl is a fifth of a star and a dead
 * officer is two and a half, so one killing takes a quiet player to three
 * stars and the helicopter.
 */
export const CRIME_HEAT: Record<Crime, number> = {
  brawl: 0.2,
  reckless: 0.3,
  theft: 1,
  assault: 0.8,
  killing: 1.6,
  officerAssault: 1.2,
  officerKilling: 2.5,
};

/** Raise the heat by an amount, never past {@link HEAT_CAP}. */
export function raiseHeat(heat: number, amount: number): number {
  return Math.min(HEAT_CAP, heat + Math.max(0, amount));
}

/** Raise the heat by what a crime is worth. */
export function heatForCrime(heat: number, crime: Crime): number {
  return raiseHeat(heat, CRIME_HEAT[crime]);
}

/**
 * The heat after one tick out of sight. `seenTick` is the last tick a police
 * unit saw the player, or a tick far in the past when none ever has; a player
 * in sight this tick keeps every point of it.
 */
export function decayHeat(heat: number, tick: number, seenTick: number): number {
  if (heat <= 0) return 0;
  if (tick - seenTick < COOL_DELAY) return heat;
  return Math.max(0, heat - COOL_PER_SECOND / TICK_RATE);
}

/** How many stars the heat reads as: what the escalation tables are keyed on. */
export function heatStars(heat: number): number {
  return Math.min(HEAT_CAP, Math.floor(heat));
}
