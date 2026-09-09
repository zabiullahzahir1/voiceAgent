import path from 'node:path';
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
  publicBaseUrl: str('PUBLIC_BASE_URL', `http://localhost:${int('PORT', 3000)}`).replace(/\/+$/, ''),

  /** Absolute path to the SQLite file. Resolved so relative paths work from any cwd. */
  databasePath: path.resolve(process.cwd(), str('DATABASE_PATH', './data/patients.sqlite')),
  seedOnBoot: bool('SEED_ON_BOOT', true),

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
