/**
 * How an officer on foot finds a way round a wall (spec section 14).
 *
 * The physics answers how far a person can go along a heading before
 * something solid stops them (`CasualtyGround.reach`). An officer walks the
 * straight line to their goal while it is clear. When a wall stands in it,
 * they follow the wall, always with it on the same side, until they are
 * nearer the goal than where they met it and the straight line is clear
 * again. This is the bug algorithm of robot path finding.
 *
 * The old rule turned further off the straight line each tick, and walked
 * straight again as soon as that was clear. In a courtyard open away from the
 * goal, the straight line led back into the corner every time the officer
 * stepped out of it, so they stood there flipping from side to side (#512).
 * Following the wall takes them out of the courtyard and round it.
 *
 * An officer who has followed a wall for {@link GIVE_UP} and is still no
 * nearer tries the other way round.
 */
import type { CasualtyGround } from '../crowd/casualty.ts';
import { TICK_RATE } from '../clock.ts';
import type { Officer } from './officer.ts';

/** Radians between two headings tried, turning away from the wall. */
const TURN_STEP = 0.15;

/** Headings tried at most in one tick: once round. */
const TRIES = Math.ceil((2 * Math.PI) / TURN_STEP);

/**
 * Metres of the circle an officer curls back towards the wall on. A wall that
 * ends is walked round its corner at this radius, and one that goes on turns
 * the curl back out.
 */
const CURL = 0.8;

/** Metres off the wall an officer keeps, felt for square to the way they walk. */
const KEEP = 0.5;

/** Metres ahead an officer looks for a wall, at the least. */
const FEELER = 1.1;

/** Metres over their feet an officer feels for a wall: over a kerb, under a car roof. */
const FEEL_HEIGHT = 0.9;

/** Metres nearer the goal than where they met the wall an officer has to be before leaving it. */
const LEAVE = 0.5;

/** Ticks a wall is followed before the officer tries the other way round. */
const GIVE_UP = 30 * TICK_RATE;

/** Forget the wall an officer followed: they are on the straight line again, or off their feet. */
export function leaveWall(officer: Officer): void {
  officer.wallGap = -1;
  officer.wallTicks = 0;
}

/**
 * The heading an officer walks this tick towards a goal `gap` metres away
 * along `want`, taking `step` metres. Undefined where every way is shut.
 */
export function wayRound(officer: Officer, want: number, step: number, gap: number, ground: CasualtyGround | undefined): number | undefined {
  if (ground === undefined) return want;
  // Not further than the goal: the player's own body is solid to the ray.
  const feel = Math.min(Math.max(FEELER, step * 3), gap - 0.4);
  if (feel <= 0.2) {
    leaveWall(officer);
    return want;
  }
  const h = officer.height + FEEL_HEIGHT;
  const clear = (dir: number): boolean => ground.reach(officer.x, h, officer.y, dir, feel) >= feel;
  if (officer.wallGap < 0) {
    if (clear(want)) return want;
    officer.wallGap = gap;
    officer.wallDir = want;
    officer.wallTicks = 0;
  } else if (gap < officer.wallGap - LEAVE && clear(want)) {
    leaveWall(officer);
    return want;
  }
  officer.wallTicks++;
  if (officer.wallTicks > GIVE_UP) {
    officer.detour = -officer.detour;
    officer.wallGap = gap;
    officer.wallTicks = 0;
  }
  // Curled a little back towards the wall first, then turned away from it
  // until the way ahead is clear and the wall is `KEEP` off to the side.
  const side = officer.detour;
  const first = officer.wallDir - side * Math.min(step / CURL, TURN_STEP);
  for (let i = 0; i < TRIES; i++) {
    const dir = first + side * i * TURN_STEP;
    if (!clear(dir) || ground.reach(officer.x, h, officer.y, dir - (side * Math.PI) / 2, KEEP) < KEEP) continue;
    // Held within a turn either way, so the heading does not wind up as it goes round.
    officer.wallDir = dir - 2 * Math.PI * Math.round(dir / (2 * Math.PI));
    return officer.wallDir;
  }
  return undefined;
}
