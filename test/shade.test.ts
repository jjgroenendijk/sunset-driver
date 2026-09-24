import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import { daylightAt, tickAtHour, SOLAR_NOON_HOUR, SUNRISE_HOUR, SUNSET_HOUR } from '../src/render/daylight.ts';
import { luma, shadowColourAt, shadowLight } from '../src/render/shade.ts';

const at = (hour: number) => daylightAt(tickAtHour(hour));
const hex = (colour: Color) => colour.getHex();

/** How far a colour stands from grey: its widest channel less its narrowest. */
const chroma = (colour: Color) => Math.max(colour.r, colour.g, colour.b) - Math.min(colour.r, colour.g, colour.b);

describe('the shadow colour', () => {
  it('is the lavender of the art style at noon and navy at midnight', () => {
    expect(hex(at(SOLAR_NOON_HOUR).shadow)).toBe(0x8f8fc0);
    expect(hex(at(0).shadow)).toBe(0x232450);
  });

  it('is a different colour at dawn than at dusk, with the sun as high', () => {
    const dawn = shadowColourAt(0, true);
    const dusk = shadowColourAt(0, false);
    expect(hex(dawn)).toBe(0xa98bb8);
    expect(hex(dusk)).not.toBe(hex(dawn));
    expect(luma(dusk)).toBeLessThan(luma(dawn) * 0.8);
    expect(dusk.b / dusk.r).toBeGreaterThan(dawn.b / dawn.r);
  });

  it('turns rose in the golden hour before sunset', () => {
    const golden = at(SUNSET_HOUR - 0.8).shadow;
    expect(golden.r).toBeGreaterThan(at(SOLAR_NOON_HOUR).shadow.r * 0.9);
    expect(golden.r - golden.g).toBeGreaterThan(0);
  });

  it('is never a neutral grey, at any hour', () => {
    for (let hour = 0; hour < 24; hour += 0.25) {
      expect(chroma(at(hour).shadow), `at ${hour}h`).toBeGreaterThan(0.02);
    }
  });

  it('leans blue at every hour, the cool side of warm light', () => {
    for (let hour = 0; hour < 24; hour += 0.25) {
      const shadow = at(hour).shadow;
      expect(shadow.b, `at ${hour}h`).toBeGreaterThan(Math.max(shadow.r, shadow.g));
    }
  });
});

describe('the fill', () => {
  it('carries the shadow hue at a luma of 1', () => {
    for (const hour of [SUNRISE_HOUR, SOLAR_NOON_HOUR, SUNSET_HOUR, 0]) {
      const light = at(hour);
      expect(luma(light.fillSky)).toBeCloseTo(1, 5);
      expect(light.fillSky.b).toBeGreaterThan(light.fillSky.r);
    }
  });

  it('keeps some white, so a lit blue wall is still brighter than one in shade', () => {
    const fill = shadowLight(new Color(0x232450));
    expect(Math.min(fill.r, fill.g, fill.b)).toBeGreaterThan(0.2);
  });
});
