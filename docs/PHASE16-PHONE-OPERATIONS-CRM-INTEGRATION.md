# Phase 16 — Phone Operations ↔ CRM / Customers / Leads / Scheduler / Jobs

Status: **IMPLEMENTED / VERIFIED / BROWSER-ACCEPTED / UI-HARDENED /
MOBILE-VERIFIED / NOT COMMITTED** (see the Phase 16 Safe Commit task, run
separately, for the commit record — matching the Phase 15 precedent
exactly).

## What this phase is

Integrates the Phase 15 Phone Operations foundation
(`docs/PHASE15-PHONE-OPERATIONS-FOUNDATION.md`) with OFS's existing
Customers/Leads/Jobs/Scheduler business modules, so a call can become a
useful operational record: a matched customer's service context, a new
Lead for an unknown caller, a follow-up task, or an unassigned appointment
for an already-known customer. It does this **without** creating a
duplicate CRM/scheduling system, **without** bypassing existing
domain/state-machine rules, and **without** starting Voice Copilot/Jarvis
or automatic dispatch.

**Explicitly out of scope, not started**: live PSTN transfer execution
against a real caller, automatic Lead→Customer conversion, automatic
technician assignment, any change to `lead-conversion.ts`'s own matching
logic (see "Documented, not fixed" below).

## Architecture

### Central design decision: Lead-first, no-auto-conversion, no-auto-Job

Modeled directly on `lead-conversion.ts`'s own pre-existing "no auto Job
creation" precedent, extended to the phone channel:

- An unknown/unmatched caller can only ever produce a **Lead**. Converting
  a Lead to a Customer stays a human decision through the existing
  conversion pipeline — no tool or webhook path creates a Customer.
- An appointment (a `jobs` row — OFS has no separate appointment entity)
  can only be created for an **already-matched existing customer**, never
  for a Lead or an unknown caller.
- A phone-created appointment is always **unassigned**
  (`technician_id: null`). Dispatch stays a human decision through the
  existing Jobs/Scheduler UI.

### New server module: `src/server/phone-operations-crm.ts`

