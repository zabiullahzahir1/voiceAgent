/**
 * Database schema (PostgreSQL).
 *
 * Design notes
 * ------------
 * - Constraints live in the database, not only in Zod. The voice agent, the
 *   REST API and any future consumer all write through the same table, so the
 *   last line of defence belongs here. Zod gives *friendly* errors; CHECK
 *   constraints guarantee the invariant.
 * - Real column types. `date_of_birth` is a DATE and the audit columns are
 *   TIMESTAMPTZ, so the database itself rejects an impossible date such as
 *   2001-02-30 and stores instants unambiguously in UTC. (The earlier SQLite
 *   version had to emulate both with text plus GLOB patterns.)
 * - `date_of_birth` additionally carries a CHECK that it is not in the future —
 *   the exact edge case the assessment calls out — enforced at the storage
 *   layer rather than trusted to the agent.
 * - Phone numbers are stored as exactly 10 normalised digits. Formatting is a
 *   presentation concern, so `(415) 555-0123`, `415-555-0123` and
 *   `+1 415 555 0123` all collapse to one canonical value — which is what makes
 *   returning-caller lookup reliable.
 * - Soft delete: `deleted_at`. Nothing is ever physically removed, per the
 *   DELETE /patients/:id requirement.
 * - The unique index on `phone_number` is PARTIAL (`WHERE deleted_at IS NULL`),
 *   so a number is unique among *active* patients but can be reused after a
 *   record is soft-deleted. This is what powers duplicate detection on a call.
 *
 * The DDL is idempotent so it can be applied on every boot.
 */
export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS patients (
  patient_id              UUID PRIMARY KEY,

  -- Required demographics ---------------------------------------------------
  first_name              TEXT NOT NULL CHECK (char_length(first_name) BETWEEN 1 AND 50),
  last_name               TEXT NOT NULL CHECK (char_length(last_name)  BETWEEN 1 AND 50),
  date_of_birth           DATE NOT NULL CHECK (date_of_birth <= CURRENT_DATE),
  sex                     TEXT NOT NULL
                            CHECK (sex IN ('Male', 'Female', 'Other', 'Decline to Answer')),
  phone_number            CHAR(10) NOT NULL CHECK (phone_number ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$'),
  address_line_1          TEXT NOT NULL CHECK (char_length(address_line_1) BETWEEN 1 AND 200),
  city                    TEXT NOT NULL CHECK (char_length(city) BETWEEN 1 AND 100),
  state                   CHAR(2) NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  zip_code                TEXT NOT NULL CHECK (zip_code ~ '^[0-9]{5}(-[0-9]{4})?$'),

  -- Optional demographics ---------------------------------------------------
  email                   TEXT     CHECK (email IS NULL OR email ~ '^[^[:space:]@]+@[^[:space:]@.]+(\\.[^[:space:]@.]+)+$'),
  address_line_2          TEXT     CHECK (address_line_2 IS NULL OR char_length(address_line_2) BETWEEN 1 AND 100),
  insurance_provider      TEXT     CHECK (insurance_provider IS NULL OR char_length(insurance_provider) BETWEEN 1 AND 100),
  insurance_member_id     TEXT     CHECK (insurance_member_id IS NULL OR insurance_member_id ~ '^[A-Z0-9-]{2,50}$'),
  preferred_language      TEXT NOT NULL DEFAULT 'English',
  emergency_contact_name  TEXT     CHECK (emergency_contact_name IS NULL OR char_length(emergency_contact_name) BETWEEN 1 AND 100),
  emergency_contact_phone CHAR(10) CHECK (emergency_contact_phone IS NULL
                                       OR emergency_contact_phone ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$'),

  -- Audit / lifecycle -------------------------------------------------------
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ
);

-- Query params supported by GET /patients.
CREATE INDEX IF NOT EXISTS idx_patients_last_name  ON patients (lower(last_name) text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_patients_dob        ON patients (date_of_birth);
CREATE INDEX IF NOT EXISTS idx_patients_phone      ON patients (phone_number);
CREATE INDEX IF NOT EXISTS idx_patients_created_at ON patients (created_at DESC);

-- One active patient per phone number. Enables "we already have a record for
-- you" during a call, and stops double-registration if a call drops and the
-- caller redials.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patients_phone_active
  ON patients (phone_number) WHERE deleted_at IS NULL;

-- Bonus: per-call transcript + summary, linked to the patient when one was
-- created or updated during that call.
CREATE TABLE IF NOT EXISTS call_logs (
  call_id       TEXT PRIMARY KEY,
  patient_id    UUID REFERENCES patients (patient_id) ON DELETE SET NULL,
  caller_number TEXT,
  outcome       TEXT,             -- created | updated | the Vapi endedReason
  summary       TEXT,
  transcript    TEXT,
  duration_secs DOUBLE PRECISION,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_patient ON call_logs (patient_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_created ON call_logs (created_at DESC);

-- Bonus: mock first-appointment scheduling offered at the end of a call.
CREATE TABLE IF NOT EXISTS appointments (
  appointment_id UUID PRIMARY KEY,
  patient_id     UUID NOT NULL REFERENCES patients (patient_id) ON DELETE CASCADE,
  scheduled_for  TIMESTAMPTZ NOT NULL,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments (patient_id);

-- Only one live booking per slot, so concurrent calls cannot double-book.
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_slot_active
  ON appointments (scheduled_for) WHERE status = 'scheduled';
`;
