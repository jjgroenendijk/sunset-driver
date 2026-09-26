/**
 * The city's own calendar (spec section 20.5): rush hour, the night market,
 * the races after midnight, the parade that closes a street, the crowd coming
 * out of a match, and the party on the pier.
 *
 * An event is a pure function of `(seed, tick)`. Its venue is picked once for
 * a world, the way a dealer's corners are (`dealer.ts`): a point in a district
 * of the right character, snapped to the nearest street. Whether it runs at
 * all is drawn from the day it would run on, so the same seed keeps the same
 * diary and a replay walks into the same parade.
 *
 * {@link eventsAt} answers what is on at a tick. It looks at the day the tick
 * falls in and at the day before it, because an event that opens at nine in
 * the evening and closes at two in the morning is yesterday's event for the
 * first two hours of today.
 *
 * Nothing here is on the record and nothing is stepped. What the events do to
 * the streets — the crowd they draw and the marks on the map — is
 * `src/ui/hud/street-life.ts`; what the player does about the street crime of the
 * same spec section is `street-crime.ts`.
 */
import { genRng, rngFor, Subsystem } from '../../core/rng.ts';
import { cos, hypot, sin } from '../../core/libm.ts';
import type { Beach, District, Point } from '../../world/types.ts';
import { TICKS_PER_DAY, TICKS_PER_HOUR, TICK_RATE } from '../clock.ts';
import type { Place } from '../player/on-foot.ts';

/** What the city puts on (spec section 20.5). */
export type EventKind = 'rush-hour' | 'night-market' | 'street-race' | 'parade' | 'match' | 'beach-party';

/** The ground an event is held on. */
type Venue =
  /** Every street at once: no place of its own. */
  | 'city'
  /** A district of a given culture, or the busiest inner one where the seed drew none. */
  | 'chinatown'
  | 'barrio'
  /** The middle of the city. */
  | 'downtown'
  /** The pier of the longest beach, or the middle of it where the beach carries none. */
  | 'pier';

/** What one event is: when it runs, where, and what it puts on the street. */
export interface EventSpec {
  /** What the HUD and the map call it. */
  name: string;
  /**
   * The hour it opens and the hour it closes. An hour past 24 closes it on the
   * next day, so a party from 20 to 26 runs until two in the morning.
   */
  from: number;
  to: number;
  venue: Venue;
  /**
   * The days of the week it may run on, as day numbers 0 to 6, or an empty
   * list for one that may run on any of them.
   */
  days: readonly number[];
  /** The chance it runs at all on a day it may run on. */
  chance: number;
  /** Metres of street it takes up. */
  radius: number;
  /** People it puts on that street, over and above the crowd already walking it. */
  crowd: number;
  /** True for one that shuts the street it runs down. */
  closes: boolean;
}

/**
 * Every event the city runs. Adding one is a row here and a venue in
 * {@link venuesOf}; nothing else branches on a kind.
 */
export const EVENTS: Readonly<Record<EventKind, EventSpec>> = Object.freeze({
  // Twice a day, every day, everywhere. It draws nobody: it is the traffic.
  'rush-hour': { name: 'Rush hour', from: 7, to: 9, venue: 'city', days: [], chance: 1, radius: 0, crowd: 0, closes: false },
  'night-market': { name: 'Night market', from: 19, to: 24, venue: 'chinatown', days: [], chance: 0.7, radius: 60, crowd: 34, closes: false },
  // After midnight, out of the Barrio, and not on a work night.
  'street-race': { name: 'Street race', from: 0, to: 3, venue: 'barrio', days: [0, 5, 6], chance: 0.5, radius: 45, crowd: 16, closes: false },
  // One afternoon a week, down the middle of the city, and the street is shut.
  parade: { name: 'Parade', from: 13, to: 17, venue: 'downtown', days: [6], chance: 0.8, radius: 70, crowd: 48, closes: true },
  match: { name: 'Match crowd', from: 21, to: 23, venue: 'downtown', days: [2, 5], chance: 0.6, radius: 50, crowd: 40, closes: false },
  'beach-party': { name: 'Beach party', from: 20, to: 26, venue: 'pier', days: [5, 6], chance: 0.75, radius: 55, crowd: 30, closes: false },
});

/** The kinds in a fixed order, so nothing here ever iterates an object. */
export const EVENT_ORDER: readonly EventKind[] = Object.freeze([
  'rush-hour',
  'night-market',
  'street-race',
  'parade',
  'match',
  'beach-party',
]);

/** The second rush hour of the day, which is the same event at the other end of it. */
const EVENING_RUSH = { from: 16, to: 19 };

