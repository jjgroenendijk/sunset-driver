import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../src/sim/clock.ts';
import type { Place } from '../src/sim/on-foot.ts';
import { createSimState, type SimState } from '../src/sim/simulation.ts';
import {
  CRIMES,
  CRIME_ORDER,
  INTERRUPT_RANGE,
  SLOT_TICKS,
  crimeGrounds,
  crimesAt,
  settledOf,
  stepStreetCrime,
  type CrimeGround,
  type StreetCrime,
} from '../src/sim/street-crime.ts';
import type { District } from '../src/world/types.ts';

/**
 * The street crime of spec section 20.5, run headless. The districts below are
 * a made-up city; every point in it has a street under it, so each district
 * keeps its full set of corners.
 */
const districts: District[] = [
  { id: 0, name: 'Downtown', zone: 'core', x: 0, y: 0, density: 0.9, wealth: 0.6, culture: 'none' },
  { id: 1, name: 'The Docks', zone: 'industrial', x: 600, y: 0, density: 0.6, wealth: 0.2, culture: 'none' },
  { id: 2, name: 'Hillside', zone: 'suburban', x: -600, y: 0, density: 0.3, wealth: 0.8, culture: 'none' },
  { id: 3, name: 'Wilds', zone: 'wilderness', x: 0, y: 1500, density: 0.02, wealth: 0.1, culture: 'none' },
];

const snap = (x: number, y: number): Place => ({ x, y, heading: 0 });
const grounds: CrimeGround[] = crimeGrounds(5, districts, snap);

/** A session standing well away from anything, on foot. */
function session(seed = 5): SimState {
  const state = createSimState(seed);
  state.player.driving = false;
  state.player.x = 100000;
  state.player.y = 100000;
  return state;
}

/** The first incident of a kind on or after a tick, with the tick it is live at. */
function find(seed: number, breakable: boolean): { crime: StreetCrime; tick: number } {
  for (let tick = 0; tick < 6 * TICKS_PER_DAY; tick += SLOT_TICKS) {
    for (const crime of crimesAt(seed, tick, grounds)) {
      if (CRIMES[crime.kind].breakable !== breakable) continue;
      return { crime, tick };
    }
  }
  throw new Error(`no ${breakable ? 'breakable' : 'unbreakable'} incident in six days`);
}

describe('the corners', () => {
  it('gives every district that has streets some corners of its own', () => {
    expect(grounds.length).toBe(3);
    for (const ground of grounds) expect(ground.corners.length).toBeGreaterThan(0);
  });

  it('leaves the backwoods alone', () => {
    expect(grounds.map((ground) => ground.district.zone)).not.toContain('wilderness');
  });

  it('gives a district with no street near it no corners at all', () => {
    expect(crimeGrounds(5, districts, () => undefined)).toEqual([]);
  });
});

