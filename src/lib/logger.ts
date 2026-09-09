import pino from 'pino';
import { env } from '../config/env';

/**
 * Single shared logger.
 *
 * Observability requirement: every call's final collected payload is logged as
 * structured JSON to stdout (see `src/voice/tools.ts`), which is what Render's
 * log drain captures. Pretty-printing is enabled only outside production so the
 * output stays machine-parseable where it matters.
 */
export const logger = pino({
  level: env.isTest ? 'silent' : env.logLevel,
  base: undefined, // drop pid/hostname noise
  timestamp: pino.stdTimeFunctions.isoTime,
  /**
   * Defence-in-depth: keep secrets out of logs even if a handler accidentally
   * logs a whole request object.
   */
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-vapi-secret"]',
      'headers.authorization',
      'headers["x-vapi-secret"]',
    ],
    censor: '[redacted]',
  },
  ...(env.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'hostname,pid' },
        },
      }),
});
