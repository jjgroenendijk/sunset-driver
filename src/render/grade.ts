/**
 * The colour grade of spec section 10.6.
 *
 * The frame is graded through a 3D lookup table: a small cube of colours that
 * says what every colour in the frame becomes. `post.ts` builds it into a
 * texture and reads it a pixel at a time, so the grade costs two texture
 * fetches a pixel however involved the maths here becomes.
 *
 * The build ships no image files (spec section 10.2), so the cube is generated
 * at runtime like every other texture in the game. It is generated again as the
 * day turns: the grade is a function of the light, warm at dusk and cool after
 * dark. Weather joins it when spec section 13.4 lands.
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
import { clamp, lerp } from '../core/math.ts';
import type { Daylight } from './daylight.ts';
import { dayFraction } from './daylight.ts';

/** A colour as three channels, black at 0 and white at 1. */
export type Rgb = readonly [number, number, number];

/** What the grade does to the frame. Every field leaves it alone at its neutral. */
export interface ColourGrade {
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

/**
 * The cube is laid out as a strip: the blue slices side by side in one row of
 * squares, red across a square and green down it. A real 3D texture would say
 * this more plainly, and `Lut3DNode` would then read it, but three.js 0.186
 * cannot upload one: see `post.ts`.
 */
export const LUT_WIDTH = LUT_SIZE * LUT_SIZE;
export const LUT_HEIGHT = LUT_SIZE;

/** Numbers {@link writeLut} fills: four channels a colour, the whole strip. */
export const LUT_LENGTH = LUT_WIDTH * LUT_HEIGHT * 4;

/**
 * Times a day the table is rebuilt. One in-game day is 24 real minutes, so this
 * is a rebuild every six seconds: far finer than the eye follows the light, and
 * rare enough that the cost never lands in two frames running.
 */
export const GRADE_STEPS = 240;

/** The grade at noon: the frame as it is, with a little more life in it. */
const DAY_GRADE: ColourGrade = {
  contrast: 1.06,
  saturation: 1.08,
  lift: [0, 0.002, 0.006],
  gain: [1, 1, 0.995],
};

/**
 * The grade at sunrise and sunset. The hour the game is named for: the light
 * goes warm, the shadows warm with it, and the colour comes up.
 */
const DUSK_GRADE: ColourGrade = {
  contrast: 1.02,
  saturation: 1.16,
  lift: [0.014, 0.005, 0],
  gain: [1.06, 0.99, 0.92],
};

/**
 * The grade after dark. The shadows go blue and the colour comes down, so the
 * neon and the lit windows are what carries the frame rather than competing
 * with a street that is still trying to be brown.
 */
const NIGHT_GRADE: ColourGrade = {
  contrast: 1.12,
  saturation: 0.95,
  lift: [0, 0.004, 0.016],
  gain: [0.94, 0.97, 1.08],
};

/**
 * The grade one moment of the day asks for.
 *
 * The day grade gives way to the night one as the light goes, and dusk is laid
 * over whatever that leaves: the sun stands on the horizon for a few minutes
 * either side of the turn, and that band is the one the eye reads as sunset.
 */
export function gradeAt(light: Daylight): ColourGrade {
  const dark = mixGrade(DAY_GRADE, NIGHT_GRADE, light.night);
  return mixGrade(dark, DUSK_GRADE, light.dusk);
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
  const { contrast, saturation, lift, gain } = grade;
  const red = channel(rgb[0], contrast, gain[0], lift[0]);
  const green = channel(rgb[1], contrast, gain[1], lift[1]);
  const blue = channel(rgb[2], contrast, gain[2], lift[2]);
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
 * Where a colour of the cube stands in the strip: the first of its four
 * numbers. Green is the row, and blue then red run along it.
 */
export function lutIndex(r: number, g: number, b: number): number {
  return (g * LUT_WIDTH + b * LUT_SIZE + r) * 4;
}

/**
 * Fill the strip. `out` is {@link LUT_LENGTH} long. The alpha is never read —
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
    contrast: lerp(from.contrast, to.contrast, t),
    saturation: lerp(from.saturation, to.saturation, t),
    lift: mixRgb(from.lift, to.lift, t),
    gain: mixRgb(from.gain, to.gain, t),
  };
}

function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}
