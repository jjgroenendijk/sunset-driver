import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../../../src/sim/clock.ts';
import { beachShare, fillAt, surfShare } from '../../../src/sim/city/beach-hours.ts';
import { BeachLife, type BeachKind, type PlacedBeachProp } from '../../../src/sim/city/beach-life.ts';
import { CLEAR_WEATHER, namedWeather, weatherAt, type Weather } from '../../../src/sim/city/weather.ts';
import type { Gait } from '../../../src/sim/crowd/pedestrian-look.ts';
import type { WaitingPassenger } from '../../../src/sim/transit/stop-queue.ts';
import type { Beach, Point } from '../../../src/world/types.ts';
import { sweepSeeds } from '../../support/helpers.ts';

/**
 * The beach life of spec section 20.1, run headless on a straight beach: a
 * kilometre and a half of waterline along y = 0 with the sea to the south,
 * the dune line 40 m inland, and sand that rises a metre over it.
 */
const SEEDS = sweepSeeds(4);
const SEA = 0;
const LENGTH = 1500;
const DUNE = 40;

function beach(): Beach {
  const shore: Point[] = [];
  const back: Point[] = [];
  for (let s = 0; s <= LENGTH; s += 12) {
    shore.push({ x: s, y: 0 });
    back.push({ x: s, y: DUNE });
  }
  return {
    id: 3,
    shore,
    back,
    length: LENGTH,
    sand: [...shore, ...[...back].reverse()],
    shallows: [],
    boardwalk: [],
    boardwalkRoad: -1,
    pier: undefined,
    carParks: [],
    districts: [0],
  };
}

const heightAt = (_x: number, y: number): number => SEA + 0.2 + Math.max(0, y) / DUNE;

function lifeOf(seed: number, weather: Weather = CLEAR_WEATHER): BeachLife {
  const life = new BeachLife(seed, { beaches: [beach()], seaLevel: SEA, heightAt });
  life.weather = weather;
  return life;
}

/** The tick of an hour of a day. */
const at = (hour: number, day = 0): number => Math.round((day + hour / 24) * TICKS_PER_DAY);

/** A weather with only the numbers the beach reads set. */
function weather(rain: number, wind: number, fog = CLEAR_WEATHER.fog): Weather {
  return { ...CLEAR_WEATHER, kind: rain > 0 ? 'rain' : 'clear', rain, wind, fog };
}

function everyone(life: BeachLife, tick: number): WaitingPassenger[] {
  const out: WaitingPassenger[] = [];
  const count = life.passengers(-1e6, -1e6, 1e6, 1e6, tick, out);
  return out.slice(0, count);
}

function gaits(life: BeachLife, tick: number): Set<Gait> {
  return new Set(everyone(life, tick).map((person) => person.pose.gait));
}