describe('what is going on', () => {
  it('is the same city twice for one seed and a different one for another', () => {
    const tick = 3 * TICKS_PER_DAY + 23 * TICKS_PER_HOUR;
    expect(crimesAt(7, tick, grounds)).toEqual(crimesAt(7, tick, grounds));
    let same = true;
    for (let t = 0; t < TICKS_PER_DAY; t += SLOT_TICKS) {
      if (JSON.stringify(crimesAt(7, t, grounds)) !== JSON.stringify(crimesAt(8, t, grounds))) same = false;
    }
    expect(same).toBe(false);
  });

  it('answers in id order, once for each incident', () => {
    for (let tick = 0; tick < 2 * TICKS_PER_DAY; tick += SLOT_TICKS) {
      const live = crimesAt(5, tick, grounds);
      const ids = live.map((crime) => crime.id);
      expect([...ids].sort((a, b) => a - b)).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('keeps each kind to its own hours and its own zones', () => {
    for (let tick = 0; tick < 4 * TICKS_PER_DAY; tick += SLOT_TICKS) {
      for (const crime of crimesAt(5, tick, grounds)) {
        const spec = CRIMES[crime.kind];
        const zone = districts[crime.district]?.zone;
        expect(spec.zones).toContain(zone);
        const hour = Math.floor((crime.from % TICKS_PER_DAY) / TICKS_PER_HOUR);
        const inHours = spec.from <= spec.to ? hour >= spec.from && hour < spec.to : hour >= spec.from || hour < spec.to;
        expect(inHours).toBe(true);
      }
    }
  });

  it('stands every incident on a corner of its own district', () => {
    for (let tick = 0; tick < 2 * TICKS_PER_DAY; tick += SLOT_TICKS) {
      for (const crime of crimesAt(5, tick, grounds)) {
        const ground = grounds.find((g) => g.district.id === crime.district) as CrimeGround;
        expect(ground.corners.some((at) => at.x === crime.x && at.y === crime.y)).toBe(true);
      }
    }
  });

  it('gets round to every kind in a week', () => {
    const seen = new Set<string>();
    for (let tick = 0; tick < 7 * TICKS_PER_DAY; tick += SLOT_TICKS) {
      for (const crime of crimesAt(5, tick, grounds)) seen.add(crime.kind);
    }
    for (const kind of CRIME_ORDER) expect(seen.has(kind)).toBe(true);
  });
});

describe('breaking one up', () => {
  it('ends the incident, pays the player, and takes it off the street', () => {
    const { crime, tick } = find(5, true);
    const state = session();
    state.tick = crime.from;
    state.player.x = crime.x;
    state.player.y = crime.y;
    const money = state.money;
    const settled = stepStreetCrime(state, grounds);
    expect(settled.map((one) => one.id)).toContain(crime.id);
    expect(state.money).toBe(money + CRIMES[crime.kind].pays);
    expect(settledOf(state.crimes, crime.id)).toBeDefined();
    expect(crimesAt(state.seed, state.tick, grounds, state.crimes).map((one) => one.id)).not.toContain(crime.id);
    expect(tick).toBeGreaterThanOrEqual(0);
  });

  it('is never broken up from across the street', () => {
    const { crime } = find(5, true);
    const state = session();
    state.tick = crime.from;
    state.player.x = crime.x + INTERRUPT_RANGE + 1;
    state.player.y = crime.y;
    expect(stepStreetCrime(state, grounds)).toEqual([]);
    expect(state.crimes.settled).toEqual([]);
  });

  it('pays a player once and never again', () => {
    const { crime } = find(5, true);
    const state = session();
    state.tick = crime.from;
    state.player.x = crime.x;
    state.player.y = crime.y;
    stepStreetCrime(state, grounds);
    const money = state.money;
    state.tick += 1;
    expect(stepStreetCrime(state, grounds)).toEqual([]);
    expect(state.money).toBe(money);
    expect(state.crimes.settled.length).toBe(1);
  });

  it('leaves the police to their own business', () => {
    const { crime } = find(5, false);
    expect(CRIMES[crime.kind].breakable).toBe(false);
    const state = session();
    state.tick = crime.from;
    state.player.x = crime.x;
    state.player.y = crime.y;
    stepStreetCrime(state, grounds);
    expect(settledOf(state.crimes, crime.id)).toBeUndefined();
  });

  it('draws the police onto a player who robs a deal', () => {
    let robbed: StreetCrime | undefined;
    for (let tick = 0; tick < 8 * TICKS_PER_DAY && robbed === undefined; tick += SLOT_TICKS) {
      robbed = crimesAt(5, tick, grounds).find((crime) => crime.kind === 'deal');
    }
    if (robbed === undefined) throw new Error('no deal in eight days');
    const state = session();
    state.tick = robbed.from;
    state.player.x = robbed.x;
    state.player.y = robbed.y;
    stepStreetCrime(state, grounds);
    expect(state.heat).toBeCloseTo(CRIMES.deal.heat, 6);
  });

  it('keeps the settled incidents in id order', () => {
    const state = session();
    for (let tick = 0; tick < 3 * TICKS_PER_DAY; tick += 60) {
      state.tick = tick;
      const live = crimesAt(state.seed, tick, grounds, state.crimes);
      const first = live.find((crime) => CRIMES[crime.kind].breakable);
      if (first === undefined) continue;
      state.player.x = first.x;
      state.player.y = first.y;
      stepStreetCrime(state, grounds);
    }
    expect(state.crimes.settled.length).toBeGreaterThan(1);
    const ids = state.crimes.settled.map((one) => one.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('does nothing at all in a city with no corners', () => {
    const state = session();
    expect(stepStreetCrime(state, [])).toEqual([]);
  });
});
