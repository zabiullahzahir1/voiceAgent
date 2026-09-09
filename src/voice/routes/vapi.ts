import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { UnauthorizedError } from '../../lib/errors';
import { saveCallLog } from '../../domain/call-log.repository';
import { buildAssistantConfig } from '../assistant';
import { executeTool } from '../tools';

/**
 * Vapi server webhook.
 *
 * Vapi posts every server-side event here: tool calls, status changes, and the
 * end-of-call report. This module is the *only* place that knows Vapi's payload
 * format — it parses a request into `(toolName, args)`, hands that to the
 * transport-agnostic `executeTool`, and formats the reply. Swapping Vapi for
 * Retell or a Twilio bridge would mean rewriting this file and nothing else.
 *
 * Payload tolerance is deliberate. Vapi has shipped several shapes for tool
 * calls over time (`toolCallList`, `toolCalls` with a nested `function`, and
 * the older singular `functionCall`), and `arguments` arrives sometimes as an
 * object and sometimes as a JSON string. Handling all of them costs a few lines
 * and removes an entire category of live-call failure.
 */

type VapiToolCall = { id: string; name: string; args: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

/**
 * Verify the shared secret Vapi is configured to send.
 *
 * Without this, anyone who finds the URL could write patient records. Compared
 * via SHA-256 digests so the check is constant-time.
 */
function verifySecret(request: FastifyRequest): void {
  if (!env.vapi.serverSecret) return; // not configured — see the boot-time warning

  const provided = request.headers['x-vapi-secret'];
  const token = Array.isArray(provided) ? provided[0] : provided;

  if (
    !token ||
    !crypto.timingSafeEqual(
      crypto.createHash('sha256').update(token).digest(),
      crypto.createHash('sha256').update(env.vapi.serverSecret).digest(),
    )
  ) {
    throw new UnauthorizedError('Invalid webhook secret.');
  }
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      logger.warn({ raw }, 'Tool arguments were not valid JSON');
    }
  }
  return {};
}

/** Pull tool calls out of whichever shape this Vapi version sent. */
function extractToolCalls(message: Record<string, unknown>): VapiToolCall[] {
  const calls: VapiToolCall[] = [];

  // Current shape: message.toolCallList = [{ id, name, arguments }]
  const toolCallList = message.toolCallList;
  if (Array.isArray(toolCallList)) {
    for (const entry of toolCallList as Record<string, unknown>[]) {
      const fn = entry.function as Record<string, unknown> | undefined;
      const name = (entry.name ?? fn?.name) as string | undefined;
      if (!name) continue;
      calls.push({
        id: String(entry.id ?? entry.toolCallId ?? ''),
        name,
        args: parseArguments(entry.arguments ?? fn?.arguments),
      });
    }
  }

  // Alternative shape: message.toolCalls = [{ id, function: { name, arguments } }]
  const toolCalls = message.toolCalls;
  if (calls.length === 0 && Array.isArray(toolCalls)) {
    for (const entry of toolCalls as Record<string, unknown>[]) {
      const fn = (entry.function ?? {}) as Record<string, unknown>;
      const name = (fn.name ?? entry.name) as string | undefined;
      if (!name) continue;
      calls.push({
        id: String(entry.id ?? ''),
        name,
        args: parseArguments(fn.arguments ?? entry.arguments),
      });
    }
  }

  // Legacy singular shape: message.functionCall = { name, parameters }
  const functionCall = message.functionCall as Record<string, unknown> | undefined;
  if (calls.length === 0 && functionCall?.name) {
    calls.push({
      id: '',
      name: String(functionCall.name),
      args: parseArguments(functionCall.parameters ?? functionCall.arguments),
    });
  }

  return calls;
}

