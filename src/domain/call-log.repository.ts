import { getDb } from '../db/client';

/**
 * Bonus: per-call transcript + summary storage.
 *
 * Vapi posts an `end-of-call-report` webhook when a call ends, containing the
 * full transcript, an LLM-generated summary and timing. Persisting it gives an
 * audit trail linking what was said to the record that was created — useful for
 * debugging a bad registration after the fact.
 */

export type CallLog = {
  call_id: string;
  patient_id: string | null;
  caller_number: string | null;
  outcome: string | null;
  summary: string | null;
  transcript: string | null;
  duration_secs: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
};

export type CallLogInput = Omit<CallLog, 'created_at'>;

/** Upsert — a call may be reported more than once, and reports can arrive late. */
export function saveCallLog(input: CallLogInput): void {
  getDb()
    .prepare(
      `INSERT INTO call_logs (
         call_id, patient_id, caller_number, outcome, summary, transcript,
         duration_secs, started_at, ended_at, created_at
       ) VALUES (
         @call_id, @patient_id, @caller_number, @outcome, @summary, @transcript,
         @duration_secs, @started_at, @ended_at, @created_at
       )
       ON CONFLICT (call_id) DO UPDATE SET
         patient_id    = COALESCE(excluded.patient_id, call_logs.patient_id),
         caller_number = COALESCE(excluded.caller_number, call_logs.caller_number),
         outcome       = COALESCE(excluded.outcome, call_logs.outcome),
         summary       = COALESCE(excluded.summary, call_logs.summary),
         transcript    = COALESCE(excluded.transcript, call_logs.transcript),
         duration_secs = COALESCE(excluded.duration_secs, call_logs.duration_secs),
         started_at    = COALESCE(excluded.started_at, call_logs.started_at),
         ended_at      = COALESCE(excluded.ended_at, call_logs.ended_at)`,
    )
    .run({ ...input, created_at: new Date().toISOString() });
}

/**
 * Attach a call to the patient it produced.
 *
 * Called from the tool handler at the moment of registration, because the
 * end-of-call report arrives later and does not know the patient_id.
 */
export function linkCallToPatient(callId: string, patientId: string, outcome: string): void {
  getDb()
    .prepare(
      `INSERT INTO call_logs (call_id, patient_id, outcome, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (call_id) DO UPDATE SET patient_id = excluded.patient_id, outcome = excluded.outcome`,
    )
    .run(callId, patientId, outcome, new Date().toISOString());
}

export function listCallLogsForPatient(patientId: string): CallLog[] {
  return getDb()
    .prepare('SELECT * FROM call_logs WHERE patient_id = ? ORDER BY created_at DESC')
    .all(patientId) as CallLog[];
}

export function listRecentCallLogs(limit = 25): CallLog[] {
  return getDb()
    .prepare('SELECT * FROM call_logs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as CallLog[];
}
