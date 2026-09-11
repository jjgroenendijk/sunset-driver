import { defineConfig } from 'vitest/config';

/**
 * Timing budget: the quick tier (default) must finish in seconds. The full sweep
 * (SWEEP_SEEDS=200) is the only thing allowed to take longer.
 */
const timeout = process.env.SWEEP_SEEDS ? 120_000 : 15_000;

const shared = {
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
} as const;

export default defineConfig({
  test: {
    // `test/budget.test.ts` measures wall-clock cost, so it may not share the
    // machine with the sweeps, which fill every core generating worlds. Two
    // projects with different group orders run one after the other; a lower
    // group order goes first.
    projects: [
      {
        test: {
          ...shared,
          name: 'budgets',
          include: ['test/budget.test.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...shared,
          name: 'sweeps',
          include: ['test/**/*.test.ts'],
          exclude: ['test/budget.test.ts'],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
