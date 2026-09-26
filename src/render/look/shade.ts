/**
 * The colour a shadow takes through the day (spec section 10.1,
 * `docs/art-style.md`).
 *
 * A shadow is never black: it shifts the colour it falls on toward the shadow
 * colour of the hour and keeps its saturation. The banded light of `cel.ts`
 * lights a surface in shade with the sky fill alone, so the fill carries that
 * colour. Its hue comes from here; how strong it is stays with `daylight.ts`.
 *
 * Pure, and free of the renderer, so the tests read it headless.
 */
import { Color } from 'three';
import { smoothstep } from '../../core/math.ts';

/** The shadow colour at each moment the art style names. */
const DAWN = 0xa98bb8;
const DAY = 0x8f8fc0;
const GOLDEN = 0x9c78a8;
const DUSK = 0x5c4a8a;
const NIGHT = 0x302b4a;

/**
 * Sun altitudes, as the sine of its angle over the horizon, where the colours
 * hand over. Under {@link NIGHT_BELOW} it is night; the dawn or the dusk colour
 * holds around the horizon; the golden hour runs up to {@link GOLDEN_TOP} in
 * the evening; the day colour is whole from {@link DAY_FROM}.
 */
const NIGHT_BELOW = -0.3;
const GOLDEN_FROM = 0.02;
const GOLDEN_TOP = 0.14;
const DAY_FROM = 0.4;

/** Rec. 709 luma of a colour in the working colour space. */
export function luma(colour: Color): number {
  return 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
}

/**
 * The shadow colour at a sun altitude. `morning` says which side of noon it is,
 * since a dawn and a dusk at the same altitude are different colours.
 */
export function shadowColourAt(altitude: number, morning: boolean): Color {
  const low = morning
    ? new Color(DAWN)
    : new Color(DUSK).lerp(new Color(GOLDEN), smoothstep(GOLDEN_FROM - 0.06, GOLDEN_FROM + 0.04, altitude));
  const risen = new Color(NIGHT).lerp(low, smoothstep(NIGHT_BELOW, 0, altitude));
  return risen.lerp(new Color(DAY), smoothstep(GOLDEN_TOP, DAY_FROM, altitude));
}

/**
 * How much of the shadow's hue the fill carries, 0 to 1. The rest is white.
 * The lit side of a surface takes the fill as well as the sun, so a fill of
 * the full hue would need a sun with no blue in it at all to keep the lit side
 * warm, and a blue wall would look the same in sun and in shade.
 */
const HUE_SHARE = 0.75;

/**
 * A light the colour of a shadow, at a luma of 1. The fill is scaled by its own
 * strength, so only the hue of the shadow reaches it here; a dark night
 * shadow is as blue as its colour says, not as dim.
 */
export function shadowLight(shadow: Color): Color {
  const hue = shadow.clone().multiplyScalar(1 / Math.max(luma(shadow), 1e-4));
  return new Color(1, 1, 1).lerp(hue, HUE_SHARE);
}
