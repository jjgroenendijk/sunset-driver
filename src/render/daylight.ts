/**
 * The day and night cycle (spec sections 10.5, 13.4).
 *
 * One in-game day is 86 400 ticks, which is 24 real minutes, so the whole cycle
 * is a function of the tick alone: the same tick always gives the same light,
 * on every machine and in every session. Nothing here reads the wall clock.
 *
 * The sun runs a tilted circle: due east on the horizon at 06:00, highest at
 * noon, due west at 18:00, and under the map at midnight. Everything else the
 * scene needs — how bright the sun burns, what colour it burns, how much sky
 * light fills the shadows, what colour the haze is, whether the windows are lit
 * and whether the street lamps are on — is read off how high it stands.
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
 * The sun's altitude at which the street lamps are fully on. They come on
 * before the light has gone, as a real city's do, so dusk is lit from both ends.
 */
const LAMP_ALTITUDE = 0.12;

/** The sun's colour on the horizon and at its highest. */
const SUN_LOW = 0xff7a35;
const SUN_HIGH = 0xfff1d8;

/** The sun's strength at its highest, in the renderer's units. */
const SUN_INTENSITY = 3.6;

/** Sky light: the colour from above and the bounce from below, by day and by night. */
const SKY_FILL_DAY = 0xbcd7f4;
const GROUND_FILL_DAY = 0x6b5e48;
const SKY_FILL_NIGHT = 0x2a3350;
const GROUND_FILL_NIGHT = 0x181420;

/** How strong that fill is by day and at midnight. */
const FILL_DAY = 0.85;
const FILL_NIGHT = 1.2;

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
  /** How far on the street lamps are, 0 by day and 1 after dark. */
  lamps: number;
}

/**
 * Where the sun stands at a tick, as a unit vector. 06:00 is due east, noon is
 * near overhead, 18:00 is due west. The map's y is the scene's z, so the tilt
 * leans the circle toward +z.
 */
export function sunDirection(tick: number): Vector3 {
  // Midnight is 0 of the day, so the quarter turn puts sunrise at the start.
  const angle = (dayFraction(tick) - 0.25) * Math.PI * 2;
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
  const dusk = (1 - smoothstep(0, DAY_ALTITUDE, Math.abs(altitude))) * DUSK_SHARE;

  return {
    sun,
    altitude,
    sunColour: blend(SUN_LOW, SUN_HIGH, smoothstep(0, DAY_ALTITUDE * 1.5, altitude)),
    sunIntensity: SUN_INTENSITY * smoothstep(DARK_ALTITUDE * 0.15, DAY_ALTITUDE, altitude),
    fillSky: blend(SKY_FILL_NIGHT, SKY_FILL_DAY, day),
    fillGround: blend(GROUND_FILL_NIGHT, GROUND_FILL_DAY, day),
    fillIntensity: FILL_NIGHT + (FILL_DAY - FILL_NIGHT) * day,
    haze: blend(HAZE_NIGHT, HAZE_DAY, day).lerp(new Color(HAZE_DUSK), dusk),
    night,
    lamps,
  };
}

/** Where in the day a tick falls: 0 at midnight, 0.5 at noon. */
export function dayFraction(tick: number): number {
  const inDay = tick - Math.floor(tick / TICKS_PER_DAY) * TICKS_PER_DAY;
  return inDay / TICKS_PER_DAY;
}

/** The tick that stands at a given hour of the first day, so a preview can ask for one. */
export function tickAtHour(hour: number): number {
  return Math.round((clamp(hour, 0, 24) / 24) * TICKS_PER_DAY) % TICKS_PER_DAY;
}

/** Blend two colour constants in the working colour space. */
function blend(from: number, to: number, t: number): Color {
  return new Color(from).lerp(new Color(to), t);
}
