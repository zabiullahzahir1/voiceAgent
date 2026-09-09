import crypto from 'node:crypto';
import { query, queryOne } from '../db/client';
import type { CreatePatientInput, ListPatientsQuery, UpdatePatientInput } from './patient.schema';

/**
 * Data access for `patients`. Parameterised SQL only — no validation and no
 * HTTP awareness. Callers are expected to hand it values that have already
 * been through `patient.schema.ts`.
 *
 * Every query uses bound parameters (`$1`, `$2`, …) rather than interpolation,
 * so user-supplied values can never be parsed as SQL.
 */

export type Patient = {
  patient_id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  sex: string;
  phone_number: string;
  email: string | null;
  address_line_1: string;
  address_line_2: string | null;
  city: string;
  state: string;
  zip_code: string;
  insurance_provider: string | null;
  insurance_member_id: string | null;
  preferred_language: string;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** Columns a client is allowed to write, in a fixed order. */
const WRITABLE_COLUMNS = [
  'first_name',
  'last_name',
  'date_of_birth',
  'sex',
  'phone_number',
  'email',
  'address_line_1',
  'address_line_2',
  'city',
  'state',
  'zip_code',
  'insurance_provider',
  'insurance_member_id',
  'preferred_language',
  'emergency_contact_name',
  'emergency_contact_phone',
] as const;

/** Postgres error code for a unique-constraint violation. */
export const UNIQUE_VIOLATION = '23505';

export async function insertPatient(input: CreatePatientInput): Promise<Patient> {
  const patientId = crypto.randomUUID();

  const rows = await query<Patient>(
    `INSERT INTO patients (
       patient_id, first_name, last_name, date_of_birth, sex, phone_number, email,
       address_line_1, address_line_2, city, state, zip_code,
       insurance_provider, insurance_member_id, preferred_language,
       emergency_contact_name, emergency_contact_phone
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      patientId,
      input.first_name,
      input.last_name,
      input.date_of_birth,
      input.sex,
      input.phone_number,
      input.email ?? null,
      input.address_line_1,
      input.address_line_2 ?? null,
      input.city,
      input.state,
      input.zip_code,
      input.insurance_provider ?? null,
      input.insurance_member_id ?? null,
      input.preferred_language ?? 'English',
      input.emergency_contact_name ?? null,
      input.emergency_contact_phone ?? null,
    ],
  );

  // RETURNING guarantees exactly one row on a successful insert.
  return rows[0]!;
}

export async function findPatientById(
  patientId: string,
  includeDeleted = false,
): Promise<Patient | null> {
  return queryOne<Patient>(
    `SELECT * FROM patients
      WHERE patient_id = $1 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    [patientId],
  );
}

/** Active patient with this exact 10-digit number. Drives duplicate detection. */
export async function findActivePatientByPhone(phoneNumber: string): Promise<Patient | null> {
  return queryOne<Patient>(
    'SELECT * FROM patients WHERE phone_number = $1 AND deleted_at IS NULL',
    [phoneNumber],
  );
}

export async function listPatients(
  q: ListPatientsQuery,
): Promise<{ rows: Patient[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!q.include_deleted) conditions.push('deleted_at IS NULL');

  if (q.last_name) {
    // Case-insensitive prefix match — matches the lower(last_name) index.
    params.push(`${q.last_name.toLowerCase()}%`);
    conditions.push(`lower(last_name) LIKE $${params.length}`);
  }
  if (q.date_of_birth) {
    params.push(q.date_of_birth);
    conditions.push(`date_of_birth = $${params.length}`);
  }
  if (q.phone_number) {
    params.push(q.phone_number);
    conditions.push(`phone_number = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRows = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM patients ${where}`,
    params,
  );
  const total = Number(totalRows[0]?.count ?? 0);

  params.push(q.limit ?? 50, q.offset ?? 0);
  const rows = await query<Patient>(
    `SELECT * FROM patients ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { rows, total };
}

/**
 * Apply a partial update. Only keys present in `input` are touched, so a PUT
 * that omits a field leaves the stored value alone rather than nulling it.
 */
export async function updatePatient(
  patientId: string,
  input: UpdatePatientInput,
): Promise<Patient | null> {
  const assignments: string[] = [];
  const params: unknown[] = [];

  for (const column of WRITABLE_COLUMNS) {
    const value = (input as Record<string, unknown>)[column];
    if (value !== undefined) {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    }
  }

  if (assignments.length === 0) return findPatientById(patientId);

  params.push(patientId);

  return queryOne<Patient>(
    `UPDATE patients
        SET ${assignments.join(', ')}, updated_at = now()
      WHERE patient_id = $${params.length} AND deleted_at IS NULL
      RETURNING *`,
    params,
  );
}

/** Soft delete — the row stays, `deleted_at` is stamped. Idempotent. */
export async function softDeletePatient(patientId: string): Promise<Patient | null> {
  return queryOne<Patient>(
    `UPDATE patients
        SET deleted_at = now(), updated_at = now()
      WHERE patient_id = $1 AND deleted_at IS NULL
      RETURNING *`,
    [patientId],
  );
}

export async function countPatients(): Promise<number> {
  const rows = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM patients');
  return Number(rows[0]?.count ?? 0);
}
