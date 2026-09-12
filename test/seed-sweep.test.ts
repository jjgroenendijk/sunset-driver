import { beforeAll, describe } from 'vitest';
import { SEED_COUNT } from './seed-limits.ts';
import { ready } from './seed-fixture.ts';
import { terrainChecks } from './seed-terrain.ts';
import { roadChecks } from './seed-roads.ts';
import { groundChecks } from './seed-ground.ts';
import { parcelChecks } from './seed-parcels.ts';
import { chunkChecks } from './seed-chunks.ts';
import { placeChecks } from './seed-places.ts';

/**
 * The seed sweep of spec section 3: every check the generated world has to pass,
 * on every seed of the tier.
 *
 * The checks are grouped by subject, one file each, and declared here inside one
 * suite. Generating a world is the dearest thing this project does, so all of
 * them read the one set `seed-fixture.ts` builds: a file of its own per subject
 * would run in parallel with the others and generate every world again. `seed-
 * limits.ts` holds the numbers they hold a world to, `seed-probes.ts` the
 * readings they take of it, and `seed-index.ts` the two indexes they ask
 * through.
 */
describe(`seed sweep (${SEED_COUNT} seeds)`, () => {
  beforeAll(ready);

  terrainChecks();
  roadChecks();
  groundChecks();
  parcelChecks();
  chunkChecks();
  placeChecks();
});
