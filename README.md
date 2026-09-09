# Voice AI Agent — Patient Registration

A voice agent that answers a real U.S. phone number, collects standard patient
demographics through natural conversation, validates and persists them, and
exposes the records over a REST API.

> **Live demo**
>
> | | |
> |---|---|
> | **📞 Phone number** | **+1 (681) 465-7159** |
> | **API base URL** | https://voice-agent-bice-nine.vercel.app |
> | **Dashboard** | https://voice-agent-bice-nine.vercel.app/ |
> | **Health check** | https://voice-agent-bice-nine.vercel.app/health |
>
> No credentials are needed to read the API.
>
> **Try it:** call the number and register as a new patient. Then:
>
> ```bash
> curl "https://voice-agent-bice-nine.vercel.app/patients?last_name=<your last name>"
> ```
>
> The record is there, and it survives restarts — the database is managed
> Postgres, not local disk. Call back with the same phone number and the agent
> recognises you and offers to update instead of creating a duplicate.
>
> **Two seeded demo patients** are already present. Giving the agent
> **415 555 0142** on a call demonstrates returning-caller detection without
> having to register first.

---

## Table of contents

- [Architecture](#architecture)
- [Tech stack and why](#tech-stack-and-why)
- [Project layout](#project-layout)
- [Running it locally](#running-it-locally)
- [Deploying](#deploying)
- [Environment variables](#environment-variables)
- [REST API](#rest-api)
- [Data model](#data-model)
- [The voice agent](#the-voice-agent)
- [Edge cases and resilience](#edge-cases-and-resilience)
- [Tests](#tests)
- [Known limitations and trade-offs](#known-limitations-and-trade-offs)
- [Next steps](#next-steps)

---

## Architecture

```
   ☎  Caller
   │
   │  PSTN
   ▼
┌──────────────────────────────────────────┐
│  Vapi                                    │   Telephony + STT + TTS + turn-taking
│  Deepgram nova-3  ·  GPT-4o  ·  TTS      │   LLM runs here, holding the conversation
└───────────────┬──────────────────────────┘
                │  HTTPS webhook (x-vapi-secret)
                │  tool-calls · end-of-call-report
                ▼
┌──────────────────────────────────────────┐
│  This service (Fastify / TypeScript)     │
│                                          │
│  src/voice/    Vapi adapter + prompt     │  ← the only Vapi-aware code
│       │        + tool handlers           │
│       ▼                                  │
│  src/domain/   service layer             │  ← validation, dedupe, business rules
│       │        (Zod + normalisers)       │
│       ▲                                  │
│  src/api/      REST routes ──────────────┼──→  reviewers, dashboard, curl
│       │                                  │
│       ▼                                  │
│  src/db/       pg connection pool        │
└───────────────┬──────────────────────────┘
                ▼
          PostgreSQL (Neon / Supabase / Render)
```

The service holds **no local state** — every record lives in Postgres. The
container can restart, redeploy or scale to several instances without losing a
registration, which is what satisfies "Jane Doe must still be there on Call 2".

**The important structural decision:** the voice agent and the REST API share one
service layer (`src/domain/patient.service.ts`). A tool call from a phone call
and a `POST /patients` from curl run *the same* validation, the same duplicate
detection and the same logging. There is no second write path that could drift,
and the agent cannot bypass server-side validation — which the assessment
explicitly asks for.

Layer boundaries:

| Layer | Knows about | Does not know about |
|---|---|---|
| `src/voice/routes/vapi.ts` | Vapi payload shapes, webhook auth | SQL, Zod, HTTP status codes |
| `src/voice/tools.ts` | How to phrase a recovery instruction | Vapi, SQL |
| `src/domain/` | Validation, business rules | HTTP, Vapi |
| `src/api/` | HTTP status codes, the envelope | SQL, Vapi |
| `src/db/` | SQL, constraints | Everything above |

Swapping Vapi for Retell or a Twilio media-stream bridge means rewriting
`src/voice/routes/vapi.ts` and nothing else.

---

## Tech stack and why

| Layer | Choice | Reasoning |
|---|---|---|
| Telephony + voice | **Vapi** | Handles PSTN, STT, TTS, barge-in and endpointing. The assessment names this as the fastest path, and the interesting engineering here is integration and prompt design, not building a speech pipeline. |
| LLM | **GPT-4o** (via Vapi) | Reliable multi-field extraction and tool calling at conversational latency. `4o-mini` was noticeably worse at capturing fields the caller volunteers unprompted ("I'm Jane Doe, 415-555-0123"), which is the behaviour that makes the agent feel non-robotic. |
| Transcription | **Deepgram nova-3**, `numerals: true` | Spoken digits are transcribed as digits, which materially improves phone-number and ZIP capture. `language: multi` enables the Spanish-switch path. |
| Backend | **Node + TypeScript + Fastify** | One language across API, webhook and dashboard. Fastify's `inject()` makes the whole HTTP surface testable with no running server. |
| Validation | **Zod** | One schema serves the API and the voice tools, and its error output maps cleanly onto per-field spoken re-prompts. |
| Database | **PostgreSQL** (`pg`) | Real `DATE`/`TIMESTAMPTZ` types, partial unique indexes and `ON CONFLICT` — so duplicate detection and the not-in-the-future DOB rule are enforced by the storage layer, not just by application code. A managed free tier persists across restarts with no disk to pay for or lose. |
| Hosting | **Vercel** (serverless) | Render, Fly and Railway all now require a payment method even on free tiers. Vercel does not, and it is on the assessment's own hosting list. Because state lives in Postgres, running on ephemeral instances costs nothing. A Dockerfile and `render.yaml` are also included for a container deploy. |

> **Why not SQLite?** It was the first implementation, and it is the shortcut the
> assessment explicitly blesses. It was replaced because the only way to persist
> a SQLite file on Render is a paid disk — the free plan has an ephemeral
> filesystem, so patient records would vanish between the reviewer's two calls
> and fail the core requirement. Postgres was the cheaper trade: a free
> non-expiring tier, a stateless container, better column types, and no
> single-writer limit. The swap touched only `src/db/` and the repository
> layer, which is the payoff from keeping SQL out of the service layer.

---

## Project layout

```
src/
  config/env.ts                 Validated environment — the only place reading process.env
  lib/
    errors.ts                   AppError hierarchy (422/404/409/400/401)
    logger.ts                   pino, with secret redaction
  db/
    schema.ts                   DDL: tables, CHECK constraints, partial indexes
    client.ts                   Pool, type parsers, transactions, migration
    seed.ts                     Two demo patients, inserted only if empty
    migrate.ts                  Standalone `npm run migrate`
  domain/
    normalize.ts                Speech → data: phones, dates, states, ZIPs, emails
    patient.schema.ts           Zod schemas (validate + normalise in one pass)
    patient.repository.ts       SQL only
    patient.service.ts          Business logic — shared by API and voice
    call-log.repository.ts      Transcript storage
    appointment.service.ts      Mock scheduling
  api/                          (HTTP layer — not to be confused with /api below)
    envelope.ts                 { data, error }
    error-handler.ts            Error → HTTP status mapping
    auth.ts                     Optional bearer token on writes
    routes/{patients,calls,health}.ts
  voice/
    prompt.ts                   ★ System prompt, with the reasoning behind it
    tools.ts                    ★ Tool schemas + handlers + recovery instructions
    assistant.ts                Full Vapi assistant config, generated from source
    routes/vapi.ts              Webhook: auth, payload parsing, dispatch
  scripts/provision-vapi.ts     Idempotently push the assistant to Vapi
api/index.ts                    Vercel serverless entry — wraps the same app
public/index.html               Dashboard (dependency-free)
tests/                          59 tests: unit + API + voice webhook
Dockerfile, render.yaml         Container deploy (alternative to Vercel)
```

---

## Running it locally

Requires Node 20+ (developed on Node 24) and a Postgres to point at.

```bash
git clone https://github.com/zabiullahzahir1/voiceAgent.git
cd voiceAgent
npm install
cp .env.example .env      # Windows: copy .env.example .env

npm run db:up             # local Postgres in Docker on port 55432
npm run dev
```

`db:up` starts `postgres:16-alpine` matching the default `DATABASE_URL` in
`.env.example`. To use a hosted database instead, skip it and put your Neon or
Supabase connection string in `DATABASE_URL`.

On boot the server applies the schema and seeds two demo patients.

Verify:

```bash
curl http://localhost:3000/health
curl "http://localhost:3000/patients?last_name=doe"
```

Open `http://localhost:3000/` for the dashboard. Tear the database down with
`npm run db:down`.

### Connecting a phone number

1. Create an account at [vapi.ai](https://dashboard.vapi.ai) (the trial credit
   covers demo calls).
2. **Phone Numbers → Buy Number** — pick any U.S. number.
3. **Organization → API Keys** — copy the **private** key.
4. Expose your local server publicly, or deploy first (see below):
   ```bash
   ngrok http 3000
   ```
5. Fill in `.env`:
   ```
   VAPI_API_KEY=<private key>
   VAPI_SERVER_SECRET=<any random string>
   PUBLIC_BASE_URL=https://<your-ngrok-or-render-url>
   ```
   Generate a secret with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
6. Push the assistant and attach it to the number:
   ```bash
   npm run provision:vapi
   ```

The script creates the assistant if it does not exist and PATCHes it if it does,
matching on name — so it is safe to re-run after every prompt change. It prints
the phone number to call.

You can inspect exactly what it will send at `GET /voice/assistant-config`.

---

## Deploying

### 1. Create a database

[Neon](https://neon.tech) — free tier, does not expire. Create a project and
copy the **pooled** connection string (it ends in `?sslmode=require`).

Supabase works identically. Render's own free Postgres also works but is deleted
after 30 days; `render.yaml` has a commented block for it.

### 2. Deploy the service (Vercel — no payment method required)

```bash
npx vercel login
npx vercel --prod
```

Accept the defaults; there is no framework preset to choose. Then set the
environment variables, either in the Vercel dashboard under
**Settings → Environment Variables** or from the CLI:

| Key | Value |
|---|---|
| `DATABASE_URL` | the connection string from step 1 |
| `VAPI_SERVER_SECRET` | any random string |
| `SEED_ON_BOOT` | `true` |

`PUBLIC_BASE_URL` is optional — set it to the deployment URL if you want the
logged webhook address to be exact. `NODE_ENV` is set by Vercel automatically.

Redeploy after adding variables (`npx vercel --prod`), since they are injected
at build time.

`api/index.ts` is the entry point: it builds the same Fastify app that
`src/index.ts` runs locally and hands it each request, so there is no separate
serverless codebase to maintain.

**Why `vercel.json` looks the way it does** (JSON allows no comments, and Vercel
rejects unknown keys — including a `"//"` comment property):

- **`builds` instead of zero-config.** Zero-config detection treated files under
  `src/` as additional serverless entrypoints. They export named helpers such as
  `buildApp` rather than a default handler, so those lambdas died on load with
  `Invalid export found in module "/var/task/src/app.js"`. Declaring the build
  pins exactly one function; everything under `src/` is bundled as an ordinary
  dependency of it.
- **`public/**` built as static.** The dashboard is served by Vercel's CDN, not
  through the function — faster, and it avoids `@fastify/static` having to
  resolve a directory inside the lambda bundle. Route order matters: the
  explicit static paths are matched before the catch-all into Fastify.
- **`api/tsconfig.json`.** The root config sets `rootDir: "src"` so
  `npm run build` emits a flat `dist/`. That makes `api/index.ts` — outside
  `src/`, importing from it — an error under that config. Vercel resolves the
  tsconfig nearest the entrypoint, so the `api/` one widens `rootDir` without
  affecting the local build.

<details>
<summary>Alternative: Render / any Docker host</summary>

Render requires a card even on the free plan, but the container path is fully
supported if you have one:

- **Blueprint:** Render dashboard → **New → Blueprint** → select the repo;
  `render.yaml` is applied automatically.
- **Manual:** **New → Web Service**, Language `Docker`, instance type Free, and
  set the same env vars by hand. `PUBLIC_BASE_URL` can be omitted — the app
  falls back to `RENDER_EXTERNAL_URL`, which Render injects.

</details>

Then point Vapi at whichever deployment you used:

```bash
PUBLIC_BASE_URL=https://<your-deployment-url> npm run provision:vapi
```

> **Free-plan caveat:** the Render web service sleeps after ~15 minutes idle and
> takes 30–60 s to wake, so the *first* call after a quiet period may time out.
> Hit `/health` once before demoing, or move to the starter plan to keep it
> warm. Patient data is unaffected either way — it lives in Postgres.

### Docker

The container is stateless; all it needs is a `DATABASE_URL`.

```bash
docker build -t voice-patient-registration .
docker run -p 3000:3000 \
  -e DATABASE_URL='postgresql://user:pass@host/patients?sslmode=require' \
  -e PUBLIC_BASE_URL=https://your-public-url \
  -e VAPI_SERVER_SECRET=your-secret \
  voice-patient-registration
```

---

## Environment variables

No secret is ever hardcoded; everything is read through `src/config/env.ts`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP port |
| `NODE_ENV` | no | `development` | `production` disables pretty logs; `test` uses an in-memory DB |
| `LOG_LEVEL` | no | `info` | pino level |
| `PUBLIC_BASE_URL` | **yes (deployed)** | `http://localhost:PORT` | Public URL Vapi calls back into |
| `DATABASE_URL` | **yes** | — | Postgres connection string |
| `DATABASE_SSL` | no | auto | TLS to the database. Auto-detected: on for managed hosts, off for localhost |
| `SEED_ON_BOOT` | no | `true` | Insert demo patients when the table is empty |
| `VAPI_API_KEY` | for provisioning | — | Vapi **private** key. Used only by `npm run provision:vapi`; the server never reads it |
| `VAPI_SERVER_SECRET` | **yes (deployed)** | — | Shared secret verified on every webhook request |
| `VAPI_PHONE_NUMBER_ID` | no | first number found | Which number to attach when the account has several |
| `API_TOKEN` | no | — | If set, `POST`/`PUT`/`DELETE` require `Authorization: Bearer <token>` |

---

## REST API

Every response uses the envelope `{ "data": ..., "error": ... }`. Exactly one
side is non-null.

| Method | Endpoint | Success | Notes |
|---|---|---|---|
| `GET` | `/patients` | 200 | Filters: `last_name` (prefix, case-insensitive), `date_of_birth` (MM/DD/YYYY or ISO), `phone_number`. Also `include_deleted`, `limit`, `offset` |
| `GET` | `/patients/:id` | 200 | 404 if unknown or soft-deleted; 400 if not a UUID |
| `POST` | `/patients` | 201 | `Location` header set. 409 if the phone belongs to an active patient |
| `PUT` | `/patients/:id` | 200 | Partial updates; omitted fields are untouched |
| `DELETE` | `/patients/:id` | 200 | **Soft delete** — sets `deleted_at`, retains the row |
| `GET` | `/calls` | 200 | Recent call transcripts and summaries |
| `GET` | `/patients/:id/calls` | 200 | Calls linked to one patient |
| `GET` | `/health` | 200 | Includes a live database read |
| `POST` | `/voice/vapi` | 200 | Vapi webhook (requires `x-vapi-secret`) |
| `GET` | `/voice/assistant-config` | 200 | The assistant config this deployment expects |

Status codes: `400` malformed, `401` bad credentials, `404` missing, `409`
conflict, `422` failed field validation, `500` unexpected.

### Examples

```bash
# Create
curl -X POST http://localhost:3000/patients \
  -H 'Content-Type: application/json' \
  -d '{
    "first_name": "Jane", "last_name": "Doe",
    "date_of_birth": "03/05/1985", "sex": "Female",
    "phone_number": "(415) 555-0123",
    "address_line_1": "42 Oak Street",
    "city": "San Francisco", "state": "California", "zip_code": "94107"
  }'

# Search
curl "http://localhost:3000/patients?last_name=doe"
curl "http://localhost:3000/patients?phone_number=4155550123"
curl "http://localhost:3000/patients?date_of_birth=03/05/1985"
```

A validation failure names the offending field, and the message is written to be
spoken aloud:

```json
{
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "One or more fields are invalid.",
    "issues": [
      {
        "field": "date_of_birth",
        "message": "A date of birth cannot be in the future. Please give the correct year."
      }
    ]
  }
}
```

---

## Data model

All 19 specified fields, plus `deleted_at` for soft deletes.

Storage decisions:

- **Real column types.** `date_of_birth` is a `DATE` and the audit columns are
  `TIMESTAMPTZ`, so the database itself rejects `2001-02-30` and stores instants
  unambiguously in UTC. A `CHECK (date_of_birth <= CURRENT_DATE)` enforces the
  not-in-the-future rule at the storage layer rather than trusting the agent.
- **Custom `pg` type parsers** (`src/db/client.ts`) keep `DATE` as
  `YYYY-MM-DD` and `TIMESTAMPTZ` as an ISO string, instead of node-postgres's
  default `Date` objects. Without this a patient born on `1985-03-05` can come
  back as `1985-03-04` depending on the server's timezone.
- **Phone numbers** as exactly 10 normalised digits. `(415) 555-0123`,
  `415-555-0123` and `+1 415 555 0123` all collapse to `4155550123`, which is
  what makes returning-caller lookup reliable. Formatting is applied on output
  (`phone_number_formatted` for the eye, `415 555 0123` for the ear).
- **Constraints live in the database**, not only in Zod: `CHECK` constraints on
  the sex enum, phone digit count, ZIP format, state format and DOB shape. Zod
  produces friendly errors; the schema guarantees the invariant.
- **Partial unique index** on `phone_number WHERE deleted_at IS NULL` — one
  active patient per number. This enforces duplicate detection at the storage
  layer and lets a number be reused after a soft delete. The service does a
  pre-check for a friendly message, then catches SQLSTATE `23505` as a backstop,
  so two simultaneous registrations of the same number cannot both succeed. The
  same pattern prevents double-booked appointment slots.

Two extra tables support bonus features: `call_logs` (transcript + summary per
call, linked to the patient) and `appointments` (mock scheduling).

---

## The voice agent

### Prompt engineering

The full system prompt is [`src/voice/prompt.ts`](src/voice/prompt.ts), with the
reasoning for each section in a comment block at the top of the file. The
decisions that mattered most:

- **Voice-first output rules come first.** The biggest failure mode is a model
  writing text meant to be *read* — markdown, `(555) 123-4567`, "e.g." — which
  TTS renders badly. Early instructions dominate, so these lead.
- **Validation is not in the prompt.** There are no regexes and no "check the
  date isn't in the future". LLMs are unreliable validators; a Zod schema is
  not. The agent submits, the server rejects with a specific field and a
  ready-to-speak message, and the agent re-prompts for that field only.
- **Every tool result carries an `agent_instruction`.** Handing a model a bare
  error produces improvisation — vague apologies, re-asking for everything, or
  claiming success anyway. An explicit next action makes recovery deterministic:

  ```json
  {
    "ok": false,
    "error_type": "validation",
    "invalid_fields": [{ "field": "date_of_birth", "label": "date of birth", "…": "…" }],
    "agent_instruction": "The record was NOT saved. Apologise briefly and ask the caller
                          again for ONLY these: date of birth. Use this wording: …"
  }
  ```

- **A hard confirmation gate.** The agent may not call `register_patient` until
  it has read everything back and heard a yes. Stated under its own heading
  because models otherwise skip ahead helpfully.
- **An explicit "never invent" rule.** Models guess plausible addresses. On a
  medical record, an empty field beats a wrong one.
- **A spelling protocol** that says to *replace* rather than merge when a caller
  spells a name out — the "D-A-V-I-S, not D-A-V-I-E-S" case.

### Tools

| Tool | When | Behaviour |
|---|---|---|
| `lookup_patient` | As soon as the phone number is known | Returning-caller detection. Returns the existing record and the exact offer to make |
| `register_patient` | Only after confirmed read-back | Creates the record. Returns field errors, a duplicate hint, or success |
| `update_patient` | Caller wants to update an existing record | Partial update by `patient_id` |
| `schedule_appointment` | After a successful registration, if the caller says yes | Mock booking. **The server picks the slot**, not the model — LLMs are bad at date arithmetic and will confidently offer a Sunday |

Tools are declared `async: false` so the model waits for the write to succeed
before it speaks. An async tool would let it tell the caller they are registered
before the database has confirmed anything.

### Conversational tuning

Set in [`src/voice/assistant.ts`](src/voice/assistant.ts):

- `startSpeakingPlan.waitSeconds: 0.6` plus semantic endpointing — default
  endpointing cuts people off mid-address, because "four one five … five five
  five" contains natural pauses. This was the single biggest quality win.
- `stopSpeakingPlan.numWords: 2` — the caller can interrupt a long read-back to
  correct a field without the agent talking over them.
- `messagePlan.idleMessages` — handles the caller going quiet.
- `firstMessage` is spoken before the LLM is invoked, so there is no dead air on
  pickup.

---

## Edge cases and resilience

| Scenario | Behaviour |
|---|---|
| Invalid date of birth (future, `02/30`, unparseable) | Rejected server-side with a distinct message per reason; agent re-prompts for that field only. Nothing is saved |
| 3-digit or NANP-invalid phone number | Rejected; agent asks for all ten digits including the area code |
| Several invalid fields | All reported in one response, so the agent fixes them in one pass instead of round-tripping |
| Database write fails | Tool returns `error_type: "system"` instructing one retry, then a graceful hand-off ("someone will call you back today"). The agent is explicitly told never to claim success — the caller never gets silence or a false confirmation |
| Duplicate phone number | Routed into the update flow rather than surfaced as a failure |
| Call drops mid-registration | Nothing is written until confirmation, so no partial records. On redial, `lookup_patient` finds them if they had already registered; otherwise they start clean |
| Caller says "start over" | Prompt instructs discarding collected state and restarting from the name |
| Correction to an earlier field | Accepted at any point, confirmed individually, without restarting |
| Caller goes silent | Idle prompts, then a 30-second silence timeout |
| Caller speaks Spanish | Agent switches language and records `preferred_language` |
| Unknown tool / malformed webhook payload | 200 with a recovery instruction — never a 500, which would leave the caller in silence |
| Unauthenticated webhook | 401 before any handler runs |
| Stuck call | 15-minute hard cap |

`executeTool` never throws: every path returns a spoken recovery instruction,
because an unhandled exception during a call means dead air.

---

## Tests

```bash
npm run db:up    # if you do not already have Postgres running
npm test
```

59 tests across three files, all against real code paths — no mocks and no
database emulator. They run against a real Postgres (so CHECK constraints,
partial unique indexes and `ON CONFLICT` are genuinely exercised) via Fastify's
`inject()` rather than a live port. Point `TEST_DATABASE_URL` elsewhere to use a
different instance.

- `tests/normalize.test.ts` — the speech-to-data layer: phone formats, NANP
  rules, future/impossible dates, spoken state names, dictated emails.
- `tests/patients.api.test.ts` — full CRUD, validation status codes, query
  filters, the envelope, soft-delete semantics including phone-number reuse.
- `tests/vapi.webhook.test.ts` — webhook auth, all three Vapi payload shapes,
  every tool, duplicate detection, and assertions on the `agent_instruction`
  text the model receives.

Also available: `npm run typecheck`.

---

## Known limitations and trade-offs

**Deployment**

- **Every free container host now wants a card.** Render (including its free
  plan and Blueprints), Fly.io and Railway all require payment details. Vercel
  does not, which is why the primary deployment is serverless. The Dockerfile
  and `render.yaml` remain in the repo and work unchanged if you have a card.
- **Serverless cold starts.** A first request to a fresh instance pays for
  building the Fastify app and connecting to Postgres — roughly 1–2 s. The app
  is memoised per instance, so warm requests are ~20 ms. During a live call the
  agent has usually already triggered `lookup_patient` before the first write,
  so the instance is warm by the time it matters. Setting `MIGRATE_ON_BOOT=false`
  after the first deploy trims it further.
- **Neon's free tier also scales compute to zero**, adding a few hundred
  milliseconds to the first query after idling. The pool is configured with a
  10-second connection timeout to absorb that.
- **No connection retry with backoff.** A database blip during a call surfaces
  as the tool's "system failure" path, which is graceful but gives up after one
  retry.

**Architecture**

- **No migration framework.** The schema is idempotent DDL applied on boot,
  which is fine greenfield but cannot express a column rename or a backfill.
  Drizzle or node-pg-migrate would be the next step.
- **The voice tools call the service layer in-process, not over HTTP.** The
  assessment permits either. In-process avoids a network hop during a live call
  and cannot partially fail; the cost is that the agent could not be moved to a
  separate host without introducing an HTTP client.

**Security**

- **`API_TOKEN` is a single shared bearer token**, and only guards writes —
  reads and the dashboard are open so reviewers can inspect data freely. A real
  deployment needs per-client credentials and authentication on reads.
- **No rate limiting** on the API.
- **No encryption at rest**, no audit trail, no HIPAA controls. Out of scope per
  the assessment, and the seed data is fictional (555 numbers).
- Logged payloads truncate phone numbers, emails and member IDs.

**Voice**

- **English and Spanish only** in practice — `language: multi` covers a handful
  of languages, not every language GPT-4o speaks. Set it to `en` if multilingual
  transcription degrades English accuracy for your accent mix.
- **Appointment scheduling is mock.** Slots are computed deterministically
  (weekdays, two days out) against the local `appointments` table, with no real
  calendar behind it.
- **Vapi is a hard dependency** for telephony. The blast radius is one file, but
  an outage there takes the phone number down.
- **No barge-in during the read-back has been load-tested** across accents; the
  `stopSpeakingPlan` values are tuned by hand, not measured.

---

## Next steps

Given more time, in priority order:

1. **A real migration tool** (Drizzle or node-pg-migrate) so schema changes are
   versioned and reversible rather than idempotent DDL applied on boot.
2. **Resume an interrupted call.** Persist partial intake state keyed by caller
   ID so a dropped call resumes where it left off rather than restarting.
3. **Eval harness for the prompt.** Scripted caller transcripts replayed against
   the tool layer, asserting on extracted fields — so prompt changes can be
   regression-tested instead of manually dialled.
4. **Structured confirmation.** Have the model emit the collected record as a
   tool call *before* the read-back, so the read-back is generated from
   validated server data rather than from the model's own memory of the call.
5. **Per-client API credentials** and rate limiting.
6. **Address verification** against USPS to catch a valid-format but nonexistent
   address.
7. **Observability** — request tracing and a metric on registration
   completion rate per call.
