import crypto from 'node:crypto';
import { getDb } from '../db/client';
import { NotFoundError } from '../lib/errors';
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

/** Clinic hours, in whole hours, local to the clinic (treated as UTC here). */
const MORNING_SLOTS = [9, 10, 11];
const AFTERNOON_SLOTS = [13, 14, 15, 16];

/** Earliest bookable appointment: two days out, so "tomorrow" is never offered. */
const LEAD_TIME_DAYS = 2;

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

function isTaken(isoSlot: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM appointments WHERE scheduled_for = ? AND status = 'scheduled'")
    .get(isoSlot);
  return row !== undefined;
}

/** Walk forward from the lead time until an unbooked weekday slot is found. */
export function findNextAvailableSlot(preference: TimePreference, from = new Date()): string {
  const hours = candidateHours(preference);

  for (let dayOffset = LEAD_TIME_DAYS; dayOffset < LEAD_TIME_DAYS + 60; dayOffset += 1) {
    const day = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + dayOffset),
    );
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue; // clinic is closed at weekends

    for (const hour of hours) {
      const slot = new Date(day);
      slot.setUTCHours(hour, 0, 0, 0);
      const iso = slot.toISOString();
      if (!isTaken(iso)) return iso;
    }
  }

  throw new Error('No appointment slots available in the next 60 days.');
}

export function scheduleAppointment(args: {
  patientId: string;
  timePreference?: string;
  reason?: string;
}): Appointment {
  const patient = findPatientById(args.patientId);
  if (!patient) throw new NotFoundError(`No patient found with id ${args.patientId}.`);

  const scheduledFor = findNextAvailableSlot(parseTimePreference(args.timePreference));

  const appointment: Appointment = {
    appointment_id: crypto.randomUUID(),
    patient_id: args.patientId,
    scheduled_for: scheduledFor,
    reason: args.reason?.trim() || 'New patient visit',
    status: 'scheduled',
    created_at: new Date().toISOString(),
  };

  getDb()
    .prepare(
      `INSERT INTO appointments (appointment_id, patient_id, scheduled_for, reason, status, created_at)
       VALUES (@appointment_id, @patient_id, @scheduled_for, @reason, @status, @created_at)`,
    )
    .run(appointment);

  return appointment;
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

export function listAppointmentsForPatient(patientId: string): Appointment[] {
  return getDb()
    .prepare('SELECT * FROM appointments WHERE patient_id = ? ORDER BY scheduled_for ASC')
    .all(patientId) as Appointment[];
}
