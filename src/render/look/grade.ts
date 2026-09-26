/**
 * The colour grade of spec section 10.6.
 *
 * The frame is graded through a 3D lookup table: a small cube of colours that
 * says what every colour in the frame becomes. `post.ts` builds it into a 3D
 * texture and reads it a pixel at a time, so the grade costs one texture fetch
 * a pixel however involved the maths here becomes.
 *
 * The build ships no image files (spec section 10.2), so the cube is generated
 * at runtime like every other texture in the game. It is generated again as the
 * day turns: the grade is a function of the light, warm at dusk and cool after
 * dark, and of the weather over it (spec section 13.4), which washes the colour
 * out of the frame.
 *
 * Everything here is pure arithmetic, so the tests run it headless and the
 * table is the same on every machine.
 *
 * The grade works on display values rather than on light: 0 is black, 1 is
 * white and a half is the grey halfway between them. The frame reaches it as
 * linear light, so `post.ts` encodes a colour before the lookup and decodes the
 * answer after it, with {@link LUT_GAMMA}. Grading light itself would put
 * almost the whole table above the brightness of a night street, and the lift
 * that warms a dusk shadow would turn a dark frame orange.
 */
import { clamp, lerp } from '../../core/math.ts';
import { CLEAR_WEATHER, type Weather } from '../../sim/city/weather.ts';
import type { Daylight } from '../environment/daylight.ts';
import { dayFraction } from '../environment/daylight.ts';
import { overcastOf } from '../environment/weather-look.ts';

/** A colour as three channels, black at 0 and white at 1. */
export type Rgb = readonly [number, number, number];

/** What the grade does to the frame. Every field leaves it alone at its neutral. */
export interface ColourGrade {
  /**
   * The power each channel is raised to before the contrast. 1 is neutral;
   * under 1 brightens the middle tones and leaves black and white where they
   * are, which is what puts a day frame into high key (`docs/art-style.md`).
   */
  key: number;
  /** Contrast about {@link PIVOT}. 1 is neutral; above it darkens the shadows. */
  contrast: number;
  /** How far colours are pushed from grey. 1 is neutral. */
  saturation: number;
  /** The colour the dark takes. Added into black and nothing into white; 0 is neutral. */
  lift: Rgb;
  /** The colour the light takes. Multiplies the whole frame; 1 is neutral. */
  gain: Rgb;
}

/** Mid grey. Contrast turns the frame about this value. */
const PIVOT = 0.5;

/**
 * How the frame is encoded for the table and decoded after it. A plain power
 * is enough: the table is a look, not a colour space conversion, and the same
 * number undoes it. It also spends the table where the eye is: half of the 16
 * entries stand below a quarter of the brightness.
 */
export const LUT_GAMMA = 2.2;

/** Rec. 709 luma: how much of the brightness each channel carries. */
const LUMA: Rgb = [0.2126, 0.7152, 0.0722];

/**
 * Colours each side of the cube. 16 is enough because every grade below is
 * smooth: the table is read with linear filtering, so a bend between two
 * neighbouring entries is what the frame sees. A larger cube would cost the
 * rebuild below without changing a pixel.
 */
export const LUT_SIZE = 16;

/** Numbers {@link writeLut} fills: four channels a colour, the whole cube. */
export const LUT_LENGTH = LUT_SIZE * LUT_SIZE * LUT_SIZE * 4;

/**
 * Times a day the table is rebuilt. One in-game day is 24 real minutes, so this
 * is a rebuild every six seconds: far finer than the eye follows the light, and
 * rare enough that the cost never lands in two frames running.
 */
export const GRADE_STEPS = 240;

/**
 * The grade at noon: high key and warm. The key lifts the middle tones so most
 * of the frame sits in the upper half of the brightness, and the contrast is
 * left alone so the shade stays light. The gain warms the lights and the lift
 * leans the dark toward lavender, as the shadow colour does (`shade.ts`).
 */
const DAY_GRADE: ColourGrade = {
  key: 0.74,
  contrast: 1,
  saturation: 1.18,
  lift: [0.004, 0.002, 0.01],
  gain: [1.02, 1, 0.97],
};

/**
 * The grade at sunrise and sunset. The hour the game is named for: the light
 * goes warm, the shadows warm with it, and the colour comes up.
 */
const DUSK_GRADE: ColourGrade = {
  key: 0.92,
  contrast: 1.02,
  saturation: 1.24,
  lift: [0.014, 0.005, 0],
  gain: [1.03, 0.99, 0.92],
};

