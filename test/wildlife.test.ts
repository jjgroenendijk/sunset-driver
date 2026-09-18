import { describe, expect, it } from 'vitest';
import { TICKS_PER_HOUR } from '../src/sim/clock.ts';
import {
  activeAt,
  AmbientWildlife,
  SPECIES,
  SPECIES_ORDER,
  type Species,
  type WildlifePose,
} from '../src/sim/wildlife.ts';
import type { Beach, Point } from '../src/world/types.ts';
import { gridTrafficRoads } from './traffic-grid.ts';

/**
 * The wildlife of spec section 20.4, run headless. The grid of `traffic-grid.ts`
 * is the city and the beach below is its shore, so the placing and the patches
 * are measured without generating a world.
 */
const roads = gridTrafficRoads();

/** Sea level far under the grid's ground, so the shore is its own place. */
const SEA = -20;

/** A straight beach along the south edge of the grid: 400 m of waterline and its dune line. */
function beach(): Beach {
  const shore: Point[] = [];
  const back: Point[] = [];
  for (let s = -200; s <= 200; s += 20) {
    shore.push({ x: s, y: -300 });
    back.push({ x: s, y: -320 });
  }
  return {
    id: 0,
    shore,
    back,
    length: 400,
    sand: [...shore, ...[...back].reverse()],
    shallows: [],
    boardwalk: [],
    boardwalkRoad: -1,
    pier: undefined,
    carParks: [],
    districts: [0],
  };
}

function city(seed = 11): AmbientWildlife {
  return new AmbientWildlife(seed, { roads, beaches: [beach()], seaLevel: SEA });
}

function pose(): WildlifePose {
  return { species: 'rat', x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, startled: 0 };
}

/** Which species the city put down at all. */
function placed(city: AmbientWildlife): Set<Species> {
  const seen = new Set<Species>();
  for (const animal of city.animals) seen.add(animal.species);
  return seen;
}

describe('wildlife placing', () => {
  it('puts every habitat of the fixture down', () => {
    const seen = placed(city());
    // The grid carries pavement, an alley and a beach; it has no wilderness.
    expect(seen.has('pigeon')).toBe(true);
    expect(seen.has('cat') || seen.has('rat')).toBe(true);
    expect(seen.has('seagull')).toBe(true);
    expect(seen.has('crab')).toBe(true);
  });

  it('is the same city twice for one seed and a different one for another', () => {
    const a = city(11).animals;
    const b = city(11).animals;
    expect(a).toEqual(b);
    expect(city(12).animals).not.toEqual(a);
  });

  it('gives every animal a whole number of ticks to go round its patch', () => {
    for (const animal of city().animals) {
      expect(Number.isInteger(animal.period)).toBe(true);
      expect(animal.period).toBeGreaterThan(0);
      expect(animal.phase).toBeGreaterThanOrEqual(0);
      expect(animal.phase).toBeLessThan(animal.period);
    }
  });
});

