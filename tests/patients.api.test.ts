import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

/**
 * Integration tests for the REST layer.
 *
 * These run the real routes, the real service layer and a real (in-memory)
 * SQLite database via `app.inject()` — no HTTP server, no mocks. What passes
 * here is what a reviewer's curl will hit.
 */

let app: FastifyInstance;

const VALID_PATIENT = {
  first_name: 'Jane',
  last_name: 'Doe',
  date_of_birth: '03/05/1985',
  sex: 'Female',
  phone_number: '(415) 555-0123',
  address_line_1: '42 Oak Street',
  city: 'San Francisco',
  state: 'California',
  zip_code: '94107',
};

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** Create a patient with a unique phone number so tests stay independent. */
let phoneSeed = 1000;
async function createPatient(overrides: Record<string, unknown> = {}) {
  phoneSeed += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/patients',
    payload: { ...VALID_PATIENT, phone_number: `415555${phoneSeed}`, ...overrides },
  });
  return { response, body: response.json() };
}

describe('POST /patients', () => {
  it('creates a patient, returning 201 and a generated UUID', async () => {
    const { response, body } = await createPatient();

    expect(response.statusCode).toBe(201);
    expect(body.error).toBeNull();
    expect(body.data.patient_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(response.headers.location).toBe(`/patients/${body.data.patient_id}`);
  });

  it('normalises input on the way in', async () => {
    const { body } = await createPatient({ state: 'California', zip_code: '941071234' });

    expect(body.data.state).toBe('CA'); // spoken name -> abbreviation
    expect(body.data.date_of_birth).toBe('1985-03-05'); // MM/DD/YYYY -> ISO
    expect(body.data.zip_code).toBe('94107-1234'); // 9 digits -> ZIP+4
    expect(body.data.phone_number).toMatch(/^\d{10}$/); // formatting stripped
    expect(body.data.preferred_language).toBe('English'); // default applied
  });

  it('rejects a future date of birth with 422 and names the field', async () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    const { response, body } = await createPatient({ date_of_birth: `01/01/${nextYear}` });

    expect(response.statusCode).toBe(422);
    expect(body.data).toBeNull();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.issues.map((i: { field: string }) => i.field)).toContain('date_of_birth');
  });

  it('rejects an invalid phone number with 422', async () => {
    const { response, body } = await createPatient({ phone_number: '555' });

    expect(response.statusCode).toBe(422);
    expect(body.error.issues[0].field).toBe('phone_number');
  });

  it('reports every invalid field at once rather than one at a time', async () => {
    const { response, body } = await createPatient({
      phone_number: '555',
      state: 'Ontario',
      zip_code: '1',
    });

    expect(response.statusCode).toBe(422);
    const fields = body.error.issues.map((i: { field: string }) => i.field);
    expect(fields).toEqual(expect.arrayContaining(['phone_number', 'state', 'zip_code']));
  });

  it('rejects a missing required field with 422', async () => {
    const { first_name: _omitted, ...withoutFirstName } = VALID_PATIENT;
    const response = await app.inject({
      method: 'POST',
      url: '/patients',
      payload: { ...withoutFirstName, phone_number: '4155559911' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.issues[0].field).toBe('first_name');
  });

  it('returns 409 when the phone number belongs to an active patient', async () => {
    const phone = '4155558800';
    await createPatient({ phone_number: phone });
    const { response, body } = await createPatient({ phone_number: phone });

    expect(response.statusCode).toBe(409);
    expect(body.error.code).toBe('CONFLICT');
  });

  it('returns 400 for a malformed JSON body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/patients',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
  });
});

