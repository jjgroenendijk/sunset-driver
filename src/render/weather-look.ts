/**
 * What the weather does to the light (spec section 13.4).
 *
 * `src/sim/weather.ts` says what the weather is; this says what it looks like.
 * Everything the scene already reads off the day — the sun, the fill, the haze,
 * the lamps — is read off the day and then bent here, so nothing downstream
 * learns a second rule. `sky.ts` and `grade.ts` are handed the bent
 * {@link Daylight} and cannot tell the difference.
 *
 * The three things weather changes:
 *
 * - the sun goes behind cloud, so its strength drops and the fill rises to
 *   take its place. An overcast street is flat, not dark;
 * - the haze goes grey and closes in, so the draw distance of spec section 9.2
 *   is pulled in with it. Fog is the one weather that cuts it hard;
 * - the street lamps come on early, because a storm at noon is dim enough to
 *   trip them.
 *
 * Pure three.js maths, so the tests run it headless.
 */
import { Color } from 'three';
import { clamp, lerp } from '../core/math.ts';
import type { Weather } from '../sim/weather.ts';
import type { Daylight } from './daylight.ts';

/** The colour the haze takes under cloud, and the colour fog itself is. */
const CLOUD_HAZE = 0x9099a0;
const FOG_HAZE = 0xb8bcbe;

/** The colour the cloud fill takes, from above and from the ground. */
const CLOUD_SKY = 0x9fa8b2;
const CLOUD_GROUND = 0x565a5e;

/** What is left of the sun at the thickest overcast. */
const SUN_UNDER_CLOUD = 0.25;

/** How much more fill the sky throws when the sun is behind cloud. */
const FILL_UNDER_CLOUD = 1.7;

/** How far on the street lamps come at the thickest overcast, in daylight. */
const LAMPS_UNDER_CLOUD = 0.8;

/** How much of the overcast colour the haze takes at its thickest. */
const HAZE_SHARE = 0.85;

/**
 * Metres at which the haze starts and at which it is complete in the thickest
 * fog.
 *
 * The camera of spec section 10.7 sees the ground from about 15 m in front of
 * it out to about 60, and the far streaming ring stands at 750 m. So the haze
 * has to come inside that band to be seen at all: a fog that merely pulled the
 * ring in would cut the draw distance where nobody is looking.
 */
const FOG_NEAR = 15;
const FOG_FAR = 70;

/**
 * The thickness below which fog is only haze on the horizon. A shower and a
 * storm both carry some, and neither should close the street in; only the fog
 * of {@link Weather.kind} reaches past this.
 */
const FOG_ONSET = 0.35;

/**
 * How overcast the sky is, 0 to 1. Rain and storm bring their own cloud; fog is
 * thick air under a sky that may be clear, so it darkens the street less than
 * its thickness suggests.
 */
export function overcastOf(weather: Weather): number {
  return clamp(Math.max(weather.rain, weather.fog * 0.55), 0, 1);
}

/**
 * The light of a tick with the weather over it. A new {@link Daylight}: the
 * one it is given is left alone, because `world-scene.ts` keeps the day's own
 * light and bends it again every frame.
 */
export function overcast(light: Daylight, weather: Weather): Daylight {
  const cloud = overcastOf(weather);
  if (cloud === 0) return light;
  const haze = new Color(CLOUD_HAZE).lerp(new Color(FOG_HAZE), weather.fog);
  return {
    ...light,
    sunColour: light.sunColour.clone().lerp(new Color(CLOUD_SKY), cloud),
    sunIntensity: light.sunIntensity * lerp(1, SUN_UNDER_CLOUD, cloud),
    fillSky: light.fillSky.clone().lerp(new Color(CLOUD_SKY), cloud),
    fillGround: light.fillGround.clone().lerp(new Color(CLOUD_GROUND), cloud),
    fillIntensity: light.fillIntensity * lerp(1, FILL_UNDER_CLOUD, cloud),
    // The haze keeps some of the hour's own colour, or a sunset behind rain
    // would come out the same grey as a wet morning.
    haze: light.haze.clone().lerp(haze, cloud * HAZE_SHARE),
    // A storm at noon is dim enough to trip the street lighting, so the lamps
    // come on under cloud as well as after dark, whichever is further on.
    lamps: Math.max(light.lamps, cloud * LAMPS_UNDER_CLOUD),
  };
}

/**
 * Where the haze stands, given where the tier of spec section 9.2 puts it.
 *
 * Fog is what cuts the draw distance (spec section 13.4). The ground still
 * ends at the far ring; the haze is brought in front of it, so the player sees
 * less without anything being seen to stop. Clear air leaves the tier's own
 * numbers all but untouched, and weather never pushes them further out.
 */
export function fogRange(near: number, far: number, weather: Weather): { near: number; far: number } {
  const thick = clamp((weather.fog - FOG_ONSET) / (1 - FOG_ONSET), 0, 1);
  if (thick === 0) return { near, far };
  // The two ends are brought in by the same share of the way, measured as a
  // ratio rather than as metres: half of the way from 750 m to 70 m is 230 m,
  // which is fog, and not the 410 m that lies halfway between them, which is
  // the clear day it started from.
  return { near: near * (FOG_NEAR / near) ** thick, far: far * (FOG_FAR / far) ** thick };
}
