import type { FastifyInstance } from 'fastify';
import { BadRequestError } from '../../lib/errors';
import * as patients from '../../domain/patient.service';
import { requireApiToken } from '../auth';
import { ok } from '../envelope';

/**
 * REST routes for the patient resource.
 *
 * Routes stay thin on purpose: parse the path/query, delegate to the service,
 * wrap the result in the envelope. All validation, duplicate detection and
 * business rules live in `patient.service.ts` — the voice agent goes through
 * the same code, so there is exactly one definition of "a valid patient".
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reject a non-UUID id before it reaches the database.
 *
 * Postgres raises a type error for a malformed UUID, which would surface as a
 * 500; this turns it into an honest 400.
 */
function assertUuid(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new BadRequestError('patient_id must be a UUID.', [
      { field: 'patient_id', message: 'Expected a UUID.' },
    ]);
  }
  return id;
}

export async function registerPatientRoutes(app: FastifyInstance): Promise<void> {
  /** GET /patients — list, with optional last_name / date_of_birth / phone_number filters. */
  app.get('/patients', async (request, reply) => {
    const { rows, total } = await patients.listPatients(request.query);
    return reply.status(200).send(
      ok({
        patients: rows.map(patients.toApiView),
        total,
        count: rows.length,
      }),
    );
  });

  /** GET /patients/:id — fetch one by UUID. */
  app.get<{ Params: { id: string } }>('/patients/:id', async (request, reply) => {
    const patient = await patients.getPatient(assertUuid(request.params.id));
    return reply.status(200).send(ok(patients.toApiView(patient)));
  });

  /** POST /patients — create. 201 on success, 409 if the phone is taken, 422 on bad fields. */
  app.post('/patients', { preHandler: requireApiToken }, async (request, reply) => {
    const patient = await patients.createPatient(request.body);
    return reply
      .status(201)
      .header('Location', `/patients/${patient.patient_id}`)
      .send(ok(patients.toApiView(patient)));
  });

  /** PUT /patients/:id — partial update; omitted fields are left untouched. */
  app.put<{ Params: { id: string } }>(
    '/patients/:id',
    { preHandler: requireApiToken },
    async (request, reply) => {
      const patient = await patients.updatePatient(assertUuid(request.params.id), request.body);
      return reply.status(200).send(ok(patients.toApiView(patient)));
    },
  );

  /** DELETE /patients/:id — soft delete only; the row is retained with deleted_at set. */
  app.delete<{ Params: { id: string } }>(
    '/patients/:id',
    { preHandler: requireApiToken },
    async (request, reply) => {
      const patient = await patients.deletePatient(assertUuid(request.params.id));
      return reply
        .status(200)
        .send(ok({ patient_id: patient.patient_id, deleted_at: patient.deleted_at }));
    },
  );
}
