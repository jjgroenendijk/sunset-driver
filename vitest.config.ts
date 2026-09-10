import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Timing budget: the quick tier (default) must finish in seconds. The full sweep
    // (SWEEP_SEEDS=200) is the only thing allowed to take longer.
    testTimeout: process.env.SWEEP_SEEDS ? 120_000 : 15_000,
    slowTestThreshold: 2_000,
  },
});