function extractCallId(message: Record<string, unknown>): string | null {
  const call = message.call as Record<string, unknown> | undefined;
  const id = call?.id ?? message.callId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function extractCallerNumber(message: Record<string, unknown>): string | null {
  const call = message.call as Record<string, unknown> | undefined;
  const customer = (call?.customer ?? message.customer) as Record<string, unknown> | undefined;
  const number = customer?.number;
  return typeof number === 'string' ? number : null;
}

/** Vapi's transcript arrives as a string on some events and as turns on others. */
function extractTranscript(message: Record<string, unknown>): string | null {
  if (typeof message.transcript === 'string') return message.transcript;

  const messages = message.messages ?? (message.artifact as Record<string, unknown>)?.messages;
  if (Array.isArray(messages)) {
    return (messages as Record<string, unknown>[])
      .filter((turn) => turn.role !== 'system')
      .map((turn) => `${String(turn.role ?? 'unknown')}: ${String(turn.message ?? turn.content ?? '')}`)
      .join('\n');
  }

  const artifactTranscript = (message.artifact as Record<string, unknown>)?.transcript;
  return typeof artifactTranscript === 'string' ? artifactTranscript : null;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function registerVapiRoutes(app: FastifyInstance): Promise<void> {
  app.post('/voice/vapi', async (request, reply) => {
    verifySecret(request);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const message = (body.message ?? body) as Record<string, unknown>;
    const type = String(message.type ?? 'unknown');
    const callId = extractCallId(message);

    switch (type) {
      // --- The agent wants to run a tool ----------------------------------
      case 'tool-calls':
      case 'function-call': {
        const toolCalls = extractToolCalls(message);

        if (toolCalls.length === 0) {
          logger.warn({ call_id: callId, type }, 'Tool-call webhook contained no recognisable calls');
          return reply.status(200).send({ results: [] });
        }

        // Sequential rather than concurrent: a model can emit `lookup_patient`
        // and `register_patient` in one batch, and running those in parallel
        // would race the duplicate check against the insert.
        const results = [];
        for (const call of toolCalls) {
          const result = await executeTool(call.name, call.args, { callId });
          results.push({
            toolCallId: call.id,
            name: call.name,
            // Vapi feeds `result` back to the model as a string.
            result: JSON.stringify(result),
          });
        }

        // `results` is the current contract; `result` keeps the legacy
        // single-function-call shape working without a second code path.
        return reply.status(200).send({ results, result: results[0]?.result });
      }

      // --- The call finished: persist the transcript (bonus) --------------
      case 'end-of-call-report': {
        if (callId) {
          try {
            await saveCallLog({
              call_id: callId,
              patient_id: null, // already linked at registration time, if any
              caller_number: extractCallerNumber(message),
              outcome: typeof message.endedReason === 'string' ? message.endedReason : null,
              summary: typeof message.summary === 'string' ? message.summary : null,
              transcript: extractTranscript(message),
              duration_secs:
                typeof message.durationSeconds === 'number' ? message.durationSeconds : null,
              started_at: typeof message.startedAt === 'string' ? message.startedAt : null,
              ended_at: typeof message.endedAt === 'string' ? message.endedAt : null,
            });
          } catch (error) {
            // A failed transcript write must never affect the caller — the call
            // is already over — so log it and still answer 200.
            logger.error({ err: error, call_id: callId }, 'Failed to persist call log');
          }
        }

        logger.info(
          { event: 'voice.call.ended', call_id: callId, ended_reason: message.endedReason },
          'Call ended',
        );
        return reply.status(200).send({ received: true });
      }

      // --- Everything else: acknowledge and log ---------------------------
      default: {
        logger.debug({ event: 'voice.webhook', type, call_id: callId }, 'Vapi webhook received');
        return reply.status(200).send({ received: true });
      }
    }
  });

  /**
   * Convenience endpoint: returns the exact assistant configuration this
   * deployment expects, so it can be inspected in a browser or piped straight
   * into Vapi. Also what `npm run provision:vapi` sends.
   *
   * Imported statically at the top of this file rather than lazily here — a
   * dynamic `import()` is not resolved by the serverless bundler and made this
   * route throw at runtime in production.
   */
  app.get('/voice/assistant-config', async (_request, reply) => {
    return reply.status(200).send(buildAssistantConfig());
  });
}
