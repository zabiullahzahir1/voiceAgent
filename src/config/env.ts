import dotenv from 'dotenv';

dotenv.config();

/**
 * Central, validated view of the process environment.
 *
 * Nothing else in the codebase reads `process.env` directly — that keeps
 * secrets out of business logic and makes the required configuration
 * discoverable in exactly one place (mirrored by `.env.example`).
 */

function str(key: string, fallback = ''): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(key: string, fallback: number): number {
  const parsed = Number.parseInt(str(key), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const nodeEnv = str('NODE_ENV', 'development');

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',

  port: int('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  logLevel: str('LOG_LEVEL', 'info'),
  /**
   * Public URL Vapi calls back into.
   *
   * Derived from whatever the host injects, so no deployment needs its own URL
   * pasted back into its own environment:
   *   - Vercel: VERCEL_PROJECT_PRODUCTION_URL (stable) then VERCEL_URL
   *     (per-deployment). Both omit the scheme, so https:// is prefixed.
   *   - Render: RENDER_EXTERNAL_URL (already absolute).
   * An explicit PUBLIC_BASE_URL always wins — which is what a local ngrok or
   * cloudflared tunnel needs.
   */
  publicBaseUrl: (() => {
    const explicit = str('PUBLIC_BASE_URL');
    if (explicit) return explicit.replace(/\/+$/, '');

    const vercelHost = str('VERCEL_PROJECT_PRODUCTION_URL', str('VERCEL_URL'));
    if (vercelHost) return `https://${vercelHost.replace(/\/+$/, '')}`;

    const render = str('RENDER_EXTERNAL_URL');
    if (render) return render.replace(/\/+$/, '');

    return `http://localhost:${int('PORT', 3000)}`;
  })(),

  /** Postgres connection string, e.g. postgresql://user:pass@host/db. */
  databaseUrl: str('DATABASE_URL'),
  /**
   * TLS for the database connection. Managed providers (Neon, Supabase, Render)
   * require it; a local Postgres over plain TCP does not. Auto-detected from
   * the connection string unless `DATABASE_SSL` is set explicitly.
   */
  databaseSsl: (() => {
    const explicit = process.env.DATABASE_SSL;
    if (explicit !== undefined && explicit !== '') {
      return ['1', 'true', 'yes', 'on'].includes(explicit.toLowerCase());
    }
    const url = str('DATABASE_URL');
    if (url === '') return false;
    if (/sslmode=(disable|allow)/.test(url)) return false;
    // Anything not obviously local is assumed to be a managed, TLS-only host.
    return !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  })(),

  seedOnBoot: bool('SEED_ON_BOOT', true),
  /**
   * Apply the schema at startup.
   *
   * On a long-lived server this is free — it happens once. On serverless it
   * runs again on every cold start, so it can be turned off there once the
   * schema exists (`npm run migrate` applies it out of band).
   */
  migrateOnBoot: bool('MIGRATE_ON_BOOT', true),

  vapi: {
    apiKey: str('VAPI_API_KEY'),
    /** Shared secret checked on every inbound Vapi webhook. */
    serverSecret: str('VAPI_SERVER_SECRET'),
    phoneNumberId: str('VAPI_PHONE_NUMBER_ID'),
  },

  /** Optional bearer token guarding the API's write endpoints. Blank = open. */
  apiToken: str('API_TOKEN'),
} as const;

/**
 * Warnings (not hard failures) for config that a *deployed* instance needs.
 * The service still boots without them so that local development and the test
 * suite never require a Vapi account.
 */
export function warnAboutMissingConfig(warn: (message: string) => void): void {
  if (!env.databaseUrl) {
    warn('DATABASE_URL is not set — the service cannot persist anything.');
  }
  if (!env.vapi.serverSecret) {
    warn(
      'VAPI_SERVER_SECRET is not set — the /voice/vapi webhook will accept unauthenticated requests. Set it before going live.',
    );
  }
  if (env.isProduction && !env.apiToken) {
    warn('API_TOKEN is not set — write endpoints (POST/PUT/DELETE /patients) are unauthenticated.');
  }
  if (env.isProduction && env.publicBaseUrl.includes('localhost')) {
    warn('PUBLIC_BASE_URL still points at localhost — Vapi will not be able to reach this server.');
  }
}
