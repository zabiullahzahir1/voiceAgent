import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { formatPhone, speakDate, speakPhone } from './normalize';
import {
  createPatientSchema,
  listPatientsQuerySchema,
  toFieldIssues,
  updatePatientSchema,
} from './patient.schema';
import * as repo from './patient.repository';
import { UNIQUE_VIOLATION, type Patient } from './patient.repository';

/**
 * Business logic for patients.
 *
 * This is the single service layer the assessment asks for: the REST routes and
 * the voice tool handlers both call *these* functions. The voice agent
 * therefore cannot bypass validation or duplicate detection, and there is no
 * second implementation to keep in sync.
 *
 * Every function takes untrusted input and validates it here, so callers may
 * hand over a raw request body or raw LLM tool arguments interchangeably.
 */

export type { Patient };

/** Narrow a thrown value to a Postgres driver error with a SQLSTATE code. */
function pgErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export async function createPatient(rawInput: unknown): Promise<Patient> {
  const parsed = createPatientSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(toFieldIssues(parsed.error));

  // Pre-check so the common case produces a helpful message naming the existing
  // patient. The unique index below is still the authority.
  const existing = await repo.findActivePatientByPhone(parsed.data.phone_number);
  if (existing) {
    throw new ConflictError(
      `A patient record already exists for ${existing.first_name} ${existing.last_name} with this phone number.`,
      existing.patient_id,
    );
  }

  let patient: Patient;
  try {
    patient = await repo.insertPatient(parsed.data);
  } catch (error) {
    /**
     * Two callers registering the same number simultaneously would both pass
     * the pre-check. The partial unique index makes one of them fail here, and
     * we translate that into the same 409 rather than a 500 — the check-then-act
     * race is closed by the database, not by application locking.
     */
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      const winner = await repo.findActivePatientByPhone(parsed.data.phone_number);
      throw new ConflictError(
        'A patient record already exists with this phone number.',
        winner?.patient_id,
      );
    }
    throw error;
  }

  // Observability requirement: the final collected payload for every
  // registration lands in stdout as structured JSON.
  logger.info(
    { event: 'patient.created', patient_id: patient.patient_id, payload: redactForLog(patient) },
    'Patient registered',
  );

  return patient;
}

export async function getPatient(patientId: string, includeDeleted = false): Promise<Patient> {
  const patient = await repo.findPatientById(patientId, includeDeleted);
  if (!patient) throw new NotFoundError(`No patient found with id ${patientId}.`);
  return patient;
}

export async function listPatients(rawQuery: unknown): Promise<{ rows: Patient[]; total: number }> {
  const parsed = listPatientsQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError(toFieldIssues(parsed.error));
  return repo.listPatients(parsed.data);
}

export async function updatePatient(patientId: string, rawInput: unknown): Promise<Patient> {
  const parsed = updatePatientSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(toFieldIssues(parsed.error));

  // Confirm the target exists before we attempt the write, so a missing record
  // is a clean 404 rather than a silent no-op.
  const current = await getPatient(patientId);

  // Moving a patient onto a phone number another active patient already owns
  // would violate the partial unique index; surface it as a 409, not a 500.
  if (parsed.data.phone_number && parsed.data.phone_number !== current.phone_number) {
    const clash = await repo.findActivePatientByPhone(parsed.data.phone_number);
    if (clash && clash.patient_id !== patientId) {
      throw new ConflictError(
        'Another patient record already uses that phone number.',
        clash.patient_id,
      );
    }
  }

  let updated: Patient | null;
  try {
    updated = await repo.updatePatient(patientId, parsed.data);
  } catch (error) {
    if (pgErrorCode(error) === UNIQUE_VIOLATION) {
      throw new ConflictError('Another patient record already uses that phone number.');
    }
    throw error;
  }

  if (!updated) throw new NotFoundError(`No patient found with id ${patientId}.`);

  logger.info(
    {
      event: 'patient.updated',
      patient_id: patientId,
      changed_fields: Object.keys(parsed.data).filter(
        (key) => (parsed.data as Record<string, unknown>)[key] !== undefined,
      ),
    },
    'Patient updated',
  );

  return updated;
}

/** Soft delete. Returns the stamped record; 404 if already gone or unknown. */
export async function deletePatient(patientId: string): Promise<Patient> {
  const deleted = await repo.softDeletePatient(patientId);
  if (!deleted) throw new NotFoundError(`No active patient found with id ${patientId}.`);

  logger.info({ event: 'patient.deleted', patient_id: patientId }, 'Patient soft-deleted');
  return deleted;
}

/** Returning-caller lookup used by the voice agent's `lookup_patient` tool. */
export async function findActiveByPhone(phoneNumber: string): Promise<Patient | null> {
  return repo.findActivePatientByPhone(phoneNumber);
}

// --- Presentation helpers ---------------------------------------------------

/**
 * A JSON view of a patient with phone/date rendered the way they should be
 * *spoken*. The voice agent receives this so it reads "March 5, 1985" and
 * "415 555 0123" rather than spelling out raw stored values.
 */
export function toSpokenSummary(patient: Patient): Record<string, string> {
  const summary: Record<string, string> = {
    name: `${patient.first_name} ${patient.last_name}`,
    date_of_birth: speakDate(patient.date_of_birth),
    sex: patient.sex,
    phone_number: speakPhone(patient.phone_number),
    address: [patient.address_line_1, patient.address_line_2].filter(Boolean).join(', '),
    city_state_zip: `${patient.city}, ${patient.state} ${patient.zip_code}`,
  };

  if (patient.email) summary.email = patient.email;
  if (patient.insurance_provider) summary.insurance_provider = patient.insurance_provider;
  if (patient.insurance_member_id) summary.insurance_member_id = patient.insurance_member_id;
  if (patient.preferred_language) summary.preferred_language = patient.preferred_language;
  if (patient.emergency_contact_name) summary.emergency_contact_name = patient.emergency_contact_name;
  if (patient.emergency_contact_phone) {
    summary.emergency_contact_phone = speakPhone(patient.emergency_contact_phone);
  }

  return summary;
}

/** API/dashboard view: phone numbers formatted for the eye rather than the ear. */
export function toApiView(patient: Patient): Patient & { phone_number_formatted: string } {
  return { ...patient, phone_number_formatted: formatPhone(patient.phone_number) };
}

/**
 * Logs are useful for debugging a call but should not be a second copy of the
 * full record, so identifiers are truncated. (The assessment says not to store
 * real patient data; this keeps the log surface small regardless.)
 */
function redactForLog(patient: Patient): Record<string, unknown> {
  return {
    ...patient,
    phone_number: `***${patient.phone_number.slice(-4)}`,
    email: patient.email ? `${patient.email.slice(0, 2)}***` : null,
    insurance_member_id: patient.insurance_member_id ? '***' : null,
    emergency_contact_phone: patient.emergency_contact_phone
      ? `***${patient.emergency_contact_phone.slice(-4)}`
      : null,
  };
}
