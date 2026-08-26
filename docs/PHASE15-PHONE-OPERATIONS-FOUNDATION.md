# Phase 15 — Phone Operations Foundation

Status: **IMPLEMENTED / VERIFIED / NOT COMMITTED** (see the Phase 15 Safe Commit
task, run separately, for the commit record).

## What this phase is

The OFS-side data model, API, RBAC, and admin/dispatcher UI foundation for a
future integration with a separate "Voice Engine" runtime — an AI phone
receptionist that bridges real phone calls (Twilio) to the OpenAI Realtime
API. This phase implements the authoritative business-data side of that
integration inside OFS; it does **not** implement the Voice Engine itself
(that stays a separate, minimal Node runtime outside this repository,
evolved from the read-only `Answermachine` reference project — see
`docs/PHASE14-ANSWERMACHINE-INTEGRATION-AUDIT.md` for the full audit and
approved architecture this phase builds against).

**Explicitly out of scope, not started**: Phase 16 (automatic
Customer/Lead/Job creation from call outcomes, live PSTN transfer execution,
AI tool-calling with real write access). Nothing in this phase writes to
`customers`, `leads`, or `jobs`.

## Architecture

OFS remains the sole user-facing system and sole source of truth. The
central design invariant, carried forward from the Phase 14 audit's most
consequential finding: **the Voice Engine can never assert which
organization a request belongs to.** OFS always resolves `organization_id`
server-side from something OFS itself issued — a bearer service credential,
the dialed phone number, or the call's own stored row — never from a
request body.

```
OFS (this repo, Cloudflare Worker)
├── Phone Operations UI            (src/client/components/phone-operations.tsx)
├── Phone Operations API           (src/server/index.ts, "Phone Operations" section)
├── Call / Transcript / Outcome data (migrations/0023_phone_operations.sql)
└── Twilio provider boundary       (src/server/twilio-provider.ts)
         │
         │  HTTP webhooks (signature-verified)      Bearer-credentialed runtime API
         ▼                                            ▲
    Twilio (real)                          Voice Engine runtime (separate, not in this repo)
                                                       │
                                                       ▼
                                          OpenAI Realtime API (real)
```

### New server module: `src/server/phone-operations.ts`

The single authoritative module for this capability, following the same
conventions already established elsewhere in this codebase rather than
inventing new ones:

- **Settings** (`phone_operations_settings`) — organization-scoped,
  non-destructively versioned (`effective_from`/`effective_until`), same
  pattern as `settings.ts`/`tax-jurisdiction.ts`. Defaults to `DISABLED` for
  every organization — a fresh install or an org that never visits this
  screen accepts zero calls, same "safe zero-config default" precedent as
  Tax Profile's `tax_enabled=0`.
- **Voice Engine (Twilio) account credential** (`voice_engine_credentials`)
  — one per org, AES-256-GCM encrypted at rest via the existing
  `src/server/crypto.ts` (the same mechanism protecting Google Calendar
  OAuth tokens). The Auth Token is never returned by any API route.
- **Voice Engine service credential** (`voice_engine_service_credentials`)
  — the bearer token the separate Voice Engine runtime presents to OFS's
  runtime API. Hashed before storage (SHA-256), same idiom as
  `sessions.token_hash` in `auth.ts`. Shown to an admin exactly once at
  issuance.
- **Voice Agents** (`voice_agents`) — versioned per agent `name` (an
  organization may run more than one named agent, e.g. a front-desk agent
  and an after-hours agent). A database-level partial unique index
  guarantees at most one open-ended default agent per organization.
- **Phone Numbers** (`phone_numbers`) — provisioning records, optionally
  bound to a specific agent (`voice_agent_id`) that overrides the org
  default for calls through that number.
- **Calls** (`calls`) — a finite state machine (`queued → ringing →
  in_progress → {completed|failed|no_answer|busy|canceled}`, no edges out
  of a terminal state). `voice_agent_snapshot` freezes the agent's
  name/language/voice/model/instructions at call-start time and is never
  re-resolved — the same snapshot-once historical-immutability discipline
  `tax_snapshots`/Contract commercial snapshots already use, so a later
  agent-config change never retroactively changes what an in-flight or
  completed call ran with.
- **Call Events, Transcripts, Outcomes, Transfers** — append-only records
  (`call_events`, `call_transcripts`) with idempotency guards (a unique
  `(call_id, idempotency_key)` / `(call_id, sequence)` index absorbs a
  duplicate delivery rather than erroring or double-applying), plus
  single-write outcome/transfer records. `call_outcomes` stores the AI's
  structured result strictly for a human to review — nothing here writes to
  any CRM table.
