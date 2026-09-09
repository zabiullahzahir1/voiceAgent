import { query } from '../db/client';

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

/**
 * Upsert — a call may be reported more than once, and reports can arrive late.
 *
 * COALESCE on update means a later, sparser report never blanks a field an
 * earlier one already filled in. In particular the `patient_id` written at
 * registration time survives the end-of-call report, which does not know it.
 */
export async function saveCallLog(input: CallLogInput): Promise<void> {
  await query(
    `INSERT INTO call_logs (
       call_id, patient_id, caller_number, outcome, summary, transcript,
       duration_secs, started_at, ended_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (call_id) DO UPDATE SET
       patient_id    = COALESCE(EXCLUDED.patient_id,    call_logs.patient_id),
       caller_number = COALESCE(EXCLUDED.caller_number, call_logs.caller_number),
       outcome       = COALESCE(EXCLUDED.outcome,       call_logs.outcome),
       summary       = COALESCE(EXCLUDED.summary,       call_logs.summary),
       transcript    = COALESCE(EXCLUDED.transcript,    call_logs.transcript),
       duration_secs = COALESCE(EXCLUDED.duration_secs, call_logs.duration_secs),
       started_at    = COALESCE(EXCLUDED.started_at,    call_logs.started_at),
       ended_at      = COALESCE(EXCLUDED.ended_at,      call_logs.ended_at)`,
    [
      input.call_id,
      input.patient_id,
      input.caller_number,
      input.outcome,
      input.summary,
      input.transcript,
      input.duration_secs,
      input.started_at,
      input.ended_at,
    ],
  );
}

/**
 * Attach a call to the patient it produced.
 *
 * Called from the tool handler at the moment of registration, because the
 * end-of-call report arrives later and does not know the patient_id.
 */
export async function linkCallToPatient(
  callId: string,
  patientId: string,
  outcome: string,
): Promise<void> {
  await query(
    `INSERT INTO call_logs (call_id, patient_id, outcome)
     VALUES ($1, $2, $3)
     ON CONFLICT (call_id) DO UPDATE SET
       patient_id = EXCLUDED.patient_id,
       outcome    = EXCLUDED.outcome`,
    [callId, patientId, outcome],
  );
}

export async function listCallLogsForPatient(patientId: string): Promise<CallLog[]> {
  return query<CallLog>(
    'SELECT * FROM call_logs WHERE patient_id = $1 ORDER BY created_at DESC',
    [patientId],
  );
}

export async function listRecentCallLogs(limit = 25): Promise<CallLog[]> {
  return query<CallLog>('SELECT * FROM call_logs ORDER BY created_at DESC LIMIT $1', [limit]);
}
