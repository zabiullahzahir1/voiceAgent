import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { closePool } from '../src/db/client';
import { resetDatabase } from './helpers/db';

/**
 * Integration tests for the voice path.
 *
 * These simulate exactly what Vapi posts during a call, so the whole chain is
 * covered: webhook auth -> payload parsing -> tool dispatch -> service layer ->
 * database -> the instruction string the model receives back.
 *
 * The `agent_instruction` assertions matter as much as the database ones: they
 * are what determines whether the caller hears a targeted re-prompt or a
 * confused apology.
 */

let app: FastifyInstance;

const SECRET = 'test-webhook-secret'; // matches vitest.config.ts

beforeAll(async () => {
  await resetDatabase();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

/** Post a tool call in the shape Vapi currently sends. */
async function callTool(name: string, args: Record<string, unknown>, callId = 'call-test-1') {
  const response = await app.inject({
    method: 'POST',
    url: '/voice/vapi',
    headers: { 'x-vapi-secret': SECRET },
    payload: {
      message: {
        type: 'tool-calls',
        call: { id: callId, customer: { number: '+14155551000' } },
        toolCallList: [{ id: 'tc-1', name, arguments: args }],
      },
    },
  });

  const envelope = response.json();
  const result = envelope.results?.[0]?.result;
  return { response, result: result ? JSON.parse(result) : null };
}

const FULL_PATIENT = {
  first_name: 'Jane',
  last_name: 'Doe',
  date_of_birth: '03/05/1985',
  sex: 'Female',
  phone_number: '4155550123',
  address_line_1: '42 Oak Street',
  address_line_2: 'Apt 3B',
  city: 'San Francisco',
  state: 'California',
  zip_code: '94107',
};

describe('webhook authentication', () => {
  it('rejects a request without the shared secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/voice/vapi',
      payload: { message: { type: 'tool-calls', toolCallList: [] } },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a request with the wrong secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/voice/vapi',
      headers: { 'x-vapi-secret': 'wrong' },
      payload: { message: { type: 'tool-calls', toolCallList: [] } },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('register_patient', () => {
  it('creates a record and tells the agent how to confirm', async () => {
    const { response, result } = await callTool('register_patient', FULL_PATIENT);

    expect(response.statusCode).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.patient_id).toBeTruthy();
    expect(result.agent_instruction).toContain('Jane');

    // The record is really in the database and readable over the REST API.
    const lookup = await app.inject({ method: 'GET', url: `/patients/${result.patient_id}` });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().data.state).toBe('CA');
  });

  it('reads phone and date back in spoken form, not raw stored form', async () => {
    const { result } = await callTool('register_patient', {
      ...FULL_PATIENT,
      phone_number: '4155550124',
    });

    expect(result.saved_record.phone_number).toBe('415 555 0124');
    expect(result.saved_record.date_of_birth).toBe('March 5, 1985');
  });

  it('does not save on an invalid date of birth, and re-prompts for that field only', async () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    const { result } = await callTool('register_patient', {
      ...FULL_PATIENT,
      phone_number: '4155550125',
      date_of_birth: `01/01/${nextYear}`,
    });

    expect(result.ok).toBe(false);
    expect(result.error_type).toBe('validation');
    expect(result.invalid_fields).toHaveLength(1);
    expect(result.invalid_fields[0].field).toBe('date_of_birth');
    // The agent is told to ask for a human-readable field name, not snake_case.
    expect(result.agent_instruction).toContain('date of birth');
    expect(result.agent_instruction).toContain('NOT saved');

    const search = await app.inject({ method: 'GET', url: '/patients?phone_number=4155550125' });
    expect(search.json().data.patients).toHaveLength(0);
  });

  it('names every invalid field so the agent can fix them in one pass', async () => {
    const { result } = await callTool('register_patient', {
      ...FULL_PATIENT,
      phone_number: '555',
      zip_code: 'nope',
    });

    expect(result.ok).toBe(false);
    const fields = result.invalid_fields.map((f: { field: string }) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['phone_number', 'zip_code']));
  });

  it('treats LLM filler values for optional fields as "not provided"', async () => {
    const { result } = await callTool('register_patient', {
      ...FULL_PATIENT,
      phone_number: '4155550126',
      email: '',
      insurance_provider: 'none',
      address_line_2: 'N/A',
    });

    expect(result.ok).toBe(true);
    const stored = (await app.inject({ method: 'GET', url: `/patients/${result.patient_id}` })).json();
    expect(stored.data.email).toBeNull();
    expect(stored.data.insurance_provider).toBeNull();
    expect(stored.data.address_line_2).toBeNull();
  });

  it('routes a duplicate phone number into the update flow instead of failing', async () => {
    await callTool('register_patient', { ...FULL_PATIENT, phone_number: '4155550199' });
    const { result } = await callTool('register_patient', {
      ...FULL_PATIENT,
      first_name: 'Janet',
      phone_number: '4155550199',
    });

    expect(result.ok).toBe(false);
    expect(result.error_type).toBe('duplicate');
    expect(result.patient_id).toBeTruthy();
    expect(result.agent_instruction).toContain('update');
  });
});

describe('lookup_patient (returning-caller detection)', () => {
  it('reports no match for an unknown number without prompting the agent to mention it', async () => {
    const { result } = await callTool('lookup_patient', { phone_number: '4155559999' });

    expect(result.ok).toBe(true);
    expect(result.exists).toBe(false);
    expect(result.agent_instruction).toContain('Say nothing');
  });

  it('recognises a returning caller and hands the agent the exact offer to make', async () => {
    const registration = await callTool('register_patient', {
      ...FULL_PATIENT,
      last_name: 'Returning',
      phone_number: '4155550150',
    });

    const { result } = await callTool('lookup_patient', { phone_number: '(415) 555-0150' });

    expect(result.exists).toBe(true);
    expect(result.patient_id).toBe(registration.result.patient_id);
    expect(result.agent_instruction).toContain('already have a record for Jane Returning');
    expect(result.agent_instruction).toContain('update_patient');
  });

  it('asks for the number again when it is not a valid U.S. number', async () => {
    const { result } = await callTool('lookup_patient', { phone_number: '123' });

    expect(result.ok).toBe(false);
    expect(result.agent_instruction).toContain('area code');
  });
});

describe('update_patient', () => {
  it('applies a correction to an existing record', async () => {
    const created = await callTool('register_patient', {
      ...FULL_PATIENT,
      last_name: 'Davies',
      phone_number: '4155550160',
    });

    // The scored scenario: "my last name is D-A-V-I-S, not D-A-V-I-E-S".
    const { result } = await callTool('update_patient', {
      patient_id: created.result.patient_id,
      last_name: 'Davis',
    });

    expect(result.ok).toBe(true);
    const stored = (
      await app.inject({ method: 'GET', url: `/patients/${created.result.patient_id}` })
    ).json();
    expect(stored.data.last_name).toBe('Davis');
  });

  it('tells the agent to look the caller up first when patient_id is missing', async () => {
    const { result } = await callTool('update_patient', { last_name: 'Davis' });

    expect(result.ok).toBe(false);
    expect(result.agent_instruction).toContain('lookup_patient');
  });

  it('falls back to a new registration when the record is gone', async () => {
    const { result } = await callTool('update_patient', {
      patient_id: '11111111-1111-4111-8111-111111111111',
      city: 'Oakland',
    });

    expect(result.ok).toBe(false);
    expect(result.error_type).toBe('not_found');
    expect(result.agent_instruction).toContain('register_patient');
  });
});

describe('schedule_appointment', () => {
  it('books a real weekday slot and gives the agent a spoken date', async () => {
    const created = await callTool('register_patient', {
      ...FULL_PATIENT,
      phone_number: '4155550170',
    });

    const { result } = await callTool('schedule_appointment', {
      patient_id: created.result.patient_id,
      time_preference: 'a morning next week',
    });

    expect(result.ok).toBe(true);
    expect(result.scheduled_for_spoken).toMatch(
      /^(Monday|Tuesday|Wednesday|Thursday|Friday), \w+ \d+ at \d+ (AM|PM)$/,
    );
    expect(result.scheduled_for_spoken).toMatch(/ AM$/); // honoured "morning"
  });
});

describe('payload tolerance and resilience', () => {
  it('accepts arguments delivered as a JSON string', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/voice/vapi',
      headers: { 'x-vapi-secret': SECRET },
      payload: {
        message: {
          type: 'tool-calls',
          call: { id: 'call-string-args' },
          toolCalls: [
            {
              id: 'tc-2',
              function: { name: 'lookup_patient', arguments: JSON.stringify({ phone_number: '4155550123' }) },
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.json().results[0].result).exists).toBe(true);
  });

  it('accepts the legacy singular functionCall shape', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/voice/vapi',
      headers: { 'x-vapi-secret': SECRET },
      payload: {
        message: {
          type: 'function-call',
          call: { id: 'call-legacy' },
          functionCall: { name: 'lookup_patient', parameters: { phone_number: '4155550123' } },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.json().result).exists).toBe(true);
  });

  it('answers 200 with a recovery instruction for an unknown tool', async () => {
    const { response, result } = await callTool('delete_everything', {});

    expect(response.statusCode).toBe(200);
    expect(result.ok).toBe(false);
    expect(result.error_type).toBe('unknown_tool');
  });

  it('acknowledges non-tool events without doing anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/voice/vapi',
      headers: { 'x-vapi-secret': SECRET },
      payload: { message: { type: 'status-update', status: 'in-progress', call: { id: 'c-1' } } },
    });

    expect(response.statusCode).toBe(200);
  });

  it('stores the transcript from an end-of-call report', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/voice/vapi',
      headers: { 'x-vapi-secret': SECRET },
      payload: {
        message: {
          type: 'end-of-call-report',
          call: { id: 'call-transcript-1', customer: { number: '+14155551000' } },
          endedReason: 'customer-ended-call',
          summary: 'Registered Jane Doe.',
          transcript: 'AI: Hello. User: Hi, I want to register.',
          durationSeconds: 92.4,
          startedAt: '2026-01-01T10:00:00.000Z',
          endedAt: '2026-01-01T10:01:32.000Z',
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const calls = await app.inject({ method: 'GET', url: '/calls' });
    const stored = calls.json().data.calls.find((c: { call_id: string }) => c.call_id === 'call-transcript-1');
    expect(stored.summary).toBe('Registered Jane Doe.');
    expect(stored.duration_secs).toBe(92.4);
  });
});