- **Caller matching** — `resolveCallerContext`/`matchCustomersByPhone`,
  phone-only (deliberately narrower than, and not sharing code with,
  `lead-conversion.ts`'s phone-OR-email `findMatchingCustomerIds` — a
  caller hasn't stated an email). Exactly one match auto-links with
  `EXACT_PHONE` confidence; zero or multiple matches leave the call
  unlinked with `UNKNOWN` confidence — the system never guesses. A
  dispatcher can always correct this manually, recorded as `MANUAL`
  confidence with `match_source = 'user:<id>'` for provenance.
- **CRM context** (`getCustomerVoiceContext`/`getJobVoiceStatus`) — read
  models for what a matched call's customer/lead/job panel and a future
  Voice Engine tool need, never raw table dumps.
- **Manual link/unlink** (`linkCallToCustomer`) — admin/dispatcher
  correction of an auto-match, tenant-checked.
- **Follow-ups** (`call_follow_ups`, new table) — a lightweight task
  record (`createFollowUp`/`listFollowUps`/`completeFollowUp`); confirmed
  via grep that no prior task/follow-up mechanism existed anywhere in the
  codebase.
- **Availability** (`getAvailability`) — calls `scheduling.ts`'s own
  exported `checkScheduleConflict` per technician rather than
  reimplementing the overlap math, so it can never drift from what the
  Jobs UI itself enforces.
- **Tool registry** (`buildToolRegistry`, `KNOWN_TOOL_NAMES`) — 7 tools
  (`find_customer_by_phone`, `get_customer_service_context`,
  `get_job_status`, `get_available_slots`, `create_lead_from_call`,
  `create_follow_up`, `create_appointment_for_customer`), each tagged
  `read` / `low_write` / `high_write`. No tool exists for technician
  assignment, job status mutation, or Lead→Customer conversion — see the
  in-code header comment for why each is deliberately absent.
- **Idempotent, atomic tool invocation** (`invokeTool`,
  `call_tool_invocations` table, `UNIQUE(call_id, idempotency_key)`) —
  claims the idempotency key with an `INSERT ... status='pending'`
  **before** any policy check or execution; the request whose INSERT wins
  the database's UNIQUE constraint is the one that actually executes. A
  losing concurrent request is told to retry; a true sequential replay
  gets back the cached final result. A reused key bound to a different
  `tool_name` is rejected.
- **Frozen per-call tool authorization** — `voice_agents.tool_policy` (new
  versioned column) is baked into `calls.voice_agent_snapshot` at
  call-creation time and never re-read live; `invokeTool` enforces only
  the frozen snapshot's policy, so a later edit to an agent's live policy
  can neither grant nor revoke permissions on a call already in progress
  or completed — same historical-immutability discipline as the Tax
  Snapshot / Phase 15 agent-config snapshot.

### Canonical-service reuse, not a bypass

`createJobRecord`/`createLeadRecord` were extracted, behavior-preserving,
from the existing `POST /api/jobs`/`POST /api/leads` route bodies in
`src/server/index.ts` into standalone functions, now called by **both**
the original routes (RBAC unchanged) **and** the new tool registry (via a
dependency-injection adapter — `phone-operations-crm.ts` cannot import
`index.ts`, so `buildToolRegistry(deps)` takes the two functions as
callback params instead). No tool ever performs a raw `INSERT` against
`leads`/`jobs`.

### Explicit input allowlisting for AI-tool-supplied data

Every tool's `execute()` builds an explicit allowlisted object from the
untrusted `args` (via `str()`/`num()`/`optStr()` helpers) before calling a
domain function — never a raw `{ ...args }` spread. In particular,
`create_appointment_for_customer` accepts no `price`, `priority`, or
`technician_id` from the model at all; `technician_id` is hardcoded
`null`.

### Routes (`src/server/index.ts`)

- **Admin + dispatcher** (`canViewPhoneOperationsCalls`): `GET
  /calls/{id}/crm-context`, `POST /calls/{id}/link`, `GET /availability`,
  `GET /follow-ups`, `POST /calls/{id}/follow-ups`, `POST
  /follow-ups/{id}/complete`. Technician is denied on all of them
  (matches Phase 15's existing pattern).
- **Admin-only** (`canManagePhoneOperations`): agent `tool_policy` is now
  part of `saveVoiceAgentRoute`'s existing Zod-validated body
  (`z.array(z.enum(KNOWN_TOOL_NAMES)).max(50)`), so an admin can never
  save a policy referencing a tool that doesn't exist.
- **Public, bearer-service-credential-authenticated** (Phase 15's existing
  mechanism): `POST /runtime/calls/{id}/tools/invoke` — the contract the
  Voice Engine calls to actually invoke a tool.
- The Twilio `/voice` webhook handler gained best-effort auto-linking
  (`resolveCallerContext`) immediately after `createInboundCall`.

### Client (`src/client/components/phone-operations.tsx`)

New `CrmContextSection` on the call-detail view: match-confidence display,
customer/lead/job panel, manual link/unlink controls, follow-up
list/create, and a table of tool invocations taken on the call. The
Agents form gained a `tool_policy` checkbox editor and a "Tools" column in
the agents list.

## Independent review outcomes (Security, Architecture, and Testing reviews
run against the initial implementation; all P0/P1 and the highest-value
P2 findings fixed and re-verified before this phase was marked verified)

**Fixed:**
- **P0 (Testing)** — `invokeTool`'s idempotency guard was check-then-act
  (SELECT, then conditionally INSERT), a genuine concurrency race: two
  simultaneous identical requests could both pass the SELECT and both
  execute the tool body, with only the second INSERT silently failing
  after the damage was done. Rewritten to claim-first — an `INSERT
  ... status='pending'` is attempted before any policy check or
  execution; only the request whose INSERT wins the database's UNIQUE
  constraint proceeds to execute. Regression-tested (see below): two
  concurrent `create_lead_from_call` invocations with the same
  idempotency key now produce exactly one Lead and exactly one
  `call_tool_invocations` row.
- **P0 (Testing, verified by code inspection by all three reviews, now
  also regression-tested)** — no test previously proved `tool_policy`
  stays frozen against a later live agent-policy edit. Two new tests
  publish a new agent version with a different `tool_policy` after a call
  has already started, and confirm the original call's tool-invoke route
  still enforces the policy that was in effect (and only that policy) at
  call-creation time, in both directions (a newly-granted tool stays
  denied; a newly-revoked tool stays allowed).
- **P1 (Security, Architecture)** — `createFollowUp` didn't re-verify that
  `customer_id`/`lead_id`/`job_id`/`assigned_user_id` belonged to the
  calling organization before inserting — a cross-tenant IDOR reachable
  via the AI tool path (the `create_follow_up` tool forwards
  Voice-Engine-supplied integers directly). Now checks all four against
  `organization_id`, matching `linkCallToCustomer`'s established pattern.
- **P2 (Security)** — an idempotency key wasn't bound to the tool it was
  first used with, allowing a mismatched-replay: reusing a key against a
  different `tool_name` could return a stale result for the wrong
  operation. `invokeTool` now rejects a key reused against a different
  tool name.
- **P2 (Security)** — `create_appointment_for_customer` and
  `create_lead_from_call` originally spread the raw `args` object
  directly into `createJobRecord`/`createLeadRecord`, letting a
  model-controlled `price` reach a real financial column with zero
  validation. Both rewritten to build explicit allowlisted objects.
- **P2 (Architecture, borderline P1)** — `getAvailability` hand-copied
  `scheduling.ts`'s conflict-overlap math instead of calling the real
  `checkScheduleConflict`, a "two places that can drift" risk (the
  module's own header comment claimed reuse that wasn't actually
  happening). Now calls `checkScheduleConflict` directly per technician;
  the now-redundant `timeToMinutesLocal` duplicate was deleted.
- **P2 (Architecture)** — `create_appointment_for_customer` and
  `create_lead_from_call` were missing explicit validation of
  `scheduled_date`/`name`, letting a missing field fall through to a bare
  low-level error instead of a clean domain error. Fixed as part of the
  same allowlist rewrite (both now use `str()` for their required
  fields).
- **P2/P1 (all three reviews)** — a comment claimed a test enforced that
  `KNOWN_TOOL_NAMES` stays in sync with `buildToolRegistry`'s actual keys;
  no such test existed. Added (`KNOWN_TOOL_NAMES stays in sync with
  buildToolRegistry's actual keys`).
- **Dead code (all three reviews)** — `assertSafeToDiscloseSensitive` was
  defined but never called anywhere in the repository. Deleted, with the
  two header comments that referenced it rewritten to describe the actual
  (simpler) disclosure boundary.
- **Test naming** — a test named "...respects the scheduling conflict
  guard" didn't actually exercise a conflict scenario (phone-created
  appointments are always unassigned, so they structurally can't collide
  with a specific technician's existing job). Renamed to describe what it
  actually proves, and a new test
  (`create_appointment_for_customer goes through the real conflict guard,
  same as the Jobs UI`) confirms the tool genuinely calls the canonical
  `createJobRecord` path rather than a hand-rolled duplicate.

**Documented, not fixed (accepted for this phase)**:
- **Architecture-flagged, deferred** — `phone-operations-crm.ts`'s
  `normalizePhone` strips a leading NANP "1" from an 11-digit number (so
  Twilio's E.164 `+16045551234` matches a customer typed as
  `604-555-1234`); `lead-conversion.ts`'s own separate, unexported
  `normalizePhone` does not. This divergence means a phone-sourced Lead
  may fail to dedupe-match an existing Customer when later converted
  through the untouched `lead-conversion.ts` pipeline. Fixing this
  requires touching `lead-conversion.ts`'s matching logic, which is
  outside this module's scope per the Module-Scoped Change Rule — flagged
  for a future phase rather than fixed opportunistically here.
- **P2 test-coverage gaps, accepted** — dispatcher-allowed (as opposed to
  admin-allowed) coverage on the 6 new routes, unauthenticated-401
  coverage, and cross-org read-isolation tests for
  `crm-context`/`follow-ups`/`availability` specifically (cross-tenant
  isolation IS tested for `link` and for the runtime tool-invoke route,
  and RBAC-denial for technician IS tested on every new route — the gap
  is only in the admin/dispatcher/cross-org read-path matrix, not in
  authorization existing at all). Judged lower-value than the P0/P1 fixes
  above given this module's routes all share Phase 15's already-reviewed
  `canViewPhoneOperationsCalls`/`canManagePhoneOperations` gates rather
  than inventing new authorization logic.

**Confirmed correct by all three reviews** (not re-summarized here — see
each review's own report): server-authoritative RBAC on every new route
(reusing Phase 15's existing gates, no new mechanism invented); tenant
isolation via `organization_id` enforced in every new function; no SQL
injection; no automatic Customer creation or Lead→Customer conversion
anywhere in this phase; no automatic technician assignment; the Lead-first
policy is structurally enforced (there is no tool or route that can create
a Job for an unmatched caller); mass assignment is closed on the runtime
tool-invoke route.

## Verification performed this session

- `pnpm run typecheck` — clean.
- `pnpm run lint` — clean.
- `pnpm run check:architecture` — clean.
- `pnpm run build` — clean production build.
- `pnpm vitest run test/phone-operations-crm.test.ts` — 21/21 passing
  (16 original + 5 added during the fix-verification pass: the
  `KNOWN_TOOL_NAMES` sync check, the concurrency-race regression test, the
  two frozen-`tool_policy` regression tests, and the canonical-conflict-
  guard test replacing the misleadingly-named original).
- `pnpm vitest run --no-file-parallelism` (full suite, sequential) — 56
  test files, 1328 tests, all passing. No regression in any pre-existing
  suite, including the Job/Lead creation tests exercised by both the
  original routes and the new tool-registry adapter path.

**Real-browser Admin/Dispatcher/Technician acceptance — COMPLETE** (same
session, `pnpm run dev`, real Vite + `wrangler dev` + local D1). The
Administrator, Dispatcher, and Technician sign-ins were each performed by
the user directly in the browser — this session never touched a password
field, per the credential-entry safety boundary (an earlier attempt at
resetting the seeded admin's password to sign in programmatically was
correctly blocked and reverted before any login was attempted; that
password hash was confirmed restored byte-for-byte). Test data (customers,
a Twilio credential, settings, a phone number, a voice agent with a full
`tool_policy`, and a set of synthetic signed-webhook calls covering every
scenario below) was seeded via the real HTTP API using a throwaway
backend-only QA admin account created for this purpose, then all
verification below was performed by driving the actual browser UI.

- **Admin — Phone Operations workflow**: all 5 tabs (Calls, Settings,
  Voice Agents, Phone Numbers, Credentials) exercised live — Operating
  Mode/concurrency-cap save, Voice Agent create with the `tool_policy`
  checkbox editor, Phone Number list, and Credentials tab (Twilio Account
  SID/Auth Token fields were deliberately never typed into — verified by
  view only; the Issue/Revoke Service Credential flow, which only ever
  *displays* a system-generated token rather than requiring one to be
  entered, was exercised end-to-end instead).
- **Call Detail CRM Context, customer matching/linking, manual match
  correction**: an exact-single-phone-match call auto-linked with
  `EXACT_PHONE` confidence and displayed the customer's real active-job
  count; unlinking and manually re-linking to a specific customer ID both
  worked live and correctly flipped `match_confidence` to `MANUAL (user:
  <real admin id>)`.
- **Multiple-match / safe-disambiguation flow**: a call whose caller phone
  matched two different customers correctly stayed unmatched
  (`UNKNOWN`) rather than guessing; the admin then manually resolved it to
  the correct one of the two.
- **Job linkage, scheduler/availability integration, booking/
  service-request flow, existing-customer synthetic flow**: an AI tool
  invocation (`create_appointment_for_customer`) against an
  already-matched real customer created a real, unassigned Job, visible
  immediately in the ordinary Jobs list and on the correct date in the
  Scheduler month view — confirming this is a genuine Job row through the
  existing Scheduler, not a parallel system. `get_available_slots`
  invoked immediately after showed the technician still available at that
  slot, live-confirming unassigned phone appointments don't block a
  technician's calendar until a human dispatches them.
- **New-prospect synthetic flow, Lead linking/creation**: `create_lead_
  from_call` against an unmatched caller created a real Lead, visible in
  the ordinary Leads list (status `new`, Unassigned, referral source
  "Phone") — confirming no bypass of the existing Leads module.
- **Follow-up creation**: created via the real browser form (both by the
  Admin and, separately, by the Dispatcher) and via the AI tool path;
  both render in the same UI, "Mark Done" tested live.
- **Tool/action audit visibility**: all three possible statuses —
  `success`, `failed`, and `denied` — observed live in the "Actions
  Taken" table with correct risk-category badges and timestamps.
- **Failure flow**: `create_appointment_for_customer` against a
  nonexistent customer id recorded a `failed` entry with no Job created.
- **Frozen `tool_policy`, live-confirmed beyond the automated regression
  test**: a call placed under a deliberately restrictive agent version
  was denied a tool both before *and* after the live default agent's
  policy was widened to permit it — the call's own frozen snapshot never
  changed.
- **Console/network errors**: checked across every page above (Calls
  list, call detail, Jobs, Leads, Schedule) — zero JS errors/exceptions,
  every `/api/*` request returned 200 for authorized actions.

**Dispatcher — full parity with Admin on the shared surface, correctly
blocked from admin-only config**: the Dispatcher session saw the exact
same `CrmContextSection` (customer link/unlink, follow-ups, tool-audit
table) and successfully created a follow-up live. The Phone Operations
tab bar showed only "Calls" — Settings/Voice Agents/Phone Numbers/
Credentials were absent client-side; a direct `fetch()` to all 5
admin-only config endpoints (`settings`, `agents`, `numbers`,
`service-credentials`, `credentials/twilio`) independently confirmed
403 server-side.

**Technician — fully blocked, confirmed both client- and server-side**:
Phone Operations is entirely absent from the Technician sidebar; a direct
URL navigation to `/phone-operations` falls back to Technician Home ("My
Jobs Today") with no error; a direct `fetch()` to every Phone Operations
route this phase added — including ones the Dispatcher IS allowed to use
(`calls` list, `crm-context`, `link`, `follow-ups` list/create,
`availability`) and the admin-only config routes — independently
confirmed 403 in every case, with clean console output throughout (no
unhandled exceptions from the blocked-route fallback).

Post-walkthrough cleanup: the one throwaway backend-automation service
credential issued for test-data seeding was revoked via the real API
before finishing. The QA fixture customers/leads/jobs/calls/agent/users
created for this walkthrough were left in the local dev D1, consistent
with this project's existing convention of prior phases' test fixtures
(e.g. `Phase13B Test Tech`, `phase15-dispatch@example.test`) persisting
across sessions.

## UI/UX + Technician Mobile Hardening addendum

A focused hardening pass on the Phone Operations UI and (where genuinely
in scope — the one blocker to any Technician mobile usability at all) the
app's mobile navigation shell. This is **not** a replacement for a future
app-wide responsive audit — it fixes the specific defects blocking this
phase's own screens and the Technician mobile role, nothing broader.

### Root cause found and fixed

`phone-operations.tsx` used two CSS classes — `.btn-secondary` and
`.form-actions` — throughout, on every button and action row, that were
never defined anywhere in `styles.css`. Every button in the original
Phone Operations UI (Back to Calls, Unlink, Link Customer, Add Follow-up,
Mark Done, Save, Show History, Issue Credential, Revoke) was rendering as
an unstyled native browser control — the single root cause behind the
"raw-looking controls" baseline finding. Fixed by replacing every
occurrence with the app's real, already-established classes
(`.btn`/`.btn-primary`/`.btn-sm`/`.btn-back`/`.btn-icon`), not by defining
new CSS for the wrong class names.

### Phone Operations UI changes

- Colored status badges (call status, match confidence, follow-up status,
  tool risk/status) via a local `Badge` component reusing the exact
  `.status-badge`/`.status-dot` CSS and per-domain-color-map convention
  already used by `status-badge.tsx`/`contract-status.ts`/
  `quote-status.ts` — not a new pattern.
- Call Detail header rebuilt using the existing `.detail-title-row`/
  `.detail-meta-grid`/`.detail-meta-item` pattern from `job-detail.tsx`,
  now showing Voice Agent name and Language (read from
  `call.voice_agent_snapshot`, genuinely available data that the original
  header never surfaced).
- CRM Context recomposed into distinct Match/Customer/Lead/Job/Follow-ups/
  Actions Taken groups. Initially built as new `.po-crm-group`/
  `.po-crm-group-label` CSS; an independent architecture review correctly
  identified this as duplicating the existing `.form-section`/
  `.form-section-heading` pattern (and incidentally missing the
  horizontal padding that pattern already provides) — consolidated to
  compose `.form-section`/`.form-section-heading` directly, with the two
  `po-*` rules reduced to only the icon+text flex layout that
  `.form-section-heading` doesn't already provide.
- Manual customer link/correction and follow-up create rows changed from
  fixed-pixel-width `display:inline-block` inputs (the root cause of the
  "nearly full-width on mobile" baseline finding) to flex rows that wrap
  naturally (`flex: 1 1 200px`-style sizing), stacking cleanly at phone
  widths instead of overflowing or looking broken.
- Empty states rewritten from bare "None" to specific text ("No lead
  linked to this call.", "No customer matched — link one below if you can
  identify the caller.", etc.).
- Admin tabs (Settings/Voice Agents/Phone Numbers/Credentials) hardened
  to the same `.form-grid`/`.settings-card`/`.settings-group-heading`
  pattern `tax-jurisdiction-settings.tsx` already established for
  exactly this kind of page-level (non-modal) settings form; the
  Voice-Agent tool-policy checkboxes now render in a responsive
  `repeat(auto-fill, minmax(200px,1fr))` grid instead of a stacked list.
  Server-authoritative RBAC on these tabs is unchanged (client-side
  `adminOnly` gating on top of the existing `canManagePhoneOperations`
  403 boundary — never touched).

### Mobile navigation (app-wide, the one out-of-Phone-Operations fix)

`.sidebar` was a fixed 240px column with no responsive override anywhere
in `styles.css` — at 390/430px it consumed 60%+ of the viewport with no
way to hide it, the single defect that would have made every other
Technician-mobile finding below moot. Converted to an off-canvas drawer
below 640px: a hamburger toggle (rendered as a Fragment sibling of
`<aside class="sidebar">`, not a child — a `transform` on an ancestor
creates a new containing block for `position:fixed` descendants, so a
child toggle would have been dragged off-screen with the closed sidebar)
opens it as an overlay with a click-to-close backdrop. Desktop/tablet
(>640px) are visually and behaviorally unchanged.

**Accessibility findings on the first version of this drawer, found by
independent review, fixed and re-verified live**:
- The closed drawer's nav/user-action buttons remained in the tab order
  and the accessibility tree despite being visually off-screen
  (`transform` alone doesn't remove either) — fixed with `visibility:
  hidden` on the closed state (removes both, unlike `display:none`'s
  layout side effects), delayed via `transition-delay` so the open→close
  slide animation is unaffected. Verified: `getComputedStyle(...)
  .visibility === "hidden"` when closed.
- No Escape-to-dismiss, no focus management on open — fixed: opening the
  drawer now moves focus to its first nav item, Escape closes it and
  returns focus to the toggle button. Verified live via Playwright
  keyboard/focus assertions (not just code inspection): focus correctly
  lands on the first nav button on open, and `document.activeElement`
  correctly is the toggle button after Escape.
- The toggle's own "X" close affordance was unreachable once the drawer
  opened — the toggle's `z-index` (60) was lower than the open drawer's
  (61), so the drawer covered its own close button. Fixed by raising the
  toggle above the drawer (`z-index: 62`); also bumped the toggle from
  40×40 to 44×44 to meet the touch-target guideline. Verified live: the
  toggle's bounding box is reachable/clickable with the drawer open, and
  visually sits as a clean floating close button rather than an obscured
  or jarring overlap (screenshot-confirmed).

### Technician mobile — real interactive walkthrough performed

Via a real, logged-in Technician session (login performed by the user —
this session never touched a password field): a job was scheduled for
"today," transitioned Scheduled → In Progress with the existing
confirm-dialog flow, then every completion-checklist surface was
exercised for real: added a checklist item; added an Activity note;
uploaded a real pre-work photo and a real post-work photo (via the
browser's actual file input, not a mocked upload); filled in and saved a
Technician Report draft, then submitted it (own confirm dialog: "Once
submitted, this report counts toward job completion..."); captured a
customer signature on the canvas with real mouse-drag strokes and saved
it (own confirm dialog); confirmed the "Complete" transition became
enabled only once every requirement was satisfied. Console/network were
clean throughout (zero JS errors, every request 200) — checked via the
browser extension's own console/network tools during the live session.

**Sticky bottom action bar (`.tech-sticky-actions`/`.tech-sticky-btn`,
pre-existing Phase 6/10 code, not new to this pass) — real bug found and
fixed**: a data-rich job (photos + submitted report + signature) reaches
far enough down the page that its last controls could render underneath
the fixed bottom bar on phone widths. A `padding-bottom: 90px` was added
to reserve space — but a pre-existing, unmodified `.job-detail-page {
padding-bottom: 84px }` rule already existed later in the same
`@media (max-width: 640px)` block, so the new rule was silently shadowed
and never took effect (independently caught by both reviews). Fixed by
consolidating into one rule computed from the bar's own actual sizing
(`calc(76px + env(safe-area-inset-bottom, 0px))`) rather than a second
guessed flat number. Verified live via Playwright: scrolled the real page
to `document.body.scrollHeight` and measured the last content section's
bounding rect against the fixed bar's — zero overlap, ~21px clear gap.

### Real breakpoint verification (1440 / 1024 / 768 / 430 / 390)

The browser extension's window-resize tool was non-functional in this
environment (confirmed via `window.innerWidth` staying at the physical
window size across two different tabs and a fresh tab) — per this task's
own fallback instruction, real device-emulated viewports via a local
Playwright/Chromium instance were used instead, authenticated by reusing
already-established session cookies (backend HTTP login for a throwaway
QA admin account, and the user's own interactive logins for Dispatcher/
Technician) — never by entering a password into any browser field.

- Zero whole-page horizontal overflow confirmed (`document.
  documentElement.scrollWidth <= clientWidth`) across all 5 breakpoints on
  Calls list, Call Detail/CRM Context, Jobs list, My Jobs Today, and Job
  Detail (Admin, Dispatcher, and Technician sessions).
- One genuine overflow bug found and fixed along the way: the Phone
  Numbers admin tab's `<select>`-heavy table caused
  `document.documentElement`/`scrollingElement` to report a scrollable
  region wider than the viewport at 390px, despite every intermediate
  container (`.table-wrap`, `.card`, `<body>`) correctly self-clipping —
  a root-element overflow-calculation edge case. `window.scrollTo()`/
  `scrollWidth` gave misleading pass/fail signals for this specific bug in
  headless automation (both still report the same numbers even after a
  CSS-level fix); the fix was verified with a real mouse-wheel gesture
  test instead — confirmed the page genuinely does not scroll
  horizontally for an actual user interaction. Fixed with a global
  `html, body { overflow-x: clip; }` — confirmed safe: every existing
  wide-content case in the app already has its own dedicated
  `overflow-x: auto` container, so nothing relies on page-level
  horizontal scroll.
- Tablet (768) intentionally keeps the full sidebar visible (only hidden
  below the 640px breakpoint) — matches common responsive convention, not
  a defect.

### Independent reviews (both run against the actual diff, adversarially)

**Design-system/architecture review** — confirmed the root-cause button
fix was genuine reuse (not new CSS for the wrong classes), the `Badge`
vs. `StatusBadge` duplication is justified (different, non-widenable
status vocabularies), the off-canvas sidebar architecture correctly
avoids the `position:fixed`-inside-`transform` trap, and the global
`overflow-x: clip` fix is safe. Found and this pass fixed: the dead
sticky-bar padding rule (P1) and the unreachable drawer close button
(P2); found and this pass fixed: the `.po-crm-group*` design-system
duplication (P2). Found and accepted as pre-existing, not introduced by
this pass: a small number of `!important` overrides where `po-*` classes
compose onto `.form-group` (P3, documented, not fixed — a future
`.form-group` change could interact with these non-obviously).

**Accessibility review** — confirmed input-label association on every
surface this pass explicitly touched, real accessible names on all
icon-only buttons, status conveyed by text (never color-only), and
correct table semantics. Found and this pass fixed: the closed drawer's
keyboard/screen-reader trap (P0), missing Escape/focus-management on the
drawer (P1), under-sized touch targets on the follow-up action buttons
(P2 — "Mark Done"/"Add Follow-up" were ~24-26px tall with no min-height
at any breakpoint; now 44px, matching the app's own existing
`.tech-route-stop-actions .btn`/`.compliance-item .btn` precedent), and a
missing live region on the one-time, non-recoverable issued-credential
token banner (P2, `role="status"` added). Found and **explicitly not
fixed, documented as an accepted pre-existing limitation**: unassociated
`<label>`/`<input>` pairs in the Settings/Voice-Agents/Numbers/
Credentials admin tabs, and unkeyboardable `onClick`-only clickable table
rows on the Calls list — both are the exact same shape already present,
unmodified by this pass, across roughly 12-18 other files throughout the
app (`invoice-detail`, `quote-detail`, `customer-detail`, `create-lead`,
`contract-list`, `lead-list`, `dashboard`, etc.). This pass faithfully
replicated the existing house pattern into new code rather than
regressing anything, but fixing either issue properly means fixing the
*shared pattern* app-wide, not patching one file — explicitly out of
scope for a Phase 16 hardening pass per this project's own Module-Scoped
Change Rule ("do not redesign unrelated legacy modules"). Flagged as a
real, worthwhile follow-up at the shared-component level for a future
phase. Not claimed as WCAG-certified — this was a focused smoke pass
against the task's own 9-point checklist, not a full audit.

### Verification performed for this addendum

- `pnpm exec tsc --noEmit` / `pnpm exec eslint .` / `pnpm run
  check:architecture` / `pnpm run build` — all clean, both before and
  after the review-driven fixes.
- `pnpm vitest run --no-file-parallelism` — 56 files, 1328 tests, all
  passing (this pass touched no server-side code, so this reconfirms no
  regression rather than testing anything new).
- No client-side component test infrastructure exists in this codebase
  (the entire `test/` suite is `@cloudflare/vitest-pool-workers`-based,
  server/API-only — no jsdom, no `@testing-library`, no Preact rendering
  harness). Introducing one solely for this hardening pass would be a
  disproportionate, unauthorized dependency addition (`package.json` diff
  for this entire pass is empty — confirmed, no new dependency added).
  Real-browser Playwright verification is the evidence base for this
  addendum instead, consistent with the task's own acknowledgment that
  "unit tests do not replace real responsive browser acceptance."
- Photo upload and signature capture were verified with real files/real
  drawn strokes through the actual browser file input and canvas — not
  mocked.

### Remaining limitations (explicitly not claimed as resolved)

- No real assistive-technology (VoiceOver/NVDA/JAWS) pass was performed —
  the accessibility review was static code + Playwright DOM/focus
  assertions, not a live screen-reader walkthrough.
- No color-contrast ratio measurements were taken against the actual CSS
  custom-property values.
- The pre-existing app-wide unassociated-label and unkeyboardable-table-
  row patterns (above) remain, by explicit scope decision, not by
  oversight.
- This pass does not constitute or replace a future Phase 19A app-wide
  responsive audit — it is scoped to Phone Operations and the one
  Technician-mobile-blocking navigation defect.

## Next steps (not started, require explicit authorization)

- Phase 16 Safe Commit — commit this work (this phase's own explicit
  Commit Policy: implementation-only, stop at IMPLEMENTED/VERIFIED/
  BROWSER-ACCEPTED/UI-HARDENED/MOBILE-VERIFIED/NOT COMMITTED).
- The deferred `lead-conversion.ts` phone-normalization divergence, if a
  future phase touches Lead-conversion matching.
- The accepted P2 test-coverage gaps above, if this module's route
  surface grows.
- The deferred shared-pattern accessibility follow-ups (unassociated
  form labels, unkeyboardable clickable table rows) at the app-wide
  component level, in a future phase authorized to touch those other
  ~12-18 files.
- A future Phase 19A app-wide responsive audit (this pass is not a
  substitute).
- Live PSTN transfer execution, automatic Lead→Customer conversion,
  automatic dispatch, and Voice Copilot/Jarvis remain explicitly
  out of scope and not started.
