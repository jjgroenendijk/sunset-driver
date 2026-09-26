import { describe, expect, it } from 'vitest';
import {
  BODY_TYPES,
  CHARACTER_CHOICES,
  cycleChoice,
  DEFAULT_APPEARANCE,
  HAIR_COLOURS,
  HAIR_STYLES,
  normaliseAppearance,
  optionLabel,
  OUTFITS,
  randomAppearance,
  resolveAppearance,
  SKIN_TONES,
} from '../../../src/sim/player/character.ts';
import { createSimState, stepSim } from '../../../src/sim/simulation.ts';
import { DEFAULT_SEED, readSeedFromLocation, writeSeedToHash } from '../../../src/core/seed.ts';
import { seedFromString } from '../../../src/core/rng.ts';
import { sweepSeeds } from '../../support/helpers.ts';
import { compareStrings } from '../../../src/core/sort.ts';

describe('character options', () => {
  it('offers a choice for every field of an appearance', () => {
    const keys = CHARACTER_CHOICES.map((c) => c.key).sort(compareStrings);
    expect(keys).toEqual(Object.keys(DEFAULT_APPEARANCE).sort(compareStrings));
  });

  it('gives every option a unique id and at least two to pick from', () => {
    for (const choice of CHARACTER_CHOICES) {
      expect(choice.options.length).toBeGreaterThan(1);
      const ids = choice.options.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const option of choice.options) expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it('resolves every valid index to a table entry', () => {
    for (let body = 0; body < BODY_TYPES.length; body++) {
      for (let hair = 0; hair < HAIR_STYLES.length; hair++) {
        const parts = resolveAppearance({ body, skin: 0, hair, hairColour: 0, outfit: 0 });
        expect(parts.body.height).toBeGreaterThan(1.5);
        expect(parts.body.shoulder).toBeGreaterThan(parts.body.hip * 0.8);
        expect(parts.hair.length).toBeGreaterThanOrEqual(0);
      }
    }
    expect(resolveAppearance(DEFAULT_APPEARANCE).skin.colour).toBe(SKIN_TONES[DEFAULT_APPEARANCE.skin]?.colour);
  });
});

describe('normaliseAppearance', () => {
  it('keeps a valid appearance unchanged', () => {
    const a = { body: 2, skin: 4, hair: 3, hairColour: 5, outfit: 1 };
    expect(normaliseAppearance(a)).toEqual(a);
  });

  it('folds an out-of-range, fractional or missing index onto a real option', () => {
    const wrapped = normaliseAppearance({ body: 99, skin: -1, hair: 1.7, hairColour: NaN });
    expect(wrapped.body).toBe(99 % BODY_TYPES.length);
    expect(wrapped.skin).toBe(SKIN_TONES.length - 1);
    expect(wrapped.hair).toBe(1);
    expect(wrapped.hairColour).toBe(0);
    expect(wrapped.outfit).toBe(0);
    expect(normaliseAppearance()).toEqual(DEFAULT_APPEARANCE);
  });
});

describe('cycleChoice', () => {
  it('walks a choice through every option and back to where it started', () => {
    for (const choice of CHARACTER_CHOICES) {
      let a = normaliseAppearance(DEFAULT_APPEARANCE);
      const seen = new Set<string>();
      for (let i = 0; i < choice.options.length; i++) {
        seen.add(optionLabel(a, choice.key));
        a = cycleChoice(a, choice.key, 1);
      }
      expect(seen.size).toBe(choice.options.length);
      expect(a).toEqual(DEFAULT_APPEARANCE);
      const atZero = { ...a, [choice.key]: 0 };
      expect(cycleChoice(atZero, choice.key, -1)[choice.key]).toBe(choice.options.length - 1);
    }
  });

  it('leaves the appearance it was given alone', () => {
    const a = normaliseAppearance(DEFAULT_APPEARANCE);
    const before = { ...a };
    cycleChoice(a, 'outfit', 1);
    expect(a).toEqual(before);
  });
});

describe('randomAppearance', () => {
  it('is a pure function of the seed', () => {
    for (const seed of sweepSeeds(16)) {
      expect(randomAppearance(seed)).toEqual(randomAppearance(seed));
      expect(normaliseAppearance(randomAppearance(seed))).toEqual(randomAppearance(seed));
    }
  });

  it('reaches every option across a spread of seeds', () => {
    const outfits = new Set<number>();
    const bodies = new Set<number>();
    for (const seed of sweepSeeds(200)) {
      const a = randomAppearance(seed);
      outfits.add(a.outfit);
      bodies.add(a.body);
    }
    expect(outfits.size).toBe(OUTFITS.length);
    expect(bodies.size).toBe(BODY_TYPES.length);
    expect(HAIR_COLOURS.length).toBeGreaterThan(1);
  });
});

describe('the character in sim state', () => {
  it('is stored, normalised and survives a save round-trip', () => {
    const chosen = randomAppearance(1234);
    const state = createSimState(seedFromString('sunset'), chosen);
    expect(state.character).toEqual(chosen);

    const loaded = JSON.parse(JSON.stringify(state)) as typeof state;
    expect(loaded.character).toEqual(chosen);

    const repaired = createSimState(7, { body: 99, skin: -3, hair: 0, hairColour: 0, outfit: 0 });
    expect(repaired.character).toEqual(normaliseAppearance({ body: 99, skin: -3, hair: 0, hairColour: 0, outfit: 0 }));
  });

  it('is untouched by simulation steps', () => {
    const chosen = randomAppearance(99);
    const state = createSimState(99, chosen);
    for (let i = 0; i < 120; i++) stepSim(state);
    expect(state.character).toEqual(chosen);
  });
});

describe('the seed in the URL hash', () => {
  it('is read, defaulted and written back', () => {
    expect(readSeedFromLocation('#seed=neonbay')).toBe('neonbay');
    expect(readSeedFromLocation('')).toBe(DEFAULT_SEED);
    expect(readSeedFromLocation('#seed=   ')).toBe(DEFAULT_SEED);
    expect(readSeedFromLocation(writeSeedToHash('', 'harbour'))).toBe('harbour');
    expect(readSeedFromLocation(writeSeedToHash('#seed=old&zoom=2', 'new'))).toBe('new');
    expect(writeSeedToHash('#zoom=2', 'new')).toContain('zoom=2');
  });
});
