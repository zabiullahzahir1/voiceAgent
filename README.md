# Voice AI Agent — Patient Registration

A voice agent that answers a real U.S. phone number, collects standard patient
demographics through natural conversation, validates and persists them, and
exposes the records over a REST API.

> **Live demo**
>
> | | |
> |---|---|
> | **Phone number** | `TBD — fill in after running npm run provision:vapi` |
> | **API base URL** | `TBD — fill in after deploying to Render` |
> | **Dashboard** | `<API base URL>/` |
> | **Health check** | `<API base URL>/health` |
>
> Try it: call the number and register. Then run
> `curl "<API base URL>/patients?last_name=<your last name>"` and the record is there.
> Call again with the same phone number and the agent will recognise you.

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
│  src/db/       SQLite (better-sqlite3)   │
└───────────────┬──────────────────────────┘
                ▼
         /data/patients.sqlite   (Render persistent disk)
```

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
| Database | **SQLite** (`better-sqlite3`) | Single writer, tiny dataset, zero operational surface. The assessment names "SQLite over Postgres" as a sensible shortcut. Synchronous driver means no connection pooling and no async edge cases in the hot path of a live call. |
| Hosting | **Render** (Docker + persistent disk) | Deploys from a Dockerfile, and a mounted disk gives real persistence across restarts and redeploys. |

---

## Project layout

```
src/
  config/env.ts                 Validated environment — the only place reading process.env
  lib/
    errors.ts                   AppError hierarchy (422/404/409/400/401)
    logger.ts                   pino, with secret redaction
  db/
    schema.ts                   DDL: tables, CHECK constraints, indexes
    client.ts                   Connection + PRAGMAs + migration on open
    seed.ts                     Two demo patients, inserted only if empty
    migrate.ts                  Standalone `npm run migrate`
  domain/
    normalize.ts                Speech → data: phones, dates, states, ZIPs, emails
    patient.schema.ts           Zod schemas (validate + normalise in one pass)
    patient.repository.ts       SQL only
    patient.service.ts          Business logic — shared by API and voice
    call-log.repository.ts      Transcript storage
    appointment.service.ts      Mock scheduling
  api/
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
public/index.html               Dashboard (dependency-free)
tests/                          59 tests: unit + API + voice webhook
```

---

## Running it locally

Requires Node 20+ (developed on Node 24).

```bash
git clone https://github.com/zabiullahzahir1/voiceAgent.git
cd voiceAgent
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm run dev
```

The server starts on `http://localhost:3000`, creates `./data/patients.sqlite`,
applies the schema and seeds two demo patients.

Verify:

```bash
curl http://localhost:3000/health
curl "http://localhost:3000/patients?last_name=doe"
```

Open `http://localhost:3000/` for the dashboard.

> **npm 11 note:** npm 11 blocks native install scripts by default. If
> `better-sqlite3` fails to load, run `npm approve-scripts better-sqlite3`.
> The repo's `package.json` already records the approval, so a fresh
> `npm install` should be fine.

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

### Render (recommended)

1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → select the repo. `render.yaml` is
   picked up automatically.
3. Set the secret env vars in the Render dashboard: `VAPI_SERVER_SECRET`,
   `VAPI_API_KEY`, and optionally `API_TOKEN`.
4. Deploy, then run `npm run provision:vapi` locally with
   `PUBLIC_BASE_URL=https://<your-service>.onrender.com` so Vapi points at the
   deployed webhook.

> **⚠ Plan requirement.** Render's **free** plan has no persistent disk and
> spins the service down when idle, so the SQLite file would be lost between
> calls — failing the "data survives restarts" requirement. `render.yaml`
> therefore specifies the **starter** plan (~$7/mo) with a 1 GB disk mounted at
> `/data`. See [trade-offs](#known-limitations-and-trade-offs) for free
> alternatives.

### Docker

```bash
docker build -t voice-patient-registration .
docker run -p 3000:3000 \
  -v "$(pwd)/data:/data" \
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
| `DATABASE_PATH` | no | `./data/patients.sqlite` | SQLite file; `/data/patients.sqlite` in Docker |
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

- **Dates** as `YYYY-MM-DD`, **timestamps** as ISO-8601 UTC. SQLite has no date
  type; these formats sort lexicographically in chronological order.
- **Phone numbers** as exactly 10 normalised digits. `(415) 555-0123`,
  `415-555-0123` and `+1 415 555 0123` all collapse to `4155550123`, which is
  what makes returning-caller lookup reliable. Formatting is applied on output
  (`phone_number_formatted` for the eye, `415 555 0123` for the ear).
- **Constraints live in the database**, not only in Zod: `CHECK` constraints on
  the sex enum, phone digit count, ZIP format, state format and DOB shape. Zod
  produces friendly errors; the schema guarantees the invariant.
- **Partial unique index** on `phone_number WHERE deleted_at IS NULL` — one
  active patient per number. This enforces duplicate detection at the storage
  layer and lets a number be reused after a soft delete.

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
npm test
```

59 tests across three files, all against real code paths — no mocks, an
in-memory SQLite database, and Fastify's `inject()` rather than a live port.

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

- **Render's free plan cannot persist SQLite.** No disk, and the instance spins
  down when idle. `render.yaml` uses the starter plan (~$7/mo) with a mounted
  disk. Free alternatives, in order of effort: point `DATABASE_PATH` at a
  [Turso](https://turso.tech) libSQL database (SQLite-compatible, generous free
  tier, needs a driver swap); use Render's free Postgres (expires after 30 days,
  needs a repository rewrite); or accept ephemeral storage, which fails the
  persistence requirement.

**Architecture**

- **SQLite means one writer.** Fine for a single instance; horizontal scaling
  would need Postgres. The repository layer is the only thing that would change.
- **The voice tools call the service layer in-process, not over HTTP.** The
  assessment permits either. In-process avoids a network hop during a live call
  and cannot partially fail; the cost is that the agent could not be moved to a
  separate host without introducing an HTTP client.
- **No migration framework.** The schema is idempotent DDL applied on open,
  which is sufficient for a greenfield service but would need something like
  Drizzle or Knex once columns start changing in production.

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

1. **Postgres + Drizzle** — removes the single-writer limit and the Render disk
   requirement in one change.
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
