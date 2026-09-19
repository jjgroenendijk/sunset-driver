import { beforeAll, describe } from 'vitest';
import { ready, seeds } from './seed-fixture.ts';
import { SEED_COUNT, SHARD_COUNT, SHARD_INDEX } from './seed-limits.ts';

/**
 * The suite every check file of the seed sweep declares (spec section 3). One
 * file holds the checks of one subject, and each of them calls this once.
 *
 * Generating a world is the dearest thing this project does, so the files read
 * one set of worlds rather than a set each. They can, because `vitest.config.ts`
 * gives them a project of their own that runs in a single worker and does not
 * isolate the files: one module registry holds `seed-fixture.ts`, and `ready()`
 * generates the worlds for whichever file asks first. A file run on its own
 * generates the same set for itself and passes the same way.
 *
 * `seed-limits.ts` holds the numbers the checks hold a world to, `seed-probes.ts`
 * the readings they take of it, and `seed-index.ts` the two indexes they ask
 * through.
 */
const tier =
  SHARD_COUNT === 1
    ? `${SEED_COUNT} seeds`
    : `${seeds.length} of ${SEED_COUNT} seeds, shard ${SHARD_INDEX + 1}/${SHARD_COUNT}`;

/** Declare one subject's checks over the worlds the fixture builds. */
export function sweepSuite(subject: string, checks: () => void): void {
  describe(`${subject} (${tier})`, () => {
    beforeAll(ready);
    checks();
  });
}
