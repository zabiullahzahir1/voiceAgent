import pg, { type Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { SCHEMA_SQL } from './schema';

/**
 * PostgreSQL connection pool.
 *
 * Why Postgres: the persistence requirement ("Jane Doe must still be there on
 * Call 2") needs storage that outlives the container. A managed Postgres gives
 * that on a free tier, whereas a SQLite file would need a paid persistent disk
 * on Render. It also removes the single-writer limitation, so the service can
 * be scaled horizontally without changing anything above the repository layer.
 */

// ---------------------------------------------------------------------------
// Type parsers
// ---------------------------------------------------------------------------

/**
 * node-postgres hydrates DATE and TIMESTAMPTZ into JavaScript `Date` objects by
 * default, which would leak timezone-shifted values into API responses — a
 * patient born on 1985-03-05 can come back as 1985-03-04 depending on the
 * server's timezone.
 *
 * Overriding the parsers keeps the wire format identical to what the API
 * promises: dates as `YYYY-MM-DD`, timestamps as ISO-8601 UTC strings.
 */
const OID = { DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184 } as const;

pg.types.setTypeParser(OID.DATE, (value: string) => value);
pg.types.setTypeParser(OID.TIMESTAMPTZ, (value: string) => new Date(value).toISOString());
pg.types.setTypeParser(OID.TIMESTAMP, (value: string) => new Date(`${value}Z`).toISOString());

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

let pool: Pool | null = null;

/**
 * Remove `sslmode` (and the related `uselibpqcompat`) from the connection
 * string.
 *
 * Managed providers hand out URLs ending in `?sslmode=require`, but TLS is
 * configured explicitly via the `ssl` option below. Leaving both in place means
 * two sources of truth, and `pg-connection-string` emits a deprecation warning
 * about `require` changing meaning in pg v9. Stripping it makes the `ssl`
 * option unambiguously authoritative and keeps the logs clean.
 */
function stripSslMode(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('uselibpqcompat');
    return url.toString();
  } catch {
    // Not a parseable URL (e.g. a libpq key=value string) — leave it untouched.
    return connectionString;
  }
}

export function getPool(): Pool {
  if (pool) return pool;

  if (!env.databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Point it at a Postgres instance — see .env.example.',
    );
  }

  pool = new pg.Pool({
    connectionString: stripSslMode(env.databaseUrl),
    /**
     * Managed providers (Neon, Supabase, Render) require TLS but present
     * certificates that Node's default CA bundle does not chain to. Local
     * development over plain TCP needs no TLS at all.
     */
    ssl: env.databaseSsl ? { rejectUnauthorized: false } : false,
    /** A voice call plus a few API readers never needs a large pool. */
    max: 10,
    idleTimeoutMillis: 30_000,
    /** Fail fast rather than leaving a caller in silence. */
    connectionTimeoutMillis: 10_000,
  });

  // An idle client erroring (a dropped connection to a serverless Postgres that
  // scaled to zero) must not take the process down mid-call.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'Idle Postgres client error');
  });

  return pool;
}

/** Parameterised query helper. Every call site uses `$1`-style placeholders. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

/** Convenience for queries that return at most one row. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run several statements in one transaction, rolling back on any failure.
 * Used where a read and a dependent write must not race another caller.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Apply the schema. Idempotent, so it runs on every boot — adequate for a
 * greenfield service; see the README for why a real migration tool would
 * replace this once columns start changing.
 */
export async function migrate(): Promise<void> {
  await query(SCHEMA_SQL);
  logger.info('Database schema applied');
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
