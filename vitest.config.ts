import { defineConfig } from 'vitest/config';

/**
 * The suite runs against a real Postgres — no mocks, no in-memory emulator — so
 * constraints, partial unique indexes and ON CONFLICT are genuinely exercised.
 *
 * Start one before running `npm test`:
 *   docker run -d --name va-postgres -p 55432:5432 \
 *     -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=patients postgres:16-alpine
 *
 * Override the connection with TEST_DATABASE_URL to point elsewhere.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],

    /**
     * Test files share one database, so they must not run concurrently — each
     * one truncates the tables in `beforeAll`.
     */
    fileParallelism: false,

    /**
     * Set before any test module is imported, which matters because
     * `src/config/env.ts` snapshots the environment at import time.
     */
    env: {
      NODE_ENV: 'test',
      SEED_ON_BOOT: 'false',
      VAPI_SERVER_SECRET: 'test-webhook-secret',
      PUBLIC_BASE_URL: 'https://example.test',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://postgres:devpass@localhost:55432/patients',
      DATABASE_SSL: 'false',
    },
  },
});
