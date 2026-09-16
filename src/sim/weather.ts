/**
 * The weather of spec section 13.4.
 *
 * Weather is a pure function of the seed and the tick, like everything else in
 * the game: no state is kept, nothing is saved, and two machines a thousand
 * ticks apart agree on the rain without exchanging a byte. A save carries the
 * tick, so it carries the weather.
 *
 * The day is cut into spells of {@link SPELL_TICKS}. Each spell draws a kind
 * and a strength from its own stream, and a spell hands over to the next across
 * {@link TURN_TICKS} so nothing on screen or under the tyres jumps.
 *
 * Wetness is the one quantity with a memory: a road stays wet after the rain
 * has stopped, and dries over about {@link DRY_TICKS}. It is still a function
 * of the tick alone, because it is read backwards rather than accumulated —
 * {@link wetnessAt} samples the rain over the last {@link WET_HORIZON} ticks
 * and weights each sample by how long ago it fell. Nothing integrates, so a
 * session joined at any tick sees the same puddles as one that watched it rain.
 *
 * Nothing here reads the wall clock or a frame delta, and nothing here touches
 * the renderer: `src/render/weather-look.ts` turns a {@link Weather} into
 * light, haze and grade, and `src/render/weather-fx.ts` into rain and litter.
 */
import { hashInts } from '../core/hash.ts';
import { rngFor, Subsystem, type Rng } from '../core/rng.ts';
import { clamp, lerp } from '../core/math.ts';
import { TICKS_PER_HOUR } from './clock.ts';

/** The four weathers of spec section 13.4. */
export type WeatherKind = 'clear' | 'rain' | 'fog' | 'storm';

/** Ticks one spell of weather lasts: two game hours, which is two real minutes. */
export const SPELL_TICKS = TICKS_PER_HOUR * 2;

/**
 * Ticks a spell takes to hand over to the next, centred on the boundary
 * between them. Half a game hour: long enough that fog rolls in rather than
 * appearing, short enough that a spell is mostly itself.
 */
export const TURN_TICKS = TICKS_PER_HOUR / 2;

/**
 * Ticks in which a wet road loses about two thirds of its water. One game
 * hour, so a shower is still felt through the turn after it.
 */
export const DRY_TICKS = TICKS_PER_HOUR;

/** How far back {@link wetnessAt} looks. Rain older than this is forgotten. */
export const WET_HORIZON = DRY_TICKS * 3;

/**
 * Samples of the rain that horizon is read at. Twelve puts a sample every
 * quarter of a game hour, which is finer than a spell turns, and keeps the
 * whole of the weather at a couple of dozen random draws a tick.
 */
const WET_SAMPLES = 12;

/** What the weather is doing at one tick. Every field runs 0 to 1. */
export interface Weather {
  /** The spell now, for the HUD and for anything that wants a name rather than a number. */
  kind: WeatherKind;
  /** How hard it is falling. 0 is dry air. */
  rain: number;
  /** Standing water on the road. This is what the tyres read (spec section 11.3). */
  wetness: number;
  /** How thick the air is. It closes the draw distance and helps lose the police. */
  fog: number;
  /** How hard it blows. It carries the litter. */
  wind: number;
  /** How much of the ambient life is out: 1 on a clear day, less in a storm. */
  crowd: number;
}

/** What one kind of weather is at its full strength. */
interface Profile {
  rain: number;
  fog: number;
  wind: number;
  crowd: number;
}

/**
 * The four profiles. `clear` is what every other kind is blended out of, so its
 * numbers are the floor the city sits at: a little haze on the horizon and
 * enough air moving to stir a wrapper.
 */
const PROFILES: Record<WeatherKind, Profile> = {
  clear: { rain: 0, fog: 0.06, wind: 0.18, crowd: 1 },
  rain: { rain: 0.55, fog: 0.3, wind: 0.42, crowd: 0.72 },
  fog: { rain: 0, fog: 1, wind: 0.05, crowd: 0.88 },
  storm: { rain: 1, fog: 0.5, wind: 1, crowd: 0.32 },
};

/**
 * How often each kind is drawn. Most of the game is played in the sun the
 * game is named for; the rest is weather the player remembers because it is
 * rare. The numbers are shares of the whole and add to 1.
 */
const ODDS: readonly (readonly [WeatherKind, number])[] = [
  ['clear', 0.52],
  ['rain', 0.24],
  ['fog', 0.14],
  ['storm', 0.1],
];

/** The weakest a spell may come out, as a share of its profile. */
const MIN_STRENGTH = 0.55;

