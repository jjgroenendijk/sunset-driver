/**
 * Being taken in (spec sections 11.7, 14): the cuffs, breaking free of them,
 * being dragged out of a car, and giving up.
 *
 * Only an officer on foot arrests. One who gets within reach of a player on
 * foot who is not sprinting away, or of a driver whose car has all but
 * stopped, takes hold of them, and the cuffing takes {@link CUFF_TICKS}. A
 * driver is pulled out of the seat first. While it lasts the player moves
 * nothing, and each fresh press of the jump key is a struggle: enough of them
 * before the cuffs close and the player breaks free, knocking the officer back.
 * The number it takes grows with the heat, so a wanted killer is not getting
 * away from the fourth car that caught them.
 *
 * At one or two stars the player may give up instead. They put their hands up
 * where they stand, nobody shoots at them, and the first officer to reach them
 * cuffs them with nothing to break free of. The bribe that costs is less
 * (`respawn.ts`), which is the point of asking for it.
 *
 * The cuffs closing is `SimState.arrested`, and the end of the tick turns that
 * into the respawn, as it always did.
 */
import { atan2, cos, hypot, sin } from '../core/libm.ts';
import { TICK_RATE } from './clock.ts';
import { heatStars } from './crime.ts';
import { CUFF_REACH, DRAG_SPEED } from './duty.ts';
import type { InputFrame } from './input.ts';
import { bark, type Officer } from './officer.ts';
import { report } from './police.ts';
import type { SimState } from './simulation.ts';
import { specOf } from './vehicle.ts';

/** Ticks the cuffs take to close: a second and a half to struggle in. */
export const CUFF_TICKS = 90;

/** A give-up is cuffed faster: there is nothing to struggle against. */
const YIELD_TICKS = 45;

/** Presses it takes to break free at one star, and the more each star after it adds. */
const FREE_BASE = 4;
const FREE_PER_STAR = 2;

/** Metres per second a player on foot must be under to be taken hold of: a sprint gets away. */
const HOLD_SPEED = 3.4;

/** Metres from the side of a stopped car an officer drags the driver out from. */
const DRAG_REACH = 1.4;

/** Ticks after breaking free before anybody can take hold again, and ticks the officer is knocked back for. */
const FREE_GRACE = 3 * TICK_RATE;
const STUN_TICKS = 2 * TICK_RATE;

/** Metres the officer is shoved back by a player who breaks free. */
const SHOVE = 1.6;

/** The most stars at which the police take a surrender (spec section 14). */
const SURRENDER_STARS = 2;

/** Metres from an officer or a car a player may give up at: somebody has to be there to take them. */
const SURRENDER_RANGE = 70;

/** Presses of the jump key it takes to break free at a heat. */
export function pressesToFree(heat: number): number {
  return FREE_BASE + FREE_PER_STAR * Math.max(0, heatStars(heat) - 1);
}

/** True where the player may give themselves up this tick. */
export function maySurrender(state: SimState): boolean {
  const stars = heatStars(state.heat);
  if (stars < 1 || stars > SURRENDER_STARS || state.police.surrendered || state.police.cuffs !== null) return false;
  if (state.player.driving || state.player.health <= 0) return false;
  const p = state.player;
  for (const officer of state.police.officers) if (hypot(officer.x - p.x, officer.y - p.y) < SURRENDER_RANGE) return true;
  for (const unit of state.police.units) if (hypot(unit.x - p.x, unit.y - p.y) < SURRENDER_RANGE) return true;
  return false;
}

/**
 * Let the nearest officer in reach take hold of the player. Called once the
 * officers have moved, so the one who has just run up takes hold on the tick
 * they arrive.
 */
