import { describe, expect, it } from 'vitest';
import { dealerPlaces } from '../src/sim/dealer.ts';
import { giverPlaces } from '../src/sim/giver.ts';
import type { Place } from '../src/sim/on-foot.ts';
import { createSimState } from '../src/sim/simulation.ts';
import { crimeGrounds } from '../src/sim/street-crime.ts';
import { venuesOf } from '../src/sim/city-events.ts';
import { DealerMarks } from '../src/ui/dealers.ts';
import { EnforcerMarks } from '../src/ui/enforcers.ts';
import { FireCrews } from '../src/ui/fire-crews.ts';
import { GiverBodies } from '../src/ui/givers.ts';
import { MapPois } from '../src/ui/map.ts';
import { OfficerMarks } from '../src/ui/officers.ts';
import { StreetLife } from '../src/ui/street-life.ts';
import type { District, WorldDescription } from '../src/world/types.ts';

/**
 * The contacts of spec section 18 on the street: a body on every corner a
 * contact stands on, and the marker over their head. The rules of who will
 * talk are `test/sim-missions.test.ts`; this is the glue between them and the
 * screen.
 */
const SEED = 7;

const districts: District[] = [
  { id: 0, name: 'Little Italy', zone: 'inner', x: 0, y: 0, density: 0.8, wealth: 0.5, culture: 'italian' },
  { id: 1, name: 'Chinatown', zone: 'inner', x: 400, y: 0, density: 0.8, wealth: 0.4, culture: 'chinese' },
  { id: 2, name: 'Downtown', zone: 'core', x: -400, y: 0, density: 0.9, wealth: 0.7, culture: 'none' },
];

const snap = (x: number, y: number): Place => ({ x, y, heading: 0 });
const givers = giverPlaces(SEED, districts, snap);

/** Ground that rises with x, so a contact's body and marker stand on a slope. */
const hill = { heightAt: (x: number): number => x / 100 };

/** A map with nothing of the world's own on it, which is all this needs. */
function pois(): MapPois {
  const world = {
    water: { harbour: { x: 0, y: 0, radius: 1 } },
    tram: { stops: [] },
    beaches: [],
  } as unknown as WorldDescription;
  return new MapPois(world);
}

/** The whole chain that writes the list the crowd mesh draws, run for one tick. */
function crowdOf(bodies: GiverBodies) {
  const state = createSimState(SEED);
  state.player.driving = false;
  // Far from everything, so no event and no incident stands anybody of its own.
  state.player.x = 50000;
  state.player.y = 50000;
  const map = pois();
  const dealers = new DealerMarks(SEED, dealerPlaces(SEED, districts, snap), map, bodies.standing);
  const enforcers = new EnforcerMarks(map);
  const life = new StreetLife(SEED, venuesOf(SEED, districts, [], snap), crimeGrounds(SEED, districts, snap), map);
  const officers = new OfficerMarks(map);
  const crews = new FireCrews();
  dealers.update(state.tick, hill);
  enforcers.update(state, hill, dealers);
  life.update(state, hill, enforcers);
  officers.update(state, life);
  crews.update(state, officers);
  return crews.standing;
}

describe('the contacts standing on their corners', () => {
  it('stands one person on every contact’s corner, on the ground under them', () => {
    const bodies = new GiverBodies(SEED, givers, hill);
    expect(givers.length).toBeGreaterThan(0);
    expect(bodies.standing.length).toBe(givers.length);
    for (let i = 0; i < givers.length; i++) {
      const giver = givers[i]!;
      const person = bodies.standing[i]!;
      expect(person.pose.x).toBe(giver.x);
      expect(person.pose.y).toBe(giver.y);
      expect(person.pose.height).toBe(hill.heightAt(giver.x));
      // A contact waits to be talked to, so nothing about them moves.
      expect(person.pose.gait).toBe('stand');
      expect(person.pose.speed).toBe(0);
    }
  });

  it('draws the same faces from the same seed, and other faces from another', () => {
    const one = new GiverBodies(SEED, givers, hill).standing.map((person) => person.look);
    const again = new GiverBodies(SEED, givers, hill).standing.map((person) => person.look);
    const other = new GiverBodies(SEED + 1, givers, hill).standing.map((person) => person.look);
    expect(again).toEqual(one);
    expect(other).not.toEqual(one);
  });

  it('stands a beam on every contact’s corner, with the marker over their head', () => {
    const bodies = new GiverBodies(SEED, givers, hill);
    expect(bodies.markers.length).toBe(givers.length);
    for (let i = 0; i < givers.length; i++) {
      const marker = bodies.markers[i]!;
      const person = bodies.standing[i]!;
      expect(marker.x).toBe(person.pose.x);
      expect(marker.y).toBe(person.pose.y);
      // The beam stands on the road they stand on and the marker over their head.
      expect(marker.ground).toBe(person.pose.height);
      expect(marker.top).toBeCloseTo(person.pose.height + person.look.height, 6);
    }
  });

  it('lights the markers for a player who may take work and dulls them for one who may not', () => {
    const bodies = new GiverBodies(SEED, givers, hill);
    const state = createSimState(SEED);
    state.player.driving = false;
    bodies.update(state);
    expect(bodies.markers.every((marker) => marker.open)).toBe(true);
    // A contact will not lean into a car, so nobody is offering anything.
    state.player.driving = true;
    bodies.update(state);
    expect(bodies.markers.some((marker) => marker.open)).toBe(false);
  });

  it('carries the contacts through the whole chain to the crowd mesh', () => {
    const bodies = new GiverBodies(SEED, givers, hill);
    const drawn = crowdOf(bodies);
    for (const person of bodies.standing) expect(drawn).toContain(person);
  });
});