/** The weather at a tick. The whole of spec section 13.4's model is this function. */
export function weatherAt(seed: number, tick: number): Weather {
  const spell = spellAt(seed, tick);
  return {
    kind: spell.kind,
    rain: spell.rain,
    wetness: wetnessAt(seed, tick),
    fog: spell.fog,
    wind: spell.wind,
    crowd: spell.crowd,
  };
}

/**
 * How wet the road is at a tick, 0 dry and 1 standing water.
 *
 * The rain over the last {@link WET_HORIZON} ticks, weighted by how long ago
 * each sample fell: a sample {@link DRY_TICKS} old counts for about a third of
 * one falling now. The weights are normalised, so rain held at full strength
 * for an hour soaks the road completely and nothing above that is possible.
 *
 * Ticks before 0 are read as tick 0, so a session that starts in the rain
 * starts on a road that has been rained on rather than on a dry one.
 */
export function wetnessAt(seed: number, tick: number): number {
  const step = WET_HORIZON / WET_SAMPLES;
  let wet = 0;
  let total = 0;
  for (let i = 0; i < WET_SAMPLES; i++) {
    const age = i * step;
    const weight = Math.exp(-age / DRY_TICKS);
    wet += spellAt(seed, Math.max(0, tick - age)).rain * weight;
    total += weight;
  }
  return clamp(wet / total, 0, 1);
}

/** The spell a tick falls in, blended with its neighbour across the turn. */
function spellAt(seed: number, tick: number): Weather {
  const index = Math.floor(tick / SPELL_TICKS);
  const into = tick - index * SPELL_TICKS;
  const half = TURN_TICKS / 2;
  const here = drawSpell(seed, index);
  if (into < half) return mix(drawSpell(seed, index - 1), here, 0.5 + into / TURN_TICKS);
  if (into > SPELL_TICKS - half) return mix(here, drawSpell(seed, index + 1), (into - (SPELL_TICKS - half)) / TURN_TICKS);
  return here;
}

/**
 * One spell at full length, before the turns either side of it are blended in.
 * A negative index is read as spell 0, which is what makes tick 0 the start of
 * the weather rather than the middle of a spell nobody saw.
 */
function drawSpell(seed: number, index: number): Weather {
  const rng = rngFor(seed, Math.max(0, index), Subsystem.Weather);
  const kind = pickKind(rng);
  const strength = rng.range(MIN_STRENGTH, 1);
  const profile = PROFILES[kind];
  const clear = PROFILES.clear;
  return {
    kind,
    rain: lerp(clear.rain, profile.rain, strength),
    wetness: 0,
    fog: lerp(clear.fog, profile.fog, strength),
    wind: lerp(clear.wind, profile.wind, strength),
    crowd: lerp(clear.crowd, profile.crowd, strength),
  };
}

/** Draw a kind against {@link ODDS}. */
function pickKind(rng: Rng): WeatherKind {
  let roll = rng.float();
  for (const [kind, share] of ODDS) {
    roll -= share;
    if (roll < 0) return kind;
  }
  return 'clear';
}

/** Blend two spells. The kind is whichever side the blend stands nearer. */
function mix(from: Weather, to: Weather, t: number): Weather {
  return {
    kind: t < 0.5 ? from.kind : to.kind,
    rain: lerp(from.rain, to.rain, t),
    wetness: 0,
    fog: lerp(from.fog, to.fog, t),
    wind: lerp(from.wind, to.wind, t),
    crowd: lerp(from.crowd, to.crowd, t),
  };
}

/** The stream that decides who stays in when the weather turns. */
const CROWD_STREAM = 7;

/**
 * Whether one member of the ambient crowd is out, given {@link Weather.crowd}.
 *
 * This is the hook of spec section 13.4: a storm empties the streets. The
 * ambient traffic and the ambient crowd are laid out once from the seed and
 * never rebuilt, so weather cannot add or remove anyone; it decides who is
 * drawn. The answer is a pure function of the id and the share, so the same
 * storm hides the same people on every machine, and a share that falls slowly
 * takes them off the street one at a time rather than all at once.
 */
export function outInThis(id: number, share: number): boolean {
  if (share >= 1) return true;
  if (share <= 0) return false;
  return hashInts(CROWD_STREAM, id) / 0x1_0000_0000 < share;
}

/** The weather of a clear day, for a scene built before a tick is known. */
export const CLEAR_WEATHER: Weather = {
  kind: 'clear',
  rain: 0,
  wetness: 0,
  fog: PROFILES.clear.fog,
  wind: PROFILES.clear.wind,
  crowd: 1,
};
