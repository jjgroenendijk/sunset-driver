import { describe, expect, it } from 'vitest';
import { archetypeFor, ARCHETYPES } from '../../../src/world/terrain/archetype.ts';
import { sweepSeeds } from '../../support/helpers.ts';

/** Seeds the roll is counted over. The draw is one number per seed, so this costs nothing. */
const ROLLS = 3000;

describe('terrain archetypes', () => {
  it('draws every archetype about as often as any other over the seeds of the sweep', () => {
    const counts = new Map<string, number>();
    for (const seed of sweepSeeds(ROLLS)) {
      const name = archetypeFor(seed).name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const even = ROLLS / ARCHETYPES.length;
    for (const archetype of ARCHETYPES) {
      const count = counts.get(archetype.name) ?? 0;
      // Four standard deviations of a fair roll either way.
      expect(Math.abs(count - even), `${archetype.name} drawn ${count} times of ${ROLLS}`).toBeLessThan(4 * Math.sqrt(even));
    }
  });

  it('names each archetype once, in the order the draw reads', () => {
    expect(new Set(ARCHETYPES.map((a) => a.name)).size).toBe(ARCHETYPES.length);
  });
});