- **Call Sessions** (`call_sessions`) — short-lived (120s default),
  call-scoped, organization-bound tokens that authorize the Voice Engine's
  one bootstrap call to `/runtime/sessions/resolve` for a specific,
  already-authorized call. A separate, durable tier from the service
  credential (which authorizes the ongoing runtime API).

### New provider boundary: `src/server/twilio-provider.ts`

Mirrors `src/server/payment-provider.ts`'s shape — hand-rolled `fetch` +
Web Crypto, no vendor SDK (Node-specific dependencies in the `twilio` npm
package are not a proven fit for the Cloudflare Workers runtime). Implements
Twilio's documented request-signature algorithm (HMAC-SHA1 over
`url + sorted key+value pairs`, base64), outbound call REST creation, TwiML
builders, and a Twilio-status-to-internal-status mapping table. All
Twilio-specific vocabulary stays inside this file — `phone-operations.ts`
and the route handlers never see a Twilio-shaped string.

### Routes (`src/server/index.ts`, "Phone Operations" section)

- **Admin-only** (`canManagePhoneOperations`): settings, Twilio account
  credential, service-credential issue/list/revoke, voice agents, phone
  numbers.
- **Admin + dispatcher** (`canViewPhoneOperationsCalls`): call list/detail,
  events, transcript, outcome, transfers, and initiating an outbound call.
  Technician is blocked from all of it (no legitimate use — calls are not
  job-scoped field work, per the Phase 14 audit's own finding).
- **Public, Twilio-signature-authenticated**: `/api/phone-operations/twilio/voice`
  and `/status` — added to the `/api/*` auth middleware's public-path
  exemption (same shape as the existing Contract-signing-link `/api/public/`
  prefix exemption), with their own independent signature check replacing
  session auth.
- **Public, bearer-service-credential-authenticated**: `/api/phone-operations/runtime/*`
  — the contract the separate Voice Engine calls. Every handler resolves
  `organization_id` solely from the credential, then re-checks every
  call/session id against that resolved org before reading or writing.

## Security review outcomes (independent Security, Architecture, and Testing
reviews — all three run against the initial implementation, findings fixed
before this phase was marked verified)

**Fixed:**
- **P0 (Testing)** — a replayed, validly-signed inbound Twilio webhook
  (same `CallSid`) crashed with an unhandled `UNIQUE constraint failed`
  500. `createCall()` now catches the constraint violation and returns the
  already-created call idempotently, matching the pattern
  `recordCallEvent`/`appendTranscript` already used two functions away.
- **P1 (Architecture)** — `phone_numbers.voice_agent_id` was recorded and
  editable in the UI but never actually consulted at call time; every call
  silently used the org-wide default agent regardless of which number was
  dialed. `createCall` now resolves the number's bound agent first, falling
  back to the org default only when none is set.
- **P1 (Architecture / Security)** — a failed outbound Twilio placement
  (bad number, Twilio-side error, network failure) left the already-created
  call row `queued` forever, permanently consuming one concurrency-cap and
  one daily-cap slot for the organization. The outbound route now marks the
  call `failed` when placement fails.
- **P2 (Security)** — `appendTranscript`/`recordCallOutcome`/
  `requestCallTransfer`/`listCallEvents`/`listTranscript`/`getCallOutcome`/
  `listCallTransfers` now all take `organizationId` and re-check it against
  the call's own stored organization before acting — defense in depth
  matching `markCallSessionDisconnected`'s existing cross-tenant check,
  rather than relying solely on every call site remembering to pre-check.
- **P2/P3 (Security / Architecture)** — the Twilio `/voice` webhook used to
  return 200 for both "number not provisioned" and "number provisioned but
  no Twilio credential configured," while returning 401 only once a number
  was both provisioned and credentialed with a bad signature — letting an
  unauthenticated caller fingerprint which numbers are live, funded Phone
  Operations numbers. The unconfigured-credential case now also returns
  401, closing that oracle (the softer 200 remains only for "not
  provisioned in OFS at all," the least sensitive case).
- **P3 (Architecture)** — an out-of-order/duplicate status webhook that a
  call correctly refuses (no transition out of a terminal state) is now
  recorded as a `*_rejected` event instead of silently swallowed, so the
  event log has a full audit trail of what Twilio actually sent.
- **P3 (Architecture)** — editing an existing named agent's `name` in the
  UI used to silently orphan its version thread (server-side versioning is
  keyed by name) rather than renaming it. The Name field is now locked
  (disabled, with an explanatory label) whenever the form holds an existing
  agent's data; renaming requires archiving and creating a new agent.
- **P3 (Security)** — the raw Twilio REST API error text is no longer
  surfaced verbatim to the client on a failed outbound placement (logged to
  `phone_operations_audit` instead; the client gets a generic message).
- **P3 (Security)** — the TwiML builder's XML escaping now covers
  `<`/`>`/`"`/`'`, not just `&` (no live injection path exists today, but a
  function whose job is building XML from a dynamic string should escape
  correctly regardless).

**Documented, not fixed (accepted for this foundation phase — see the
in-code `ponytail:`-style comments at each site for the exact reasoning and
upgrade path)**:
- The concurrency-cap and daily-cap checks are read-then-insert, not one
  atomic statement — a narrow race under near-simultaneous inbound calls
  could momentarily exceed a configured cap. Acceptable at realistic
  small-business call volumes; revisit with a transaction or an atomic
  `INSERT ... WHERE count < cap` if that ever changes.
- `phone_numbers.e164_number` uniqueness is global, not per-organization,
  and this phase never calls Twilio to verify the calling org's account
  actually owns a number being registered — an admin of any org can
  register (and thereby block) a number belonging to a different,
  not-yet-onboarded org. Can't be used to hijack real calls (the squatter's
  wrong Auth Token fails signature verification, closed), but is a real
  griefing vector worth real ownership verification in a later phase.