export function startCuffs(state: SimState): void {
  const police = state.police;
  if (police.cuffs !== null || state.heat <= 0 || state.tick < police.freeTick || state.player.health <= 0) return;
  const p = state.player;
  const driving = p.driving;
  const x = driving ? state.vehicle.x : p.x;
  const y = driving ? state.vehicle.z : p.y;
  if (driving && Math.abs(state.vehicle.speed) > DRAG_SPEED) return;
  if (!driving && Math.abs(p.speed) > HOLD_SPEED && !police.surrendered) return;
  // A car is reached at its side, which stands its half width out from the middle.
  const reach = driving ? specOf(state.vehicle.cls).halfWidth + DRAG_REACH : CUFF_REACH + 0.25;
  const taker = nearestTaker(state, x, y, reach);
  if (taker === undefined) return;
  police.cuffs = {
    officer: taker.id,
    start: state.tick,
    presses: 0,
    need: police.surrendered ? 0 : pressesToFree(state.heat),
    held: true,
    yielded: police.surrendered,
  };
  taker.task = 'cuff';
  bark(state, 'cuff', taker.x, taker.y);
}

/** The nearest officer within reach of (x, y) who is up and chasing or covering, if any. */
function nearestTaker(state: SimState, x: number, y: number, reach: number): Officer | undefined {
  let taker: Officer | undefined;
  let nearest = reach;
  for (const officer of state.police.officers) {
    if (officer.stunned > state.tick || (officer.task !== 'pursue' && officer.task !== 'cover')) continue;
    const gap = hypot(officer.x - x, officer.y - y);
    if (gap > nearest) continue;
    nearest = gap;
    taker = officer;
  }
  return taker;
}

/**
 * One tick of the cuffs, and of giving up, before the physics moves anybody.
 * Answers true while the player is held, so the physics is stepped with
 * nothing pressed: a player being cuffed walks nowhere, drives nowhere and
 * fires nothing.
 */
export function stepArrest(state: SimState, input: InputFrame): boolean {
  const police = state.police;
  // Hands up at no heat is nothing: nobody is coming to take them.
  if (state.heat <= 0 && police.cuffs === null) police.surrendered = false;
  if (input.surrender && maySurrender(state)) {
    police.surrendered = true;
    bark(state, 'freeze', state.player.x, state.player.y);
  }
  const cuffs = police.cuffs;
  if (cuffs === null) return police.surrendered;
  const officer = police.officers.find((o: Officer) => o.id === cuffs.officer);
  if (officer === undefined) {
    // Whoever had hold of them is down: the player is free, and still wanted.
    police.cuffs = null;
    return police.surrendered;
  }
  if (!cuffs.yielded) {
    const pressed = input.jump && !cuffs.held;
    cuffs.held = input.jump;
    if (pressed) cuffs.presses += 1;
    if (cuffs.presses >= cuffs.need) {
      breakFree(state, officer);
      return false;
    }
  }
  if (state.tick - cuffs.start >= (cuffs.yielded ? YIELD_TICKS : CUFF_TICKS)) state.arrested = true;
  return true;
}

/** How far through the cuffing the player is, 0 to 1, or -1 while nobody has hold of them. */
export function cuffProgress(state: SimState): number {
  const cuffs = state.police.cuffs;
  if (cuffs === null) return -1;
  return Math.min(1, (state.tick - cuffs.start) / (cuffs.yielded ? YIELD_TICKS : CUFF_TICKS));
}

/**
 * The player throws the officer off: the officer staggers back and stands dazed
 * for a moment, nobody may take hold again for a little longer, and resisting
 * is a crime of its own.
 */
function breakFree(state: SimState, officer: Officer): void {
  const police = state.police;
  const p = state.player;
  const x = p.driving ? state.vehicle.x : p.x;
  const y = p.driving ? state.vehicle.z : p.y;
  const away = atan2(officer.y - y, officer.x - x);
  officer.x += cos(away) * SHOVE;
  officer.y += sin(away) * SHOVE;
  officer.stunned = state.tick + STUN_TICKS;
  officer.task = 'pursue';
  officer.speed = 0;
  police.cuffs = null;
  police.freeTick = state.tick + FREE_GRACE;
  report(state, RESISTING);
}

/** What resisting arrest adds to the heat: a brawl with an officer. */
const RESISTING = 0.6;
