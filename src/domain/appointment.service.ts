import crypto from 'node:crypto';
import { query, queryOne } from '../db/client';
import { NotFoundError } from '../lib/errors';
import { UNIQUE_VIOLATION } from './patient.repository';
import { findPatientById } from './patient.repository';

/**
 * Bonus: mock first-appointment scheduling.
 *
 * There is no real calendar behind this. Rather than trust the LLM to compute a
 * concrete date from "sometime next week" (models are bad at date arithmetic
 * and will confidently return a Sunday), the server owns slot selection: the
 * agent passes the caller's rough preference, and we deterministically pick the
 * next open weekday slot that fits it. The agent then reads back a real date.
 */

export type Appointment = {
  appointment_id: string;
  patient_id: string;
  scheduled_for: string;
  reason: string | null;
  status: string;
  created_at: string;
};

export type TimePreference = 'morning' | 'afternoon' | 'any';

/** Clinic hours, in whole UTC hours. */
const MORNING_SLOTS = [9, 10, 11];
const AFTERNOON_SLOTS = [13, 14, 15, 16];

/** Earliest bookable appointment: two days out, so "tomorrow" is never offered. */
const LEAD_TIME_DAYS = 2;

/** How far ahead to search before giving up. */
const SEARCH_HORIZON_DAYS = 60;

function candidateHours(preference: TimePreference): number[] {
  if (preference === 'morning') return MORNING_SLOTS;
  if (preference === 'afternoon') return AFTERNOON_SLOTS;
  return [...MORNING_SLOTS, ...AFTERNOON_SLOTS];
}

/** Map the caller's loose phrasing onto a slot preference. */
export function parseTimePreference(raw: string | undefined): TimePreference {
  const text = (raw ?? '').toLowerCase();
  if (/\b(morning|am|early)\b/.test(text)) return 'morning';
  if (/\b(afternoon|pm|evening|late|after lunch)\b/.test(text)) return 'afternoon';
  return 'any';
}

/** Every weekday slot in the search window, in chronological order. */
function candidateSlots(preference: TimePreference, from: Date): string[] {
  const hours = candidateHours(preference);
  const slots: string[] = [];

  for (let dayOffset = LEAD_TIME_DAYS; dayOffset < LEAD_TIME_DAYS + SEARCH_HORIZON_DAYS; dayOffset += 1) {
    const day = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + dayOffset),
    );
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue; // closed at weekends

    for (const hour of hours) {
      const slot = new Date(day);
      slot.setUTCHours(hour, 0, 0, 0);
      slots.push(slot.toISOString());
    }
  }

  return slots;
}

/**
 * The first slot in the window that nobody holds.
 *
 * One query rather than one per candidate: fetch the booked set, then scan.
 */
export async function findNextAvailableSlot(
  preference: TimePreference,
  from = new Date(),
): Promise<string> {
  const slots = candidateSlots(preference, from);
  if (slots.length === 0) throw new Error('No candidate appointment slots.');

  const taken = await query<{ scheduled_for: string }>(
    `SELECT scheduled_for FROM appointments
      WHERE status = 'scheduled' AND scheduled_for = ANY($1::timestamptz[])`,
    [slots],
  );

  const takenSet = new Set(taken.map((row) => row.scheduled_for));
  const free = slots.find((slot) => !takenSet.has(slot));

  if (!free) throw new Error(`No appointment slots available in the next ${SEARCH_HORIZON_DAYS} days.`);
  return free;
}

export async function scheduleAppointment(args: {
  patientId: string;
  timePreference?: string;
  reason?: string;
}): Promise<Appointment> {
  const patient = await findPatientById(args.patientId);
  if (!patient) throw new NotFoundError(`No patient found with id ${args.patientId}.`);

  const preference = parseTimePreference(args.timePreference);

  /**
   * Two callers can pick the same slot between the availability query and the
   * insert. The partial unique index rejects the loser, so retry with the next
   * free slot rather than failing the booking.
   */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const scheduledFor = await findNextAvailableSlot(preference);

    try {
      const row = await queryOne<Appointment>(
        `INSERT INTO appointments (appointment_id, patient_id, scheduled_for, reason, status)
         VALUES ($1, $2, $3, $4, 'scheduled')
         RETURNING *`,
        [
          crypto.randomUUID(),
          args.patientId,
          scheduledFor,
          args.reason?.trim() || 'New patient visit',
        ],
      );
      if (row) return row;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : undefined;
      if (code !== UNIQUE_VIOLATION) throw error;
      // Slot taken in the meantime — loop and pick the next one.
    }
  }

  throw new Error('Could not reserve an appointment slot after several attempts.');
}

/** "2026-09-14T14:00:00.000Z" -> "Monday, September 14 at 2 PM" — for speech. */
export function speakAppointment(isoDateTime: string): string {
  const date = new Date(isoDateTime);
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const hour24 = date.getUTCHours();
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${weekdays[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()} at ${hour12} ${suffix}`;
}

export async function listAppointmentsForPatient(patientId: string): Promise<Appointment[]> {
  return query<Appointment>(
    'SELECT * FROM appointments WHERE patient_id = $1 ORDER BY scheduled_for ASC',
    [patientId],
  );
}
