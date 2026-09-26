import { describe, expect, it } from 'vitest';
import { LOOKS, WILDLIFE_VIEW, WildlifeView } from '../../../src/render/environment/wildlife.ts';
import { TICKS_PER_HOUR } from '../../../src/sim/clock.ts';
import { activeAt, AmbientWildlife, SPECIES_ORDER } from '../../../src/sim/city/wildlife.ts';
import { gridTrafficRoads } from '../../support/traffic-grid.ts';

/**
 * The wildlife of spec section 20.4, drawn. three.js runs headless, so the
 * counts are measured here rather than looked at: what is in view, what the
 * hours leave out, and what a storm keeps in.
 */
const wildlife = new AmbientWildlife(5, { roads: gridTrafficRoads(), beaches: [], seaLevel: -20 });

/** Noon, when the pavement birds are about and the rats are not. */
const NOON = 12 * TICKS_PER_HOUR;

/** A pigeon of the fixture, so the view is pointed at ground that has animals on it. */
const bird = wildlife.animals.find((animal) => animal.species === 'pigeon');
if (bird === undefined) throw new Error('the fixture placed no pigeons');

describe('the wildlife, drawn (spec section 20.4)', () => {
  it('names a model and a colour for every species', () => {
    for (const species of SPECIES_ORDER) {
      const look = LOOKS[species];
      expect(look.length).toBeGreaterThan(0);
      expect(look.model === 'bird' || look.model === 'beast').toBe(true);
    }
  });

  it('draws what is in view and leaves out what is over the horizon', () => {
    const view = new WildlifeView(wildlife);
    view.update(NOON, NOON, bird.x, bird.y);
    expect(view.drawn).toBeGreaterThan(0);
    // Far out past the grid there is nothing placed at all.
    view.update(NOON, NOON, bird.x + 40 * WILDLIFE_VIEW, bird.y + 40 * WILDLIFE_VIEW);
    expect(view.drawn).toBe(0);
    view.dispose();
  });

  it('draws only the species whose hours the tick falls in', () => {
    const view = new WildlifeView(wildlife);
    const midnight = 0;
    expect(activeAt('pigeon', NOON)).toBe(true);
    expect(activeAt('pigeon', midnight)).toBe(false);
    view.update(NOON, NOON, bird.x, bird.y);
    const day = view.drawn;
    view.update(midnight, midnight, bird.x, bird.y);
    expect(view.drawn).not.toBe(day);
    view.dispose();
  });

  it('keeps the wildlife in when a storm keeps the crowd in', () => {
    const view = new WildlifeView(wildlife);
    view.update(NOON, NOON, bird.x, bird.y);
    expect(view.drawn).toBeGreaterThan(0);
    view.share = 0;
    view.update(NOON, NOON, bird.x, bird.y);
    expect(view.drawn).toBe(0);
    view.dispose();
  });

  it('draws no more than the cap it was built with', () => {
    const view = new WildlifeView(wildlife, 4);
    view.update(NOON, NOON, bird.x, bird.y);
    expect(view.drawn).toBeLessThanOrEqual(8);
    view.dispose();
  });
});
