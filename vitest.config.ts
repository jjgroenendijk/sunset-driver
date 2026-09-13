import { defineConfig } from 'vitest/config';

/**
 * The quick tier (default) must finish in seconds. The full sweep
 * (SWEEP_SEEDS=200) is the only thing allowed to take longer.
 *
 * The full tier's figure is a hang guard and not a budget: `docs/performance.md`
 * holds what the tier is meant to cost. It has to cover the seed sweep's one
 * hook, which generates every world of the sweep in the pool's workers while
 * the simulation sweep runs beside it on the same cores. That hook alone passed
 * 120 s on a four-core GitHub runner once the city filled the map.
 */
const timeout = process.env.SWEEP_SEEDS ? 300_000 : 15_000;

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
