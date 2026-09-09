import { getDb } from './client';
import { logger } from '../lib/logger';
import { env } from '../config/env';

/**
 * Standalone migration entry point (`npm run migrate`).
 *
 * The schema is idempotent (`CREATE TABLE IF NOT EXISTS` throughout) and is
 * also applied automatically when the server opens the database, so this script
 * exists mainly to create or inspect the file without booting the API — useful
 * in a Docker build step or when debugging a mounted disk.
 */
function main(): void {
  const db = getDb();

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];

  logger.info(
    { database: env.databasePath, tables: tables.map((t) => t.name) },
    'Schema applied',
  );
}

main();
