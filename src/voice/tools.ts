import { AppError, ConflictError, ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';
import * as patients from '../domain/patient.service';
import { normalizePhone, speakDate, speakPhone } from '../domain/normalize';
import { linkCallToPatient } from '../domain/call-log.repository';
import { scheduleAppointment, speakAppointment } from '../domain/appointment.service';

/**
 * The tools the voice agent can call, and what happens when it does.
 *
 * Two ideas drive the design here:
 *
 * 1. **Handlers call the same service layer the REST API calls.** There is no
 *    parallel "voice write path". Validation, duplicate detection and logging
 *    behave identically whether a record arrives from a phone call or a curl.
 *
 * 2. **Every result carries an `agent_instruction`.** Returning a bare error to
 *    an LLM produces improvisation — it will apologise vaguely, re-ask for
 *    everything, or claim success. Returning an explicit, speakable next action
 *    makes recovery deterministic. This is what turns a 422 into "Sorry, could
 *    I get your date of birth again — month, day and year?" rather than a
 *    robotic error read-out.
 */

// ---------------------------------------------------------------------------
// Tool result shape
// ---------------------------------------------------------------------------

export type ToolResult = {
  ok: boolean;
  /** Plain-language next action for the model. Always present. */
  agent_instruction: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// JSON Schema definitions sent to Vapi (OpenAI function-calling format)
// ---------------------------------------------------------------------------

/** Reused across register/update so the two can never describe a field differently. */
const patientFieldProperties = {
  first_name: { type: 'string', description: "Caller's legal first name." },
  last_name: { type: 'string', description: "Caller's legal last name." },
  date_of_birth: {
    type: 'string',
    description: 'Date of birth as MM/DD/YYYY, for example 03/05/1985.',
  },
  sex: {
    type: 'string',
    enum: ['Male', 'Female', 'Other', 'Decline to Answer'],
    description: 'One of the four allowed values.',
  },
  phone_number: {
    type: 'string',
    description: 'Ten-digit U.S. phone number, digits only, for example 4155550123.',
  },
  email: { type: 'string', description: 'Email address. Omit if not provided.' },
  address_line_1: { type: 'string', description: 'Street address, for example 42 Oak Street.' },
  address_line_2: {
    type: 'string',
    description: 'Apartment, suite or unit. Omit if not provided.',
  },
  city: { type: 'string', description: 'City name.' },
  state: {
    type: 'string',
    description: 'Two-letter U.S. state abbreviation, or the full state name.',
  },
  zip_code: { type: 'string', description: 'Five-digit ZIP, or ZIP+4.' },
  insurance_provider: { type: 'string', description: 'Insurance company name. Omit if not provided.' },
  insurance_member_id: { type: 'string', description: 'Member or subscriber ID. Omit if not provided.' },
  preferred_language: { type: 'string', description: 'Preferred language. Defaults to English.' },
  emergency_contact_name: { type: 'string', description: 'Emergency contact full name. Omit if not provided.' },
  emergency_contact_phone: { type: 'string', description: 'Emergency contact ten-digit phone. Omit if not provided.' },
} as const;

const REQUIRED_TOOL_FIELDS = [
  'first_name',
  'last_name',
  'date_of_birth',
  'sex',
  'phone_number',
  'address_line_1',
  'city',
  'state',
  'zip_code',
];

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'lookup_patient',
      description:
        'Check whether a patient record already exists for a phone number. Call this as soon as the phone number is known, before completing the rest of the intake.',
      parameters: {
        type: 'object',
        properties: {
          phone_number: {
            type: 'string',
            description: 'Ten-digit U.S. phone number, digits only.',
          },
        },
        required: ['phone_number'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'register_patient',
      description:
        'Create a new patient record. Call this ONLY after reading all collected information back to the caller and hearing them confirm it is correct.',
      parameters: {
        type: 'object',
        properties: patientFieldProperties,
        required: REQUIRED_TOOL_FIELDS,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_patient',
      description:
        'Update an existing patient record. Requires the patient_id returned by lookup_patient. Send only the fields that changed.',
      parameters: {
        type: 'object',
        properties: {
          patient_id: {
            type: 'string',
            description: 'The patient_id returned by lookup_patient.',
          },
          ...patientFieldProperties,
        },
        required: ['patient_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'schedule_appointment',
      description:
        "Book the patient's first appointment. Call only after a successful registration and only if the caller says yes to booking.",
      parameters: {
        type: 'object',
        properties: {
          patient_id: { type: 'string', description: 'The patient_id from register_patient.' },
          time_preference: {
            type: 'string',
            description:
              "The caller's rough preference in their own words, for example 'a morning' or 'afternoon next week'.",
          },
          reason: { type: 'string', description: 'Reason for the visit, if mentioned.' },
        },
        required: ['patient_id'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type ToolContext = { callId: string | null };

type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => ToolResult;

/** Human-readable field labels, so the agent never speaks a snake_case name. */
const FIELD_LABELS: Record<string, string> = {
  first_name: 'first name',
  last_name: 'last name',
  date_of_birth: 'date of birth',
  sex: 'sex',
  phone_number: 'phone number',
  email: 'email address',
  address_line_1: 'street address',
  address_line_2: 'apartment or suite',
  city: 'city',
  state: 'state',
  zip_code: 'ZIP code',
  insurance_provider: 'insurance provider',
  insurance_member_id: 'insurance member ID',
  preferred_language: 'preferred language',
  emergency_contact_name: 'emergency contact name',
  emergency_contact_phone: 'emergency contact phone number',
};

function labelFor(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, ' ');
}

/** Turn a ValidationError into a targeted, speakable re-prompt. */
function validationResult(error: ValidationError): ToolResult {
  const fields = [...new Set(error.issues.map((issue) => issue.field))];
  const labels = fields.map(labelFor);

  return {
    ok: false,
    error_type: 'validation',
    invalid_fields: error.issues.map((issue) => ({
      field: issue.field,
      label: labelFor(issue.field),
      message: issue.message,
    })),
    agent_instruction:
      `The record was NOT saved. Apologise briefly and ask the caller again for ONLY these: ${labels.join(', ')}. ` +
      `Use this wording: "${error.issues.map((issue) => issue.message).join(' ')}" ` +
      `Do not ask for any other field. Once corrected, confirm just those fields and call register_patient again.`,
  };
}

const lookup_patient: ToolHandler = (args) => {
  const raw = String(args.phone_number ?? '');
  const phone = normalizePhone(raw);

  if (!phone) {
    return {
      ok: false,
      error_type: 'validation',
      agent_instruction:
        'That is not a valid ten-digit U.S. phone number. Ask the caller to repeat their phone number including the area code, then call lookup_patient again.',
    };
  }

  const existing = patients.findActiveByPhone(phone);

  if (!existing) {
    return {
      ok: true,
      exists: false,
      agent_instruction:
        'No existing record. Say nothing about this lookup and continue collecting the remaining information.',
    };
  }

  return {
    ok: true,
    exists: true,
    patient_id: existing.patient_id,
    first_name: existing.first_name,
    last_name: existing.last_name,
    date_of_birth: speakDate(existing.date_of_birth),
    current_record: patients.toSpokenSummary(existing),
    agent_instruction:
      `A record already exists for ${existing.first_name} ${existing.last_name}. Say: "It looks like we already have a record for ${existing.first_name} ${existing.last_name}. Would you like to update your information instead?" ` +
      `If they say yes, collect only what changed and call update_patient with patient_id "${existing.patient_id}". ` +
      `If they say it is a different person, ask them to confirm the phone number, because two active patients cannot share one.`,
  };
};

const register_patient: ToolHandler = (args, ctx) => {
  try {
    const patient = patients.createPatient(args);

    if (ctx.callId) linkCallToPatient(ctx.callId, patient.patient_id, 'created');

    logger.info(
      { event: 'voice.registration.success', call_id: ctx.callId, patient_id: patient.patient_id },
      'Voice registration completed',
    );

    return {
      ok: true,
      patient_id: patient.patient_id,
      saved_record: patients.toSpokenSummary(patient),
      agent_instruction:
        `Saved successfully. Confirm warmly using their first name, for example "You're all set, ${patient.first_name}." ` +
        `Then offer once to book a first appointment, and if they say yes call schedule_appointment with patient_id "${patient.patient_id}". ` +
        `Do not read the whole record back again.`,
    };
  } catch (error) {
    if (error instanceof ValidationError) return validationResult(error);

    // Duplicate phone number — route the agent into the update flow instead.
    if (error instanceof ConflictError) {
      const existingId = error.existingPatientId;
      return {
        ok: false,
        error_type: 'duplicate',
        patient_id: existingId,
        agent_instruction:
          `A record with that phone number already exists, so nothing was saved. Tell the caller we already have a record on that number and ask whether they would like to update it instead. ` +
          (existingId
            ? `If yes, collect what changed and call update_patient with patient_id "${existingId}". `
            : '') +
          `If it is genuinely a different person, ask for a different phone number for this patient and call register_patient again.`,
      };
    }

    return systemFailureResult(error, ctx, 'register_patient');
  }
};

const update_patient: ToolHandler = (args, ctx) => {
  const { patient_id: patientId, ...fields } = args;

  if (typeof patientId !== 'string' || patientId.length === 0) {
    return {
      ok: false,
      error_type: 'validation',
      agent_instruction:
        'A patient_id is required to update a record. Call lookup_patient with the caller\'s phone number first, then retry.',
    };
  }

  try {
    const patient = patients.updatePatient(patientId, fields);

    if (ctx.callId) linkCallToPatient(ctx.callId, patient.patient_id, 'updated');

    logger.info(
      { event: 'voice.update.success', call_id: ctx.callId, patient_id: patient.patient_id },
      'Voice update completed',
    );

    return {
      ok: true,
      patient_id: patient.patient_id,
      saved_record: patients.toSpokenSummary(patient),
      agent_instruction: `The record was updated. Confirm briefly using their first name, for example "All updated, ${patient.first_name}." Do not read the whole record back.`,
    };
  } catch (error) {
    if (error instanceof ValidationError) return validationResult(error);

    if (error instanceof AppError && error.statusCode === 404) {
      return {
        ok: false,
        error_type: 'not_found',
        agent_instruction:
          'That record no longer exists. Tell the caller you will set them up as a new patient, collect anything still missing, confirm it, and call register_patient.',
      };
    }

    if (error instanceof ConflictError) {
      return {
        ok: false,
        error_type: 'duplicate',
        agent_instruction:
          'Another patient already uses that phone number, so nothing was changed. Ask the caller to confirm the correct phone number for this record, then retry.',
      };
    }

    return systemFailureResult(error, ctx, 'update_patient');
  }
};

const schedule_appointment: ToolHandler = (args, ctx) => {
  const patientId = String(args.patient_id ?? '');

  try {
    const appointment = scheduleAppointment({
      patientId,
      timePreference: args.time_preference ? String(args.time_preference) : undefined,
      reason: args.reason ? String(args.reason) : undefined,
    });

    const spoken = speakAppointment(appointment.scheduled_for);

    logger.info(
      { event: 'voice.appointment.scheduled', call_id: ctx.callId, patient_id: patientId, slot: appointment.scheduled_for },
      'Appointment scheduled',
    );

    return {
      ok: true,
      appointment_id: appointment.appointment_id,
      scheduled_for_spoken: spoken,
      agent_instruction: `Booked. Tell the caller their first appointment is ${spoken}, and ask if that works. If it does not, call schedule_appointment again with their updated preference.`,
    };
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) {
      return {
        ok: false,
        error_type: 'not_found',
        agent_instruction:
          'That patient record was not found, so no appointment was booked. Do not claim it was. Tell the caller the office will follow up to book their first visit.',
      };
    }
    return systemFailureResult(error, ctx, 'schedule_appointment');
  }
};

/**
 * Anything unexpected — a disk failure, a corrupt database.
 *
 * The caller must never get silence or a false success. The instruction spells
 * out one retry, then a graceful hand-off, which matches the prompt's rules.
 */
function systemFailureResult(error: unknown, ctx: ToolContext, tool: string): ToolResult {
  logger.error({ err: error, call_id: ctx.callId, tool }, 'Voice tool failed unexpectedly');

  return {
    ok: false,
    error_type: 'system',
    agent_instruction:
      'The save FAILED because of a system problem. Do not tell the caller they are registered. ' +
      'Say you are having trouble saving on your end and are trying once more, then retry this tool exactly once. ' +
      'If it fails again, apologise, tell them the office will call back today to finish the registration, and end the call.',
  };
}

const HANDLERS: Record<string, ToolHandler> = {
  lookup_patient,
  register_patient,
  update_patient,
  schedule_appointment,
};

/**
 * Dispatch one tool call. Never throws — an unhandled exception here would
 * leave the caller listening to silence, so every path returns a spoken
 * recovery instruction instead.
 */
export function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): ToolResult {
  const handler = HANDLERS[name];

  if (!handler) {
    logger.warn({ tool: name, call_id: ctx.callId }, 'Unknown tool requested');
    return {
      ok: false,
      error_type: 'unknown_tool',
      agent_instruction:
        'That action is not available. Continue the conversation normally without mentioning this.',
    };
  }

  logger.info(
    { event: 'voice.tool.called', tool: name, call_id: ctx.callId, arguments: args },
    'Voice tool invoked',
  );

  try {
    return handler(args, ctx);
  } catch (error) {
    return systemFailureResult(error, ctx, name);
  }
}