/** Days in a week, which is what an event that runs weekly is counted in. */
const DAYS_PER_WEEK = 7;

/** Where each kind is held, or undefined for a kind this world has no ground for. */
export type Venues = Readonly<Partial<Record<EventKind, Place>>>;

/** One event, as it stands while it is on. */
export interface LiveEvent {
  kind: EventKind;
  name: string;
  /** Where it is held. A citywide event stands where the player does, and has no ground of its own. */
  x: number;
  y: number;
  /** The way the street it is held on runs, which is the way a parade marches. */
  heading: number;
  radius: number;
  /** The tick it opened and the tick it closes. */
  from: number;
  to: number;
  crowd: number;
  /** True while it has the street shut. */
  closes: boolean;
}

/**
 * Pick the venues of a world. `snap` puts a point on the nearest street and
 * answers nothing where there is no street near it, exactly as the dealers'
 * corners are placed; a kind whose ground is missing simply never runs.
 */
export function venuesOf(
  seed: number,
  districts: readonly District[],
  beaches: readonly Beach[],
  snap: (x: number, y: number) => Place | undefined,
): Venues {
  const venues: Partial<Record<EventKind, Place>> = {};
  for (const kind of EVENT_ORDER) {
    const spec = EVENTS[kind];
    if (spec.venue === 'city') continue;
    const at = groundFor(spec.venue, districts, beaches);
    if (at === undefined) continue;
    const rng = genRng(seed, Subsystem.Events, EVENT_ORDER.indexOf(kind));
    const angle = rng.range(0, 2 * Math.PI);
    const away = rng.range(0, spec.radius);
    const place = snap(at.x + cos(angle) * away, at.y + sin(angle) * away);
    if (place !== undefined) venues[kind] = place;
  }
  return venues;
}

/** What is on at a tick, in the order of {@link EVENT_ORDER}. */
export function eventsAt(seed: number, tick: number, venues: Venues): LiveEvent[] {
  const live: LiveEvent[] = [];
  const today = Math.floor(Math.max(0, tick) / TICKS_PER_DAY);
  for (const kind of EVENT_ORDER) {
    // An event that opens in the evening and closes after midnight belongs to
    // the day it opened on, so yesterday's diary is read as well as today's.
    for (const day of [today - 1, today]) {
      if (day < 0) continue;
      const event = eventOn(seed, kind, day, venues);
      if (event === undefined) continue;
      if (tick < event.from || tick >= event.to) continue;
      live.push(event);
    }
  }
  return live;
}

/**
 * The event of one kind on one day, or undefined where it does not run. The
 * evening rush hour is the morning one's own second window, so a caller that
 * asks for rush hour gets whichever of the two the day holds.
 */
export function eventOn(seed: number, kind: EventKind, day: number, venues: Venues): LiveEvent | undefined {
  const spec = EVENTS[kind];
  if (spec.venue !== 'city' && venues[kind] === undefined) return undefined;
  if (spec.days.length > 0 && !spec.days.includes(day % DAYS_PER_WEEK)) return undefined;
  if (spec.chance < 1 && !rngFor(seed, day, Subsystem.Events, EVENT_ORDER.indexOf(kind)).chance(spec.chance)) {
    return undefined;
  }
  const at = venues[kind] ?? { x: 0, y: 0, heading: 0 };
  return {
    kind,
    name: spec.name,
    x: at.x,
    y: at.y,
    heading: at.heading,
    radius: spec.radius,
    from: day * TICKS_PER_DAY + spec.from * TICKS_PER_HOUR,
    to: day * TICKS_PER_DAY + spec.to * TICKS_PER_HOUR,
    crowd: spec.crowd,
    closes: spec.closes,
  };
}

/**
 * A number that names one event for as long as it runs and never names
 * another: the tick it opened on and which kind it is. Whoever draws its crowd
 * keys a face on it.
 */
export function eventKey(event: LiveEvent): number {
  return event.from * EVENT_ORDER.length + EVENT_ORDER.indexOf(event.kind);
}

/**
 * True while the streets are at their worst: either end of the working day,
 * every day. It is the one event with no ground of its own, so it is asked
 * rather than listed.
 */
export function rushHourAt(tick: number): boolean {
  const spec = EVENTS['rush-hour'];
  const hour = Math.floor(Math.max(0, tick) / TICKS_PER_HOUR) % 24;
  return (hour >= spec.from && hour < spec.to) || (hour >= EVENING_RUSH.from && hour < EVENING_RUSH.to);
}

