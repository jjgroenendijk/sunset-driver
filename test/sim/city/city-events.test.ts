import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from '../../../src/sim/clock.ts';
import {
  EVENTS,
  EVENT_ORDER,
  eventAt,
  eventKey,
  eventOn,
  eventPeople,
  eventsAt,
  rushHourAt,
  venuesOf,
  type EventPerson,
  type LiveEvent,
  type Venues,
} from '../../../src/sim/city/city-events.ts';
import type { Place } from '../../../src/sim/player/on-foot.ts';
import type { Beach, District, Point } from '../../../src/world/types.ts';

/**
 * The city's calendar of spec section 20.5, run headless. The districts below
 * are a made-up city with a Chinatown, a Barrio, a core and a beach, so every
 * venue has ground to stand on and the diary can be read straight through.
 */
const districts: District[] = [
  { id: 0, name: 'Downtown', zone: 'core', x: 0, y: 0, density: 0.9, wealth: 0.6, culture: 'none' },
  { id: 1, name: 'Chinatown', zone: 'inner', x: 300, y: 0, density: 0.8, wealth: 0.4, culture: 'chinese' },
  { id: 2, name: 'The Barrio', zone: 'inner', x: -300, y: 0, density: 0.7, wealth: 0.3, culture: 'latin' },
  { id: 3, name: 'Wilds', zone: 'wilderness', x: 0, y: 900, density: 0.02, wealth: 0.1, culture: 'none' },
];

/** A beach with a pier, so the party has somewhere to be held. */
const beaches: Beach[] = [
  {
    id: 0,
    shore: [
      { x: -100, y: -400 },
      { x: 100, y: -400 },
    ],
    back: [
      { x: -100, y: -420 },
      { x: 100, y: -420 },
    ],
    length: 200,
    sand: [],
    shallows: [],
    boardwalk: [],
    boardwalkRoad: -1,
    pier: { root: { x: 0, y: -400 }, head: { x: 0, y: -460 }, polygon: [] },
    carParks: [],
    districts: [0],
  },
];

/** A city whose every point has a street under it, running east. */
const snap = (x: number, y: number): Place => ({ x, y, heading: 0 });

/** A city with no streets at all, which is how a venue comes to be missing. */
const nowhere = (): undefined => undefined;

const venues: Venues = venuesOf(3, districts, beaches, snap);

/** The first tick of an hour on a day. */
function at(day: number, hour: number): number {
  return day * TICKS_PER_DAY + hour * TICKS_PER_HOUR;
}

/** The first day on or after `day` that an event of a kind runs on. */
function firstDay(kind: keyof typeof EVENTS, from = 0): number {
  for (let day = from; day < from + 60; day++) if (eventOn(11, kind, day, venues) !== undefined) return day;
  throw new Error(`nothing of kind ${kind} runs`);
}

describe('the venues', () => {
  it('holds each event on ground that suits it', () => {
    expect(venues['night-market']).toBeDefined();
    expect(venues['street-race']).toBeDefined();
    expect(venues.parade).toBeDefined();
    expect(venues['beach-party']).toBeDefined();
    // The market is held in Chinatown and the race starts in the Barrio.
    expect((venues['night-market'] as Place).x).toBeGreaterThan(0);
    expect((venues['street-race'] as Place).x).toBeLessThan(0);
  });

  it('holds no event a city has no street for', () => {
    expect(venuesOf(3, districts, beaches, nowhere)).toEqual({});
  });

  it('holds the rush hour nowhere, because it is everywhere', () => {
    expect(venues['rush-hour']).toBeUndefined();
  });
});