describe('GET /patients', () => {
  it('filters by last_name, date_of_birth and phone_number', async () => {
    const { body: created } = await createPatient({ last_name: 'Zimmerman' });
    const phone = created.data.phone_number;

    const byName = await app.inject({ method: 'GET', url: '/patients?last_name=zimmerman' });
    expect(byName.statusCode).toBe(200);
    expect(byName.json().data.patients.length).toBeGreaterThan(0);

    // Accepts MM/DD/YYYY in the query string, matching the stored ISO value.
    const byDob = await app.inject({ method: 'GET', url: '/patients?date_of_birth=03/05/1985' });
    expect(byDob.json().data.patients.length).toBeGreaterThan(0);

    const byPhone = await app.inject({ method: 'GET', url: `/patients?phone_number=${phone}` });
    expect(byPhone.json().data.patients).toHaveLength(1);
    expect(byPhone.json().data.patients[0].patient_id).toBe(created.data.patient_id);
  });

  it('returns 422 for an unusable query parameter', async () => {
    const response = await app.inject({ method: 'GET', url: '/patients?date_of_birth=yesterday' });
    expect(response.statusCode).toBe(422);
  });
});

describe('GET /patients/:id', () => {
  it('returns the patient', async () => {
    const { body: created } = await createPatient();
    const response = await app.inject({ method: 'GET', url: `/patients/${created.data.patient_id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.patient_id).toBe(created.data.patient_id);
  });

  it('returns 404 for an unknown UUID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/patients/11111111-1111-4111-8111-111111111111',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 400 when the id is not a UUID', async () => {
    const response = await app.inject({ method: 'GET', url: '/patients/not-a-uuid' });
    expect(response.statusCode).toBe(400);
  });
});

describe('PUT /patients/:id', () => {
  it('applies a partial update and leaves other fields untouched', async () => {
    const { body: created } = await createPatient();

    const response = await app.inject({
      method: 'PUT',
      url: `/patients/${created.data.patient_id}`,
      payload: { last_name: 'Davis', email: 'jane dot davis at example dot com' },
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json().data;
    expect(updated.last_name).toBe('Davis');
    expect(updated.email).toBe('jane.davis@example.com');
    expect(updated.city).toBe('San Francisco'); // untouched
    expect(updated.updated_at >= updated.created_at).toBe(true);
  });

  it('validates updated fields', async () => {
    const { body: created } = await createPatient();
    const response = await app.inject({
      method: 'PUT',
      url: `/patients/${created.data.patient_id}`,
      payload: { zip_code: 'abc' },
    });

    expect(response.statusCode).toBe(422);
  });

  it('returns 404 for an unknown patient', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/patients/11111111-1111-4111-8111-111111111111',
      payload: { city: 'Oakland' },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /patients/:id', () => {
  it('soft-deletes: the row is retained with deleted_at set', async () => {
    const { body: created } = await createPatient();
    const id = created.data.patient_id;

    const deleted = await app.inject({ method: 'DELETE', url: `/patients/${id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.deleted_at).toBeTruthy();

    // Gone from the default views...
    expect((await app.inject({ method: 'GET', url: `/patients/${id}` })).statusCode).toBe(404);

    // ...but still in the database.
    const withDeleted = await app.inject({
      method: 'GET',
      url: `/patients?include_deleted=true&phone_number=${created.data.phone_number}`,
    });
    expect(withDeleted.json().data.patients).toHaveLength(1);
  });

  it('returns 404 on a second delete', async () => {
    const { body: created } = await createPatient();
    await app.inject({ method: 'DELETE', url: `/patients/${created.data.patient_id}` });
    const again = await app.inject({ method: 'DELETE', url: `/patients/${created.data.patient_id}` });

    expect(again.statusCode).toBe(404);
  });

  it('frees the phone number for re-registration', async () => {
    const phone = '4155557700';
    const { body: created } = await createPatient({ phone_number: phone });
    await app.inject({ method: 'DELETE', url: `/patients/${created.data.patient_id}` });

    const { response } = await createPatient({ phone_number: phone });
    expect(response.statusCode).toBe(201);
  });
});

describe('conventions', () => {
  it('wraps every response in the { data, error } envelope', async () => {
    const okResponse = await app.inject({ method: 'GET', url: '/health' });
    expect(okResponse.json()).toMatchObject({ error: null });
    expect(okResponse.json().data.status).toBe('ok');

    const errorResponse = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(errorResponse.statusCode).toBe(404);
    expect(errorResponse.json().data).toBeNull();
    expect(errorResponse.json().error.code).toBe('NOT_FOUND');
  });
});
