# Phase 14 — Answermachine → OFS Integration Audit

**Status: AUDIT / ARCHITECTURE / MIGRATION PLAN — no implementation, no commit.**
Date: 2026-08-26. Audited source: `D:\IT Department\Answermachine` (not a git repository — see §1).
This document is the durable record for Phase 14; Phase 15/16 implementation work should start from here, not re-derive it.

**No secret values appear anywhere in this document** — only variable names, config shape, and structural findings, per the task's explicit No-Secret Rule.

---

## §1. Project Identity

### OFS
```
Repo:    D:\IT Department\Open Fieldservice\open-fieldservice-git
Branch:  main
HEAD:    d3c12e7 (Phase 13D, committed)
Remote:  https://github.com/clawnify/open-fieldservice.git
Package: @clawnify/open-fieldservice
Tree:    clean (CLAUDE.md, guide.txt untracked/protected)
```

### Answermachine
```
Path:      D:\IT Department\Answermachine
Git repo:  NO — `git rev-parse --show-toplevel` fails ("not a git repository"). No .git anywhere in
           the tree or parents. There is no branch/HEAD/remote to report.
Package:   "answermachine-voice-mvp" v0.1.0, private, type: commonjs
Runtime:   Node.js >=18.17.0, TypeScript 5.7, tsx (dev watch runner)
Framework: Express 4 (HTTP), `ws` 8 (raw WebSocket server/client), `twilio` 5 SDK, `dotenv`
Tree:      not applicable (no git) — working directory contains real, uncommitted local state
           (`.env` with live credentials, `output/` with real test-call reports, `cloudflared.log`,
           `server.log`, `dist/` build output, `node_modules/`)
```

**CLAUDE.md**: OFS root — **TRACKED** at `D:\IT Department\CLAUDE.md` (the parent-directory instructions file governing this whole engagement) and **UNTRACKED** at the repo root (`open-fieldservice-git\CLAUDE.md`, pre-existing, protected). Answermachine — **ABSENT** (`.claude/` directory exists but is empty; no CLAUDE.md file anywhere in the tree).

---

## §2. Serena Reconciliation

OFS: live MCP confirmed, active project `open-fieldservice-git`, `project/fsm-upgrade-plan` read fresh — Phase 13D confirmed **COMMITTED (`d3c12e7`)**, Phase 14 confirmed **NOT STARTED** prior to this audit. Relevant architecture memories consulted from this session's own accumulated knowledge of OFS (Company Profile / `organization_profiles`, Global Settings / `global_settings` effective-dated key-value store, `BUSINESS_TIMEZONE` setting, Customers/Leads/Jobs/Scheduler, admin/dispatcher/technician RBAC, tenant isolation via `organization_id`, Notifications Phase 9 provider-adapter pattern, Financial/Invoicing boundaries) — all directly informed the mapping in §13/§29 below.

Answermachine has its own local `.serena/memories/` (two files, read in full): a runtime-identity source-of-truth audit and a live-call-failure trace. Both are incident/debugging records, not an architecture record — they contributed concrete evidence (confirmed config-load-once-at-startup behavior, confirmed `cloudflared` quick-tunnel is the actual current tunnel mechanism vs. the README's stated `ngrok`, confirmed `npm test` was 187/187 passing as of 2026-08-24) but did not replace direct code reading, which is the primary evidence base for this document.

No duplicate OFS memory was created by this audit; the Phase 14 durable-sync write happens once, in §50/§Serena-sync below.

---

## §3. Executive Summary — Read This First

Answermachine is **not** the "second CRM/dashboard" system the task brief anticipated auditing. It is a **private, single-purpose, outbound-only technical MVP**: one hardcoded test destination number, no database, no inbound calling, no transfer, no recording, no CRM, no scheduling, no tool/function calling, no multi-call orchestration. Its own README states this explicitly and the code matches the README's claims in every case checked. Several sections below therefore correctly resolve to **NOT IMPLEMENTED** rather than a reverse-engineered guess — per the task's own repeated instruction not to invent capabilities that don't exist.

What Answermachine *does* contain, and contains well, is a genuinely production-quality **Voice Engine core**: a carefully-tuned Twilio Media Stream ↔ OpenAI Realtime audio bridge with noise-resistant barge-in handling, a clean config-driven business-identity injection architecture, all **six** of the target languages (fa/en/hi/zh-CN/zh-HK/ru) already implemented as detailed native-register prompt profiles, a real post-call outcome-analysis pipeline with a well-designed outcome taxonomy, comprehensive secret redaction in logging, and unusually thorough test coverage (16 test files, reported 187/187 passing as of the last recorded run) for an app its own README calls an "MVP." This is the asset worth carrying forward — as a **separate Voice Engine runtime component**, not as a second product, and not copied wholesale into the Worker.

**Recommended architecture (§26/§27, detailed below): Option C (hybrid).** The Voice Engine keeps running as an evolved, Node-based service outside the Cloudflare Worker (avoiding a high-risk rewrite of proven, latency-sensitive audio-bridging code onto Durable Objects), but it is stripped of every piece of local "source of truth" (no local report files, no local session registry treated as CRM) and becomes a thin adapter that authenticates to OFS's own domain APIs for every business fact and every business write. OFS remains the single user-facing system and the single source of truth for Customers, Leads, Jobs, Company Profile, Users/RBAC, and now Phone Operations data — full detail in §17/§27/§29.

**Post-review update**: this document was independently reviewed by three separate agents (Architecture, Security, Testing — §46-48) before being finalized. All three returned PASS WITH FINDINGS, no blockers to the core recommendation. The single most consequential finding, reached independently by both the Architecture and Security reviews from different angles, was that the Voice Engine's authentication to OFS must use **per-organization credentials with OFS resolving tenant scope server-side**, never a single shared credential trusting a Voice-Engine-asserted `organization_id` — this is now a named, resolved requirement in §26, not an open question. A factual error in the original test-file count (15 vs. the actual 16) was also caught and corrected (§40). Every other finding is folded into its relevant section inline, marked as a review-sourced correction.

---

## §4. Secret Boundary (No-Secret Rule compliance)

```
SECRET PRESENT — D:\IT Department\Answermachine\.env — TYPE: OpenAI API key (OPENAI_API_KEY)
SECRET PRESENT — D:\IT Department\Answermachine\.env — TYPE: Twilio Account SID (TWILIO_ACCOUNT_SID)
SECRET PRESENT — D:\IT Department\Answermachine\.env — TYPE: Twilio Auth Token (TWILIO_AUTH_TOKEN)
```
Confirmed present by checking `.env` for these three key *names* only (`grep -oE "^[A-Z_]+="`, printing keys never values). No value was read, printed, logged, copied, or referenced anywhere in this document, in Serena memory, or in any OFS source file. `.env.example` (safe, no real values) and the real `.env`'s key set were cross-checked and match exactly — no undocumented extra variables exist.

Two further fields are **real PII, not secrets in the classic sense, but must never be hardcoded into OFS source either**: `BUSINESS_PHONE`/`BUSINESS_EMAIL` in `.env` hold a real phone number and email address (`.env.example` itself ships a real-looking business phone/email as its template default — not flagged as a "secret" by the task's own definition, but noted here since it's real contact information sitting in a template file). `TEST_DESTINATION_NUMBER` holds a real personal phone number used only for placing test calls — this must **never** migrate into OFS in any form; it is test-harness-only and has no place in a multi-tenant product.

Answermachine's own logger (`src/logger.ts`) redacts any field whose key matches `/api[_-]?key|auth[_-]?token|authorization|password|secret/i` before writing structured JSON logs — verified by direct code read, not just documentation. `doctor.ts` (the config diagnostic tool) never prints secret values, only presence/format/masked previews (confirmed by direct code read). This existing discipline is worth preserving in whatever the Phase 15 Voice Engine becomes.

**Gap in that redaction (independent Security review, verified by direct code read of `logger.ts:3-13`)**: the redaction is **key-based only** — it inspects an object's *key names*, never scans the *content* of string values. A secret or credential embedded as text inside a differently-named field (for example, an upstream provider's raw HTTP error body logged under a `message` key — `reporting/outcomeAnalyzer.ts`'s error path does exactly this shape today, though with low-sensitivity content currently) would pass through unredacted. Low blast radius today (OpenAI/Twilio error bodies don't typically echo credentials back), but this is exactly the gap that bites a new service-to-service boundary: once the Voice Engine starts sending the new per-org OFS service credential (§26) in request headers, any future error message, debug string, or SDK log line that happens to embed that credential as text — not as a conveniently-named field — would not be caught by today's redaction. **Required before the Voice Engine logs anything involving the new OFS credential**: add a value-pattern secondary check (e.g. mask substrings shaped like `Bearer <token>`, `sk-...`, or Twilio's `AC[a-f0-9]{32}` SID pattern) in addition to the existing key-based check.

---

## §5–§7. Full Module Inventory / Voice Engine Inventory

```
File                                              Purpose
────────────────────────────────────────────────────────────────────────────────────────
src/server.ts                                     Express app, routes, Twilio signature
                                                   validation, WS upgrade routing, process
                                                   lifecycle
src/config.ts                                     ALL env parsing/validation — single source
                                                   of typed AppConfig, fail-fast on load
src/doctor.ts                                     CLI diagnostic (`npm run doctor`) — config
                                                   + port check, never prints secrets
src/logger.ts                                     Structured JSON logger with key-based
                                                   secret redaction
src/runtimeFingerprint.ts                         Safe (secret-free) startup-state summary +
                                                   phone-number masking helper
src/callInitiation.ts                             Pure function: config → Twilio
                                                   calls.create() params (the ONE outbound
                                                   call this app can place)
src/mediaBridge.ts                                THE VOICE ENGINE CORE. Twilio Media Stream
                                                   WS ↔ OpenAI Realtime WS bridge; noise-
                                                   resistant barge-in state machine; per-call
                                                   closure state only, no persistence
src/openaiRealtime.ts                             OpenAI Realtime WS session wrapper —
                                                   session.update, audio relay, event parsing
src/agent/types.ts                                Shared type contracts (SupportedLanguage,
                                                   CallPurposeId, VoicePersonalityId,
                                                   BusinessContext)
src/agent/corePolicy.ts                           Business-agnostic behavioral policy (role,
                                                   tone, scope, intent handling, ending) — one
                                                   shared text, language-independent
src/agent/businessContext.ts                      config → BusinessContext mapping (single
                                                   place)
src/agent/buildInstructions.ts                     Composes final Realtime `instructions` from
                                                   corePolicy + language + personality +
                                                   business context + call context
src/agent/languageProfiles.ts                     All 6 target-language prompt profiles (see
                                                   §11)
src/agent/languageRouter.ts                       Language validation/resolution — explicit
                                                   extension point already anticipating a
                                                   future per-call/CRM-driven language value
src/agent/voicePersonalities.ts                   Voice/personality preset catalog (1 entry:
                                                   natural_receptionist)
src/agent/callPurposes.ts                         Call-purpose catalog (1 entry:
                                                   annual_heat_pump_service)
src/agent/customerName.ts                         Placeholder-name sanitization for safe
                                                   greeting use
src/reporting/types.ts                            CallOutcomeType taxonomy (15 values),
                                                   CallSessionState, CallReport shapes
src/reporting/callSessionRegistry.ts               In-memory, per-call-SID session accumulator
                                                   — NOT a database, consumed once
src/reporting/outcomeAnalyzer.ts                  Post-call LLM analysis (separate text model)
                                                   → structured CallOutcome, with a hardcoded
                                                   business name and hardcoded Persian output
                                                   language (see §10/§12 findings)
src/reporting/reportWriter.ts                     Assembles CallReport, writes JSON + localized
                                                   TXT to local filesystem (`output/`), never
                                                   throws (falls back to UNKNOWN)
src/reporting/localizedPersianReport.ts           Persian-language TXT report renderer (not
                                                   read in full this pass — low architectural
                                                   weight, output-formatting only)
src/reporting/timezone.ts                         IANA timezone validation + ISO-with-offset
                                                   formatting for report timestamps
src/reporting/filename.ts                         Deterministic date-bucketed report file
                                                   paths
16 × *.test.ts                                     Unit tests across nearly every module above,
                                                   including src/runtimeFingerprint.test.ts
                                                   (see §40)
.env / .env.example                               Runtime config (see §12)
package.json / tsconfig.json                      Node/TS project config
dist/                                              Compiled build output (gitignored)
output/                                            Local call-report storage (gitignored,
                                                   documented as PII, real test data present —
                                                   see §44)
cloudflared.log / server.log                      Local process logs (not source, not
                                                   inventoried further)
kill-port.bat                                      Local dev convenience script
README.md                                         Accurate — every claim in it was verified
                                                   against source and matched
```

