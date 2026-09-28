import { describe, expect, it } from 'vitest';
import { SPARKS_PER_HIT } from '../../../src/render/weapons/melee-fx.ts';
import { blazeStream } from '../../../src/render/vehicles/damage-fx.ts';
import { HIT_CAP } from '../../../src/sim/weapons/melee.ts';
import { TRACER_CAP } from '../../../src/sim/weapons/tracer.ts';

/**
 * The streams of `Subsystem.Damage` that `damage-fx.ts`, `melee-fx.ts` and
 * `shot-fx.ts` jitter from. Two users of one stream in one tick draw the same
 * numbers, so two effects would take the same jitter.
 */
describe('the streams of a blaze', () => {
  const PARTS = 4;

  it('gives every part of every blaze a stream of its own', () => {
    const seen = new Set<number>();
    for (let id = 0; id < 5000; id++) {
      for (let part = 0; part < PARTS; part++) seen.add(blazeStream(id, part));
    }
    expect(seen.size).toBe(5000 * PARTS);
  });

  it('stays clear of the blast, the melee sparks and the impacts of rounds', () => {
    // The blast draws from 1 to 205; sparks start at 400 and impacts at 900,
    // one run of SPARKS_PER_HIT ids for each hit or round the record keeps.
    const highest = 900 + Math.max(HIT_CAP, TRACER_CAP) * SPARKS_PER_HIT;
    expect(blazeStream(0, 0)).toBeGreaterThan(highest);
  });
});
