/**
 * When the beach of spec section 20.1 is used: the hours of each thing on it,
 * and how the weather thins it.
 *
 * The pavement crowd thins by `Weather.crowd`, which keeps most people out in
 * rain. A beach empties at a drizzle the pavement carries on through, so it
 * has its own rule, {@link beachShare}. Surfers want wind, since wind is the
 * swell, and keep to their own rule, {@link surfShare}. Everything here is a
 * function of the tick and the weather alone.
 */
import { hashInts } from '../../core/hash.ts';
import { clamp, smoothstep } from '../../core/math.ts';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../clock.ts';
import type { Weather } from './weather.ts';

/** What is out on a beach. */
export type BeachKind =
  | 'towels'
  | 'swimmers'
  | 'volleyball'
  | 'surfers'
  | 'lifeguard'
  | 'icecream'
  | 'cocktail'
  | 'bonfire'
  | 'party'
  | 'joggers'
  | 'skaters';

/** The hours each kind is out, from and to, which may run past midnight. */
const BEACH_HOURS: Record<BeachKind, readonly [number, number]> = {
  towels: [9, 19],
  swimmers: [10, 19],
  volleyball: [10, 20],
  surfers: [6, 20],
  lifeguard: [9, 18],
  icecream: [10, 20],
  cocktail: [11, 1],
  bonfire: [20, 2],
  party: [21, 3],
  joggers: [6, 21],
  skaters: [9, 21],
};

/** The chance a spot of each kind is out at all on a day it could be. */
const BEACH_DAYS: Record<BeachKind, number> = {
  towels: 0.9,
  swimmers: 0.85,
  volleyball: 0.7,
  surfers: 0.9,
  lifeguard: 1,
  icecream: 0.95,
  cocktail: 0.9,
  bonfire: 0.4,
  party: 0.2,
  joggers: 1,
  skaters: 1,
};

/** Hours a kind takes to fill after it opens, and to empty before it closes. */
const FILL_HOURS = 1.5;

/** Rain at which the beach is empty. A rain spell at full strength reaches it. */
const BEACH_RAIN = 0.55;

/** Fog on a clear day, which thins nobody, and how much thick fog thins the rest. */
const CLEAR_FOG = 0.06;
const FOG_THIN = 0.5;

/** The wind the swell starts to rise at, and the wind it is worth going out in. */
const SWELL_FROM = 0.25;
const SWELL_UP = 0.4;

/** The wind of a storm, at which the surfers come in. */
const STORM_FROM = 0.5;
const STORM_WIND = 0.6;

/**
 * The share of the beach that is out in a weather: 1 on a clear day, falling
 * with the rain to nothing, so a storm empties it. Fog thins it as well.
 */
export function beachShare(weather: Pick<Weather, 'rain' | 'fog'>): number {
  const dry = clamp(1 - weather.rain / BEACH_RAIN, 0, 1);
  const fog = 1 - FOG_THIN * clamp(weather.fog - CLEAR_FOG, 0, 1);
  return dry * fog;
}

/**
 * The share of the surfers out in a weather. The swell rises with the wind, so
 * a calm clear day holds none; rain does not keep them in, but a storm does.
 */
export function surfShare(weather: Pick<Weather, 'rain' | 'wind'>): number {
  const swell = smoothstep(SWELL_FROM, SWELL_UP, weather.wind);
  const calm = 1 - smoothstep(STORM_FROM, STORM_WIND, weather.wind);
  return swell * calm * clamp(1 - weather.rain, 0, 1);
}

/** The share of a kind the weather lets out: its own rule for the surfers, the beach's for the rest. */
export function weatherShare(kind: BeachKind, weather: Weather): number {
  if (kind === 'surfers') return surfShare(weather);
  const share = beachShare(weather);
  // The lifeguard and the vendors stay while anybody is there to watch or serve.
  if (kind === 'lifeguard' || kind === 'icecream' || kind === 'cocktail') return share > 0.1 ? 1 : 0;
  return share;
}

/**
 * How full a kind is at a tick by its hours: 0 outside them, rising over
 * {@link FILL_HOURS} after it opens and falling over as many before it
 * closes. `day` is the day its hours began on, so a night past midnight
 * counts as the day it started.
 */
export function fillAt(kind: BeachKind, tick: number): { fill: number; day: number } {
  const [from, to] = BEACH_HOURS[kind];
  const span = (to - from + 24) % 24;
  const inDay = ((tick % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  const since = (inDay / TICKS_PER_HOUR - from + 24) % 24;
  const day = Math.floor((tick - since * TICKS_PER_HOUR) / TICKS_PER_DAY + 1e-9);
  if (since >= span) return { fill: 0, day };
  return { fill: clamp(Math.min(since, span - since) / FILL_HOURS, 0, 1), day };
}

const DAY_STREAM = 1;
const PERSON_STREAM = 2;

/** A uniform draw in [0, 1) from integers alone. */
function unit(...parts: number[]): number {
  return (hashInts(...parts) >>> 0) / 0x1_0000_0000;
}

/** True when a spot of a kind is out on a day at all. */
export function spotOnDay(seed: number, kind: BeachKind, spot: number, day: number): boolean {
  return unit(DAY_STREAM, seed, spot, day) < BEACH_DAYS[kind];
}

/**
 * True when one person of a spot is out at a level, the fill of the hour
 * times the share the weather lets out. The draw holds for a whole day, so a
 * level that falls sends people home one at a time and never brings them back
 * in a flicker.
 */
export function personOut(seed: number, spot: number, person: number, day: number, level: number): boolean {
  if (level >= 1) return true;
  if (level <= 0) return false;
  return unit(PERSON_STREAM, seed, spot, person, day) < level;
}