describe('where an animal is', () => {
  it('comes back to the same place once round its patch', () => {
    const world = city();
    const here = pose();
    const there = pose();
    for (const animal of world.animals.slice(0, 40)) {
      world.poseAt(animal.id, 1234, here);
      world.poseAt(animal.id, 1234 + animal.period, there);
      expect(there.x).toBeCloseTo(here.x, 6);
      expect(there.y).toBeCloseTo(here.y, 6);
    }
  });

  it('never leaves the patch it was given', () => {
    const world = city();
    const at = pose();
    for (const animal of world.animals.slice(0, 60)) {
      for (let tick = 0; tick < animal.period; tick += Math.max(1, Math.floor(animal.period / 17))) {
        world.poseAt(animal.id, tick, at);
        // The wander is three tenths of the radius on each axis over the circle itself.
        const reach = animal.radius * (1 + 0.3 * Math.SQRT2);
        expect(Math.hypot(at.x - animal.x, at.y - animal.y)).toBeLessThanOrEqual(reach + 1e-6);
      }
    }
  });

  it('flies the species that fly and walks the rest', () => {
    const world = city();
    const at = pose();
    for (const animal of world.animals) {
      world.poseAt(animal.id, 500, at);
      expect(at.height - animal.height).toBeCloseTo(SPECIES[animal.species].fly, 6);
    }
  });

  it('finds every animal from a box around where it stands', () => {
    const world = city();
    const at = pose();
    for (const animal of world.animals) {
      world.poseAt(animal.id, 777, at);
      expect(world.near(at.x - 1, at.y - 1, at.x + 1, at.y + 1)).toContain(animal.id);
    }
  });

  it('answers a box once for each animal, in id order', () => {
    const found = city().near(-400, -400, 400, 400);
    expect(new Set(found).size).toBe(found.length);
    expect([...found].sort((a, b) => a - b)).toEqual(found);
  });

  it('finds the animals whose patch reaches a box', () => {
    const world = city();
    const animal = world.animals[0];
    if (animal === undefined) throw new Error('the fixture placed nothing');
    const found = world.near(animal.x - 50, animal.y - 50, animal.x + 50, animal.y + 50);
    expect(found).toContain(animal.id);
  });
});

describe('giving way', () => {
  it('moves a shy animal off the place somebody stands, and further the nearer they are', () => {
    const world = city();
    const shy = world.animals.find((a) => SPECIES[a.species].shy > 0);
    if (shy === undefined) throw new Error('the fixture placed nothing shy');
    const alone = pose();
    world.poseAt(shy.id, 900, alone);
    const close = pose();
    world.poseAt(shy.id, 900, close, { x: alone.x - 0.5, y: alone.y });
    const far = pose();
    world.poseAt(shy.id, 900, far, { x: alone.x - SPECIES[shy.species].shy * 0.9, y: alone.y });
    expect(close.startled).toBeGreaterThan(far.startled);
    expect(close.x).toBeGreaterThan(far.x);
    expect(far.x).toBeGreaterThan(alone.x);
  });

  it('leaves an animal alone once whoever is there is past its reach', () => {
    const world = city();
    const shy = world.animals.find((a) => SPECIES[a.species].shy > 0);
    if (shy === undefined) throw new Error('the fixture placed nothing shy');
    const alone = pose();
    world.poseAt(shy.id, 900, alone);
    const watched = pose();
    world.poseAt(shy.id, 900, watched, { x: alone.x + SPECIES[shy.species].shy + 1, y: alone.y });
    expect(watched.x).toBeCloseTo(alone.x, 9);
    expect(watched.startled).toBe(0);
  });

  it('takes a flock of pigeons up rather than sideways', () => {
    const world = city();
    const bird = world.animals.find((a) => a.species === 'pigeon');
    if (bird === undefined) throw new Error('the fixture placed no pigeons');
    const alone = pose();
    world.poseAt(bird.id, 300, alone);
    const scattered = pose();
    world.poseAt(bird.id, 300, scattered, { x: alone.x, y: alone.y + 1 });
    expect(scattered.height).toBeGreaterThan(alone.height);
  });
});

describe('the hours each species keeps', () => {
  it('has the rats out at night and gone by morning', () => {
    expect(activeAt('rat', 23 * TICKS_PER_HOUR)).toBe(true);
    expect(activeAt('rat', 2 * TICKS_PER_HOUR)).toBe(true);
    expect(activeAt('rat', 12 * TICKS_PER_HOUR)).toBe(false);
  });

  it('has the crabs on the sand in daylight', () => {
    expect(activeAt('crab', 12 * TICKS_PER_HOUR)).toBe(true);
    expect(activeAt('crab', 3 * TICKS_PER_HOUR)).toBe(false);
  });

  it('gives every species some hours of its own', () => {
    for (const species of SPECIES_ORDER) {
      let hours = 0;
      for (let hour = 0; hour < 24; hour++) if (activeAt(species, hour * TICKS_PER_HOUR)) hours++;
      expect(hours).toBeGreaterThan(0);
      expect(hours).toBeLessThan(24);
    }
  });
});
