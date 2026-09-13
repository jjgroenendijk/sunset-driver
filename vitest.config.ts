import { defineConfig } from 'vitest/config';

/**
 * Both figures are hang guards, not budgets: a test that takes this long is
 * stuck, not slow. `CLAUDE.md` holds what each tier is meant to cost, and
 * `docs/performance.md` how to measure it.
 *
 * The quick tier's guard has room for a busy laptop: the seed sweep's one hook
 * generates its worlds in the pool's workers, and on a loaded machine it passed
 * 15 s while the same run takes 10 s on an idle one. The full tier's guard
 * covers that hook for every seed of the sweep, which passed 120 s on a
 * four-core GitHub runner once the city filled the map.
 */
const timeout = process.env.SWEEP_SEEDS ? 300_000 : 60_000;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: timeout,
    // The sweeps generate their worlds in a `beforeAll`, so a hook may take as
    // long as a test.
    hookTimeout: timeout,
    slowTestThreshold: 2_000,
    // One environment per worker, reused by every file that worker runs. The
    // modules under test are pure, so nothing carries from one file to the next,
    // and the run stops re-importing three.js once per file.
    isolate: false,
  },
});
