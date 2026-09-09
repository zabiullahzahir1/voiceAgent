import type { FastifyInstance } from 'fastify';
import { countPatients } from '../../domain/patient.repository';
import { env } from '../../config/env';
import { ok } from '../envelope';

/**
 * Liveness/readiness probe.
 *
 * It runs a real query rather than just returning 200, so a database
 * connectivity problem shows up here instead of during a live phone call.
 * Render's health check points at this path.
 *
 * Returns 503 when the database is unreachable, which is what makes it usable
 * as a readiness gate: a failing instance stops receiving traffic.
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const base = {
      uptime_seconds: Math.round(process.uptime()),
      environment: env.nodeEnv,
    };

    try {
      const patientCount = await countPatients();
      return reply.status(200).send(
        ok({ ...base, status: 'ok', database: { reachable: true, patient_count: patientCount } }),
      );
    } catch (error) {
      app.log.error({ err: error }, 'Health check failed — database unreachable');
      return reply
        .status(503)
        .send(ok({ ...base, status: 'degraded', database: { reachable: false } }));
    }
  });
}
