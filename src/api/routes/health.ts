import type { FastifyInstance } from 'fastify';
import { countPatients } from '../../domain/patient.repository';
import { env } from '../../config/env';
import { ok } from '../envelope';

/**
 * Liveness/readiness probe.
 *
 * It touches the database rather than just returning 200, so a mounted-disk
 * problem on Render shows up here instead of during a live phone call. Render's
 * health check points at this path.
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const patientCount = countPatients();
    return reply.status(200).send(
      ok({
        status: 'ok',
        uptime_seconds: Math.round(process.uptime()),
        environment: env.nodeEnv,
        database: { reachable: true, patient_count: patientCount },
      }),
    );
  });
}
