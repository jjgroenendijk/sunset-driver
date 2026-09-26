/**
 * How the crowd answers what the player does (spec section 20.1).
 *
 * `pedestrians.ts` holds the crowd and the fright itself: `startle` takes the
 * people near a place off their loops and `releaseFar` gives them back. This
 * says what is worth reacting to and how far each thing carries — a gun going
 * off, a blast, a car among the people on the pavement, a crash to ring and
 * watch.
 *
 * Every reaction is a function of the record and the tick, so a replay frights
 * the same people in the same places. Nothing here reads wall-clock, and the
 * only randomness is the stream `startle` draws its scatter from.
 *
 * Two callers: `gunfire.ts` calls {@link crowdHearsShot} and
 * {@link crowdFeelsBlast} on the tick the weapon goes off, and `physics.ts`
 * calls {@link stepCrowdReactions} once a tick with the crash the player's car
 * has just taken. Everything else the step reads off the record itself.
 */
import { hypot } from '../../core/libm.ts';
import type { CrowdSource } from '../weapons/melee.ts';
import { releaseFar } from './pedestrians.ts';
import type { SimState } from '../simulation.ts';

/** Metres a gunshot empties the pavement around the muzzle. */
export const SHOT_REACH = 32;

/**
 * How much wider than the blast itself the fright is. A blast is felt as
 * damage only inside its radius, but it is heard well beyond one.
 */
export const BLAST_FRIGHT = 2.5;

/**
 * Metres from the middle of a car that people jump clear of it. A car in its
 * lane is further than this from the pavement, so it is the car that has
 * mounted the kerb or is scraping it that scatters anybody.
 */
export const CAR_REACH = 3.5;

/** Metres a second a car has to be doing before anyone gets out of its way. */
export const CAR_SPEED = 5;

/**
 * The severity of a crash people react to at all, on the scale `damage.ts`
 * measures one in. Below this it is a scrape and nobody looks up.
 */
export const CRASH_SEVERITY = 0.5;

/** Metres of a crash people run from rather than gather at. */
export const CRASH_FLEE = 7;

/** Metres of a crash people walk over to watch, once the fleeing ring is out. */
export const CRASH_WATCH = 25;

/**
 * Metres from the player a startled person is let go of, back onto their loop.
 * Comfortably beyond the `PEDESTRIAN_VIEW` the crowd is drawn in, so the jump
 * back happens where nobody can see it.
 */
export const RELEASE_FAR = 180;

/** A gun going off: everyone who hears it runs. */
export function crowdHearsShot(state: SimState, crowd: CrowdSource, x: number, y: number, ids?: number[]): number {
  return crowd.startle(state.pedestrians, state.tick, x, y, SHOT_REACH, 'flee', ids);
}

/** A grenade, a Molotov or a rocket going off: the same, over a wider ring. */
export function crowdFeelsBlast(
  state: SimState,
  crowd: CrowdSource,
  x: number,
  y: number,
  blastRadius: number,
  ids?: number[],
): number {
  return crowd.startle(state.pedestrians, state.tick, x, y, BLAST_FRIGHT * blastRadius, 'flee', ids);
}

/**
 * What the crowd does about the player's car on one tick, and who is let go of
 * afterwards.
 *
 * `crash` is the severity the car took this tick, which `physics.ts` has just
 * measured. A crash worth looking at empties the ground right around the wreck
 * and draws a ring in from further out: the fright is written first, so the
 * people who run are not also asked to gather. A car that has hit nothing
 * scatters whoever it is about to run over instead, and only with the player
 * in it: a car standing at a kerb frightens nobody.
 *
 * The release is measured from the player rather than from the car, since the
 * player is what the crowd is drawn around: a wreck left across town keeps
 * nobody standing.
 */
export function stepCrowdReactions(state: SimState, crowd: CrowdSource, crash: number, ids?: number[]): void {
  const v = state.vehicle;
  if (crash >= CRASH_SEVERITY) {
    crowd.startle(state.pedestrians, state.tick, v.x, v.z, CRASH_FLEE, 'flee', ids);
    crowd.startle(state.pedestrians, state.tick, v.x, v.z, CRASH_WATCH, 'gather', ids);
  } else if (state.player.driving && hypot(v.vx, v.vz) >= CAR_SPEED) {
    // Out of its way, and then they turn and shout after it.
    crowd.startle(state.pedestrians, state.tick, v.x, v.z, CAR_REACH, 'dodge', ids);
  }
  const p = state.player;
  releaseFar(state.pedestrians, state.tick, p.driving ? v.x : p.x, p.driving ? v.z : p.y, RELEASE_FAR);
}
