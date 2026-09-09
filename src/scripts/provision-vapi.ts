/**
 * Idempotently push the assistant defined in `src/voice/assistant.ts` to Vapi,
 * and attach it to a phone number.
 *
 *   npm run provision:vapi
 *
 * Run it after every prompt or tool change, and after the `PUBLIC_BASE_URL`
 * changes (a new Render URL, a fresh ngrok tunnel). It matches an existing
 * assistant by name and PATCHes it, so re-running never creates duplicates and
 * never orphans the phone number that is already pointed at it.
 *
 * Kept as a script rather than boot-time behaviour on purpose: a redeploy
 * should not silently mutate a live phone assistant.
 */
import { env } from '../config/env';
import { buildAssistantConfig } from '../voice/assistant';

const VAPI_API = 'https://api.vapi.ai';

type VapiAssistant = { id: string; name?: string };
type VapiPhoneNumber = { id: string; number?: string; name?: string; assistantId?: string };

async function vapi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${VAPI_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.vapi.apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Vapi ${init.method ?? 'GET'} ${path} failed (${response.status}): ${text}`);
  }

  return (text ? JSON.parse(text) : {}) as T;
}

async function main(): Promise<void> {
  // --- Preconditions -------------------------------------------------------
  if (!env.vapi.apiKey) {
    console.error('VAPI_API_KEY is not set. Add it to .env (Vapi dashboard -> Organization -> API Keys).');
    process.exit(1);
  }

  if (env.publicBaseUrl.includes('localhost')) {
    console.error(
      `PUBLIC_BASE_URL is "${env.publicBaseUrl}". Vapi cannot reach localhost.\n` +
        'Set it to your Render URL, or start a tunnel (ngrok http 3000) and use that URL.',
    );
    process.exit(1);
  }

  if (!env.vapi.serverSecret) {
    console.warn(
      'WARNING: VAPI_SERVER_SECRET is empty. The webhook will accept unauthenticated requests.\n',
    );
  }

  const config = buildAssistantConfig();
  console.log(`Assistant:  ${config.name}`);
  console.log(`Webhook:    ${config.server.url}`);
  console.log(`Tools:      ${config.model.tools.map((t) => t.function.name).join(', ')}\n`);

  // --- Create or update the assistant --------------------------------------
  const assistants = await vapi<VapiAssistant[]>('/assistant?limit=100');
  const existing = assistants.find((assistant) => assistant.name === config.name);

  let assistantId: string;

  if (existing) {
    await vapi(`/assistant/${existing.id}`, { method: 'PATCH', body: JSON.stringify(config) });
    assistantId = existing.id;
    console.log(`Updated existing assistant  ${assistantId}`);
  } else {
    const created = await vapi<VapiAssistant>('/assistant', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    assistantId = created.id;
    console.log(`Created assistant           ${assistantId}`);
  }

  // --- Attach a phone number -----------------------------------------------
  const numbers = await vapi<VapiPhoneNumber[]>('/phone-number?limit=100');

  if (numbers.length === 0) {
    console.log(
      '\nNo phone numbers on this Vapi account yet.\n' +
        'Buy one in the dashboard (Phone Numbers -> Buy Number), then re-run this script\n' +
        'to attach the assistant to it.',
    );
    return;
  }

  // Honour an explicit choice when several numbers exist; otherwise take the first.
  const target =
    (env.vapi.phoneNumberId && numbers.find((n) => n.id === env.vapi.phoneNumberId)) || numbers[0];

  if (!target) {
    console.error(`VAPI_PHONE_NUMBER_ID "${env.vapi.phoneNumberId}" was not found on this account.`);
    process.exit(1);
  }

  if (target.assistantId === assistantId) {
    console.log(`\nAlready attached to ${target.number ?? target.id} — nothing to change.`);
  } else {
    await vapi(`/phone-number/${target.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ assistantId }),
    });
    console.log(`Attached to phone number    ${target.number ?? target.id}`);
  }

  console.log('\n--------------------------------------------------------------');
  console.log(`  Call this number to test:  ${target.number ?? '(see Vapi dashboard)'}`);
  console.log(`  API base URL:              ${env.publicBaseUrl}`);
  console.log('--------------------------------------------------------------');

  if (numbers.length > 1) {
    console.log('\nOther numbers on this account (set VAPI_PHONE_NUMBER_ID to pick one):');
    for (const number of numbers) {
      console.log(`  ${number.id}  ${number.number ?? ''}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(`\nProvisioning failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
