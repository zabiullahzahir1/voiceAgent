import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { env } from './config/env';
import { logger } from './lib/logger';
import { registerErrorHandler } from './api/error-handler';
import { registerHealthRoutes } from './api/routes/health';
import { registerPatientRoutes } from './api/routes/patients';
import { registerCallRoutes } from './api/routes/calls';
import { registerVapiRoutes } from './voice/routes/vapi';

/**
 * Builds the Fastify app without starting it.
 *
 * Kept separate from `index.ts` so the test suite can use `app.inject()` to
 * exercise real routes over an in-memory database, with no port binding and no
 * network.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    /**
     * Cast at the boundary: Fastify 5 bundles its own (older) pino typings, so
     * a pino 9.14 `Logger` is structurally fine but nominally mismatched.
     * Casting here keeps every route typed against the default FastifyInstance
     * instead of leaking the specialised logger generic through the app.
     */
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Vapi sits behind a proxy; trust the forwarded headers for accurate logs.
    trustProxy: true,
    /** A tool-call payload is small — reject anything that clearly is not one. */
    bodyLimit: 1_048_576, // 1 MB
  });

  registerErrorHandler(app);

  // The dashboard is a static page served from the same origin, but CORS is
  // open so reviewers can hit the API from anywhere (curl, Postman, a browser).
  await app.register(cors, { origin: true });

  // --- Routes --------------------------------------------------------------
  await app.register(registerHealthRoutes);
  await app.register(registerPatientRoutes);
  await app.register(registerCallRoutes);
  await app.register(registerVapiRoutes);

  // --- Dashboard (bonus) ---------------------------------------------------
  const publicDir = path.join(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
  } else {
    app.get('/', async (_request, reply) =>
      reply.status(200).send({ data: { service: 'voice-patient-registration' }, error: null }),
    );
  }

  return app;
}
