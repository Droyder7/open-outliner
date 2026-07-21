import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one Postgres; run serially to avoid cross-talk.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
