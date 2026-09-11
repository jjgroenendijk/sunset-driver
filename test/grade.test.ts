import { describe, expect, it } from 'vitest';
import { daylightAt, tickAtHour } from '../src/render/daylight.ts';
import {
  gradeAt,
  gradeColour,
  gradeStep,
  lutIndex,
  writeLut,
  GRADE_STEPS,
  LUT_LENGTH,
  LUT_SIZE,
  type ColourGrade,
} from '../src/render/grade.ts';
import { TICKS_PER_DAY } from '../src/sim/clock.ts';

/** A grade that leaves every colour where it found it. */
const NEUTRAL: ColourGrade = { contrast: 1, saturation: 1, lift: [0, 0, 0], gain: [1, 1, 1] };

/**
 * How far from the identity the grade of any hour may take a channel: a fifth
 * of the range, and only a colour already at the edge of it reaches that far.
 * Spec section 10.6 asks for a subtle grade, and this is what subtle means.
 */
const SUBTLE = 0.2;

/** The grade at an hour of the first day. */
function at(hour: number): ColourGrade {
  return gradeAt(daylightAt(tickAtHour(hour)));
}

/** The cube the grade of an hour builds. */
function lutAt(hour: number): Float32Array {
  const out = new Float32Array(LUT_LENGTH);
  writeLut(at(hour), out);
  return out;
}

describe('a colour grade', () => {
  it('leaves the frame alone when it is neutral', () => {
    for (const colour of [0, 0.18, 0.5, 1]) {
      const [r, g, b] = gradeColour(NEUTRAL, [colour, colour, colour]);
      expect(r).toBeCloseTo(colour, 6);
      expect(g).toBeCloseTo(colour, 6);
      expect(b).toBeCloseTo(colour, 6);
    }
  });

  it('never answers outside the range a display can show', () => {
    for (const hour of [0, 6, 12, 18, 21]) {
      for (const value of lutAt(hour)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is subtle at every hour: the look is the lighting, not the grade', () => {
    const last = LUT_SIZE - 1;
    for (let hour = 0; hour < 24; hour++) {
      const lut = lutAt(hour);
      for (let b = 0; b < LUT_SIZE; b++) {
        for (let g = 0; g < LUT_SIZE; g++) {
          for (let r = 0; r < LUT_SIZE; r++) {
            const i = lutIndex(r, g, b);
            expect(Math.abs((lut[i] ?? 0) - r / last)).toBeLessThan(SUBTLE);
            expect(Math.abs((lut[i + 1] ?? 0) - g / last)).toBeLessThan(SUBTLE);
            expect(Math.abs((lut[i + 2] ?? 0) - b / last)).toBeLessThan(SUBTLE);
          }
        }
      }
    }
  });

  it('keeps a brighter colour brighter, so nothing in the frame is inverted', () => {
    const grade = at(21);
    let previous = -1;
    for (let step = 0; step < LUT_SIZE; step++) {
      const [red] = gradeColour(grade, [step / (LUT_SIZE - 1), 0.4, 0.4]);
      expect(red).toBeGreaterThanOrEqual(previous);
      previous = red;
    }
  });
});

describe('the grade of the day', () => {
  it('warms the light at sunrise and at sunset', () => {
    for (const hour of [6, 18]) {
      const { gain } = at(hour);
      expect(gain[0]).toBeGreaterThan(gain[2]);
    }
  });

  it('cools it after dark, and lifts the shadows toward blue', () => {
    const { gain, lift } = at(0);
    expect(gain[2]).toBeGreaterThan(gain[0]);
    expect(lift[2]).toBeGreaterThan(lift[0]);
  });

  it('takes the colour down at night and up at dusk, against noon', () => {
    expect(at(0).saturation).toBeLessThan(at(12).saturation);
    expect(at(18).saturation).toBeGreaterThan(at(12).saturation);
  });

  it('grades the same tick of every day alike', () => {
    for (const hour of [3, 12, 19]) {
      const tick = tickAtHour(hour);
      expect(gradeAt(daylightAt(tick + TICKS_PER_DAY * 3))).toEqual(gradeAt(daylightAt(tick)));
    }
  });
});

describe('the rebuild of the cube', () => {
  it('happens a fixed number of times a day, and no more', () => {
    const steps = new Set<number>();
    for (let tick = 0; tick < TICKS_PER_DAY; tick += 8) steps.add(gradeStep(tick));
    expect(steps.size).toBe(GRADE_STEPS);
  });

  it('holds one table across the ticks of a step', () => {
    const perStep = TICKS_PER_DAY / GRADE_STEPS;
    expect(gradeStep(0)).toBe(gradeStep(perStep - 1));
    expect(gradeStep(perStep)).toBe(1);
    expect(gradeStep(TICKS_PER_DAY * 5 + perStep)).toBe(1);
  });
});
