import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * Set before any test module is imported, which matters because
     * `src/config/env.ts` snapshots the environment at import time.
     *
     * NODE_ENV=test switches the database to `:memory:` and silences the
     * logger, so the suite needs no files, no ports and no cleanup. Each test
     * file runs in its own worker and therefore gets its own fresh database.
     */
    env: {
      NODE_ENV: 'test',
      SEED_ON_BOOT: 'false',
      VAPI_SERVER_SECRET: 'test-webhook-secret',
      PUBLIC_BASE_URL: 'https://example.test',
    },
  },
});
