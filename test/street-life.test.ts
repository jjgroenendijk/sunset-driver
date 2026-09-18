import { describe, expect, it } from 'vitest';
import { MapPois } from '../src/ui/map.ts';
import { StreetLife } from '../src/ui/street-life.ts';
import { TICKS_PER_DAY } from '../src/sim/clock.ts';
import { eventOn, venuesOf, type LiveEvent, type Venues } from '../src/sim/city-events.ts';
import type { Place } from '../src/sim/on-foot.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { crimeGrounds, crimesAt, SLOT_TICKS, type CrimeGround } from '../src/sim/street-crime.ts';
import type { District, WorldDescription } from '../src/world/types.ts';

/**
 * The events and the street crime of spec section 20.5, as the player meets
 * them: people standing in the crowd's own mesh and marks on the map. The
 * pieces underneath are tested in `city-events.test.ts` and
 * `street-crime.test.ts`; this is the glue between them and the screen.
 */
const districts: District[] = [
  { id: 0, name: 'Downtown', zone: 'core', x: 0, y: 0, density: 0.9, wealth: 0.6, culture: 'none' },
  { id: 1, name: 'Chinatown', zone: 'inner', x: 300, y: 0, density: 0.8, wealth: 0.4, culture: 'chinese' },
  { id: 2, name: 'The Barrio', zone: 'inner', x: -300, y: 0, density: 0.7, wealth: 0.3, culture: 'latin' },
];

const snap = (x: number, y: number): Place => ({ x, y, heading: 0 });
const venues: Venues = venuesOf(3, districts, [], snap);
const grounds: CrimeGround[] = crimeGrounds(3, districts, snap);

/** A map with nothing of the world's own on it, which is all this needs. */
function pois(): MapPois {
  const world = {
    water: { harbour: { x: 0, y: 0, radius: 1 } },
    tram: { stops: [] },
    beaches: [],
  } as unknown as WorldDescription;
  return new MapPois(world);
}

/** Flat ground, so a pose's height says nothing and gets in the way of nothing. */
const flat = { heightAt: (): number => 0 };

/** Nothing was standing on the street and nothing was on the map before this. */
const nothing = { standing: [], marks: [] };

/** The first day a parade runs on. */
function paradeDay(): number {
  for (let day = 0; day < 40; day++) if (eventOn(3, 'parade', day, venues) !== undefined) return day;
  throw new Error('no parade in forty days');
}

describe('what the player sees of the city’s own life', () => {
  it('stands nobody and marks nothing while nothing is on', () => {
    const life = new StreetLife(3, venues, grounds, pois());
    const state = createSimState(3);
    // Four in the morning of the first day: no event, and the player is far off.
    state.tick = 4 * 3600;
    state.player.driving = false;
    state.player.x = 50000;
    state.player.y = 50000;
    life.update(state, flat, nothing);
    expect(life.standing.length).toBe(0);
    expect(life.happening).toBe('');
  });

  it('marches a parade past a player standing in it, and names it', () => {
    const life = new StreetLife(3, venues, grounds, pois());
    const parade = eventOn(3, 'parade', paradeDay(), venues) as LiveEvent;
    const state = createSimState(3);
    state.tick = parade.from + 600;
    state.player.driving = false;
    state.player.x = parade.x;
    state.player.y = parade.y;
    life.update(state, flat, nothing);
    expect(life.happening).toBe(parade.name);
    expect(life.standing.length).toBeGreaterThanOrEqual(parade.crowd);
    expect(life.marks.some((mark) => mark.type === 'event' && mark.name === parade.name)).toBe(true);
    // A marcher is walking, so the crowd mesh moves their legs.
    expect(life.standing.some((person) => person.pose.speed > 0)).toBe(true);
  });

  it('keeps one face per person of an event from tick to tick', () => {
    const life = new StreetLife(3, venues, grounds, pois());
    const parade = eventOn(3, 'parade', paradeDay(), venues) as LiveEvent;
    const state = createSimState(3);
    state.tick = parade.from + 600;
    state.player.driving = false;
    state.player.x = parade.x;
    state.player.y = parade.y;
    life.update(state, flat, nothing);
    const first = life.standing.map((person) => person.look);
    state.tick += 1;
    life.update(state, flat, nothing);
    expect(life.standing.map((person) => person.look)).toEqual(first);
  });

  it('stands two people in an incident and marks it', () => {
    const life = new StreetLife(3, venues, grounds, pois());
    const state = createSimState(3);
    state.player.driving = false;
    for (let tick = 0; tick < 3 * TICKS_PER_DAY; tick += SLOT_TICKS) {
      const live = crimesAt(3, tick, grounds, state.crimes);
      const crime = live[0];
      if (crime === undefined) continue;
      state.tick = tick;
      // Beside it rather than on it, so nothing is broken up by looking at it.
      state.player.x = crime.x + 40;
      state.player.y = crime.y;
      life.update(state, flat, nothing);
      expect(life.standing.length).toBeGreaterThanOrEqual(2);
      expect(life.marks.some((mark) => mark.type === 'incident')).toBe(true);
      return;
    }
    throw new Error('no incident in three days');
  });

  it('writes whatever was already standing and already marked before its own', () => {
    const life = new StreetLife(3, venues, grounds, pois());
    const parade = eventOn(3, 'parade', paradeDay(), venues) as LiveEvent;
    const state = createSimState(3);
    state.tick = parade.from + 600;
    state.player.driving = false;
    state.player.x = parade.x;
    state.player.y = parade.y;
    const before = {
      standing: [
        {
          look: { skin: 0, hair: 0, top: 0, legs: 0, height: 1.75, speed: 1.2, gait: 'stand' as const },
          pose: { x: 1, y: 2, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' as const },
        },
      ],
      marks: [{ type: 'dealer' as const, x: 5, y: 5 }],
    };
    life.update(state, flat, before);
    expect(life.standing[0]).toBe(before.standing[0]);
    expect(life.marks[0]).toBe(before.marks[0]);
  });
});