describe('the diary', () => {
  it('is the same diary twice for one seed', () => {
    expect(eventsAt(9, at(3, 20), venues)).toEqual(eventsAt(9, at(3, 20), venues));
  });

  it('runs a weekly event only on the days it keeps', () => {
    for (let day = 0; day < 21; day++) {
      if (eventOn(11, 'parade', day, venues) === undefined) continue;
      expect(EVENTS.parade.days).toContain(day % 7);
    }
  });

  it('carries an event that opened yesterday past midnight', () => {
    const day = firstDay('beach-party');
    const party = eventOn(11, 'beach-party', day, venues) as LiveEvent;
    // The party closes at two in the morning, which is the next day.
    expect(party.to).toBeGreaterThan((day + 1) * TICKS_PER_DAY);
    const live = eventsAt(11, (day + 1) * TICKS_PER_DAY + TICKS_PER_HOUR, venues);
    expect(live.map((event) => event.kind)).toContain('beach-party');
  });

  it('lists nothing before an event opens and nothing after it closes', () => {
    const day = firstDay('night-market');
    const market = eventOn(11, 'night-market', day, venues) as LiveEvent;
    const kinds = (tick: number): string[] => eventsAt(11, tick, venues).map((event) => event.kind);
    expect(kinds(market.from - 1)).not.toContain('night-market');
    expect(kinds(market.from)).toContain('night-market');
    expect(kinds(market.to - 1)).toContain('night-market');
    expect(kinds(market.to)).not.toContain('night-market');
  });

  it('has the streets at their worst at either end of the working day', () => {
    expect(rushHourAt(at(2, 8))).toBe(true);
    expect(rushHourAt(at(2, 17))).toBe(true);
    expect(rushHourAt(at(2, 12))).toBe(false);
    expect(rushHourAt(at(2, 3))).toBe(false);
  });

  it('names each event of a day apart from every other', () => {
    const seen = new Set<number>();
    for (let day = 0; day < 14; day++) {
      for (const kind of EVENT_ORDER) {
        const event = eventOn(11, kind, day, venues);
        if (event === undefined) continue;
        expect(seen.has(eventKey(event))).toBe(false);
        seen.add(eventKey(event));
      }
    }
  });
});

describe('standing in one', () => {
  it('answers the event a place is inside, and the smallest of two', () => {
    const big: LiveEvent = { kind: 'parade', name: 'Parade', x: 0, y: 0, heading: 0, radius: 70, from: 0, to: 10, crowd: 4, closes: true };
    const small: LiveEvent = { ...big, kind: 'match', name: 'Match crowd', radius: 20, closes: false };
    expect(eventAt([big, small], 5, 0)?.kind).toBe('match');
    expect(eventAt([big, small], 40, 0)?.kind).toBe('parade');
    expect(eventAt([big, small], 400, 0)).toBeUndefined();
  });

  it('is never inside the rush hour, which has no ground', () => {
    const rush = eventOn(11, 'rush-hour', 1, venues) as LiveEvent;
    expect(rush.radius).toBe(0);
    expect(eventAt([rush], 0, 0)).toBeUndefined();
  });
});

describe('the people an event puts on the street', () => {
  const out: EventPerson[] = [];

  it('puts out the crowd it says it will, inside the ground it takes', () => {
    const day = firstDay('night-market');
    const market = eventOn(11, 'night-market', day, venues) as LiveEvent;
    const people = eventPeople(market, 11, market.from + 600, out);
    expect(people).toHaveLength(market.crowd);
    for (const person of people) {
      expect(Math.hypot(person.x - market.x, person.y - market.y)).toBeLessThanOrEqual(market.radius + 1e-6);
      expect(person.speed).toBe(0);
    }
  });

  it('marches a parade up its own street', () => {
    const day = firstDay('parade');
    const parade = eventOn(11, 'parade', day, venues) as LiveEvent;
    const early = eventPeople(parade, 11, parade.from, out).map((p) => ({ ...p }));
    const later = eventPeople(parade, 11, parade.from + 120, out);
    expect(early).toHaveLength(parade.crowd);
    for (const person of early) expect(person.speed).toBeGreaterThan(0);
    // Two seconds on, the ranks have moved along the street rather than across it.
    const along = (a: EventPerson, b: EventPerson): number =>
      (b.x - a.x) * Math.cos(parade.heading) + (b.y - a.y) * Math.sin(parade.heading);
    const across = (a: EventPerson, b: EventPerson): number =>
      -(b.x - a.x) * Math.sin(parade.heading) + (b.y - a.y) * Math.cos(parade.heading);
    const moved = along(early[0] as EventPerson, later[0] as EventPerson);
    expect(Math.abs(moved)).toBeGreaterThan(1);
    expect(across(early[0] as EventPerson, later[0] as EventPerson)).toBeCloseTo(0, 6);
  });

  it('puts the same people in the same places on a replay', () => {
    const day = firstDay('match');
    const match = eventOn(11, 'match', day, venues) as LiveEvent;
    const first = eventPeople(match, 11, match.from + 90, out).map((p) => ({ ...p }));
    const again: EventPerson[] = [];
    expect(eventPeople(match, 11, match.from + 90, again)).toEqual(first);
  });
});

/** The beaches and the districts are read but never written; this pins that. */
it('reads the world without changing it', () => {
  const before: Point[] = beaches.flatMap((beach) => beach.shore);
  venuesOf(4, districts, beaches, snap);
  expect(beaches.flatMap((beach) => beach.shore)).toEqual(before);
});
