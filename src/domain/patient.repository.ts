import crypto from 'node:crypto';
import { getDb } from '../db/client';
import type { CreatePatientInput, ListPatientsQuery, UpdatePatientInput } from './patient.schema';

/**
 * Data access for `patients`. Pure SQL, no validation and no HTTP awareness —
 * callers are expected to hand it values that have already been through
 * `patient.schema.ts`.
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

function nowIso(): string {
  return new Date().toISOString();
}

export function insertPatient(input: CreatePatientInput): Patient {
  const db = getDb();
  const timestamp = nowIso();
  const patientId = crypto.randomUUID();

  const row = {
    patient_id: patientId,
    first_name: input.first_name,
    last_name: input.last_name,
    date_of_birth: input.date_of_birth,
    sex: input.sex,
    phone_number: input.phone_number,
    email: input.email ?? null,
    address_line_1: input.address_line_1,
    address_line_2: input.address_line_2 ?? null,
    city: input.city,
    state: input.state,
    zip_code: input.zip_code,
    insurance_provider: input.insurance_provider ?? null,
    insurance_member_id: input.insurance_member_id ?? null,
    preferred_language: input.preferred_language ?? 'English',
    emergency_contact_name: input.emergency_contact_name ?? null,
    emergency_contact_phone: input.emergency_contact_phone ?? null,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
  };

  db.prepare(
    `INSERT INTO patients (
       patient_id, first_name, last_name, date_of_birth, sex, phone_number, email,
       address_line_1, address_line_2, city, state, zip_code,
       insurance_provider, insurance_member_id, preferred_language,
       emergency_contact_name, emergency_contact_phone,
       created_at, updated_at, deleted_at
     ) VALUES (
       @patient_id, @first_name, @last_name, @date_of_birth, @sex, @phone_number, @email,
       @address_line_1, @address_line_2, @city, @state, @zip_code,
       @insurance_provider, @insurance_member_id, @preferred_language,
       @emergency_contact_name, @emergency_contact_phone,
       @created_at, @updated_at, @deleted_at
     )`,
  ).run(row);

  return row;
}

export function findPatientById(patientId: string, includeDeleted = false): Patient | null {
  const db = getDb();
  const sql = includeDeleted
    ? 'SELECT * FROM patients WHERE patient_id = ?'
    : 'SELECT * FROM patients WHERE patient_id = ? AND deleted_at IS NULL';
  return (db.prepare(sql).get(patientId) as Patient | undefined) ?? null;
}

/** Active patient with this exact 10-digit number. Drives duplicate detection. */
export function findActivePatientByPhone(phoneNumber: string): Patient | null {
  const db = getDb();
  return (
    (db
      .prepare('SELECT * FROM patients WHERE phone_number = ? AND deleted_at IS NULL')
      .get(phoneNumber) as Patient | undefined) ?? null
  );
}

export function listPatients(query: ListPatientsQuery): { rows: Patient[]; total: number } {
  const db = getDb();

  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (!query.include_deleted) where.push('deleted_at IS NULL');

  if (query.last_name) {
    // Case-insensitive prefix match — matches the lower(last_name) index.
    where.push('lower(last_name) LIKE @last_name');
    params.last_name = `${query.last_name.toLowerCase()}%`;
  }
  if (query.date_of_birth) {
    where.push('date_of_birth = @date_of_birth');
    params.date_of_birth = query.date_of_birth;
  }
  if (query.phone_number) {
    where.push('phone_number = @phone_number');
    params.phone_number = query.phone_number;
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const total = (
    db.prepare(`SELECT COUNT(*) AS count FROM patients ${whereSql}`).get(params) as { count: number }
  ).count;

  const rows = db
    .prepare(
      `SELECT * FROM patients ${whereSql} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as Patient[];

  return { rows, total };
}

/**
 * Apply a partial update. Only keys present in `input` are touched, so a PUT
 * that omits a field leaves the stored value alone rather than nulling it.
 */
export function updatePatient(patientId: string, input: UpdatePatientInput): Patient | null {
  const db = getDb();

  const assignments: string[] = [];
  const params: Record<string, unknown> = { patient_id: patientId, updated_at: nowIso() };

  for (const column of WRITABLE_COLUMNS) {
    const value = (input as Record<string, unknown>)[column];
    if (value !== undefined) {
      assignments.push(`${column} = @${column}`);
      params[column] = value;
    }
  }

  if (assignments.length === 0) return findPatientById(patientId);

  const result = db
    .prepare(
      `UPDATE patients SET ${assignments.join(', ')}, updated_at = @updated_at
       WHERE patient_id = @patient_id AND deleted_at IS NULL`,
    )
    .run(params);

  return result.changes > 0 ? findPatientById(patientId) : null;
}

/** Soft delete — the row stays, `deleted_at` is stamped. Idempotent. */
export function softDeletePatient(patientId: string): Patient | null {
  const db = getDb();
  const timestamp = nowIso();

  const result = db
    .prepare(
      'UPDATE patients SET deleted_at = ?, updated_at = ? WHERE patient_id = ? AND deleted_at IS NULL',
    )
    .run(timestamp, timestamp, patientId);

  return result.changes > 0 ? findPatientById(patientId, true) : null;
}

export function countPatients(): number {
  const db = getDb();
  return (db.prepare('SELECT COUNT(*) AS count FROM patients').get() as { count: number }).count;
}
