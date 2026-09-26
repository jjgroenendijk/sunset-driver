/**
 * The driver behind the wheel of one ambient vehicle (spec section 20.2).
 *
 * Every vehicle of the traffic carries a personality, drawn once from its own
 * stream when it is placed. The personality is a row of numbers and nothing
 * else: how fast the driver cruises, how close they stand to the car in front
 * at a red light, how long they take to pull away when it turns green,
 * whether they cross a line on amber rather than wait for the next green, and
 * how long they stand behind the player or a wreck before they lean on the horn.
 *
 * `traffic-timing.ts` reads those four numbers while it lays the tour down, so
 * the personality is baked into the timing rather than stepped. That is what
 * keeps a vehicle a pure function of the tick: a hurried driver is not one who
 * reacts to the road, but one whose whole lap was timed the way a hurried
 * driver would drive it.
 *
 * Nothing here reads another vehicle. Tailgating is therefore a shorter gap in
 * the queue this driver takes their own place in, not a car closing on the one
 * ahead, and hesitation is a wait of their own after their green, not a driver
 * caught out by the car in front.
 */
import type { Rng } from '../../core/rng.ts';
import { TICK_RATE } from '../clock.ts';

/** The personalities the city drives with. */
export type Personality = 'hesitant' | 'careful' | 'steady' | 'brisk' | 'tailgater';

/** How one driver drives. Every field is read while the tour is timed. */
export interface Driver {
  personality: Personality;
  /** Fraction of the speed limit they cruise at. */
  cruise: number;
  /** Metres they leave for each car ahead of them in a queue: their own length and the gap. */
  gap: number;
  /** Ticks they take to pull away after their light turns green. */
  react: number;
  /** True when they cross a stop line on amber rather than wait for the next green. */
  runsAmber: boolean;
  /**
   * Ticks they stand behind the player, a wreck or somebody in the road before
   * the first honk (`src/audio/honks.ts`); 0 for a driver who never honks.
   */
  honks: number;
}

/**
 * The roster of personalities and how common each is. The shares are relative,
 * so the table can be read as "one tailgater for every four steady drivers".
 *
 * The spread of `cruise` is deliberately narrow. No vehicle reads another, so
 * two drivers on one stretch of road pass through each other rather than queue;
 * a wide spread would fill the city with cars sitting inside each other, which
 * `test/sweep/seed-traffic.test.ts` counts and caps.
 */
export const PERSONALITIES: readonly (Driver & { share: number })[] = [
  // Slow away from every light and slow between them: the driver everyone else is stuck behind.
  // Patient with whatever holds them up, and never on the horn.
  { personality: 'hesitant', share: 2, cruise: 0.82, gap: 8, react: Math.round(1.2 * TICK_RATE), runsAmber: false, honks: 0 },
  // Under the limit, a long gap in the queue, never a chance taken on an amber, and never a honk.
  { personality: 'careful', share: 3, cruise: 0.86, gap: 9, react: Math.round(0.8 * TICK_RATE), runsAmber: false, honks: 0 },
  // The middle of the road, and what the traffic drove like before this file.
  { personality: 'steady', share: 6, cruise: 0.9, gap: 7, react: Math.round(0.45 * TICK_RATE), runsAmber: false, honks: Math.round(3.5 * TICK_RATE) },
  // Up to the limit, away quickly, and through on an amber.
  { personality: 'brisk', share: 4, cruise: 0.95, gap: 6, react: Math.round(0.25 * TICK_RATE), runsAmber: true, honks: 2 * TICK_RATE },
  // Over the limit, half a car off the one in front, gone the moment it is green, and on the horn at once.
  { personality: 'tailgater', share: 2, cruise: 0.99, gap: 4.5, react: Math.round(0.1 * TICK_RATE), runsAmber: true, honks: TICK_RATE },
];

/** The driver of a vehicle that has none: the middle of the roster. */
export const STEADY: Driver = driverNamed('steady');

/** Draw one driver from the roster. One call, so a caller's stream stays in step. */
export function drawDriver(rng: Rng): Driver {
  let total = 0;
  for (const row of PERSONALITIES) total += row.share;
  let pick = rng.float() * total;
  for (const row of PERSONALITIES) {
    pick -= row.share;
    if (pick < 0) return rowOf(row);
  }
  return STEADY;
}

/** The row of the roster with a name, for a test or a caller that wants one personality. */
export function driverNamed(personality: Personality): Driver {
  const row = PERSONALITIES.find((entry) => entry.personality === personality);
  return rowOf(row ?? (PERSONALITIES[0] as Driver & { share: number }));
}

/** A row of the roster without the share, which is no business of a driver's. */
function rowOf(row: Driver & { share: number }): Driver {
  const { personality, cruise, gap, react, runsAmber, honks } = row;
  return { personality, cruise, gap, react, runsAmber, honks };
}
