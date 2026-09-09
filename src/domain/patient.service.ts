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
import type { Patient } from './patient.repository';

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

export function createPatient(rawInput: unknown): Patient {
  const parsed = createPatientSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(toFieldIssues(parsed.error));

  const existing = repo.findActivePatientByPhone(parsed.data.phone_number);
  if (existing) {
    throw new ConflictError(
      `A patient record already exists for ${existing.first_name} ${existing.last_name} with this phone number.`,
      existing.patient_id,
    );
  }

  const patient = repo.insertPatient(parsed.data);

  // Observability requirement: the final collected payload for every
  // registration lands in stdout as structured JSON.
  logger.info(
    { event: 'patient.created', patient_id: patient.patient_id, payload: redactForLog(patient) },
    'Patient registered',
  );

  return patient;
}

export function getPatient(patientId: string, includeDeleted = false): Patient {
  const patient = repo.findPatientById(patientId, includeDeleted);
  if (!patient) throw new NotFoundError(`No patient found with id ${patientId}.`);
  return patient;
}

export function listPatients(rawQuery: unknown): { rows: Patient[]; total: number } {
  const parsed = listPatientsQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError(toFieldIssues(parsed.error));
  return repo.listPatients(parsed.data);
}

export function updatePatient(patientId: string, rawInput: unknown): Patient {
  const parsed = updatePatientSchema.safeParse(rawInput);
  if (!parsed.success) throw new ValidationError(toFieldIssues(parsed.error));

  // Confirm the target exists before we attempt the write, so a missing record
  // is a clean 404 rather than a silent no-op.
  const current = getPatient(patientId);

  // Moving a patient onto a phone number another active patient already owns
  // would violate the partial unique index; surface it as a 409, not a 500.
  if (parsed.data.phone_number && parsed.data.phone_number !== current.phone_number) {
    const clash = repo.findActivePatientByPhone(parsed.data.phone_number);
    if (clash && clash.patient_id !== patientId) {
      throw new ConflictError(
        'Another patient record already uses that phone number.',
        clash.patient_id,
      );
    }
  }

  const updated = repo.updatePatient(patientId, parsed.data);
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
export function deletePatient(patientId: string): Patient {
  const deleted = repo.softDeletePatient(patientId);
  if (!deleted) throw new NotFoundError(`No active patient found with id ${patientId}.`);

  logger.info({ event: 'patient.deleted', patient_id: patientId }, 'Patient soft-deleted');
  return deleted;
}

/** Returning-caller lookup used by the voice agent's `lookup_patient` tool. */
export function findActiveByPhone(phoneNumber: string): Patient | null {
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
