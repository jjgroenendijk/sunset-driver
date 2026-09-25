/**
 * What a unit of contraband is worth, district by district and tick by tick
 * (spec section 16.2).
 *
 * The trade of spec section 16.2 is the difference between two districts, so a
 * price is the thing this file exists to answer: buy where a good is plentiful,
 * sell where it is wanted. Three things move it, as the spec says — the wealth
 * of the district, its character, and the demand a crowded street makes — and
 * over that sits a slow drift and the occasional shock.
 *
 * Nothing here is stored. A price is a pure function of `(seed, tick,
 * district, good)`, the way the traffic and the crowd are functions of the tick
 * (spec section 5.3), so the record carries what the player owns and never a
 * table of prices. Two things follow: a save cannot disagree with the market it
 * was saved in, and the price history the panel draws is read by asking for the
 * prices of an hour ago rather than by keeping a log.
 *
 * Pure: no wall-clock, no DOM, no state.
 */
import { clamp, lerp, smoothstep } from '../core/math.ts';
import { genRng, rngFor, Subsystem } from '../core/rng.ts';
import type { District } from '../world/types.ts';
import { TICKS_PER_HOUR } from './clock.ts';
import { GOODS } from './goods.ts';

// The list of goods moved to `goods.ts`; the prices are asked of this file,
// so the names callers read with them are handed on from here.
export { GOOD_GROUPS, GOOD_IDS, GOODS, goodIndex, type Good } from './goods.ts';

/** The share taken off a price in the district whose own people trade the good. */
const HOME_DISCOUNT = 0.3;

/** The most a district's own taste may move a price, each way. */
const TASTE_JITTER = 0.12;

/** The narrowest and widest a district's standing price may be, as a share of the base. */
const TASTE_LOW = 0.45;
const TASTE_HIGH = 1.8;

/** Game ticks between the corners of the drift. The wave runs smoothly between them. */
const DRIFT_TICKS = TICKS_PER_HOUR * 3;

/** How far the drift moves a price of volatility 1, each way. */
const DRIFT_SPAN = 0.45;

/** Game ticks one shock lasts, which is also how often one may start. */
const SHOCK_TICKS = TICKS_PER_HOUR * 6;

/** The chance a district's market in one good is shaken in one of those spells. */
const SHOCK_CHANCE = 0.07;

/** How far a shock throws a price of volatility 1: a third of it, or three times it. */
const SHOCK_LOW = 0.6;
const SHOCK_HIGH = 2;

/** A price this far over the district's standing price is a spike, and this far under it a glut. */
export const SPIKE = 1.3;
export const GLUT = 0.75;

/**
 * What one district pays for one good, before the day moves it: its wealth, its
 * character and its crowd, and a little of its own taste so that two districts
 * of the same numbers are still worth driving between.
 */
export function tasteOf(seed: number, district: District, good: number): number {
  const spec = GOODS[good];
  if (spec === undefined) return 1;
  const jitter = genRng(seed, Subsystem.Market, district.id * GOODS.length + good).range(-TASTE_JITTER, TASTE_JITTER);
  const taste =
    1 +
    spec.wealth * (district.wealth - 0.5) * 2 +
    spec.density * (district.density - 0.5) * 2 -
    (district.culture === spec.home ? HOME_DISCOUNT : 0) +
    jitter;
  return clamp(taste, TASTE_LOW, TASTE_HIGH);
}

/**
 * The standing price of a good in a district: what it costs there on an
 * ordinary day. The panel measures the price of the moment against this to say
 * whether the street is having a spike or a glut.
 */
export function standingPrice(seed: number, district: District, good: number): number {
  return Math.max(1, Math.round((GOODS[good]?.base ?? 0) * tasteOf(seed, district, good)));
}

/**
 * What a district asks for a good on a tick: the standing price, the drift over
 * the day, and whatever shock the street is in the middle of.
 */
export function priceAt(seed: number, tick: number, district: District, good: number): number {
  const spec = GOODS[good];
  if (spec === undefined) return 0;
  const key = district.id * GOODS.length + good;
  const value = spec.base * tasteOf(seed, district, good) * driftAt(seed, tick, key, spec.volatility) * shockAt(seed, tick, key, spec.volatility);
  return Math.max(1, Math.round(value));
}

/**
 * The prices of the last `samples` steps, oldest first and ending at the tick
 * given, for the history of spec section 12. It is read rather than remembered:
 * the price of three hours ago is the same function of the same seed it was
 * three hours ago.
 */
export function priceRun(seed: number, tick: number, district: District, good: number, samples: number, step: number): number[] {
  const run: number[] = [];
  for (let i = samples - 1; i >= 0; i--) run.push(priceAt(seed, Math.max(0, tick - i * step), district, good));
  return run;
}

/**
 * The slow wave a market walks over the day. A corner every few hours, and a
 * smooth ride between them, so a price a player just read does not jump the
 * moment they turn round.
 */
function driftAt(seed: number, tick: number, key: number, volatility: number): number {
  const block = Math.floor(tick / DRIFT_TICKS);
  const t = (tick - block * DRIFT_TICKS) / DRIFT_TICKS;
  const from = corner(seed, block, key);
  const to = corner(seed, block + 1, key);
  return 1 + lerp(from, to, smoothstep(0, 1, t)) * DRIFT_SPAN * volatility;
}

/** One corner of the wave, -1..1. */
function corner(seed: number, block: number, key: number): number {
  return rngFor(seed, block, Subsystem.Market, key).range(-1, 1);
}

/**
 * A shock, or 1 where the street is quiet (spec section 16.2). A spell either
 * holds a shock or it does not; where it does, the swing is at its widest the
 * moment it lands and is gone by the end of the spell, so a player who hears of
 * one has the rest of the spell to drive there.
 */
function shockAt(seed: number, tick: number, key: number, volatility: number): number {
  const block = Math.floor(tick / SHOCK_TICKS);
  const rng = rngFor(seed, block, Subsystem.Events, key);
  if (!rng.chance(SHOCK_CHANCE)) return 1;
  const up = rng.chance(0.5);
  const size = rng.range(SHOCK_LOW, SHOCK_HIGH) * volatility;
  const t = (tick - block * SHOCK_TICKS) / SHOCK_TICKS;
  const left = size * (1 - t);
  return up ? 1 + left : 1 / (1 + left);
}
