import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Each test file builds its own in-memory SQLite database from migrations/.
    pool: 'forks',
    testTimeout: 20_000,
  },
});
