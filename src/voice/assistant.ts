import { env } from '../config/env';
import { CLINIC_NAME, FIRST_MESSAGE, buildSystemPrompt } from './prompt';
import { TOOL_DEFINITIONS } from './tools';

/**
 * The complete Vapi assistant configuration, generated from source.
 *
 * Keeping this in code rather than clicking through the Vapi dashboard means
 * the prompt, the tool schemas and the webhook URL are versioned together and
 * can be re-applied idempotently (`npm run provision:vapi`). A dashboard-only
 * assistant is invisible to code review and drifts silently — exactly the kind
 * of thing that breaks a demo.
 *
 * Each block below is tuned for a *data-collection* call, which behaves
 * differently from open-ended chat: callers speak long digit strings, pause
 * mid-address, and interrupt to correct themselves.
 */
export function buildAssistantConfig() {
  const serverUrl = `${env.publicBaseUrl}/voice/vapi`;

  return {
    name: `${CLINIC_NAME} — Patient Intake`,

    /**
     * Spoken immediately on pickup, before the model is invoked, so there is no
     * dead air while the first LLM token is generated.
     */
    firstMessage: FIRST_MESSAGE,
    firstMessageMode: 'assistant-speaks-first',

    model: {
      provider: 'openai',
      /**
       * GPT-4o: strong multi-field extraction and reliable tool calling at
       * conversational latency. 4o-mini drops fields when the caller volunteers
       * several at once; the larger model's accuracy is worth the extra ~200 ms
       * on a two-minute call.
       */
      model: 'gpt-4o',
      /** Low but non-zero — natural phrasing without improvising on the rules. */
      temperature: 0.4,
      messages: [{ role: 'system', content: buildSystemPrompt() }],
      tools: TOOL_DEFINITIONS.map((tool) => ({
        ...tool,
        /**
         * Synchronous: the model must wait for the write to succeed or fail
         * before it speaks. An async tool would let it tell the caller they are
         * registered before the database has confirmed anything.
         */
        async: false,
        server: {
          url: serverUrl,
          ...(env.vapi.serverSecret ? { secret: env.vapi.serverSecret } : {}),
        },
      })),
    },

    /**
     * Deepgram nova-3 in multilingual mode. `numerals: true` transcribes spoken
     * digits as digits ("four one five" -> "415"), which materially improves
     * phone number and ZIP capture. `multi` lets the Spanish-switch path work;
     * set it to 'en' if you only need English.
     */
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      language: 'multi',
      numerals: true,
      smartFormat: true,
      /** Bias the recogniser toward vocabulary this call is guaranteed to use. */
      keyterm: ['insurance', 'ZIP code', 'date of birth', 'apartment', 'suite', 'member ID'],
    },

    /** Vapi's bundled voices avoid a second vendor account for the demo. */
    voice: {
      provider: 'vapi',
      voiceId: 'Paige',
    },

    /**
     * Turn-taking. The default endpointing cuts people off mid-address, because
     * "four one five ... five five five" contains natural pauses. Waiting a
     * little longer and using a semantic endpointing model is the single
     * biggest conversational-quality win on a form-filling call.
     */
    startSpeakingPlan: {
      waitSeconds: 0.6,
      smartEndpointingPlan: { provider: 'livekit' },
    },

    /**
     * Barge-in. The caller must be able to interrupt a long read-back to
     * correct a field, which is explicitly scored. Two words is enough signal
     * to stop talking without triggering on "mm-hm".
     */
    stopSpeakingPlan: {
      numWords: 2,
      voiceSeconds: 0.3,
      backoffSeconds: 1.2,
    },

    /** Handles the caller going quiet, per the prompt's silence rules. */
    messagePlan: {
      idleMessages: ['Are you still there?', 'I can still hear you if you are there.'],
      idleTimeoutSeconds: 10,
      idleMessageMaxSpokenCount: 2,
    },

    /** Which events Vapi posts to our webhook. */
    server: {
      url: serverUrl,
      timeoutSeconds: 20,
      ...(env.vapi.serverSecret ? { secret: env.vapi.serverSecret } : {}),
    },
    serverMessages: ['tool-calls', 'end-of-call-report', 'status-update'],

    /** Produces the summary stored in `call_logs` (bonus requirement). */
    analysisPlan: {
      summaryPlan: {
        enabled: true,
        messages: [
          {
            role: 'system',
            content:
              'Summarise this patient intake call in three sentences or fewer: who called, which fields were collected, and whether a record was created, updated, or neither.',
          },
          { role: 'user', content: 'Transcript:\n\n{{transcript}}' },
        ],
      },
    },

    /** The agent can hang up itself once registration is finished. */
    endCallFunctionEnabled: true,
    endCallMessage: 'Thanks for calling. Take care.',

    /** Guardrails: a stuck call should not run forever or bill indefinitely. */
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 900,
    backgroundSound: 'off',

    /** Recording is needed for the stored transcript. */
    recordingEnabled: true,
  };
}

export type AssistantConfig = ReturnType<typeof buildAssistantConfig>;
