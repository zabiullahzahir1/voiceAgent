import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { env } from '../src/config/env';
import { migrate } from '../src/db/client';
import { logger } from '../src/lib/logger';
import { seedIfEmpty } from '../src/db/seed';

/**
 * Vercel serverless entry point.
 *
 * The same Fastify app that `src/index.ts` runs as a long-lived server is
 * reused here — Vercel just hands it requests instead of a listening socket.
 * Nothing in `src/` is aware of the deployment target.
 *
 * Why this deployment exists: Render, Fly and Railway all now require a payment
 * method even on their free tiers. Vercel does not, and the assessment lists it
 * as an acceptable host. Because state lives in Neon Postgres rather than on
 * disk, running on ephemeral serverless instances costs us nothing.
 *
 * Cold-start strategy: the app is built once per instance and memoised in
 * module scope, so only the *first* request to a fresh instance pays the setup
 * cost. Warm invocations reuse the same Fastify instance and the same Postgres
 * pool — which matters, because Vapi expects a tool call to return in seconds.
 */

let appPromise: Promise<FastifyInstance> | null = null;

function initialise(): Promise<FastifyInstance> {
  return (async () => {
    // Idempotent DDL. Set MIGRATE_ON_BOOT=false once the schema is stable to
    // shave a few queries off each cold start.
    if (env.migrateOnBoot) {
      await migrate();
      if (env.seedOnBoot) await seedIfEmpty();
    }

    const app = await buildApp();
    // `ready()` rather than `listen()` — Vercel owns the socket.
    await app.ready();
    return app;
  })();
}

function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = initialise().catch((error: unknown) => {
      // Clear the memo so a transient failure (a database still waking up)
      // does not poison this instance for every subsequent request.
      appPromise = null;
      throw error;
    });
  }
  return appPromise;
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const app = await getApp();
    // Hand the raw request to Fastify's internal server. This is the standard
    // way to run Fastify without binding a port.
    app.server.emit('request', request, response);
  } catch (error) {
    logger.error({ err: error }, 'Failed to initialise the app');
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        data: null,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is starting up. Please retry.' },
      }),
    );
  }
}
