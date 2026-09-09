import { migrate, query } from '../../src/db/client';

/**
 * Test database helpers.
 *
 * The suite runs against a real Postgres rather than a mock or an emulator, so
 * CHECK constraints, partial unique indexes and `ON CONFLICT` behave exactly as
 * they will in production. Start one with:
 *
 *   docker run -d --name va-postgres -p 55432:5432 \
 *     -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=patients postgres:16-alpine
 *
 * `vitest.config.ts` sets `fileParallelism: false`, so test files share this
 * database sequentially and a reset at the start of each file is sufficient
 * isolation.
 */

/** Apply the schema and empty every table. */
export async function resetDatabase(): Promise<void> {
  await migrate();
  // RESTART IDENTITY + CASCADE clears dependent rows in one statement.
  await query('TRUNCATE appointments, call_logs, patients RESTART IDENTITY CASCADE');
}
