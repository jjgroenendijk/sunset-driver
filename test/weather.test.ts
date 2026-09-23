import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../src/sim/clock.ts';
import {
  CLEAR_WEATHER,
  DRY_TICKS,
  namedWeather,
  outInThis,
  SPELL_TICKS,
  weatherAt,
  wetnessAt,
  type Weather,
  type WeatherKind,
} from '../src/sim/weather.ts';
import { gripOf, WET_GRIP } from '../src/sim/vehicle.ts';
import { daylightAt, tickAtHour } from '../src/render/daylight.ts';
import { gradeAt } from '../src/render/grade.ts';
import { fogRange, overcast, overcastOf } from '../src/render/weather-look.ts';

/** Seeds the weather is read on. Nothing here may depend on which one. */
const SEEDS = [1, 7, 4242, 0xbeef, 123_456_789];

/** Every field of a weather, which all run 0 to 1. */
const FIELDS: (keyof Weather)[] = ['rain', 'wetness', 'fog', 'wind', 'crowd'];

/** A day of weather at a sample every quarter hour. */
function overADay(seed: number, day = 0): Weather[] {
  const out: Weather[] = [];
  for (let tick = 0; tick < TICKS_PER_DAY; tick += TICKS_PER_HOUR / 4) {
    out.push(weatherAt(seed, day * TICKS_PER_DAY + tick));
  }
  return out;
}

