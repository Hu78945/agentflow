import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks', // Temporal's native core and PGlite's WASM both prefer their own process
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