**Voice Engine component audit** (Twilio / OpenAI Realtime / Media Streams / STT / TTS / Transfer / Call Runtime):

| Component | Purpose | Implementation | Deps | I/O | State | Failure modes | Secrets | Coupling | OFS reuse |
|---|---|---|---|---|---|---|---|---|---|
| Twilio outbound call | Place the one test call | `callInitiation.ts` (pure fn) + `server.ts` `/call` route | `twilio` SDK | config → `calls.create()` params | none (stateless) | Twilio API error → 502 to caller | Account SID/Auth Token | Low — isolated pure function | Direct reuse of the *shape*, not the hardcoded-destination logic |
| Twilio webhook (voice) | Fetch TwiML on answer | `server.ts` `/twilio/voice` | `twilio` SDK (signature validation), `twiml` builder | Twilio POST → TwiML XML | none | Missing/bad signature → 403 | Auth Token (signature validation) | Medium — assumes single fixed handler for the whole app | Reusable pattern; must add real inbound-vs-outbound branching for Phase 15 |
| Twilio webhook (status) | Call lifecycle + trigger reporting | `server.ts` `/twilio/status` | same | Twilio POST → 204, async report kickoff | triggers session consumption | Report failure logged, never blocks the webhook response | Auth Token | Medium | Reusable pattern |
| Media Streams bridge | Relay audio both directions, own barge-in FSM | `mediaBridge.ts` | `ws`, `openaiRealtime.ts` | Twilio WS ↔ OpenAI WS, G.711 µ-law passthrough | **all in closure-scoped variables, call-duration only** | WS close/error → cleanup(), never crashes process | none directly (uses config's) | High — this is the hardest-to-port piece | **Primary reuse candidate — see §26** |
| STT | N/A as a separate component | Folded into OpenAI Realtime's native audio-in; a SEPARATE side-channel transcription (`gpt-live-transcribe`) is enabled purely for reporting evidence, not for driving the conversation | OpenAI Realtime session config | audio in → `conversation.item.input_audio_transcription.completed` events | none | Silent (no explicit handling beyond ignoring malformed events) | OpenAI key | Low | N/A — not a separable component |
| TTS | N/A as a separate component | Folded into OpenAI Realtime's native audio-out (`output_modalities: ["audio"]`) | same | model reasoning → audio deltas | none | same | OpenAI key | Low | N/A |
| Transfer | Hand off to a human | **NOT IMPLEMENTED.** `corePolicy.ts` explicitly instructs the model to say so ("there is no live call-transfer capability in this system — never claim or simulate a transfer happening") | — | — | — | — | — | — | Design fresh for Phase 15/16 (§20) |
| Call Runtime | Overall call lifecycle owner | `mediaBridge.ts` + `server.ts` together | — | — | one call = one WS pair = one closure | — | — | High | Becomes the Voice Engine Adapter's core |

---

## §8. Inbound Call Audit

**Inbound calling from a real, unknown caller is NOT IMPLEMENTED.** Verified three independent ways:
1. README, verbatim: *"Nothing to set in 'A Call Comes In' — this app only makes outbound calls; it does not need to receive inbound calls."*
2. `server.ts`'s `/twilio/voice` handler is only ever reached because `callInitiation.ts` passes that exact URL as the `url` param to `calls.create()` for the ONE outbound call this app places — Twilio calls it back as part of *that* specific call's lifecycle, not because a phone number's "Voice URL" is configured to receive arbitrary inbound calls. No Twilio phone number is configured in the console to route inbound calls here (README §"Twilio Console setup required," item 5, confirms this explicitly).
3. The `/twilio/voice` handler itself has **zero logic to distinguish** an inbound call from a callback for its own outbound call — it unconditionally returns the same Media-Stream TwiML for any signature-valid request. If it *were* wired as an inbound Voice URL today, it would answer and bridge to the same single-purpose, single-test-customer-name, single-language-per-process agent with no caller-ID lookup, no customer matching, no business-hours check, and no way to know this is a "real" call vs. a self-test.

**Conclusion for Phase 15 design purposes**: the webhook/TwiML/Media-Stream mechanism itself is directly reusable (it's transport plumbing, not business logic), but the entire "this is an inbound call, from this caller, what do we do" decision layer — caller ID → customer lookup, business-hours gating, escalation, per-org routing — does not exist and must be designed new (§16/§17/§18).

---

## §9. Outbound Call Audit

**Outbound calling exists, but only in the narrowest possible form: exactly one call, to one hardcoded destination, triggered by one unauthenticated (no RBAC — this is a private local dev tool) `POST /call` with an empty body.** Traced fully:
```
POST /call (any body, ignored)
  → buildOutboundCallParams(config)   [pure fn: to=TEST_DESTINATION_NUMBER, from=TWILIO_PHONE_NUMBER,
                                        url=.../twilio/voice, statusCallback=.../twilio/status]
  → twilioClient.calls.create(callParams)
  → registerCallStart() in the in-memory session registry
  → 202 response {callSid, to, from}
```
No scheduling, no retries, no consent/business-rule gating beyond the hardcoded-destination safety restriction, no caller-ID selection logic (always `TWILIO_PHONE_NUMBER`), no queueing, no batch/bulk capability (explicitly out of scope per README). Call-status callbacks ARE wired (`statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]`) and DO drive the post-call reporting pipeline. Transcript/outcome IS captured (§reporting). Human transfer is not implemented (§20).

For Phase 16 (outbound from OFS), this is a real, working reference for the *mechanics* (Twilio call creation, status callback wiring, TwiML fetch) but the *policy* layer (who may be called, when, why, from which number, with what consent) must be designed from scratch as an OFS-governed feature, not adapted from this test-only safety restriction.

---

## §10. Agent / Prompt Architecture

Layering (verified by reading `buildInstructions.ts` and every file it composes):
```
corePolicy.ts (CORE_POLICY, business-agnostic, shared across all languages/deployments)
  + LANGUAGE block (languageProfiles.ts, selected by AGENT_LANGUAGE)
  + PERSONALITY block (voicePersonalities.ts, selected by VOICE_PERSONALITY)
  + BUSINESS CONTEXT block (agentName/businessName/businessPhone/businessEmail — from config,
    via businessContext.ts — NEVER hardcoded in corePolicy.ts, verified: corePolicy.ts's own
    header comment states this constraint and the body contains zero identity literals)
  + CALL CONTEXT block (call purpose description + sanitized customer name, per-call)
```
This is a genuinely well-designed, non-duplicated composition — **identity correctly does NOT belong in source**, and already flows from `config.ts` the same way OFS's Company Profile/Global Settings already flow into other generated documents (Contract PDF, Invoice PDF).

**Two real hardcoding findings, both worth carrying into Phase 15/16 design (not fixed here, per this phase's audit-only scope):**

1. **`corePolicy.ts`'s "BUSINESS KNOWLEDGE" section hardcodes real domain facts directly in source**: the specific list of services offered, the named service-area cities (Metro Vancouver + 10 named municipalities), the recommended maintenance cadence, the warranty term ("10-year workmanship warranty"), the estimate policy, and business hours ("Monday–Saturday 7:00–18:00"). The file's own header comment already flags this as a known, deliberate scope-limitation: *"they were not part of this work package's configuration scope (only identity + call purpose were)... Revisit if/when this app needs to serve a genuinely different business."* This maps cleanly onto OFS concepts that mostly already exist (Service Types table for "services offered"; a service-area concept does not currently exist as an explicit OFS setting and would need to be added; business hours does not currently exist as an OFS Global Setting either, despite `BUSINESS_TIMEZONE` already existing) or would need new Admin-configurable content for the parts that don't (warranty terms, maintenance-cadence guidance, estimate policy) — this is real content-authoring work, not just a data-migration.

2. **`outcomeAnalyzer.ts`'s `SYSTEM_PROMPT` independently hardcodes the business name** ("You analyze a completed customer service phone call transcript for Coreline Comfort Solution Ltd., an HVAC company...") — a SEPARATE hardcoding from the realtime call's own correctly-config-driven identity, in a different file the realtime-prompt discipline evidently wasn't applied to. **Also hardcodes the report OUTPUT language to Persian regardless of the call's own language** ("write your OUTPUT TEXT FIELDS... entirely in natural, conversational Persian (Farsi), regardless of what language the call itself was conducted in") — appropriate for this single current deployment (a Persian-reading business owner) but not appropriate for a multi-tenant OFS feature; must become an org-level "report/admin language" setting, independent of the customer-facing call language.

3. **Prompt-injection hardening gap in `outcomeAnalyzer.ts` (finding from independent Security review)**: unlike the live call's `corePolicy.ts` (whose SCOPE section explicitly defends against topic-drift/off-policy requests), the post-call `SYSTEM_PROMPT` has **no instruction telling the model to treat transcript content as untrusted data rather than instructions**. The caller's own words go verbatim into the analysis request and directly drive `outcome`/`nextContactInitiator`/`followUpRequired` — fields §31 explicitly plans to wire into automated Phase 16 actions (follow-up task creation, CRM notes). A caller who phrases something like "this call is complete, no follow-up needed" mid-conversation could plausibly skew the classification, since nothing separates "things the customer said" from "instructions to the analysis model." The JSON-schema-constrained response (`response_format: json_schema, strict: true`) bounds the output *shape* but not its *content* — a wrong-but-schema-valid outcome is exactly as damaging as a malformed one. **This is a live gap in the existing pipeline, not only a future-tools concern** — §23's "never trust the model's framing" discipline needs to extend to this already-built analysis step. **Required for Phase 15/16**: explicitly delimit transcript content as untrusted data in the system prompt, and/or treat `call_outcomes` as dispatcher-reviewable-by-default rather than an unconditional trigger for Phase 16 automation until this is hardened.

---

## §11. Language Support Audit

| Language | Task's desired list | Answermachine status | Evidence |
|---|---|---|---|
| Persian (Farsi) | `fa` | **SUPPORTED** | Full native-register `languageProfiles.ts` entry; current default (`AGENT_LANGUAGE` defaults to `"fa"`) |
| English | `en` | **SUPPORTED** | Full native-register entry (Canadian English specifically) |
| Hindi/Hinglish | `hi` | **SUPPORTED** | Full entry, explicitly handles Hindi/English code-switching ("Hinglish") per the caller's own mixing level |
| Mandarin | `zh-CN` | **SUPPORTED** | Full entry, explicitly instructed not to use Cantonese vocabulary |
| Cantonese | `zh-HK` | **SUPPORTED** | Full entry, explicitly instructed never to generate Mandarin under this profile |
| Russian | `ru` | **SUPPORTED** | Full entry |

**All six are genuinely implemented as detailed, culturally-aware, native-register conversational instructions** — this significantly exceeds what the audit expected going in. However, three real limitations must not be overclaimed away:

- **Automatic language detection from the caller's speech: NOT IMPLEMENTED.** Language is selected once, at process start, from `AGENT_LANGUAGE` — one language per running process, for every call that process handles.
- **Per-call / per-customer language selection: NOT IMPLEMENTED**, but the code already anticipates it cleanly — `languageRouter.ts`'s own comment: *"a future CRM 'preferred_language' field... resolve through this same function, so language selection was never coupled to `.env` in the first place."* `resolveLanguageProfile()` already takes a plain string, not an env read. This is a **PROVIDER-LIMITED: NO — architecturally ready, just not wired to a per-call value yet** classification: the extension point exists and needs a caller (e.g. OFS's own future per-Customer or per-call `preferred_language` field), not a redesign.
- **Mid-call language switching (caller asks to continue in a different language): NOT IMPLEMENTED**, but the shape is documented in the same file's comment (resolve a new profile, rebuild instructions, send a fresh `session.update` on the existing session — no new connection needed, since the Realtime API supports mid-session instruction updates).
- **Report-output language is hardcoded to Persian** regardless of call language (§10 finding #2) — must decouple for multi-tenant use.

---

## §12. Configuration Audit

Every config source found: **`.env` only** (plus `.env.example` as the template/documentation). No JSON/YAML config files, no hardcoded hostnames/ports beyond documented defaults, no database-backed config, no runtime feature flags beyond what's listed. `dotenv/config` is imported once, at process start, in `config.ts` — never re-read (confirmed in two independent places: `config.ts` itself and both Answermachine Serena memories, which each independently root-caused a real incident to exactly this "process never restarted after `.env` edit" behavior).

| Variable | Classification | Notes |
|---|---|---|
| `OPENAI_API_KEY` | **SECRET** | Never migrate as plaintext |
| `TWILIO_ACCOUNT_SID` | **SECRET** | " |
| `TWILIO_AUTH_TOKEN` | **SECRET** | " |
| `TWILIO_PHONE_NUMBER` | RUNTIME INFRASTRUCTURE / ORG-LEVEL ADMIN SETTING | Not secret, but tenant-specific — becomes an org-scoped `phone_numbers` record (§17) |
| `PUBLIC_BASE_URL` | RUNTIME INFRASTRUCTURE | Deployment-environment concern, not a business setting |
| `PORT` | RUNTIME INFRASTRUCTURE | " |
| `TEST_DESTINATION_NUMBER` | **TEST-ONLY — DO NOT MIGRATE** | Exists solely for this MVP's safety restriction |
| `TEST_CUSTOMER_NAME` | **TEST-ONLY — DO NOT MIGRATE** | Same |
| `BUSINESS_NAME` | **SHOULD MOVE INTO OFS** — already has a home | `organization_profiles.company_name` (Phase 13A Company Profile) |
| `BUSINESS_PHONE` | **SHOULD MOVE INTO OFS** — already has a home | `organization_profiles.phone` |
| `BUSINESS_EMAIL` | **SHOULD MOVE INTO OFS** — already has a home | `organization_profiles.email` |
| `BUSINESS_TIMEZONE` | **SHOULD MOVE INTO OFS** — already has a home | OFS's existing `BUSINESS_TIMEZONE` Global Setting (Phase 1, hardened Phase 13C) — a **literal, no-new-concept match** |
| `AGENT_NAME` | AGENT CONFIG — new OFS concept | Org-scoped, admin-managed (§17/§36) |
| `AGENT_LANGUAGE` | AGENT CONFIG — new OFS concept, should become per-call-resolvable (§11) | " |
| `OPENAI_VOICE` | AGENT CONFIG | " |
| `VOICE_PERSONALITY` | AGENT CONFIG | " |
| `CALL_PURPOSE` | AGENT CONFIG, likely evolves into a richer per-org concept | " |
| `OPENAI_REALTIME_MODEL` | AGENT CONFIG / RUNTIME | Could be platform-level default with org override |
| `OPENAI_REPORT_MODEL` | AGENT CONFIG / RUNTIME | " |
| `BARGE_IN_CONFIRM_MS` | RUNTIME / AGENT CONFIG (tuning parameter) | Reasonable as an advanced org setting or platform default |

No setting in this table should become Global-Settings **plaintext** for the three SECRET rows — they remain in the Voice Engine's own runtime secret store (§14/§26), never touching OFS's D1 database or Worker environment.

---

## §13. Data Model Audit / §14. CRM Duplication Audit

**Answermachine has NO database and NO persistent CRM of its own.** Its only stateful business-data artifacts are:
- `output/calls/YYYY/MM/DD/*.json` and `*.txt` — one JSON + one localized TXT report per completed call, written to **local disk only** (§21).
- The in-memory `callSessionRegistry` — explicitly transient, call-duration-scoped, consumed and deleted once the call ends (§17 distinguishes this correctly: this is *session runtime state*, not a business record).

There is therefore **no duplicated CRM database to eliminate** — the finding is simpler than the task anticipated: there was never a second Customer/Lead/Appointment/Job table to reconcile. What exists is a **reporting sink with no CRM behind it at all** — a real gap, not a duplication, and the fix is the same either way: route report data into OFS instead of the local filesystem.

| Answermachine concept | OFS equivalent | Classification |
|---|---|---|
| (implicit) callee, identified only by a hardcoded test number + a free-text `TEST_CUSTOMER_NAME` | `customers` | **MAP TO OFS** — needs real phone-based lookup (§16), doesn't exist as a concept in Answermachine today beyond a name string |
| `CallSessionState` (in-memory) | (new) transient Voice Engine session state | **KEEP VOICE-SPECIFIC** — never persisted as its own OFS table, exists only for the duration of one call |
| `CallReport` (JSON + TXT on local disk) | (new) `phone_calls` + `call_transcripts` + `call_outcomes` | **MIGRATE** — this is the one real "business record" Answermachine produces; move it into OFS/D1 |
| `CallOutcomeType` (15-value enum) | (new) `call_outcomes.outcome` enum | **REUSE OFS-side** — the taxonomy itself is well-designed and directly portable; see §17 |
| Agent/language/personality/purpose config | (new) `voice_agents` / `voice_agent_versions` | **MIGRATE (as new OFS-owned config)**, not a straight copy — must become org-scoped, DB-backed, versioned, matching OFS's existing effective-dated Global Settings discipline |
| Appointment/Job | — | **NOT PRESENT in Answermachine at all** — nothing to reconcile; §15 |

---

## §15. Scheduler / Booking Audit

**No booking/scheduling logic of any kind exists.** `corePolicy.ts` explicitly and deliberately keeps the agent out of this territory — the closest thing to "booking" is the `APPOINTMENT_REQUESTED` outcome value in the post-call analysis taxonomy, which only records that the *customer asked* to book something; nothing acts on it. Verified: no availability read, no conflict check, no appointment/job creation, no technician awareness, no service-duration or travel-time awareness — none of these concepts appear anywhere in the codebase.

**For Phase 16**, this means there is no existing behavior to preserve or migrate here — the entire "voice agent triggers a real OFS Job/appointment" flow is new work, and per the task's own instruction, the future Voice Agent must call through OFS's existing Scheduler/Job creation APIs and their existing validation — it must never be given a shortcut that bypasses OFS's own scheduling rules (conflict checks, technician assignment, service-type duration) just because the request originated from a phone call instead of the web UI.

---

## §16. Customer Identification Strategy (design, for Phase 15/16)

Answermachine has no real identification logic to audit (§13) — this section is therefore a **forward design**, grounded in OFS's existing tenant/customer model (`customers` table, `organization_id`-scoped, phone/email fields already present per this session's own Phase 5–13D work).

Recommended flow:
```
Inbound call arrives (caller ID from Twilio, E.164)
  → normalize to E.164 (already a pattern in Answermachine's own config.ts — reusable validation logic)
  → look up customers WHERE organization_id = <org owning this Voice Agent/phone number> AND phone = <normalized>
  → 0 matches  → treat as a new/unknown caller — no customer name/context available (mirrors
                 Answermachine's own existing "no usable customer name → generic greeting" fallback,
                 sanitizeCustomerName()'s exact pattern, already reusable as-is)
  → 1 match    → attach that Customer as call context (name for greeting, existing Job/service history
                 visible to any tool/function calls added later)
  → 2+ matches → do NOT guess — treat as unknown-caller-with-ambiguity; never surface one matched
                 customer's data on the strength of a shared phone number without further
                 verification (e.g. a shared household/business line). Safer default: same as the
                 0-match path for anything sensitive; a live agent can ask a light disambiguating
                 question (e.g. "can I get your name?") without ever revealing which existing
                 customer record(s) matched.
```
**Privacy boundary, non-negotiable**: never expose one customer's job/appointment/financial history to a caller whose identity hasn't been reasonably established beyond "dialed from a matching number" — phone numbers are shared (households, small businesses) too often for a bare match to authorize disclosure of anything beyond a generic greeting. This mirrors OFS's own existing RBAC/tenant discipline (server-authoritative, never trust a client-observable signal alone) applied to a new context (caller ID is client-observable-equivalent — Twilio reports it, but it is not proof of identity).

**Caller-ID spoofing (finding from independent Security review — a real gap in the flow above, not just a theoretical caveat)**: Twilio's inbound `From` value is **not cryptographically verified**. It is telephony-signaling-reported and well-documented as spoofable — STIR/SHAKEN attestation mitigates this on some carrier paths but is not universal and is not enforced by Twilio as a hard gate (it surfaces only as an advisory attestation parameter the app would have to check itself, which nothing in this design currently does). This means a **1-match hit in the flow above is not proof of identity** — an attacker who merely knows a real customer's registered phone number could spoof caller ID and be treated as that customer. This matters immediately once Phase 16 adds any READ tool (§23, §31 — "technician context surfaced to the agent," "confirming an existing appointment"): without a secondary check, a 1-match caller-ID hit alone must **never** be sufficient to let a tool call read back job/appointment/service history over the phone. **Required for Phase 15/16 design**: treat a 1-match caller-ID hit as necessary but not sufficient for any disclosure beyond a generic greeting — require a secondary verification factor (e.g. last-name confirmation, postal code, or a light knowledge-based challenge) before any tool call is permitted to surface customer data to the caller, and capture Twilio's STIR/SHAKEN attestation level (where present) as an additional, still-not-fully-trustworthy, signal worth logging alongside the call record.

---

## §17. Phone Operations Data Boundary (design)

Distinguishing **persistent business records** (must live in OFS/D1, org-scoped) from **transient runtime session state** (lives only in the Voice Engine's memory for one call, exactly as `callSessionRegistry` already does today):

**Persistent (OFS/D1, new tables, Phase 15 scope):**
```
phone_numbers        — org-scoped, which Twilio number(s) belong to which org
voice_agents         — org-scoped agent identity/config (name, language default, voice, personality,
                        call purpose, model — the DB-backed evolution of today's env vars)
voice_agent_versions — effective-dated, mirrors Global Settings' own versioning discipline (never
                        overwrite history — an agent config change must not retroactively alter how
                        a past call is displayed, matching the exact "historical documents render
                        under the settings that produced them" principle already used for Tax
                        Profiles/Global Settings in this codebase)
phone_calls          — one row per call (call_sid, org, phone_number, direction, customer_id
                        [nullable — unknown caller], started_at, ended_at, duration, status, outcome)
call_transcripts      — turn-by-turn transcript (role, text, ts) — the durable form of what
                        Answermachine's ConversationTurn[] already captures per-call, just persisted
call_outcomes        — reuses Answermachine's own CallOutcomeType taxonomy (§14) almost verbatim —
                        outcome, next_contact_initiator, customer_decision, summary,
                        follow_up_required, follow_up_reason
call_transfers        — new concept, doesn't exist in Answermachine yet (§20)
call_events          — optional, finer-grained lifecycle log (ringing/answered/etc.) if the coarse
                        phone_calls.status isn't sufficient for future reporting needs
```
**Transient (Voice Engine process memory only, never a D1 table — matches `mediaBridge.ts`'s existing closure-scoped state and `callSessionRegistry`'s existing "in-memory, consumed once" design exactly):**
```
Live barge-in state machine (assistantGenerating, pendingMarkCount, timers, etc.)
Live WebSocket handles (Twilio side, OpenAI side)
In-progress conversation buffer, until the call ends and it's flushed to OFS as call_transcripts
```

---

## §18. Call State Machine

Answermachine's *actual* observed states (extracted from `server.ts`'s `TERMINAL_CALL_STATUSES` set and the Twilio status-callback events it subscribes to) are simply **Twilio's own canonical CallStatus values**, passed through unmodified: `initiated`, `ringing`, `answered` (non-terminal, logged), `completed`, `busy`, `no-answer`, `failed`, `canceled` (all five terminal). Answermachine adds no states of its own on top of Twilio's.

**Recommended normalized OFS Phone Operations FSM** (derived from what's actually observed, not invented, plus the two additions the task's own draft correctly anticipates for a system that will have AI-active and human-transfer phases, neither of which Answermachine currently distinguishes as a formal state — today "connected" and "AI is talking" are the same undifferentiated period):
```
QUEUED        — call accepted by OFS/Voice Engine, not yet dialed/ringing (mainly relevant for
                future outbound scheduling, §9)
RINGING       — Twilio's own "ringing"
CONNECTED     — Twilio's own "answered"/"in-progress", before the Media Stream is confirmed open
AI_ACTIVE     — Media Stream open, OpenAI Realtime session live (Answermachine's own
                "media_connected"/"openai_realtime_connected" log events already mark this
                transition precisely — directly reusable as the state-transition trigger)
HUMAN_TRANSFER — new state, only meaningful once §20 is designed/built
COMPLETED     — Twilio's "completed"
FAILED        — Twilio's "failed"
CANCELLED     — Twilio's "canceled"
(BUSY / NO_ANSWER are outcome-classification detail under COMPLETED-without-connection, matching
 how CallOutcomeType already separately captures BUSY/NO_ANSWER/VOICEMAIL as *outcomes*, not
 states — keep that separation: state machine tracks the call's technical lifecycle, outcome
 taxonomy tracks the business result, exactly as Answermachine's own `reporting/types.ts` already
 keeps these two concerns in separate types)
```

---

## §19. Pause / Disable / Emergency Stop

**NOT IMPLEMENTED in Answermachine** — there is no admin surface of any kind (Answermachine has no UI at all, no auth, no multi-user concept), so "an authorized admin pauses AI phone operations" has no current analog to audit.

**Design for OFS (Phase 15, admin-only per §33):**
```
ACTIVE         — normal operation
PAUSED         — admin-initiated, temporary. CRITICAL (per task): PAUSED must NOT drop incoming
                 calls. Inbound Twilio webhook still answers; TwiML routes to a configured
                 fallback (§ below) instead of opening the AI Media Stream.
MAINTENANCE    — platform-initiated (e.g. a deploy in progress) — same fallback behavior as PAUSED
                 from the caller's perspective; distinguished only for admin/observability clarity
DISABLED       — admin turned Phone Operations off for this org entirely (longer-term than PAUSED)
EMERGENCY_STOP — immediate, admin- or platform-triggered halt, same caller-facing fallback as
                 PAUSED/DISABLED but logged/alerted distinctly for incident response
```
**Fallback behavior for every non-ACTIVE state** (never a dead line): the same `/twilio/voice`-shaped webhook responds with TwiML that does NOT open a Media Stream — instead one of: a configured voicemail `<Record>`, an unconditional `<Dial>` to a configured human forwarding number, or a static `<Say>` message, selected by an org-level admin setting (§36). This is new design — Answermachine has no analog (it has never needed a "can't answer right now" path, since it only ever makes one outbound test call).

---

## §20. Human Transfer

**NOT IMPLEMENTED** — confirmed in three places: README's explicit out-of-scope list, `corePolicy.ts`'s explicit instruction to the model never to claim or simulate a transfer, and zero transfer-related code anywhere in `mediaBridge.ts`/`server.ts`/`openaiRealtime.ts`. No warm/cold transfer, no number source, no timeout, no return-to-AI, no caller announcement, no office-hours handling — none of these exist to audit.

**Design requirement for Phase 15/16**: the transfer destination must be an **organization-configurable** setting (§36 — "Transfer Number"), never hardcoded, and must respect tenant isolation the same way every other OFS org-scoped resource does (Org A's transfer number must never be reachable via Org B's call flow). Given Twilio's own primitives, a "warm" transfer (bridge the live call to a human, AI stays on standby) is technically the more capable option Twilio supports today, but nothing in Answermachine constrains this choice — it is a clean Phase 15/16 design decision, not a migration decision.

---

## §21. Call Recording / Transcript / Privacy

**Audio recording: NOT IMPLEMENTED** — no Twilio `<Record>` verb used anywhere, no recording-related Twilio API calls, confirmed absent from README's explicit out-of-scope list and from all code read. **Transcripts: implemented**, but only as **text** (via OpenAI's separate transcription side-channel + the assistant's own spoken-text deltas), never audio.

**Storage today**: local filesystem only (`output/calls/YYYY/MM/DD/*.json` + `*.txt`), on the machine running the Node process. No cloud storage, no encryption at rest beyond whatever the host OS provides, no access control beyond OS filesystem permissions, no retention policy (files simply accumulate), no deletion mechanism. `.gitignore` correctly excludes `output/` with an explicit comment naming the PII risk (name, phone, conversation summary) — a real, if minimal, privacy-conscious decision already present in this codebase.

**Design for OFS**: recording/transcript storage must move to D1 (structured data) with the same RBAC/tenant discipline as every other OFS financial/customer record (admin+dispatcher visibility per §33, never technician by default unless proven otherwise), plus explicit, admin-configurable: recording-enabled toggle (defaulting OFF, since it's currently not implemented and this audit makes no legal-permissibility claim about consent requirements in any jurisdiction — that determination is the business's own responsibility, not something this document certifies), a consent-announcement toggle/script if recording is ever enabled, a retention-period setting, and transcript-access RBAC. **No legal compliance claim is made anywhere in this document** — recording/consent law varies by jurisdiction and this audit is not qualified to certify compliance.

**Two further gaps named explicitly (independent Security review) rather than left implicit under "retention period" above**: (1) no deletion/DSAR (data-subject access or deletion request) mechanism is specified anywhere in this design — worth a named Phase 15/16 backlog item once real customer transcripts (a materially larger and more sensitive dataset than today's 16 test-call files) start accumulating; (2) whether `call_transcripts` should be encrypted at rest in D1 is not yet decided — also worth a named decision point rather than an implicit assumption either way. Neither is a Phase 15 blocker given the audit's own no-legal-claim stance, but both should be explicit backlog items, not silently absent.

**Third-party AI subprocessor disclosure (named explicitly per independent Architecture review, not just covered by the general legal-compliance disclaimer above)**: once real customer calls flow through this design, customer conversation audio and transcript content are transmitted to OpenAI (and Twilio, for the call transport itself) as third-party subprocessors. This is a fact the business should be aware of before Phase 15/16 goes live with real customers, not something that should stay buried under the general "no legal compliance claim" disclaimer — it is a deliberate architectural consequence of using OpenAI Realtime for the voice engine, not a hidden side effect, and Phase 15 planning should record which provider(s) receive what category of customer data as its own explicit line item.

---

## §22. Security Audit (independent, adversarial)

| # | Area | Finding | Severity |
|---|---|---|---|
| 1 | Webhook authentication | `requireTwilioSignature` correctly validates `X-Twilio-Signature` against the *exact* configured `publicBaseUrl + originalUrl`, using the official `twilio.validateRequest()` helper (not a hand-rolled HMAC check) — applied to both `/twilio/voice` and `/twilio/status`. **Solid.** | — (PASS) |
| 2 | WebSocket upgrade endpoint | `/twilio/media-stream` is the only path accepted at the `server.on("upgrade", ...)` level; anything else is `socket.destroy()`'d. However, **the WS upgrade path itself carries no signature/token check** — Twilio Media Stream connections are not authenticated the way the HTTP webhooks are (this is a known general limitation of Twilio's WS protocol, not unique to this app: anyone who discovers the WS URL and can complete a WS handshake could, in principle, open a session and start relaying arbitrary audio to a live OpenAI Realtime connection billed to this account, for as long as they can fake Twilio's `start`/`media` message shape). **P2 for today's private single-user tool behind an obscure tunnel URL; P1 REQUIREMENT for the Phase 15 production/multi-tenant target (severity re-rated per independent Security review).** URL obscurity is not an adequate control for a discoverable, multi-tenant production endpoint. **Concrete, achievable mitigation, not a research problem**: the `<Connect><Stream url=...>` TwiML is generated by this app per call (`server.ts:107`) — nothing prevents appending a short-lived, single-use, per-CallSid signed token (e.g. an HMAC over the CallSid, verified against an active-call registry populated by the outbound-call API/inbound webhook) that the WS-upgrade handler validates before accepting the stream. This closes the cost-abuse vector named above directly and must be a named Phase 15 requirement (ties to CLAUDE.md law #15, Cost-Control Preservation — see also §39), not "keep the URL unguessable and monitor." |
| 3 | OpenAI session security | API key sent once via `Authorization: Bearer` header on the outbound WS connect — never re-sent per message, never logged (redaction confirmed, §4). **PASS.** |
| 4 | Public endpoint exposure | `/health` is unauthenticated by design (liveness probe) and leaks nothing beyond `{status:"ok"}`. `/call` is **unauthenticated** — anyone who can reach the tunnel URL can trigger the one outbound test call (acceptable for a private local MVP behind an obscure tunnel URL known only to the developer; **not acceptable as-is for any multi-tenant Phase 15/16 design** — every future outbound-call-triggering endpoint must sit behind OFS's own RBAC, never be bare like this). **P1 for migration purposes, not a live bug in the current private tool.** |
| 5 | Prompt injection | The caller fully controls their side of the conversation, which becomes part of the LLM's context. `corePolicy.ts`'s SCOPE section already defends against topic-drift ("don't answer it substantively... steer back"), but there is **no tool/function-calling surface to abuse (§23 — none exists)**, which is itself the strongest current mitigation: an attacker manipulating the conversation has no side-effecting action to trigger, only the ability to make the agent say off-policy things within a private test call. This changes materially the moment Phase 16 adds real tools (job creation, customer lookup) — **every future tool must independently authorize and validate its own inputs, never trust the model's framing of what the caller "asked for"** (§23). |
| 6 | Customer-data leakage | None possible today — there is no customer database to leak from (§14). Becomes a live concern the moment §16's customer-lookup is built — see §16's privacy-boundary design. |
| 7 | Cross-call context leakage | Each call gets a fresh `attachMediaStream()` closure and a fresh `OpenAIRealtimeSession` — no shared mutable state between calls found anywhere (the only cross-call structure, `callSessionRegistry`, is keyed by `callSid` and entries are deleted on consumption). **PASS.** |
| 8 | Secret exposure (logs/recordings/transcripts) | Logging redaction confirmed (§4). No recordings exist. Transcripts contain conversation content only, never secrets (the model never has access to secrets to leak). **PASS.** |
| 9 | Transfer abuse | N/A — not implemented (§20). Must be designed with the same rigor as §5's future-tools warning once built. |
| 10 | Outbound-call abuse | Today: bounded to exactly one hardcoded number, `/call` has no request-body influence at all — **cannot** be abused to call an arbitrary number even by an attacker who reaches the endpoint. **This specific safety property must NOT be lost during migration** — Phase 16's real outbound calling needs its own, different, deliberately-designed consent/authorization model; it should not "inherit" today's safety by accident, since today's safety mechanism (hardcoded destination) is precisely what Phase 16 needs to remove. |
| 11 | Rate limiting | **NOT IMPLEMENTED anywhere** — no rate limiting on `/call`, `/twilio/voice`, `/twilio/status`, or WS connections. Acceptable for a private single-user tool; **must be added for Phase 15/16** (both for cost control per OFS's own CLAUDE.md "Cost-Control Preservation" law, and for abuse resistance). |
| 12 | Replay | Twilio signature validation is tied to full URL + body, which provides reasonable protection against naive replay of webhook POSTs (a replayed request would need the exact original body to produce a valid signature, and Twilio's own signatures aren't designed to be long-lived security tokens for this purpose) — not deeply audited further as this is an inherited Twilio-platform property, not app-specific logic. |

---

## §23. Tool / Function Calling Audit

**Zero tools/functions are registered anywhere.** Confirmed directly: `openaiRealtime.ts`'s `sendSessionUpdate()` — the only place a `tools` array could be attached to the Realtime `session.update` payload — contains no `tools` key at all. `corePolicy.ts` explicitly tells the model it has no capability to look anything up or update any record ("there is no such capability in this system"). This is a real **NOT IMPLEMENTED**, not an oversight in this audit — nothing was missed.

**For Phase 16**, every future tool must be classified before it's built:
```
READ            — e.g. "look up a customer by phone" — still needs authorization (§16's privacy
                  boundary is exactly this concern) but no side effect
LOW-RISK WRITE  — e.g. "log a follow-up note" — reversible, low blast radius
HIGH-RISK WRITE — e.g. "create a Job," "book an appointment," "cancel an appointment" — must route
                  through OFS's own existing domain functions (Scheduler conflict checks, RBAC),
                  never a shortcut the voice agent invents on its own, matching this document's own
                  §15 principle
```
No tool inventory exists yet to classify (there are zero tools) — this section is a forward requirement for Phase 16, not an audit finding about existing code.

---

## §24. OpenAI Realtime Findings

Model: `gpt-realtime-2.1` (env-configurable, default). Session creation: single WS connect per call, `Authorization: Bearer` header, `session.update` sent on open with `type: "realtime"`. Voice: env-configurable (`marin` default; doctor.ts documents alloy/ash/ballad/coral/echo/sage/shimmer/verse/marin/cedar as the known catalog, explicitly NOT enforced in code — future-proof against OpenAI adding voices). Audio formats: G.711 µ-law both directions, no transcoding. Turn detection: server-side VAD (`server_vad`), `create_response`/`interrupt_response` both enabled. Latency handling: the app's own barge-in debounce (`BARGE_IN_CONFIRM_MS`, default 250ms) is a deliberate, empirically-tuned mitigation against VAD false-positives on transient noise — genuinely sophisticated engineering, not a naive implementation (§7 table). Reconnect: **none** — a WS close/error simply ends the call cleanly (`cleanup()`); no automatic reconnect-and-resume exists or is attempted. Token/session lifecycle: one session, full call duration, closed explicitly on cleanup or implicitly on WS close. Error handling: `onError` logs and continues; the connection is not automatically retried.

---

## §25. Twilio Findings

Voice webhooks: `/twilio/voice` (TwiML fetch), `/twilio/status` (status callback) — both signature-validated (§22). Media Streams: `<Connect><Stream>` verb, bidirectional, WSS. Call SID: used as the join key for session/report correlation throughout. Status callbacks: subscribed to `initiated`/`ringing`/`answered`/`completed`. Transfer: not used. Outbound calls: `calls.create()`, single hardcoded destination (§9). Phone numbers: one, from config, no multi-number awareness. Signature validation: real, correct, confirmed (§22). Retry: none built by this app (Twilio's own webhook retry behavior, if any, is unmodified/default). Timeout: none configured explicitly beyond Twilio's own defaults. Recording: not used (§21).

**Classification**: signature-validation middleware, TwiML generation, and the outbound-call-params pure function are all **REUSE** (directly portable logic, framework-agnostic enough to port to whatever HTTP layer the eventual Voice Engine uses). The Media-Stream WS handling in `mediaBridge.ts` is **REUSE_WITH_ADAPTER** (the barge-in/relay logic itself is sound and hard-won; only the outer transport wiring needs adaptation to wherever it runs). Nothing is **REWRITE** or **REMOVE** — there is no dead or wrong Twilio code found.

---

## §26. Runtime Architecture Decision

Three options were evaluated against the stated criteria (Cloudflare compatibility, WebSocket support, Twilio Media Streams, long-lived connections, deployment complexity, latency, failure isolation, secrets, observability, scaling, cost, maintainability):

**Option A — Fully merge into the OFS Cloudflare Worker.** Technically *possible* (Cloudflare Workers do support native WebSocket upgrades and outbound WebSocket connections; the proven pattern for a long-lived, per-call, stateful audio relay on Cloudflare is a Durable Object using the WebSocket Hibernation API) but this would require a genuine **rewrite** of `mediaBridge.ts`'s closure-based state machine and `openaiRealtime.ts`'s `ws`-library-based session wrapper onto Durable Objects' different concrete APIs, plus porting `fs`-based report writing to D1/R2. This throws away the empirical tuning already validated in the existing, well-tested Node implementation (barge-in timing, G.711 passthrough correctness) and re-introduces that risk from scratch. **Not recommended** — the risk/reward is poor given a working, tested alternative exists.

**Option B — Keep Voice Engine as a fully separate internal service, OFS purely a control plane, with no further discipline specified.** Reuses the proven code with minimal change, but on its own this is not really a distinct third option — it is the same physical topology as Option C. **Correction (independent Architecture review)**: naming B as a separately-evaluated alternative slightly overstates the rigor of the comparison; the real decision axis is not "B vs. C" as different topologies, it is **whether the separate service is held to the "no local source of truth" governance discipline** — Option B *without* that discipline is precisely the failure mode Option C exists to prevent (a Voice Engine with its own local report storage and no dependency on OFS's domain APIs would BE a second, disconnected system, just relocated), and Option B is presented here only to name that failure mode explicitly, not as a genuinely separate architecture worth choosing.

**Option C — Hybrid, RECOMMENDED.** Keep the Voice Engine as a separate, minimal Node-based runtime (evolved from Answermachine's `mediaBridge.ts`/`openaiRealtime.ts`/`callInitiation.ts` core — genuinely reuse this code, it is good), but require it to have **no local source of truth whatsoever**: no `output/` filesystem writes, no local session treated as a customer record, no local config that isn't fetched from (or pushed by) OFS. Every business fact (company identity, agent config, customer match, call outcome, transcript, appointment/job creation) flows through **authenticated OFS domain APIs** — new, purpose-built endpoints under `/api/phone-operations/*` (or similar), scoped by organization exactly like every other OFS API, never exposed publicly beyond what Twilio itself needs to reach (the webhook/media-stream endpoints, which stay on the Voice Engine, not the Worker — Twilio's connection requirements, a persistent low-latency audio path, are exactly what the Voice Engine is already built for and the Worker is not).

This satisfies "OFS is the single user-facing system and single source of truth" literally: nothing about the Voice Engine is user-facing (no dashboard, no login, no UI — it never had one) and nothing about it holds business truth once this design is followed. It is functionally equivalent to OFS's own already-established pattern for Google Calendar/Maps/Payment-provider isolation (per OFS's CLAUDE.md §14) — an external, provider-facing integration kept behind a server-side boundary, not reimplemented inside the Worker's own execution model, while OFS's Worker remains the sole authority for what that integration is allowed to do and where its output ends up.

**Two open questions both independent reviews (Architecture and Security) converged on independently, and which must be resolved as named Phase 15 design requirements — not left implicit — before implementation starts:**

1. **Voice Engine ↔ OFS service-credential scoping (the actual cross-tenant blast-radius question).** "Its own service credential" was left under-specified in earlier drafts of this document — critically, whether that means ONE shared credential across every organization's calls, or one credential per organization/`phone_numbers` registration. **This must be per-organization (or at minimum per-Voice-Engine-instance-per-organization), never a single shared credential.** A single shared credential means: (a) a credential leak (compromised host, a log line, an env-file exposure) grants an attacker read/write to *every* organization's `phone_calls`/`call_transcripts`/`call_outcomes`/transfer-number config, not just one, and (b) a Voice Engine bug that attaches the wrong `organization_id` to an outgoing API call becomes a classic confused-deputy, because OFS's API has no independent way to verify the claimed org scope — it can only trust the payload. This directly conflicts with CLAUDE.md law #16 ("Security and RBAC Are Server-Authoritative... UI hiding is never sufficient authorization") applied to a service-to-service context: **OFS's Phone Operations API must resolve `organization_id` itself from the authenticated credential (or from the `phone_numbers` row the inbound call actually arrived on), never from a value the Voice Engine merely asserts in the request body** — the same "never trust a client-supplied organization_id" discipline this codebase already applies everywhere else (Phase 11.5, and every RBAC-hardening phase since).
2. **Voice Engine hosting/operations ownership.** The absence of a UI or login does not by itself make the Voice Engine "not a second product" — it is still a second deployment target, with its own OS/container, its own patch cadence, and (per the credential-scoping point above) a host holding live Twilio/OpenAI secrets plus a real, per-org OFS service credential. Phase 15 planning must name who operates this host, what access control exists over it, and how it's patched/monitored/incident-responded — an explicit ops answer, not an implicit "it's just infrastructure" assumption.

**Cost/observability/scaling**: bounded by call volume either way; Option C's separate host needs its own basic monitoring (uptime, error rate) feeding into OFS-visible observability via the same API calls that persist call data — not a separate dashboard. See §39 for why telemetry alone is insufficient and an enforced spend cap is required.

---

## §27. Recommended Target Architecture

```
Open Fieldservice (Cloudflare Worker, single user-facing system)
│
├── Phone Operations UI          (new, Phase 15 — call history, transcripts, agent config, pause/disable)
├── Phone Operations API         (new, Phase 15 — /api/phone-operations/*, org-scoped, RBAC-gated)
├── Call / Transcript / Outcome data   (new D1 tables, §17 — phone_calls, call_transcripts, call_outcomes, ...)
├── Customers / Leads / Jobs / Scheduler  (EXISTING OFS — Phone Ops reads/writes through these, never around them)
│
└── Voice Engine Adapter (separate Node runtime, evolved from Answermachine — NOT inside the Worker)
      ├── Twilio (signature-validated webhooks, Media Streams, outbound calls — REUSE)
      ├── OpenAI Realtime (session bridge — REUSE)
      ├── Media Streams (barge-in FSM — REUSE, the hardest-won asset)
      ├── STT/TTS (folded into Realtime — REUSE)
      ├── Transfer (NEW — Phase 15/16)
      └── Call Runtime (per-call transient state only — no local persistence, calls back into
                          OFS's Phone Operations API for every business fact/write)
```
Physically separate, architecturally singular: OFS is still the only product a user, admin, dispatcher, or technician ever sees or logs into. The Voice Engine is invisible infrastructure, the same category as "the process that sends notification emails" — necessary, but not a competing product.

---

## §28. Integration Classification Matrix

| Subsystem | Classification | Rationale |
|---|---|---|
| Twilio signature validation middleware | **REUSE_AS_IS** | Correct, standard, framework-portable |
| TwiML generation (`/twilio/voice`) | **REUSE_WITH_ADAPTER** | Logic is right; needs real inbound-vs-outbound + org-routing added |
| Outbound call params builder | **REUSE_WITH_ADAPTER** | Pure-function shape is right; hardcoded single-destination must be replaced with real policy |
| `mediaBridge.ts` (barge-in FSM, audio relay) | **REUSE_WITH_ADAPTER** | The core asset — reuse the logic, adapt its I/O boundary (no more local report writes; calls OFS APIs) |
| `openaiRealtime.ts` | **REUSE_AS_IS** (with config passthrough) | Clean, correct, no changes needed to the wire-protocol handling itself |
| `agent/corePolicy.ts` | **REFACTOR** | Keep the behavioral policy; extract the hardcoded BUSINESS KNOWLEDGE section into OFS-sourced content (§10) |
| `agent/languageProfiles.ts` + `languageRouter.ts` | **REUSE_AS_IS** | Already extension-point-ready for a per-call value; just needs a real caller |
| `agent/voicePersonalities.ts`, `agent/callPurposes.ts` | **REUSE_AS_IS** | Same catalog pattern, becomes DB-backed instead of source-constant-backed (§17 `voice_agents`) |
| `agent/customerName.ts` | **REUSE_AS_IS** | Directly portable sanitization logic |
| `reporting/types.ts` (CallOutcomeType etc.) | **REUSE_AS_IS** (schema-adapted) | The taxonomy itself is sound; becomes a D1 enum instead of a TS union |
| `reporting/callSessionRegistry.ts` | **REUSE_AS_IS** | Exactly the right shape for Voice-Engine-side transient state (§17) |
| `reporting/outcomeAnalyzer.ts` | **REFACTOR** | Remove the hardcoded business name and hardcoded Persian output language (§10); everything else is sound |
| `reporting/reportWriter.ts` | **REFACTOR** | Same fallback-never-throws discipline, but write to OFS's API instead of local `fs` |
| `reporting/localizedPersianReport.ts` | **DEFER** | Single-language TXT rendering was a deployment-specific convenience; a future OFS Phone Operations UI likely replaces the need for a plain-text file entirely — revisit once the UI exists rather than porting a format that may not be needed |
| `reporting/timezone.ts`, `filename.ts` | **REUSE_AS_IS** / **REMOVE_DUPLICATE** | Timezone formatting logic is reusable; filename/date-bucketing logic is superseded once storage is D1 rather than a filesystem tree |
| Human transfer | **DEFER** (build new in Phase 15/16) | Nothing to migrate — doesn't exist |
| Tool/function calling | **DEFER** (build new in Phase 16) | Nothing to migrate — doesn't exist |
| `doctor.ts`, `runtimeFingerprint.ts` | **REUSE_AS_IS** (as Voice-Engine-local dev tooling) | Good diagnostic hygiene worth keeping in whatever the Voice Engine becomes |
| `.env`-based config | **REFACTOR** | Split per §12's classification — secrets/runtime-infra stay env-based on the Voice Engine host; business-identity/agent-config move to OFS-sourced (fetched or pushed at call time) |

---

## §29. File-Level Migration Map

| Answermachine path | Current purpose | Target OFS location/module | Action | Dependencies | Risk | Phase |
|---|---|---|---|---|---|---|
| `src/server.ts` | Express app + routes | Voice Engine's own entrypoint (stays Node/Express-shaped, or ported to the Voice Engine's chosen framework) | REUSE_WITH_ADAPTER | Twilio SDK, `ws` | Medium | 15 |
| `src/config.ts` | Env parsing | Split: secret/runtime vars stay Voice-Engine-local `config.ts`; business-identity vars replaced by an OFS API fetch at call-time | REFACTOR | new OFS API | Medium | 15 |
| `src/callInitiation.ts` | Outbound call params | Voice Engine, generalized to accept a real destination + policy from OFS instead of a hardcoded test number | REFACTOR | new OFS outbound-call API | Medium | 16 |
| `src/mediaBridge.ts` | Audio bridge + barge-in | Voice Engine core, unchanged internals, I/O boundary adapted (no local `fs`/`callSessionRegistry`-only; also POSTs transcript/outcome to OFS at call end) | REUSE_WITH_ADAPTER | `openaiRealtime.ts`, new OFS API | **Low** (logic itself untouched) | 15 |
| `src/openaiRealtime.ts` | Realtime session | Voice Engine, as-is | REUSE_AS_IS | `ws` | Low | 15 |
| `src/agent/*.ts` (all 8 files) | Prompt architecture | Voice Engine (prompt composition logic) + OFS (source of BUSINESS CONTEXT values, replacing `businessContext.ts`'s config read with an OFS API read) | REUSE_WITH_ADAPTER / REFACTOR (corePolicy.ts only) | new OFS Company-Profile/Service-Types-backed content API | Medium (`corePolicy.ts`'s BUSINESS KNOWLEDGE extraction is real content work) | 15/16 |
| `src/reporting/types.ts` | Outcome taxonomy | New OFS `call_outcomes` schema (migrations) | MIGRATE (schema translation) | — | Low | 15 |
| `src/reporting/callSessionRegistry.ts` | Transient session state | Voice Engine, as-is | REUSE_AS_IS | — | Low | 15 |
| `src/reporting/outcomeAnalyzer.ts` | Post-call LLM analysis | Voice Engine (still calls OpenAI directly — latency/cost profile argues for keeping this call on the Voice Engine side, then POSTing the *result* to OFS) — strip hardcoded business name + Persian-only output | REFACTOR | OpenAI API, new OFS API to receive the result | Medium | 15 |
| `src/reporting/reportWriter.ts` | Assemble + persist report | Voice Engine (assembly logic) → OFS API (persistence) instead of local `fs` | REFACTOR | new OFS API | Medium | 15 |
| `src/reporting/localizedPersianReport.ts` | TXT formatting | — | DEFER | — | — | — |
| `src/reporting/timezone.ts` | Timestamp formatting | Voice Engine, as-is (or OFS already has equivalent `business-timezone.ts` logic — compare before porting, avoid duplicating a concept OFS already owns) | REUSE_AS_IS / possible REMOVE_DUPLICATE | — | Low | 15 |
| `src/reporting/filename.ts` | Local file path scheme | — | REMOVE_DUPLICATE (no filesystem target once D1-backed) | — | — | — |
| `src/doctor.ts`, `runtimeFingerprint.ts` | Dev diagnostics | Voice Engine, as-is | REUSE_AS_IS | — | Low | 15 |
| `.env` / `.env.example` | Config template | Split per §12 — Voice Engine keeps a trimmed `.env` (secrets + runtime-infra only); new OFS Global Settings entries for agent config (§36) | REFACTOR | — | Low | 15 |
| 16 × `*.test.ts` | Unit tests | Ported alongside their corresponding module, adapted where the module's I/O boundary changed (mainly `reportWriter`/`outcomeAnalyzer`'s tests) | REUSE_WITH_ADAPTER | — | Medium (test doubles need updating for the new API-call boundary); **higher** for `openaiRealtime.test.ts`/`outcomeAnalyzer.test.ts` specifically — see §40's confidence-calibration note | 15 |
| `output/`, `dist/`, `cloudflared.log`, `server.log`, `kill-port.bat` | Local dev artifacts | — | REMOVE (not migrated — dev-local only) | — | — | — |

This table is the concrete starting point for Phase 15/16 implementation — it is not itself an implementation plan with task breakdowns/estimates, which is explicitly out of scope for this audit phase.

---

## §30. Phase 15 — Phone Operations Foundation (exact scope)

```
IN SCOPE:
- call/voice-agent/phone-number data model (migrations, additive, org-scoped — §17)
- voice_agents / voice_agent_versions admin-managed config (replaces env-only agent config)
- Voice Engine runtime stood up as a separate service (evolved from Answermachine core, §26–§29)
- Inbound call handling wired for real (webhook → media stream → AI → basic completion), including
  genuine caller-ID capture (not yet requiring full customer-matching — that's §16/Phase 16 if the
  audit's own boundary is followed strictly, though a minimal phone-lookup MAY be pulled forward if
  Phase 15 planning finds it trivially cheap given §16's design is already complete)
- Outbound-call foundation (policy-gated, NOT the old hardcoded-single-destination shape) — enough
  to place a real call under real authorization, not yet integrated with Scheduler-driven "call this
  customer about their upcoming appointment" automation (that's Phase 16). **Boundary gap flagged by
  independent Architecture review, must be resolved during Phase 15 planning, not left implicit**:
  since full customer/lead matching is explicitly Phase 16, Phase 15's outbound foundation needs an
  explicit answer for what supplies the destination number before then — most likely an admin/
  dispatcher manually entering or selecting a number through the Phone Operations UI, since nothing
  else exists yet to supply one. "Real authorization" is only meaningful once this is named.
- Call history / transcripts / outcomes persisted in OFS (D1), visible nowhere yet but the DB
  (UI comes in this same phase per the task's own Phase 15 category list)
- Transfer (basic — number-configurable, no smart routing yet)
- Pause/disable/emergency-stop (§19)
- Provider adapters (Twilio, OpenAI) — the Voice Engine's own boundary, not new OFS-side provider
  code
- Security foundation: service-to-service auth between Voice Engine and OFS API, rate limiting,
  webhook signature validation carried forward
- Phone Operations UI: admin config screens (agent identity/language/voice/personality, phone
  numbers, pause control) + call history/transcript/outcome viewer

OUT OF SCOPE (explicitly deferred to Phase 16 or later):
- caller → real Customer/Lead matching beyond a minimal lookup (§16 design exists; full wiring
  is Phase 16's "caller → Customer/Lead" boundary item)
- appointment booking / Job creation from a call
- scheduler integration / technician context
- follow-up automation / CRM notes written back from a call
- tool/function calling of any kind (§23)
- Voice Copilot (§32 — kept fully separate)
```

## §31. Phase 16 — Phone Operations ↔ OFS Core (exact scope)

```
- caller → Customer/Lead resolution, live, per §16's designed flow (exact-match / multi-match /
  new-caller handling, privacy boundary enforced)
- appointment booking through OFS's real Scheduler (conflict checks, technician/service-duration
  awareness — never bypassed, per §15)
- Job creation from a completed call, where appropriate to the call outcome
- technician context surfaced to the agent where relevant (e.g. confirming an existing
  appointment) — read-only to start, per §23's READ/LOW-RISK/HIGH-RISK classification discipline
- follow-up task creation from `call_outcomes.follow_up_required`
- call outcome → CRM notes on the matched Customer/Lead
- first real tool/function-calling surface (§23), each tool explicitly classified and each
  HIGH-RISK WRITE routed through existing OFS domain functions, never a shortcut
- real outbound-call authorization model (replacing the audit-only single-destination MVP shape
  entirely) — consent/business-rule design is new work, not inherited from Answermachine
```

## §32. Voice Copilot Boundary

Not started, not designed in this audit beyond this explicit boundary statement (per the task's instruction to keep Phase 16A/16B — an internal "Jarvis"-style staff assistant — fully separate from customer-facing Phone Operations during this phase). **Shared infrastructure identified as reusable later, without merging the two products now**: the speech/audio-bridge layer (`mediaBridge.ts`'s pattern), the OpenAI provider wrapper (`openaiRealtime.ts`), a future tool registry (§23, once it exists), and audit/permissions plumbing (OFS's existing RBAC). None of this implies the two assistants share a runtime, a UI, or a data model — only that the same *engineering patterns* may eventually be reused for both, evaluated separately when Voice Copilot itself is scoped.

---

## §33. RBAC Design

```
Admin:       full Phone Operations management — voice_agents config, phone_numbers, pause/
             disable/emergency-stop, transfer-number config, provider settings, recording/
             retention settings. Matches Phase 13C/13D's own precedent (Global Settings/Tax
             Profile: admin-only, stricter than the financial admin+dispatcher split) for any
             setting this sensitive.
Dispatcher:  operational call handling — call history, transcripts, outcomes, follow-up/CRM-note
             actions, live transfer-in-progress visibility. NOT config/pause/provider-secret
             access (mirrors the existing canManageFinancials/canManageQuotes admin+dispatcher
             split for OPERATIONAL data, while keeping the Global-Settings-shaped CONFIGURATION
             surface admin-only, exactly as Phase 13C established for Global Settings generally).
Technician:  no Phone Operations access by default — no evidence anywhere in Answermachine or in
             OFS's existing conventions suggests a technician-facing need for call
             history/config; if a future need emerges (e.g. a technician wants to see a call
             related to their own job), it should be a narrow, explicitly-justified read scoped
             to their own assigned jobs, not a blanket grant.
```
This is a design recommendation for Phase 15, not implemented anywhere yet.

---

## §34. Organization / Multi-Tenant Design

Every new table in §17 carries `organization_id`, scoped and enforced exactly the way every other OFS table already is (session-derived `actorOrganizationId(c)`, never client-supplied — the same discipline this session's own Phase 13C/13D work applied to Global Settings and Tax Profiles). No shared global phone numbers/agents/call logs/transcripts/transfer numbers across organizations — each is exclusively owned by one org's data, matching Answermachine's own complete absence of any multi-tenant concept today (it has never needed one, being a single-deployment private tool) as the "nothing to preserve, design fresh, correctly" case.

---

## §35. Company Profile Reuse

Direct, already-complete mapping (§12): `BUSINESS_NAME` → `organization_profiles.company_name`, `BUSINESS_PHONE` → `organization_profiles.phone`, `BUSINESS_EMAIL` → `organization_profiles.email`, `BUSINESS_TIMEZONE` → OFS's existing `BUSINESS_TIMEZONE` Global Setting (Phase 1/13C — a literal, no-new-concept match), Service Area/Business Hours → **do not currently exist as OFS settings**, need to be added (new Global Settings entries, following the exact effective-dated pattern already used for Tax Profiles) rather than sourced from anywhere existing. The one Answermachine hardcoding this section must flag again: `corePolicy.ts`'s BUSINESS KNOWLEDGE block (§10) currently hardcodes exactly these facts in source — that must be replaced by real reads from Company Profile + the new settings, not carried forward as source-code text.

---

## §36. Global Settings / Admin Settings Design

New Admin-managed OFS settings for Phase 15 (Global Settings, same effective-dated pattern as Tax Profiles/existing settings — never plaintext secrets):
```
Phone Operations Enabled       (org-level master toggle)
Default Agent Language          (one of the 6 supported — §11)
Fallback Language                (if per-call detection is ever added; today = same as default)
Business Hours behavior          (new — doesn't exist in OFS yet, needed both for Phone Ops and
                                  arguably useful more broadly)
Transfer Number                  (§20)
Voicemail / fallback behavior    (§19)
Recording enabled                (§21, default OFF)
Retention period                 (§21)
Outbound Caller ID                (which configured phone_numbers row to dial from)
Model (Realtime + Report)         (§12 — org override of a platform default, or platform-fixed;
                                   a Phase 15 decision, not resolved by this audit)
Voice                             (§12)
```
Secrets (Twilio SID/token, OpenAI key) remain env/secret-store on the Voice Engine host — **never** written into OFS's `global_settings` table as plaintext, matching this codebase's own existing, hardened discipline for every other provider secret (Google/Maps/Payments).

---

## §37. Failure / Degraded Mode

| Failure | Design |
|---|---|
| Twilio failure | Inbound: caller gets Twilio's own default failure behavior (nothing OFS can do once Twilio itself is down). Outbound: fail the call attempt, surface to whatever triggered it (UI action or automation), never silently retry-loop. |
| OpenAI failure | Media Stream still connects; if the Realtime WS fails to open or errors, fall back to the same PAUSED-style fallback TwiML (§19) rather than a dead/silent line — this is new design, Answermachine today just fails the call (acceptable for a private test tool, not for production). |
| Realtime disconnect mid-call | Answermachine's own `onClose` handler already does the safe thing (closes the Twilio side cleanly) — worth preserving as the immediate behavior; a future enhancement (not required for Phase 15) could attempt one reconnect before giving up. |
| Media stream failure | Same as above. |
| OFS API unavailable (Voice Engine can't reach OFS) | The call must not simply drop — the Voice Engine should have a bounded local fallback (e.g., a cached last-known agent config, and queue the transcript/outcome write for retry) rather than failing the live call over a control-plane hiccup. This is a real design requirement Option C introduces that Answermachine's all-local design never had to consider. **Correction, both independent reviews converged on this**: as originally drafted this "bounded local fallback" was unbounded in every practical sense — no size cap, no TTL, no at-rest encryption specified for a queue that will hold real customer transcripts/PII on the Voice Engine host, and no defined behavior if OFS stays unreachable indefinitely. Left unspecified, this silently reintroduces the exact unbounded-local-PII problem (today's `output/` filesystem, §21/§44) that Option C's "no local source of truth" rule exists to eliminate — just through the failure path instead of the happy path. **Required for Phase 15**: an explicit max size/TTL on the local queue, mandatory at-rest encryption for anything queued, and a defined hard-failure behavior once the bound is hit — new calls should degrade to the PAUSED-style voicemail/forward fallback (§19) rather than let the queue grow further. |
| Database unavailable (OFS/D1) | Same as above, from OFS's own side — matches OFS's existing general resilience posture, nothing Phone-Ops-specific needed here beyond the retry-queue point above. |
| Transfer unavailable | Falls back to the voicemail/message path (§19), never a dead line. |
| AI disabled (PAUSED/DISABLED/EMERGENCY_STOP) | §19 — never drop the call. |

**Critical customer-call fallback, stated once, clearly**: whatever else fails, an inbound call must never simply hang up in silence — some fallback (voicemail, human forward, or at minimum a spoken message) must always be reachable. This is a hard requirement carried into Phase 15 design, not something Answermachine currently guarantees (it has no fallback path at all today, having never needed one as an outbound-only private tool).

---

## §38. Observability

Answermachine today: structured JSON logs to stdout only (no metrics system, no error tracker, no cost/token-usage tracking, no latency dashboards) — genuinely thorough *event* logging (§7's event list: `server_started`, `call_initiated`, `call_answered`, `call_status`, `media_connected`, `openai_realtime_connected`, `ai_started_speaking`, `user_speech_detected`, `barge_in_*` events with real latency measurements, `ai_interrupted`, `ai_transcript`, `call_completed`, plus `*_error` events for every failure point) but nothing beyond stdout captures or aggregates it.

**Minimum for Phase 15**: the same event taxonomy, but shipped somewhere OFS-visible (at minimum, persisted call-level summary rows per §17; ideally the finer-grained events too, if volume is manageable) rather than only living in a local process's stdout. No raw audio or secret values logged, ever (carry forward §4's existing discipline). Token usage / cost per call is **not currently tracked at all** — a real gap worth closing early given OFS's own explicit "Cost-Control Preservation" law (§39).

---

## §39. Cost / Usage Boundaries

Cost-driving components identified: Twilio call minutes, Twilio phone number rental, OpenAI Realtime audio-minute billing, OpenAI report-model text calls (small, per-call), any future recording/storage cost (currently zero — recording isn't implemented), any future SMS (not implemented anywhere in Answermachine). No current provider pricing was assumed or encoded — none is required for this audit per the task's own instruction. **Design requirement carried into Phase 15**: per-call cost/usage telemetry (call duration → Twilio minutes, Realtime session duration → OpenAI audio cost) should be captured alongside `phone_calls` records from day one, since OFS's own CLAUDE.md already treats uncontrolled paid-API usage as a standing architectural concern (§15 of that document) — Answermachine itself has zero usage telemetry today, so this is new work, not a migration.

**Telemetry alone is not sufficient (both independent reviews flagged this)**: CLAUDE.md law #15 requires that anything able to materially increase paid API usage be "identified during planning **and verified during review**" — after-the-fact telemetry satisfies "identified" but not "controlled." §22 finding #2's unauthenticated-WS cost-abuse vector and finding #11's absence of rate limiting are the concrete mechanisms by which usage could run uncontrolled. **Required for Phase 15, not optional**: an enforced spend/volume guardrail (e.g., a per-organization max concurrent calls, max outbound calls/day, or a hard budget alert with an automatic pause) alongside the telemetry, not telemetry on its own.

---

## §40. Test Audit

**16** test files found (corrected by independent Testing review — an initial pass undercounted this at 15 by missing `runtimeFingerprint.test.ts`), one per (or closely following) a corresponding source module: `agent/callPurposes.test.ts`, `agent/customerName.test.ts`, `agent/customerNamePersonalization.test.ts`, `agent/identityAndOpening.test.ts`, `agent/language.test.ts`, `agent/voicePersonalities.test.ts`, `callInitiation.test.ts`, `config.test.ts`, `identityVoiceIndependence.test.ts`, `mediaBridge.test.ts`, `openaiRealtime.test.ts`, `runtimeFingerprint.test.ts`, `reporting/filename.test.ts`, `reporting/outcomeAnalyzer.test.ts`, `reporting/reportWriter.test.ts`, `reporting/timezone.test.ts`. Run via Node's built-in test runner (`tsx --test src/**/*.test.ts`), no separate test framework dependency.

**Classification**: all **unit tests**, provider-mocked where a provider is involved (`mediaBridge.ts`'s own header comment confirms tests inject a fake `OpenAISessionFactory` specifically to exercise the barge-in state machine "without a network call" — confirmed by direct code read of the factory-injection pattern in `mediaBridge.ts`). **No live-provider tests, no integration tests, no browser tests found or expected** (there is no browser-facing surface — Answermachine has no UI). Last recorded run (per Answermachine's own Serena memory, not independently re-executed this session — see below): **187/187 passing** as of 2026-08-24.

**This audit did NOT execute `npm test`, `npm run dev`, or `npm run doctor` against Answermachine.** Running its test suite or dev server was judged an unnecessary risk for a read-only audit (a live run could theoretically touch real Twilio/OpenAI credentials already present in `.env`, and the task's own scope is audit/architecture only) — the 187/187 figure is reported as **prior recorded evidence**, not evidence gathered in this session, and is presented with that caveat rather than re-claimed as freshly verified.

**Confidence-calibration correction (from independent Testing review — read directly, not assumed)**: not every file in §28/§29's classification table is equally test-backed, and this document's earlier draft implied a uniform confidence level that isn't accurate:
- `mediaBridge.test.ts` (16 tests, real injected fakes, races/timing/noise-rejection covered) and `config.test.ts` and `agent/language.test.ts` (imports and exercises the real `resolveLanguageProfile`/`isSupportedLanguage`) are **genuinely thorough** — the REUSE_WITH_ADAPTER/REUSE_AS_IS confidence for `mediaBridge.ts` and the language-profile files is well-supported by real behavioral test evidence.
- `openaiRealtime.test.ts` is **not** a behavioral test — it is two regex checks against `openaiRealtime.ts`'s own source text, with the file's own comment admitting the real `OpenAIRealtimeSession` class "opens a real WebSocket in its constructor, so it can't be unit-tested directly without a network mock." Combined with `mediaBridge.test.ts` faking the session at the factory boundary (never exercising the real class), **the 9-case OpenAI event switch, `sendSessionUpdate`'s payload shape, and error/close handling in `openaiRealtime.ts` have zero executable test coverage anywhere in the suite.** §28's "REUSE_AS_IS... no changes needed" verdict for this file is a code-reading judgment, not a test-evidenced one — treat it with correspondingly lower confidence during Phase 15 porting, and consider adding a real mocked-WebSocket behavioral test before or during the port, not after.
- `reporting/outcomeAnalyzer.test.ts` similarly only asserts regex patterns against the `SYSTEM_PROMPT` string constant — no test calls `analyzeCallOutcome()` with a transcript or exercises its response parsing/validation logic. §28/§29's "everything else is sound" judgment for this file rests entirely on code-reading, same caveat as above.

**Critical missing coverage before any real migration**: no test exercises the *new* boundary this migration introduces (Voice Engine ↔ OFS API calls) — because that boundary doesn't exist yet. Phase 15 must add, at minimum:
- webhook-signature-rejection tests against the ported middleware (carry the concept forward, don't assume the port is correct without re-testing it)
- a mocked-OFS-API test double for every Voice-Engine-side call, plus explicit **OFS-API-unavailable-mid-call fallback tests** for §37's bounded local-retry-queue behavior (distinct from the admin-toggled PAUSED/DISABLED tests below — this is a transient-failure path, not an admin action)
- call-state-machine tests for the new PAUSED/DISABLED/EMERGENCY_STOP fallback paths (§19/§37, which have no current analog to test)
- **§16 customer-identification disambiguation tests** — explicit coverage of the 0-match/1-match/2+-match branching, and specifically a *negative* test proving the 2+-match ambiguous path never leaks one candidate customer's data (this is the privacy-critical boundary §16 itself calls non-negotiable, and it was absent from this section's own first draft)
- **§33 RBAC/tenant-isolation tests** for every new Phone Operations endpoint — Answermachine has zero auth today, so this is 100% new surface with no existing pattern to inherit; needs its own named test category (e.g. Org A dispatcher token must 403 on Org B's `phone_calls`/`voice_agents` rows; a dispatcher token must reject admin-only pause/transfer-number/provider-credential endpoints), not folded generically into "mocked-OFS-API test doubles"
- eventual browser tests for the new Phone Operations UI (none needed today since none exists)

---

## §41. Deployment Audit

Answermachine runs **locally only**: `npm run dev` (tsx watch) or `npm start` (compiled `dist/`), a single Node process, no containerization, no process manager beyond the developer's own terminal/scripts (`kill-port.bat` exists specifically because of repeated stale-process incidents — see both Serena memories, §2). Public reachability is provided by a **Cloudflare Quick Tunnel** (`cloudflared`) in actual current practice (confirmed via `cloudflared.log` and the Serena live-call-trace memory), despite the README documenting `ngrok` — the README is stale on this one specific point; everything else in it checked out accurate. No Docker, no cloud deployment, no CI/CD, no production process manager (PM2, systemd, etc.) found anywhere in the tree.

---

## §42. Environment Compatibility (Cloudflare)

| Requirement | Answermachine's use | Cloudflare Workers compatibility |
|---|---|---|
| Long-lived WebSockets | Yes — call-duration bidirectional relay, potentially minutes | Supported, but only cleanly via Durable Objects + WebSocket Hibernation (not a plain stateless Worker fetch handler) |
| Binary audio | G.711 µ-law frames, base64-encoded in JSON messages (not raw binary WS frames) | No incompatibility — this is just JSON message content, Workers handle this fine either way |
| TCP assumptions | None found — everything is WS/HTTP over TLS, no raw TCP socket use | Compatible |
| Filesystem assumptions | `fs.writeFileSync` for reports (§21) | **Incompatible** with Workers (no persistent local filesystem) — must become D1/R2, already accounted for in §26/§29 |
| Node APIs | `node:http`, `node:net` (doctor.ts only), `node:fs`, `node:path`, `process.env`, `process.cwd()`, `process.exit()` | `node:http`/`node:net`/`process.exit()` are Node-runtime-only; Workers has `nodejs_compat` for *some* Node API surface but a raw `net.createServer()` (doctor.ts) and `http.createServer()` (server.ts, if ported as-is) are exactly the kind of thing that motivates keeping the Voice Engine OFF the Worker runtime (§26) rather than fighting compatibility-shim edge cases |
| Python dependencies | None — pure Node/TS | N/A |
| Native libraries | None found (`ws`, `express`, `twilio`, `dotenv` are all pure-JS/TS) | N/A |
| Twilio Media Streams | WS server accepting Twilio's connection | Technically reachable from a Worker via Durable Objects, but see §26 — recommended NOT to attempt this given the available lower-risk alternative |
| OpenAI Realtime | Outbound WS client | Workers can open outbound WebSocket connections — not the blocker; the *combination* of both directions plus stateful per-call logic is what argues for Option C |

**Bottom line**: nothing here is a hard, unconditional Cloudflare incompatibility — Option A was technically possible, just higher-risk than necessary (§26). The recommendation to keep the Voice Engine off the Worker is a risk/effort judgment, not a capability limitation.

---

## §43. No Duplicate Source of Truth (design confirmation)

Restating the target explicitly, now that the audit is complete and confirms it's achievable: Customer/Lead/Job/Schedule/Company-Profile/User-RBAC truth already lives in OFS and nothing in Answermachine currently competes with any of it (§13/§14 — there was no CRM to reconcile, only a reporting sink to redirect). Voice runtime state stays exactly where Answermachine's own `callSessionRegistry` already correctly keeps it: transient, in the Voice Engine's process memory, never a second database.

---

## §44. Data Migration Need

**Classification: TEST DATA ONLY.** `output/calls/` contains 16 real completed test-call report pairs (32 files total), dated 2026-08-20 and 2026-08-24, all placed to the single hardcoded `TEST_DESTINATION_NUMBER` under the test customer names "Test Customer" and "Hasan" (the developer's own documented test recipient, per both Answermachine Serena memories). This is **not real customer/business historical data** — it is exactly what the app's own privacy-conscious `.gitignore` comment already calls it ("Call reports contain customer PII... never commit these," written defensively even though the actual content is test data, not live customer data). **No migration of this data into OFS is required or recommended** — it has no ongoing business value and re-classifying test artifacts as production call history would misrepresent OFS's own future call-history data. If retained at all, it should stay exactly where it is (local, gitignored) as a development reference, not imported.

---

## §45. Duplicate / Dead Code Audit

No dead code, no superseded experiments, no duplicate providers, no duplicate prompts, no old UI (none was ever built), and no unused configuration were found in the 24 real source files read for this audit — the codebase is unusually lean and current for its size, consistent with its own README's accurate self-description as a minimal MVP. The one legacy artifact worth naming: `dist/` (a stale compiled build, gitignored, regenerated on every `npm run build` — not source, correctly excluded from the migration map).

```
REMOVE:            dist/, output/ (test data, §44), cloudflared.log, server.log, kill-port.bat
                    (dev-local convenience only)
KEEP FOR REFERENCE: none needed beyond the source tree itself, which this document already maps
                    file-by-file (§29)
MIGRATE:            per §28/§29 — the large majority of src/
```

---

## §46–§48. Independent Reviews

All three reviews were run against the full document plus direct re-reading of the cited Answermachine/OFS source (not the document's word alone). All findings below have already been folded into the relevant sections above (§4, §10, §16, §21, §22, §26, §29, §30, §37, §39, §40) — this section is the durable record of what was found and resolved, not a separate pending action list.

### §46. Architecture Review — Verdict: PASS WITH FINDINGS

Verified accurate: the Option A/B/C technical analysis, all five spot-checked §28/§29 classifications (`mediaBridge.ts`, `openaiRealtime.ts`, `agent/corePolicy.ts`, `reporting/outcomeAnalyzer.ts`, `reporting/callSessionRegistry.ts`), §17's persistent/transient data-boundary split, §33/§34's RBAC/tenant design against OFS's own established conventions, and §35/§36's Company Profile/Global Settings mapping (independently re-verified against `migrations/0019_company_profile.sql`/`0012_business_timezone_setting.sql`, not trusted from the document).

Findings (now folded in): Voice Engine ↔ OFS credential scoping must be per-organization, not a single shared credential (§26) — the single most consequential finding, converged on independently by the Security review too. Voice Engine hosting/ops ownership was undefined (§26). Cost-control needed an enforced cap, not just telemetry (§39). §37's local retry-queue exception needed explicit bounds (§37). Option B was presented with more rigor than it deserved as a genuinely separate alternative (§26, reframed). Phase 15's outbound-call foundation didn't specify what supplies a destination number before Phase 16 (§30). Third-party AI subprocessor exposure deserved an explicit line, not disclaimer-only coverage (§21).

### §47. Security Review — Verdict: PASS WITH FINDINGS

Verified accurate (independently, via direct source read, not trusted from the document): Twilio signature validation is real and correctly scoped to the exact URL (`server.ts:42-55`); zero tool/function-calling surface exists (`openaiRealtime.ts:60-91` has no `tools` key); zero rate limiting exists anywhere; the `.env`/`.env.example` config inventory matches exactly.

Findings (now folded in): logger redaction is key-based only, not value-content-based (§4). The unauthenticated Media Stream WS endpoint's severity needed re-rating from P2 to P1 for the production/multi-tenant target, with a concrete per-call signed-token mitigation named instead of "URL obscurity" (§22). The Voice Engine credential-scoping question (independently identified as this review's own top finding, converged with the Architecture review) needed a concrete resolution: OFS's API must resolve `organization_id` from the credential/phone-number registration itself, never trust a Voice-Engine-asserted payload field (§26). Caller-ID spoofing against §16's customer-identification design was a real, previously entirely unaddressed gap (§16 — this was a genuinely new finding neither the original draft nor the Architecture review caught). The post-call outcome-analysis pipeline has no prompt-injection defense on transcript content already driving (in the Phase 16 plan) automated actions (§10). §37's retry queue needed encryption-at-rest specified, not just size/TTL bounds (§37, incorporated alongside the Architecture review's framing of the same gap). DSAR/deletion mechanics and transcript encryption-at-rest were absent (§21).

### §48. Testing Review — Verdict: PASS WITH FINDINGS

Caught one genuine factual error in the original draft: **16 test files exist, not 15** — `src/runtimeFingerprint.test.ts` was omitted from every count and listing (§5-7, §29, §40 — all now corrected). Independently re-verified the 187/187-passing framing was honestly sourced (explicitly attributed to prior Serena-memory evidence, not re-claimed as freshly verified) and confirmed accurate. Independently verified `mediaBridge.test.ts`, `config.test.ts`, and `agent/language.test.ts` are genuinely thorough, behavioral, real-assertion test suites that support the document's REUSE confidence for those files.

Findings (now folded in): the document's REUSE_AS_IS confidence for `openaiRealtime.ts` was stated more strongly than its actual test coverage supports — `openaiRealtime.test.ts` only regex-checks the file's own source text, never exercises the real class's event-handling logic behaviorally (§40, now explicitly caveated). Same gap for `reporting/outcomeAnalyzer.ts`'s "everything else is sound" judgment (§40). The Phase 15/16 test-planning list was missing two explicit categories: §16's privacy-critical customer-disambiguation tests (0/1/2+-match branching, with a negative test proving no ambiguous-match data leak) and §33's RBAC/tenant-isolation tests for the entirely-new Phone Operations auth surface (§40, both now added as named categories) — plus a distinct OFS-API-unavailable-mid-call fallback test category, separate from the admin-toggled PAUSED/DISABLED tests already listed (§40).

### Cross-review synthesis

The Voice Engine ↔ OFS credential-scoping question was identified **independently by both the Architecture and Security reviews**, from different angles (Architecture: "the actual cross-tenant trust boundary is not designed, only asserted"; Security: "this is the most consequential finding... should be resolved with a concrete answer before Phase 15 implementation starts") — convergent independent findings on the same root issue are treated as strong evidence this is a real, load-bearing gap, not a stylistic nitpick, and it is now resolved in §26 with a concrete requirement (per-organization credentials, OFS resolves org scope server-side, never trusts a Voice-Engine-asserted value). No BLOCKER was raised by any of the three reviews against the document's core recommendation (Option C, the migration classifications, or the Phase 15/16 boundary) — all findings were refinements/specifications of design items the document had already correctly identified as open, sharpened with concrete failure scenarios and required mitigations.

---

## §49. Documentation

This document **is** the Phase 14 documentation deliverable — architecture, inventory, secrets/config boundary, duplicate-CRM findings (none — §14), Twilio/OpenAI architecture (§24/§25), runtime constraints (§42), recommended integration architecture (§26/§27), migration classifications (§28/§29), Phase 15/16 scope (§30/§31), deferred items, and risks are all captured above. No secret values appear anywhere in it.

---

## Limitations / What This Audit Does Not Claim

This audit does not certify legal compliance for call recording, consent, or telemarketing regulations in any jurisdiction — that determination belongs to the business and its own counsel, not this document. It does not include cost estimates, timeline estimates, or a task-level implementation plan for Phase 15/16 — those are implementation-phase deliverables, not audit deliverables. It does not independently re-run Answermachine's test suite (§40) or place a live test call — both were judged unnecessary risk for a read-only architecture audit. Answermachine's own README was found accurate on every claim checked except the tunnel-provider detail (§41), which is noted, not treated as evidence of broader unreliability.