/**
 * The grade after dark. The colour comes down, so the neon and the lit windows
 * carry the frame. The lift leans the dark toward indigo, so no street is ever
 * black; the gain cools the light only a little, or the indigo of the shadow
 * colour (`shade.ts`) went a royal blue.
 */
const NIGHT_GRADE: ColourGrade = {
  key: 1,
  contrast: 1.02,
  saturation: 0.95,
  lift: [0.13, 0.12, 0.165],
  gain: [0.98, 0.97, 1.03],
};

/**
 * The grade under cloud (spec section 13.4). The colour goes out of the frame,
 * the contrast with it, and what is left leans blue: a wet street reads as one
 * flat grey sheet, and the tail lights and neon on it are the only colour left.
 */
const CLOUD_GRADE: ColourGrade = {
  key: 1,
  contrast: 0.94,
  saturation: 0.72,
  lift: [0.004, 0.006, 0.012],
  gain: [0.94, 0.96, 1],
};

/**
 * The grade one moment of the day and its weather ask for.
 *
 * The day grade gives way to the night one as the light goes, and dusk is laid
 * over whatever that leaves: the sun stands on the horizon for a few minutes
 * either side of the turn, and that band is the one the eye reads as sunset.
 * The cloud grade goes over all of it, because rain at sunset is still rain.
 */
export function gradeAt(light: Daylight, weather: Weather = CLEAR_WEATHER): ColourGrade {
  const dark = mixGrade(DAY_GRADE, NIGHT_GRADE, light.night);
  const hour = mixGrade(dark, DUSK_GRADE, light.dusk);
  return mixGrade(hour, CLOUD_GRADE, overcastOf(weather));
}

/**
 * Which rebuild of the table a tick falls in. The table is rebuilt when this
 * changes and not otherwise, so the grade follows the day without the cube
 * being filled every frame.
 */
export function gradeStep(tick: number): number {
  return Math.floor(dayFraction(tick) * GRADE_STEPS);
}

/** What the grade makes of one colour. The whole of the grade is this function. */
export function gradeColour(grade: ColourGrade, rgb: Rgb): [number, number, number] {
  const { key, contrast, saturation, lift, gain } = grade;
  const red = channel(rgb[0] ** key, contrast, gain[0], lift[0]);
  const green = channel(rgb[1] ** key, contrast, gain[1], lift[1]);
  const blue = channel(rgb[2] ** key, contrast, gain[2], lift[2]);
  // Saturation last, about the brightness the frame already has, so pushing the
  // colour never changes how bright the pixel reads.
  const luma = red * LUMA[0] + green * LUMA[1] + blue * LUMA[2];
  return [
    clamp(luma + (red - luma) * saturation, 0, 1),
    clamp(luma + (green - luma) * saturation, 0, 1),
    clamp(luma + (blue - luma) * saturation, 0, 1),
  ];
}

/**
 * One channel through the grade: contrast about mid grey, then the colour of
 * the light and the colour of the dark. Lift is weighted by how bright the
 * channel already is, so it fills the shadows and leaves a white kerb white.
 */
function channel(value: number, contrast: number, gain: number, lift: number): number {
  const turned = (value - PIVOT) * contrast + PIVOT;
  return turned * gain + lift * (1 - clamp(turned, 0, 1));
}

/**
 * Where a colour stands in the cube: the first of its four numbers. This is the
 * order a `Data3DTexture` reads its data in — red along a row, green down a
 * slice, blue through the slices — so the array is uploaded as it stands.
 */
export function lutIndex(r: number, g: number, b: number): number {
  return ((b * LUT_SIZE + g) * LUT_SIZE + r) * 4;
}

/**
 * Fill the cube. `out` is {@link LUT_LENGTH} long. The alpha is never read —
 * the graded frame keeps its own — and is written as 1 so the texture is a
 * valid one.
 */
export function writeLut(grade: ColourGrade, out: Float32Array): void {
  const last = LUT_SIZE - 1;
  for (let b = 0; b < LUT_SIZE; b++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        const [red, green, blue] = gradeColour(grade, [r / last, g / last, b / last]);
        const i = lutIndex(r, g, b);
        out[i] = red;
        out[i + 1] = green;
        out[i + 2] = blue;
        out[i + 3] = 1;
      }
    }
  }
}

/** Blend two grades, field by field. */
function mixGrade(from: ColourGrade, to: ColourGrade, t: number): ColourGrade {
  return {
    key: lerp(from.key, to.key, t),
    contrast: lerp(from.contrast, to.contrast, t),
    saturation: lerp(from.saturation, to.saturation, t),
    lift: mixRgb(from.lift, to.lift, t),
    gain: mixRgb(from.gain, to.gain, t),
  };
}

function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}
