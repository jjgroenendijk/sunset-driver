/**
 * The day and night cycle (spec sections 10.5, 13.4).
 *
 * One in-game day is 86 400 ticks, which is 24 real minutes, so the whole cycle
 * is a function of the tick alone: the same tick always gives the same light,
 * on every machine and in every session. Nothing here reads the wall clock.
 *
 * The day is a summer one: the sun is due east on the horizon at 05:30, highest
 * at 13:00, due west at 20:30, and lowest at 01:00. It runs a tilted circle, at
 * an even pace through the day and a faster one through the night. The clock
 * the player reads is not changed, only where the sun stands at each hour of
 * it. Everything else the scene needs — how bright the sun burns, what colour
 * it burns, how much sky light fills the shadows, what colour the haze is,
 * whether the windows are lit and whether the street lamps are on — is read off
 * how high it stands.
 *
 * The numbers are the scene's, not the sky model's: `sky.ts` turns them into a
 * dome, a directional light and fog. Pure three.js maths, so the tests run this
 * headless.
 */
import { Color, Vector3 } from 'three';
import { clamp, smoothstep } from '../core/math.ts';
import { TICKS_PER_DAY } from '../sim/clock.ts';

/**
 * Radians the sun's circle is tilted from straight overhead. The noon sun
 * leans toward the far side of the map rather than standing over the player, so
 * a building casts a shadow at every hour of the day and the top-down camera
 * always has relief to read.
 */
const DECLINATION = 0.38;

/**
 * The clock hours of sunrise and sunset. The sun of a 24-hour circle would set
 * at 18:00, and the evening the game is named for would be dark by 18:20. A
 * summer day keeps the street lit into the evening and still gives it a night.
 */
export const SUNRISE_HOUR = 5.5;
export const SUNSET_HOUR = 20.5;

/** The clock hour the sun stands highest: halfway between sunrise and sunset. */
export const SOLAR_NOON_HOUR = (SUNRISE_HOUR + SUNSET_HOUR) / 2;

/** How high the sun stands at noon, as the sine of its angle above the horizon. */
export const NOON_ALTITUDE = Math.cos(DECLINATION);

/**
 * The sine of the sun's angle above the horizon at which day has fully arrived,
 * and the one below which it has fully gone. Sunrise and sunset are 0; the band
 * around it is dusk, and it is what every blend below is measured against.
 */
const DAY_ALTITUDE = 0.3;
const DARK_ALTITUDE = -0.3;

/**
 * The clock hours the small hours run between: the night is fully deep at
 * {@link LATE_FROM} and has let go by {@link LATE_TO}. It is a clock rather
 * than a sun height, because what it drives is people rather than light: an
 * office empties at midnight whatever the sun is doing.
 */
const LATE_FROM = 22;
const LATE_TO = 4.5;
/** Hours after {@link LATE_TO} that the small hours take to let go. */
const LATE_BAND = 2;

/**
 * Ticks of one blink of the red aircraft beacons on the tallest towers (spec
 * section 10.5). It is measured in ticks, so every session blinks together.
 */
export const BEACON_CYCLE = 90;

/**
 * The sun's altitude at which the street lamps are fully on. They come on
 * before the light has gone, as a real city's do, so dusk is lit from both ends.
 */
const LAMP_ALTITUDE = 0.12;

/** The sun's colour on the horizon and at its highest. */
const SUN_LOW = 0xff7a35;
const SUN_HIGH = 0xfff1d8;

/** The sun's strength at its highest, in the renderer's units. */
const SUN_INTENSITY = 3.2;

/**
 * Sky light: the colour from above and the bounce from below, by day and by
 * night. The day sky is a pale lavender, so that with the warm sun the light on
 * a lit surface sums to a warm white. A bluer sky outweighed the sun on blue
 * and turned the cream pavements grey.
 */
const SKY_FILL_DAY = 0xc6cce0;
const GROUND_FILL_DAY = 0x6b5e48;
const SKY_FILL_NIGHT = 0x5a5a96;
const GROUND_FILL_NIGHT = 0x3a3440;

/**
 * How strong that fill is by day and at midnight. A clear sky is a light as
 * big as the whole dome, so by day a street in shadow is about half as bright
 * as one in the sun. The frame is tone mapped, and the curve's toe pulls a
 * shadow down further than its share of the light says: at a third of the sun
 * the street under a tower still came out as dusk at noon, which is what this
 * number was raised for. The night fill is moonlight: strong enough that a
 * street with no lamp still shows its kerbs, its cars and its people. Weaker,
 * and a night frame away from the lamps was black. It is set against the pale
 * colours of the palette: at the strength the dark asphalt once needed, the
 * night street came out a bright blue.
 */
const FILL_DAY = 3.6;
const FILL_NIGHT = 0.85;

/** The haze the far chunks fade into: by day, at dusk and at night. */
const HAZE_DAY = 0x9ab0c0;
const HAZE_DUSK = 0xd2764a;
const HAZE_NIGHT = 0x0d1020;

/** How much of the dusk haze is mixed in at its strongest. */
const DUSK_SHARE = 0.85;