describe('the weather', () => {
  it('is a pure function of the seed and the tick', () => {
    for (const seed of SEEDS) {
      for (const tick of [0, 1, 5_000, 90_123, TICKS_PER_DAY * 3 + 77]) {
        expect(weatherAt(seed, tick)).toEqual(weatherAt(seed, tick));
      }
    }
  });

  it('keeps every field between 0 and 1', () => {
    for (const seed of SEEDS) {
      for (const weather of overADay(seed)) {
        for (const field of FIELDS) expect(weather[field]).toBeGreaterThanOrEqual(0);
        for (const field of FIELDS) expect(weather[field]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('changes over a day', () => {
    for (const seed of SEEDS) {
      const kinds = new Set<WeatherKind>(overADay(seed).map((weather) => weather.kind));
      expect(kinds.size).toBeGreaterThan(1);
    }
  });

  it('gives a different day different weather', () => {
    for (const seed of SEEDS) {
      const first = overADay(seed, 0).map((weather) => weather.kind).join();
      const fourth = overADay(seed, 3).map((weather) => weather.kind).join();
      expect(fourth).not.toBe(first);
    }
  });

  it('gives two seeds different weather', () => {
    const days = SEEDS.map((seed) => overADay(seed).map((weather) => weather.kind).join());
    expect(new Set(days).size).toBe(SEEDS.length);
  });

  it('never jumps: a tick moves nothing far', () => {
    for (const seed of SEEDS) {
      let last = weatherAt(seed, 0);
      for (let tick = 1; tick < SPELL_TICKS * 6; tick += 7) {
        const now = weatherAt(seed, tick);
        for (const field of FIELDS) {
          expect(Math.abs((now[field] as number) - (last[field] as number))).toBeLessThan(0.02);
        }
        last = now;
      }
    }
  });

  it('brings all four kinds up over a week', () => {
    const kinds = new Set<WeatherKind>();
    for (let day = 0; day < 7; day++) for (const weather of overADay(SEEDS[0] as number, day)) kinds.add(weather.kind);
    expect([...kinds].sort()).toEqual(['clear', 'fog', 'rain', 'storm']);
  });
});

describe('the wetness', () => {
  it('is dry when nothing has fallen and wet when it has', () => {
    // A seed is searched for a wet hour and a dry one rather than assumed: the
    // weather belongs to the seed, not to the test.
    let wettest = 0;
    let driest = 1;
    for (const seed of SEEDS) {
      for (const weather of overADay(seed)) {
        wettest = Math.max(wettest, weather.wetness);
        driest = Math.min(driest, weather.wetness);
      }
    }
    expect(wettest).toBeGreaterThan(0.4);
    expect(driest).toBeLessThan(0.05);
  });

  it('lags the rain: the road is still wet after it stops', () => {
    // The tick the rain is hardest at, and the road an hour after it.
    for (const seed of SEEDS) {
      let peak = 0;
      let best = 0;
      for (let tick = 0; tick < TICKS_PER_DAY; tick += TICKS_PER_HOUR / 8) {
        const rain = weatherAt(seed, tick).rain;
        if (rain > best) {
          best = rain;
          peak = tick;
        }
      }
      if (best < 0.5) continue;
      expect(wetnessAt(seed, peak + DRY_TICKS)).toBeGreaterThan(0.1);
    }
  });

  it('reads the same backwards as a session that watched it rain', () => {
    // Nothing accumulates, so a tick read on its own equals the same tick
    // reached by walking there.
    for (let tick = 0; tick < SPELL_TICKS * 3; tick += 331) {
      expect(wetnessAt(11, tick)).toBe(weatherAt(11, tick).wetness);
    }
  });
});

describe('a wet road', () => {
  it('holds less than a dry one', () => {
    const dry = gripOf('asphalt', 0);
    const wet = gripOf('asphalt', 1);
    expect(wet.friction).toBeCloseTo(dry.friction * WET_GRIP, 6);
    expect(wet.side).toBeLessThan(dry.side);
  });

  it('gives up its grip in step with the water on it', () => {
    const half = gripOf('asphalt', 0.5).friction;
    expect(half).toBeLessThan(gripOf('asphalt', 0).friction);
    expect(half).toBeGreaterThan(gripOf('asphalt', 1).friction);
  });
});

describe('the look of the weather', () => {
  it('leaves a clear day alone', () => {
    expect(overcastOf(CLEAR_WEATHER)).toBeLessThan(0.05);
    expect(fogRange(500, 750, CLEAR_WEATHER).far).toBeGreaterThan(700);
  });

  it('puts the sun behind cloud and the lamps on', () => {
    const noon = daylightAt(tickAtHour(12));
    const storm = overcast(noon, { ...CLEAR_WEATHER, kind: 'storm', rain: 1, fog: 0.5, wind: 1, crowd: 0.3 });
    expect(storm.sunIntensity).toBeLessThan(noon.sunIntensity * 0.5);
    expect(storm.fillIntensity).toBeGreaterThan(noon.fillIntensity);
    expect(storm.lamps).toBeGreaterThan(noon.lamps);
  });

  it('closes the draw distance in fog and never opens it', () => {
    // Thick fog has to come inside the hundred metres the camera sees, or the
    // draw distance is cut where nobody is looking.
    const thick = fogRange(500, 750, { ...CLEAR_WEATHER, kind: 'fog', fog: 1 });
    expect(thick.far).toBeLessThan(150);
    expect(thick.near).toBeLessThan(thick.far);
    for (const seed of SEEDS) {
      for (const weather of overADay(seed)) {
        const range = fogRange(500, 750, weather);
        expect(range.far).toBeLessThanOrEqual(750);
        expect(range.near).toBeLessThan(range.far);
      }
    }
  });

  it('washes the colour out of the frame', () => {
    const noon = daylightAt(tickAtHour(12));
    const clear = gradeAt(noon, CLEAR_WEATHER);
    const wet = gradeAt(noon, { ...CLEAR_WEATHER, kind: 'rain', rain: 1 });
    expect(wet.saturation).toBeLessThan(clear.saturation);
  });
});

describe('the crowd hook', () => {
  it('keeps everyone out on a clear day', () => {
    for (let id = 0; id < 200; id++) expect(outInThis(id, 1)).toBe(true);
  });

  it('thins the street in proportion to the share', () => {
    for (const share of [0.25, 0.5, 0.75]) {
      let out = 0;
      for (let id = 0; id < 4000; id++) if (outInThis(id, share)) out++;
      expect(out / 4000).toBeCloseTo(share, 1);
    }
  });

  it('keeps the same people out, so nobody flickers', () => {
    for (let id = 0; id < 200; id++) expect(outInThis(id, 0.5)).toBe(outInThis(id, 0.5));
    // Anyone out in a storm is out in a shower: the shares nest.
    for (let id = 0; id < 200; id++) if (outInThis(id, 0.3)) expect(outInThis(id, 0.8)).toBe(true);
  });
});

describe('the weather a preview names', () => {
  it('is clear when none is named, and the seed\'s own when asked for', () => {
    expect(namedWeather(undefined)).toEqual(CLEAR_WEATHER);
    expect(namedWeather('seed')).toBeUndefined();
  });

  it('is the named kind at full strength, with the road as wet as its rain', () => {
    const storm = namedWeather('storm');
    expect(storm?.kind).toBe('storm');
    expect(storm?.rain).toBe(1);
    expect(storm?.wetness).toBe(1);
    expect(namedWeather('fog')?.rain).toBe(0);
  });

  it('refuses a name that is not a weather', () => {
    expect(() => namedWeather('snow')).toThrow(/snow/);
  });
});
