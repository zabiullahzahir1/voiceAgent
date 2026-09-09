import { z } from 'zod';
import type { FieldIssue } from '../lib/errors';
import {
  SEX_VALUES,
  normalizeDateOfBirth,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeSex,
  normalizeState,
  normalizeZip,
  squish,
  type Sex,
} from './normalize';

/**
 * Validation schemas for the patient data model.
 *
 * Each field both *validates and normalises*: the schema's output is exactly
 * what gets written to the database. Messages are written to be spoken aloud —
 * the voice agent reads them back verbatim when re-prompting, so they say what
 * the caller should do, not what the regex expected.
 *
 * The same schema serves the REST API and the voice tools. That is deliberate:
 * the assessment requires server-side validation that does not trust the agent,
 * and one schema means the two paths can never drift apart.
 */

/** Wrap a transform so a normaliser returning `null` becomes a Zod issue. */
function normalized<T>(normalize: (raw: string) => T | null, message: string) {
  return z
    .string({ message })
    .transform((value, ctx): T => {
      const result = normalize(value);
      if (result === null) {
        ctx.addIssue({ code: 'custom', message });
        return z.NEVER;
      }
      return result;
    });
}

/** Names: letters plus the punctuation that legitimately appears in them. */
const NAME_RE = /^[\p{L}][\p{L} .'-]*$/u;

function nameField(label: string) {
  return z.string({ message: `Please say your ${label}.` }).transform((value, ctx): string => {
    const name = normalizeName(value);
    if (name.length < 1 || name.length > 50) {
      ctx.addIssue({ code: 'custom', message: `Your ${label} must be between 1 and 50 characters.` });
      return z.NEVER;
    }
    if (!NAME_RE.test(name)) {
      ctx.addIssue({
        code: 'custom',
        message: `Your ${label} can only contain letters, hyphens and apostrophes.`,
      });
      return z.NEVER;
    }
    return name;
  });
}

const dateOfBirthField = z
  .string({ message: 'Please give your date of birth as month, day and year.' })
  .transform((value, ctx): string => {
    const result = normalizeDateOfBirth(value);
    if (result.ok) return result.value;

    // Each failure reason maps to a *specific* spoken re-prompt, which is what
    // the "re-prompt for that field" requirement is really asking for.
    const message = {
      unparseable: "I didn't catch that date. Please give your date of birth as month, day and year.",
      invalid_date: "That date doesn't exist on the calendar. Please give your date of birth again.",
      future: 'A date of birth cannot be in the future. Please give the correct year.',
      too_old: 'That date of birth looks too far in the past. Please say it again.',
    }[result.reason];

    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  });

const freeTextField = (label: string, max: number) =>
  z.string({ message: `Please provide ${label}.` }).transform((value, ctx): string => {
    const text = squish(value);
    if (text.length < 1 || text.length > max) {
      ctx.addIssue({ code: 'custom', message: `${label} must be between 1 and ${max} characters.` });
      return z.NEVER;
    }
    return text;
  });

/**
 * Field-level schemas, declared once and composed into the create/update
 * schemas below so the two can never disagree.
 */
const fields = {
  first_name: nameField('first name'),
  last_name: nameField('last name'),
  date_of_birth: dateOfBirthField,
  sex: normalized<Sex>(
    normalizeSex,
    `Please say one of: ${SEX_VALUES.join(', ')}.`,
  ),
  phone_number: normalized(
    normalizePhone,
    'That is not a valid U.S. phone number. Please give all ten digits, starting with the area code.',
  ),
  address_line_1: freeTextField('a street address', 200),
  city: freeTextField('a city', 100),
  state: normalized(
    normalizeState,
    'I need a U.S. state. You can say the full state name or the two-letter abbreviation.',
  ),
  zip_code: normalized(
    normalizeZip,
    'A ZIP code needs to be five digits, or five plus four. Please say it again.',
  ),

  // Optional
  email: normalized(normalizeEmail, "That email address doesn't look right. Please spell it out for me."),
  address_line_2: freeTextField('an apartment, suite or unit', 100),
  insurance_provider: freeTextField('an insurance provider', 100),
  insurance_member_id: z
    .string()
    .transform((value, ctx): string => {
      // Member IDs are alphanumeric; spoken input often arrives spaced out.
      const id = squish(value).replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z0-9-]{2,50}$/.test(id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'A member ID should be letters and numbers only. Please read it out again.',
        });
        return z.NEVER;
      }
      return id;
    }),
  preferred_language: freeTextField('a preferred language', 50),
  emergency_contact_name: freeTextField('an emergency contact name', 100),
  emergency_contact_phone: normalized(
    normalizePhone,
    "That emergency contact number isn't a valid U.S. number. Please give all ten digits.",
  ),
} as const;

