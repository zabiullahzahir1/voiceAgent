import type { FastifyInstance } from 'fastify';
import { listCallLogsForPatient, listRecentCallLogs } from '../../domain/call-log.repository';
import { getPatient } from '../../domain/patient.service';
import { ok } from '../envelope';

/**
 * Read-only views over stored call transcripts (bonus requirement).
 *
 * Deliberately read-only: call logs are written by the Vapi webhook and by the
 * tool handlers, never by an API client.
 */
export async function registerCallRoutes(app: FastifyInstance): Promise<void> {
  /** GET /calls — most recent calls, for the dashboard and for debugging. */
  app.get<{ Querystring: { limit?: string } }>('/calls', async (request, reply) => {
    const limit = Math.min(Number.parseInt(request.query.limit ?? '25', 10) || 25, 100);
    return reply.status(200).send(ok({ calls: await listRecentCallLogs(limit) }));
  });

  /** GET /patients/:id/calls — the calls that created or updated this record. */
  app.get<{ Params: { id: string } }>('/patients/:id/calls', async (request, reply) => {
    // 404s for an unknown patient rather than returning an empty list.
    const patient = await getPatient(request.params.id);
    return reply.status(200).send(
      ok({
        patient_id: patient.patient_id,
        calls: await listCallLogsForPatient(patient.patient_id),
      }),
    );
  });
}