/** The event a place stands inside, or undefined. The smallest one wins, so a pier beats a parade. */
export function eventAt(live: readonly LiveEvent[], x: number, y: number): LiveEvent | undefined {
  let best: LiveEvent | undefined;
  for (const event of live) {
    if (event.radius <= 0) continue;
    if (hypot(event.x - x, event.y - y) > event.radius) continue;
    if (best === undefined || event.radius < best.radius) best = event;
  }
  return best;
}

/** Metres per second a parade marches at, which is a slow walk. */
const MARCH_SPEED = 1.1;

/** Metres between one rank of a parade and the next, and how many march abreast. */
const RANK_GAP = 2.2;
const ABREAST = 4;

/** Metres one stride of that march covers, so the crowd mesh moves their legs with them. */
const MARCH_STRIDE = 0.85;

/** Somebody at an event: where they stand and which way they face. */
export interface EventPerson {
  x: number;
  y: number;
  heading: number;
  /** Metres per second they are moving at. A marcher walks; everybody else stands. */
  speed: number;
  /** How far through their stride they are, 0 to 1. */
  cycle: number;
}

/**
 * The people an event has put on the street at a tick, written into `out`.
 *
 * A parade is ranks marching along its own street, which is what closing the
 * street looks like from above. Everything else is a crowd standing around the
 * venue, swaying where it stands. Both are functions of the seed and the tick,
 * so a replay walks into the same parade at the same corner.
 */
export function eventPeople(event: LiveEvent, seed: number, tick: number, out: EventPerson[]): EventPerson[] {
  out.length = 0;
  const rng = genRng(seed, Subsystem.Events, EVENT_ORDER.indexOf(event.kind));
  const seconds = Math.max(0, tick - event.from) / TICK_RATE;
  const marched = seconds * MARCH_SPEED;
  const along = Math.max(RANK_GAP, event.radius * 2);
  for (let i = 0; i < event.crowd; i++) {
    // Every person draws the same three numbers whether or not this event
    // marches, so the stream stays in step for both kinds of crowd.
    const turn = rng.range(0, 2 * Math.PI);
    const away = event.radius * Math.sqrt(rng.float());
    const sway = rng.range(0, 2 * Math.PI);
    if (event.closes) {
      // A rank every few metres, marching up the street and starting again at
      // the back once the head of the parade is past the end of it.
      const at = (((Math.floor(i / ABREAST) * RANK_GAP + marched) % along) + along) % along;
      const across = ((i % ABREAST) - (ABREAST - 1) / 2) * 1.6;
      const down = at - along / 2;
      out.push({
        x: event.x + cos(event.heading) * down - sin(event.heading) * across,
        y: event.y + sin(event.heading) * down + cos(event.heading) * across,
        heading: event.heading,
        speed: MARCH_SPEED,
        cycle: fraction(marched / MARCH_STRIDE + i * 0.17),
      });
      continue;
    }
    out.push({
      x: event.x + cos(turn) * away,
      y: event.y + sin(turn) * away,
      heading: turn + Math.PI + 0.3 * sin(seconds * 0.4 + sway),
      speed: 0,
      cycle: 0,
    });
  }
  return out;
}

/** The fractional part of a number, which is where a stride has got to. */
function fraction(value: number): number {
  return value - Math.floor(value);
}

/** The middle of the ground a venue is held on, before it is snapped to a street. */
function groundFor(venue: Venue, districts: readonly District[], beaches: readonly Beach[]): Point | undefined {
  if (venue === 'pier') return partyBeach(beaches);
  if (venue === 'downtown') return pick(districts, (d) => (d.zone === 'core' ? 1 + d.density : 0));
  const culture = venue === 'chinatown' ? 'chinese' : 'latin';
  // A seed that drew no such quarter holds the event in the busiest inner
  // district instead, rather than not holding it at all.
  return (
    pick(districts, (d) => (d.culture === culture ? 1 + d.density : 0)) ??
    pick(districts, (d) => (d.zone === 'inner' ? 1 + d.density : 0))
  );
}

/** The head of the longest beach's pier, or the middle of that beach where it has none. */
function partyBeach(beaches: readonly Beach[]): Point | undefined {
  let best: Beach | undefined;
  for (const beach of beaches) if (best === undefined || beach.length > best.length) best = beach;
  if (best === undefined) return undefined;
  if (best.pier !== undefined) return best.pier.root;
  return best.shore[best.shore.length >> 1];
}

/** The district that scores highest, or undefined where none scores at all. */
function pick(districts: readonly District[], score: (district: District) => number): Point | undefined {
  let best: District | undefined;
  let bestScore = 0;
  for (const district of districts) {
    const value = score(district);
    if (value <= bestScore) continue;
    bestScore = value;
    best = district;
  }
  return best;
}