/**
 * Treat `null`, `undefined` and `""` as "not provided".
 *
 * This matters more than it looks: an LLM filling a tool call frequently emits
 * `""` or the literal string `"null"`/`"none"` for a field the caller skipped,
 * and without this those would fail validation instead of being omitted.
 */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '' || ['null', 'none', 'n/a', 'na', 'undefined'].includes(trimmed.toLowerCase())) {
        return undefined;
      }
    }
    return value;
  }, schema.optional());
}

/** POST /patients and the `register_patient` voice tool. */
export const createPatientSchema = z.object({
  first_name: fields.first_name,
  last_name: fields.last_name,
  date_of_birth: fields.date_of_birth,
  sex: fields.sex,
  phone_number: fields.phone_number,
  address_line_1: fields.address_line_1,
  city: fields.city,
  state: fields.state,
  zip_code: fields.zip_code,

  email: optional(fields.email),
  address_line_2: optional(fields.address_line_2),
  insurance_provider: optional(fields.insurance_provider),
  insurance_member_id: optional(fields.insurance_member_id),
  preferred_language: optional(fields.preferred_language),
  emergency_contact_name: optional(fields.emergency_contact_name),
  emergency_contact_phone: optional(fields.emergency_contact_phone),
});

/** PUT /patients/:id and the `update_patient` voice tool. Partial by design. */
export const updatePatientSchema = z
  .object({
    first_name: optional(fields.first_name),
    last_name: optional(fields.last_name),
    date_of_birth: optional(fields.date_of_birth),
    sex: optional(fields.sex),
    phone_number: optional(fields.phone_number),
    address_line_1: optional(fields.address_line_1),
    city: optional(fields.city),
    state: optional(fields.state),
    zip_code: optional(fields.zip_code),
    email: optional(fields.email),
    address_line_2: optional(fields.address_line_2),
    insurance_provider: optional(fields.insurance_provider),
    insurance_member_id: optional(fields.insurance_member_id),
    preferred_language: optional(fields.preferred_language),
    emergency_contact_name: optional(fields.emergency_contact_name),
    emergency_contact_phone: optional(fields.emergency_contact_phone),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'Provide at least one field to update.',
  });

/** Query parameters accepted by GET /patients. */
export const listPatientsQuerySchema = z.object({
  last_name: z.string().trim().min(1).max(50).optional(),
  /** Accepts MM/DD/YYYY or YYYY-MM-DD; normalised to the stored format. */
  date_of_birth: z
    .string()
    .transform((value, ctx): string => {
      const result = normalizeDateOfBirth(value);
      if (!result.ok) {
        ctx.addIssue({ code: 'custom', message: 'date_of_birth must be MM/DD/YYYY or YYYY-MM-DD.' });
        return z.NEVER;
      }
      return result.value;
    })
    .optional(),
  phone_number: normalized(normalizePhone, 'phone_number must be a valid 10-digit U.S. number.').optional(),
  /** Include soft-deleted records. Off by default. */
  include_deleted: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type CreatePatientInput = z.infer<typeof createPatientSchema>;
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;
export type ListPatientsQuery = z.infer<typeof listPatientsQuerySchema>;

/** Flatten a ZodError into the `FieldIssue[]` the rest of the app speaks. */
export function toFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '_root',
    message: issue.message,
  }));
}
