import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Tests create disposable PostgreSQL databases; run sequentially to keep
    // resource usage predictable on small machines.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