describe('the beach life of spec section 20.1', () => {
  it('lays out the same beach for the same seed, and every kind somewhere', () => {
    const kinds = new Set<BeachKind>();
    for (const seed of SEEDS) {
      const a = lifeOf(seed);
      expect(lifeOf(seed).spots).toEqual(a.spots);
      for (const spot of a.spots) kinds.add(spot.kind);
      expect(a.runners.length).toBeGreaterThan(0);
    }
    for (const kind of ['towels', 'swimmers', 'volleyball', 'surfers', 'lifeguard', 'icecream', 'cocktail', 'bonfire'] as const) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });

  it('fills on a clear afternoon, thins in rain and empties in a storm', () => {
    for (const seed of SEEDS) {
      const tick = at(14);
      const clear = lifeOf(seed).countOut(tick);
      const drizzle = lifeOf(seed, weather(0.15, 0.2)).countOut(tick);
      const rain = lifeOf(seed, weather(0.35, 0.2)).countOut(tick);
      const storm = lifeOf(seed, namedWeather('storm')).countOut(tick);
      expect(clear).toBeGreaterThan(40);
      expect(drizzle).toBeLessThan(clear);
      expect(rain).toBeLessThan(drizzle);
      expect(storm).toBe(0);
    }
  });

  it('empties at a drizzle the pavement carries on through', () => {
    const drizzle = weather(0.3, 0.3);
    // A rain spell keeps most of the pavement crowd out.
    expect(beachShare(drizzle)).toBeLessThan(0.5);
    expect(beachShare(namedWeather('rain') as Weather)).toBe(0);
    expect(beachShare(CLEAR_WEATHER)).toBe(1);
  });

  it('sends people home one at a time: who is out in rain is out in the sun', () => {
    const seed = SEEDS[0] as number;
    const key = (p: WaitingPassenger): string => `${p.pose.x.toFixed(2)},${p.pose.y.toFixed(2)}`;
    const sunny = new Set(everyone(lifeOf(seed), at(15)).map(key));
    for (const person of everyone(lifeOf(seed, weather(0.25, 0.2)), at(15))) expect(sunny.has(key(person))).toBe(true);
  });

  it('keeps to the hours: towels by day, fires and dancing after dark', () => {
    const seed = SEEDS[1] as number;
    const noon = gaits(lifeOf(seed), at(13));
    expect(noon.has('lie')).toBe(true);
    expect(noon.has('dance')).toBe(false);
    let danced = false;
    for (let day = 0; day < 6 && !danced; day++) danced = SEEDS.some((s) => gaits(lifeOf(s), at(23.5, day)).has('dance'));
    expect(danced).toBe(true);
    const late = gaits(lifeOf(seed), at(23.5));
    expect(late.has('lie')).toBe(false);
    expect(late.has('swim')).toBe(false);
  });

  it('puts the surfers out only when the swell is up, and brings them in for a storm', () => {
    expect(surfShare(CLEAR_WEATHER)).toBe(0);
    expect(surfShare(weather(0.2, 0.5))).toBeGreaterThan(0.5);
    expect(surfShare(namedWeather('storm') as Weather)).toBe(0);
    const surfing = (life: BeachLife): number => everyone(life, at(11)).filter((p) => p.pose.gait === 'surf' && p.pose.speed === 0).length;
    let windy = 0;
    for (const seed of SEEDS) {
      expect(surfing(lifeOf(seed))).toBe(0);
      windy += surfing(lifeOf(seed, weather(0.1, 0.5)));
    }
    expect(windy).toBeGreaterThan(0);
  });

  it('stands swimmers and surfers in the sea and everyone else on the sand', () => {
    const seed = SEEDS[2] as number;
    for (const { pose } of everyone(lifeOf(seed, weather(0.05, 0.5)), at(12))) {
      if (pose.gait === 'swim' || (pose.gait === 'surf' && pose.speed === 0)) {
        expect(pose.y).toBeLessThan(0);
        expect(pose.height).toBeLessThan(SEA + 0.5);
      } else {
        expect(pose.y).toBeGreaterThanOrEqual(-3);
        expect(pose.y).toBeLessThanOrEqual(DUNE + 3);
      }
    }
  });

  it('reads a tick the same whatever was read before it', () => {
    const seed = SEEDS[3] as number;
    const fresh = everyone(lifeOf(seed), at(16.25)).map((p) => ({ ...p.pose }));
    const used = lifeOf(seed);
    for (let h = 0; h < 24; h += 3) used.countOut(at(h, 2));
    expect(everyone(used, at(16.25)).map((p) => ({ ...p.pose }))).toEqual(fresh);
  });

  it('runs the joggers and the skaters to and fro along the dune line, a step at a time', () => {
    const life = lifeOf(SEEDS[0] as number);
    const before = new Map<number, { x: number; y: number }>();
    const runnersAt = (tick: number): WaitingPassenger[] => everyone(life, tick).filter((p) => p.pose.speed > 0);
    for (const [i, { pose }] of runnersAt(at(8)).entries()) {
      expect(pose.y).toBeGreaterThan(DUNE - 4);
      expect(pose.x).toBeGreaterThanOrEqual(0);
      expect(pose.x).toBeLessThanOrEqual(LENGTH);
      before.set(i, { x: pose.x, y: pose.y });
    }
    expect(before.size).toBeGreaterThan(0);
    for (const [i, { pose }] of runnersAt(at(8) + 1).entries()) {
      const was = before.get(i);
      if (was !== undefined) expect(Math.hypot(pose.x - was.x, pose.y - was.y)).toBeLessThan(0.2);
    }
  });

  it('keeps the towers and the stands standing in a storm, and puts the towels away', () => {
    const props: PlacedBeachProp[] = [];
    const kinds = (life: BeachLife): Set<string> => {
      const count = life.props(-1e6, -1e6, 1e6, 1e6, at(14), props);
      return new Set(props.slice(0, count).map((p) => p.kind));
    };
    const seed = SEEDS[0] as number;
    const sunny = kinds(lifeOf(seed));
    const storm = kinds(lifeOf(seed, namedWeather('storm')));
    expect(sunny.has('towel')).toBe(true);
    expect(storm.has('towel')).toBe(false);
    expect(storm.has('tower')).toBe(true);
  });

  it('counts a night past midnight as the day it began on', () => {
    expect(fillAt('party', at(1, 3)).day).toBe(2);
    expect(fillAt('party', at(22, 3)).day).toBe(3);
    expect(fillAt('towels', at(8, 1)).fill).toBe(0);
    expect(fillAt('towels', at(14, 1)).fill).toBe(1);
  });

  it('is empty in the weather of the seed whenever that weather is a storm', () => {
    const seed = SEEDS[0] as number;
    for (let tick = at(9); tick < at(9, 4); tick += at(1)) {
      const now = weatherAt(seed, tick);
      if (now.kind !== 'storm' || now.rain < 0.55) continue;
      expect(lifeOf(seed, now).countOut(tick)).toBe(0);
    }
  });
});
