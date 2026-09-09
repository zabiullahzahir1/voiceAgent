/**
 * Database schema (SQLite).
 *
 * Design notes
 * ------------
 * - Constraints live in the database, not only in Zod. The voice agent, the
 *   REST API and any future consumer all write through the same table, so the
 *   last line of defence belongs here. Zod gives *friendly* errors; CHECK
 *   constraints guarantee the invariant.
 * - Dates are stored as `YYYY-MM-DD` and timestamps as ISO-8601 UTC strings.
 *   SQLite has no native date type; lexicographic ordering of these formats is
 *   the same as chronological ordering, so range queries and ORDER BY work.
 * - Phone numbers are stored as exactly 10 normalised digits. Formatting is a
 *   presentation concern, so `(415) 555-0123`, `415-555-0123` and
 *   `+1 415 555 0123` all collapse to one canonical value — which is what makes
 *   returning-caller lookup reliable.
 * - Soft delete: `deleted_at`. Nothing is ever physically removed, per the
 *   DELETE /patients/:id requirement.
 * - The unique index on `phone_number` is PARTIAL (`WHERE deleted_at IS NULL`),
 *   so a number is unique among *active* patients but can be reused after a
 *   record is soft-deleted. This is what powers duplicate detection on a call.
 */
export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS patients (
  patient_id              TEXT PRIMARY KEY NOT NULL,

  -- Required demographics ---------------------------------------------------
  first_name              TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 50),
  last_name               TEXT NOT NULL CHECK (length(last_name)  BETWEEN 1 AND 50),
  date_of_birth           TEXT NOT NULL
                            CHECK (date_of_birth GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  sex                     TEXT NOT NULL
                            CHECK (sex IN ('Male', 'Female', 'Other', 'Decline to Answer')),
  phone_number            TEXT NOT NULL
                            CHECK (length(phone_number) = 10 AND phone_number NOT GLOB '*[^0-9]*'),
  address_line_1          TEXT NOT NULL CHECK (length(address_line_1) BETWEEN 1 AND 200),
  city                    TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
  state                   TEXT NOT NULL CHECK (length(state) = 2 AND state GLOB '[A-Z][A-Z]'),
  zip_code                TEXT NOT NULL
                            CHECK (zip_code GLOB '[0-9][0-9][0-9][0-9][0-9]'
                                OR zip_code GLOB '[0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]'),

  -- Optional demographics ---------------------------------------------------
  email                   TEXT     CHECK (email IS NULL OR email LIKE '%_@_%._%'),
  address_line_2          TEXT,
  insurance_provider      TEXT,
  insurance_member_id     TEXT,
  preferred_language      TEXT NOT NULL DEFAULT 'English',
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT
                            CHECK (emergency_contact_phone IS NULL
                               OR (length(emergency_contact_phone) = 10
                                   AND emergency_contact_phone NOT GLOB '*[^0-9]*')),

  -- Audit / lifecycle -------------------------------------------------------
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT
);

-- Query params supported by GET /patients.
CREATE INDEX IF NOT EXISTS idx_patients_last_name     ON patients (lower(last_name));
CREATE INDEX IF NOT EXISTS idx_patients_dob           ON patients (date_of_birth);
CREATE INDEX IF NOT EXISTS idx_patients_phone         ON patients (phone_number);
CREATE INDEX IF NOT EXISTS idx_patients_deleted_at    ON patients (deleted_at);

-- One active patient per phone number. Enables "we already have a record for
-- you" during a call, and stops double-registration if a call drops and the
-- caller redials.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patients_phone_active
  ON patients (phone_number) WHERE deleted_at IS NULL;

-- Bonus: per-call transcript + summary, linked to the patient when one was
-- created or updated during that call.
CREATE TABLE IF NOT EXISTS call_logs (
  call_id       TEXT PRIMARY KEY NOT NULL,
  patient_id    TEXT REFERENCES patients (patient_id) ON DELETE SET NULL,
  caller_number TEXT,
  outcome       TEXT,            -- created | updated | abandoned | error
  summary       TEXT,
  transcript    TEXT,
  duration_secs REAL,
  started_at    TEXT,
  ended_at      TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_logs_patient ON call_logs (patient_id);

-- Bonus: mock first-appointment scheduling offered at the end of a call.
CREATE TABLE IF NOT EXISTS appointments (
  appointment_id TEXT PRIMARY KEY NOT NULL,
  patient_id     TEXT NOT NULL REFERENCES patients (patient_id) ON DELETE CASCADE,
  scheduled_for  TEXT NOT NULL,   -- ISO-8601 UTC
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments (patient_id);
`;
