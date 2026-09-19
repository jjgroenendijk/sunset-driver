import { describe, expect, it } from 'vitest';
import { daylightAt, dayFraction, NOON_ALTITUDE, sunDirection, tickAtHour } from '../src/render/daylight.ts';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../src/sim/clock.ts';

/** How close two floats have to be to count as the same light. */
const CLOSE = 6;

/** The light at an hour of the first day. */
function at(hour: number) {
  return daylightAt(tickAtHour(hour));
}

describe('the day', () => {
  it('is 86 400 ticks, which is 24 real minutes', () => {
    expect(TICKS_PER_DAY).toBe(86_400);
    expect(TICKS_PER_DAY / 60 / 60).toBe(24);
  });

  it('starts at midnight and turns over at the end of the day', () => {
    expect(dayFraction(0)).toBe(0);
    expect(dayFraction(TICKS_PER_DAY / 2)).toBeCloseTo(0.5, CLOSE);
    expect(dayFraction(TICKS_PER_DAY)).toBe(0);
    expect(dayFraction(TICKS_PER_DAY * 3 + 17)).toBe(dayFraction(17));
  });

  it('lights the same tick of every day alike', () => {
    for (const hour of [0, 5, 11, 18, 23]) {
      const first = daylightAt(tickAtHour(hour));
      const later = daylightAt(tickAtHour(hour) + TICKS_PER_DAY * 4);
      expect(later.altitude).toBeCloseTo(first.altitude, CLOSE);
      expect(later.night).toBeCloseTo(first.night, CLOSE);
      expect(later.sunIntensity).toBeCloseTo(first.sunIntensity, CLOSE);
    }
  });
});

describe('the sun', () => {
  it('keeps to a unit circle all day', () => {
    for (let tick = 0; tick < TICKS_PER_DAY; tick += TICKS_PER_HOUR / 4) {
      expect(sunDirection(tick).length()).toBeCloseTo(1, CLOSE);
    }
  });

  it('rises in the east, stands highest at noon and sets in the west', () => {
    const dawn = sunDirection(tickAtHour(6));
    expect(dawn.y).toBeCloseTo(0, CLOSE);
    expect(dawn.x).toBeCloseTo(1, CLOSE);

    const noon = sunDirection(tickAtHour(12));
    expect(noon.y).toBeCloseTo(NOON_ALTITUDE, CLOSE);
    expect(noon.x).toBeCloseTo(0, CLOSE);

    const dusk = sunDirection(tickAtHour(18));
    expect(dusk.y).toBeCloseTo(0, CLOSE);
    expect(dusk.x).toBeCloseTo(-1, CLOSE);

    expect(sunDirection(0).y).toBeCloseTo(-NOON_ALTITUDE, CLOSE);
  });

  it('climbs to noon and falls from it', () => {
    for (let hour = 0; hour < 12; hour++) {
      expect(at(hour + 1).altitude).toBeGreaterThan(at(hour).altitude);
    }
    for (let hour = 12; hour < 24; hour++) {
      expect(at(hour + 1).altitude).toBeLessThan(at(hour).altitude);
    }
  });

  it('burns nothing once it is under the horizon', () => {
    for (let tick = 0; tick < TICKS_PER_DAY; tick += TICKS_PER_HOUR / 4) {
      const light = daylightAt(tick);
      if (light.altitude < -0.05) expect(light.sunIntensity).toBe(0);
    }
    expect(at(12).sunIntensity).toBeGreaterThan(at(7).sunIntensity);
  });

  it('leaves a street in shade at noon about a third as bright as one in the sun', () => {
    // Level ground: the sun by how high it stands, the sky fill from straight
    // above. Much less, and the city in its own shadow reads as dusk at noon.
    const noon = at(12);
    const luma = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const shade = luma(noon.fillSky) * noon.fillIntensity;
    const sun = luma(noon.sunColour) * noon.sunIntensity * noon.altitude + shade;
    expect(shade / sun).toBeGreaterThan(0.25);
    expect(shade / sun).toBeLessThan(0.5);
  });

  it('burns orange on the horizon and white overhead', () => {
    const low = at(6).sunColour;
    const high = at(12).sunColour;
    expect(low.r - low.b).toBeGreaterThan(high.r - high.b);
  });
});

describe('night', () => {
  it('is gone by day and complete at midnight', () => {
    expect(at(12).night).toBe(0);
    expect(at(0).night).toBe(1);
  });

  it('closes in through the evening and lifts through the morning', () => {
    for (let hour = 12; hour < 23; hour++) {
      expect(at(hour + 1).night).toBeGreaterThanOrEqual(at(hour).night);
    }
    for (let hour = 0; hour < 11; hour++) {
      expect(at(hour + 1).night).toBeLessThanOrEqual(at(hour).night);
    }
  });

  it('fills the shadows more weakly than the day does', () => {
    // The fill is a hemisphere light, so its strength is read against its
    // colour: the night sky is a tenth of the day's before either is scaled.
    const day = at(12);
    const night = at(0);
    expect(night.fillSky.r).toBeLessThan(day.fillSky.r * 0.2);
    expect(night.fillGround.r).toBeLessThan(day.fillGround.r * 0.5);
  });

  it('turns the haze from day blue through a warm dusk to near black', () => {
    const day = at(12).haze;
    const dusk = at(18).haze;
    const night = at(0).haze;
    expect(dusk.r - dusk.b).toBeGreaterThan(day.r - day.b);
    expect(night.r + night.g + night.b).toBeLessThan(day.r + day.g + day.b);
  });
});

describe('the street lamps', () => {
  it('are off in the middle of the day and full on at midnight', () => {
    expect(at(12).lamps).toBe(0);
    expect(at(0).lamps).toBe(1);
  });

  it('come on before the light has gone, and go off after it is back', () => {
    // Dusk is lit from both ends: the lamps are already burning while the sun
    // is still above the horizon.
    expect(at(18).lamps).toBeGreaterThan(0);
    expect(at(18).altitude).toBeGreaterThanOrEqual(0);
    expect(at(6).lamps).toBeGreaterThan(0);
    expect(at(19.5).lamps).toBe(1);
    expect(at(7).lamps).toBe(0);
  });
});

describe('tickAtHour', () => {
  it('lands on the hour and stays inside the day', () => {
    expect(tickAtHour(0)).toBe(0);
    expect(tickAtHour(6)).toBe(6 * TICKS_PER_HOUR);
    expect(tickAtHour(24)).toBe(0);
    expect(tickAtHour(-5)).toBe(0);
    expect(tickAtHour(99)).toBe(0);
  });
});