/** What the scene is lit by at one moment of the day. */
export interface Daylight {
  /** Unit vector from the ground toward the sun. */
  sun: Vector3;
  /** The sine of the sun's angle above the horizon: 1 overhead, negative under the map. */
  altitude: number;
  sunColour: Color;
  /** 0 once the sun is under the horizon. */
  sunIntensity: number;
  /** The sky light that fills the shadows: from above, from below, and how strong. */
  fillSky: Color;
  fillGround: Color;
  fillIntensity: number;
  /** The colour of the haze, the fog and the sky behind it. */
  haze: Color;
  /** How far into the night it is, 0 by day and 1 at midnight. It lights the windows. */
  night: number;
  /** How near the horizon the sun is: 0 by day and at midnight, 1 at sunrise and sunset. */
  dusk: number;
  /** How far on the street lamps are, 0 by day and 1 after dark. */
  lamps: number;
  /**
   * How deep into the night it is: 0 by day and at dusk, 1 in the small hours.
   * An office empties and a home turns in as it rises; a shop stays lit.
   */
  late: number;
}

/**
 * Where the sun stands at a tick, as a unit vector. It is due east at
 * {@link SUNRISE_HOUR}, near overhead at {@link SOLAR_NOON_HOUR} and due west
 * at {@link SUNSET_HOUR}. The map's y is the scene's z, so the tilt leans the
 * circle toward +z.
 */
export function sunDirection(tick: number): Vector3 {
  // A quarter turn after the sun's midnight is sunrise.
  const angle = (sunFraction(dayFraction(tick)) - 0.25) * Math.PI * 2;
  const up = Math.sin(angle);
  return new Vector3(Math.cos(angle), up * Math.cos(DECLINATION), up * Math.sin(DECLINATION));
}

/** The light of one tick. Everything the scene needs, read off the sun's height. */
export function daylightAt(tick: number): Daylight {
  const sun = sunDirection(tick);
  const altitude = sun.y;
  const day = smoothstep(DARK_ALTITUDE, DAY_ALTITUDE, altitude);
  const night = 1 - day;
  const lamps = 1 - smoothstep(DARK_ALTITUDE, LAMP_ALTITUDE, altitude);

  // Dusk is the band around the horizon, whichever side of it the sun is on.
  const dusk = 1 - smoothstep(0, DAY_ALTITUDE, Math.abs(altitude));

  return {
    sun,
    altitude,
    sunColour: blend(SUN_LOW, SUN_HIGH, smoothstep(0, DAY_ALTITUDE * 1.5, altitude)),
    sunIntensity: SUN_INTENSITY * smoothstep(DARK_ALTITUDE * 0.15, DAY_ALTITUDE, altitude),
    fillSky: blend(SKY_FILL_NIGHT, SKY_FILL_DAY, day),
    fillGround: blend(GROUND_FILL_NIGHT, GROUND_FILL_DAY, day),
    fillIntensity: FILL_NIGHT + (FILL_DAY - FILL_NIGHT) * day,
    haze: blend(HAZE_NIGHT, HAZE_DAY, day).lerp(new Color(HAZE_DUSK), dusk * DUSK_SHARE),
    night,
    dusk,
    lamps,
    late: lateness(dayFraction(tick) * 24),
  };
}

/**
 * How deep into the night a clock hour is, 0 to 1. It rises from
 * {@link LATE_FROM} to midnight, holds through the small hours, and lets go
 * over {@link LATE_BAND} hours after {@link LATE_TO}.
 */
function lateness(hour: number): number {
  return Math.max(smoothstep(LATE_FROM, 24, hour), 1 - smoothstep(LATE_TO, LATE_TO + LATE_BAND, hour));
}

/** Where the beacons of the tallest towers are in their blink, 0 to 1 a cycle. */
export function beaconPhase(tick: number): number {
  return (tick - Math.floor(tick / BEACON_CYCLE) * BEACON_CYCLE) / BEACON_CYCLE;
}

/** Where in the day a tick falls: 0 at midnight, 0.5 at noon. */
export function dayFraction(tick: number): number {
  const inDay = tick - Math.floor(tick / TICKS_PER_DAY) * TICKS_PER_DAY;
  return inDay / TICKS_PER_DAY;
}

/**
 * Where the sun is in its own day, 0 at its midnight and 0.5 at its noon, for a
 * clock's fraction of the day. Sunrise is 0.25 and sunset 0.75, and the clock
 * is stretched to them in a straight line on each side.
 */
export function sunFraction(clock: number): number {
  const hour = clock * 24;
  const rise = SUNRISE_HOUR;
  const set = SUNSET_HOUR;
  // The night runs from sunset over midnight to the next sunrise.
  const sun =
    hour >= rise && hour <= set
      ? 6 + ((hour - rise) / (set - rise)) * 12
      : 18 + (((hour < rise ? hour + 24 : hour) - set) / (24 - (set - rise))) * 12;
  return (sun / 24) % 1;
}

/** The tick that stands at a given hour of the first day, so a preview can ask for one. */
export function tickAtHour(hour: number): number {
  return Math.round((clamp(hour, 0, 24) / 24) * TICKS_PER_DAY) % TICKS_PER_DAY;
}

/** Blend two colour constants in the working colour space. */
function blend(from: number, to: number, t: number): Color {
  return new Color(from).lerp(new Color(to), t);
}