**Confirmed correct by all three reviews** (not re-summarized here — see
each review's own report): server-authoritative RBAC on every route;
Twilio signature verification gates every state-changing action and is
resolved per-organization before checking; the Twilio Auth Token is
correctly encrypted at rest and never returned by any route; service
credentials are hashed, shown once, and revoked immediately with no
caching; call session tokens are genuinely short-lived and single-purpose;
no SQL injection; mass assignment is closed on both the Zod-validated admin
routes and the hand-validated runtime routes; idempotency/replay handling
is correct for events, transcripts, and outcomes; the call FSM has no
reachable dead end and no forbidden backward transition; module placement
follows the existing flat-file-in-`src/server/` capability-module
precedent (not nested under `modules/`, which is reserved for
industry/regional code); no HVAC/CleanBC/BC-Hydro-specific logic leaked
into this industry-neutral capability.

## Deployment prerequisites (not exercised in this session — see below)

- `TOKEN_ENCRYPTION_KEY` — already required by Google Calendar integration;
  reused here for the Twilio Auth Token. No new secret needed if Calendar
  is already configured.
- `VOICE_ENGINE_STREAM_BASE_URL` — new, optional `wrangler.toml` `[vars]`
  entry: the base `wss://` origin of the separate Voice Engine runtime.
  Absent by design in this session's local dev/test environment (the
  runtime doesn't exist yet) — its absence is the deliberate "runtime not
  yet deployed" gate: an otherwise fully-authorized inbound call gets a
  graceful TwiML rejection instead of a broken stream URL.
- A real Twilio account, phone number, and webhook configuration pointing
  at this Worker's `/api/phone-operations/twilio/voice` and `/status`
  routes — none of this was exercised against live Twilio infrastructure
  this session (no real account exists in this environment); all Twilio
  interaction was verified via the hand-rolled signature algorithm against
  test credentials and a `fetch` interceptor mock (`test/helpers.ts`'s
  `mockNotificationProviders()`, which already generically intercepts
  `api.twilio.com/*`).

## Verification performed this session

- `pnpm run typecheck` — clean.
- `pnpm run lint` — clean.
- `pnpm run check:architecture` — clean.
- `pnpm vitest run --no-file-parallelism` (full suite, sequential to avoid
  this environment's observed parallel-worker resource contention) — see
  the Phase 15 implementation report for the final pass/fail count.
- Real-browser acceptance via `pnpm run dev` (real Vite + real `wrangler
  dev` + real local D1) for Admin (full settings/agents/numbers/credentials
  CRUD, including issuing and revoking a service credential and verifying
  the agent-rename lock), Dispatcher (Calls-tab-only visibility, config
  routes 403 both client-side-hidden and server-side-confirmed via direct
  `fetch`), and Technician (Phone Operations entirely absent from the
  sidebar, direct URL falls back to Technician Home, direct API probe
  returns 403).
- No automatic Customer/Lead/Job write path exists anywhere in this phase
  (confirmed by grep — no code in `phone-operations.ts` or the new routes
  touches `customers`/`leads`/`jobs`).

## Next steps (not started, require explicit authorization)

- Phase 16: automatic Customer/Lead/Job creation from call outcomes, live
  PSTN transfer execution, AI tool-calling with real write access.
- Building and deploying the actual separate Voice Engine runtime.
- Real Twilio account provisioning and live webhook verification against
  this Worker's real deployed URL.
- Addressing the two documented-not-fixed limitations above if call volume
  or multi-tenant number-provisioning risk grows.
