import { closePool, migrate, query } from './client';
import { logger } from '../lib/logger';

/**
 * Standalone migration entry point (`npm run migrate`).
 *
 * The schema is idempotent DDL and is also applied automatically when the
 * server boots, so this script exists mainly to prepare or inspect a database
 * without starting the API — useful when pointing at a fresh Neon/Render
 * instance for the first time.
 */
async function main(): Promise<void> {
  await migrate();

  const tables = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );

  logger.info({ tables: tables.map((t) => t.table_name) }, 'Schema applied');
  await closePool();
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Migration failed');
  process.exit(1);
});
