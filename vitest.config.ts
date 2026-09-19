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

/** The check files of the seed sweep, one per subject. `seed-suite.ts` has how they share a world. */
const SWEEP = 'test/seed-*.test.ts';

export default defineConfig({
  test: {
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
    projects: [
      {
        extends: true,
        test: {
          name: 'sweep',
          include: [SWEEP],
          /**
           * One worker for every check file of the sweep. Vitest hands a
           * project's files to one worker in a single request when it may run
           * only one and does not isolate the files, so the files share a module
           * registry: `seed-fixture.ts` is loaded once and generates the worlds
           * once, however many files ask it. Give the project a second worker
           * and the second file generates every world again.
           *
           * The worlds are generated in `world-pool.ts`, which uses every core
           * the machine has, so the one worker costs the sweep nothing: the
           * checks it then runs read the worlds on one thread either way.
           */
          maxWorkers: 1,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [SWEEP],
          /**
           * A group of its own: vitest refuses two projects that ask for
           * different worker counts in one group. The groups run one after the
           * other, which costs the quick tier nothing — the pool already has
           * every core busy while the sweep generates, so a file running beside
           * it only takes a core away from it.
           */
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
