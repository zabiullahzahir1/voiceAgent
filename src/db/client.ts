import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { SCHEMA_SQL } from './schema';

let db: Database.Database | null = null;

/**
 * Lazily open (and migrate) the SQLite database.
 *
 * Why SQLite: the assessment explicitly calls out "SQLite over Postgres" as a
 * reasonable shortcut. There is a single writer (this process), the data volume
 * is tiny, and pointing `DATABASE_PATH` at a mounted Render disk gives us real
 * persistence across restarts and redeploys with zero operational surface.
 */
export function getDb(): Database.Database {
  if (db) return db;

  // In-memory database for the test suite; a file on disk everywhere else.
  const location = env.isTest ? ':memory:' : env.databasePath;

  if (location !== ':memory:') {
    fs.mkdirSync(path.dirname(location), { recursive: true });
  }

  db = new Database(location);

  // WAL lets the API read while the voice webhook writes, without lock errors.
  if (location !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Wait rather than immediately throwing SQLITE_BUSY if a write overlaps.
  db.pragma('busy_timeout = 5000');

  db.exec(SCHEMA_SQL);

  logger.info({ database: location }, 'SQLite database ready');
  return db;
}

/** Used by the test suite to get a clean database between files. */
export function closeDb(): void {
  db?.close();
  db = null;
}
