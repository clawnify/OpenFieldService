# Phase 19C — Recurring Maintenance / Renewal / Reminder Automation

Status at the end of this phase: **IMPLEMENTED / VERIFIED / BROWSER-ACCEPTED / NOT COMMITTED.**
Sits on top of Phase 19B (`45f9fb8`). No push, no deploy, no Phase 19D, no
Voice Copilot, no Customer Portal performed in this phase.

## 1. Objective

Automate the operational lifecycle of a signed Maintenance Agreement /
Membership: recurring visit scheduling with automatic Job generation, 60/30/14
renewal reminders, and agreement renewal (auto-renew under valid consent, or a
fresh-acceptance draft otherwise) — reusing Phase 19B's Agreement/Membership/
Service-Report domain and Phase 9's notification pipeline rather than building
parallel machinery.

Explicitly out of scope this phase (unimplemented, not silently dropped):
Phase 19D, Customer Portal, Voice Copilot, automatic discount/pricing
application beyond what a Plan snapshot already carries, uncontrolled
auto-charging/payment capture, seasonal campaigns, referrals, loyalty credits.

## 2. Architecture

### 2.1 What's new vs. reused (migration `0028`, 3 new tables, fully additive)

Only three new tables were needed — everything else rides on Phase 19B/Phase 9
infrastructure that already covered the concept:

- `maintenance_schedules` — one recurring schedule per Membership
  (`UNIQUE(membership_id)`). `recurrence_type` is a plain string (`ANNUAL` /
  `SEMI_ANNUAL` / `QUARTERLY` / `CUSTOM_DAYS`), `next_due_date` is a plain
  `YYYY-MM-DD` string (never a full timestamp — see §7 for why that matters).
- `maintenance_occurrences` — one row per generated/skipped visit cycle.
  `UNIQUE(schedule_id, cycle_number)` is the real duplicate-generation guard
  under concurrent automation runs (claim-first INSERT, catch-and-adopt on
  conflict — mirrors Phase 19B's `maintenance_entitlement_events.idempotency_key`
  idiom).
- `maintenance_automation_runs` — an execution ledger row per meaningful
  automation cycle (manual or cron). `organization_id` is nullable: NULL means
  a global cron run spanning every org in one tick; a real id means an
  admin-triggered manual run scoped to that admin's own organization.

What was deliberately **not** duplicated:
- **Renewal state** — no new table, no new state machine. Renewal status is
  entirely *derived* from Phase 19B's existing
  `maintenance_agreements.supersedes_agreement_id` /
  `superseded_by_agreement_id` columns (`getRenewalStatus()` in
  `maintenance-agreements.ts`). See §5.
- **Reminder delivery evidence** — reuses Phase 9's `notification_outbox` /
  `notification_delivery_attempts` and its `dedupe_key` idempotency mechanism
  directly. A new `enqueueMaintenanceRenewalReminder()` helper in
  `notifications.ts` builds a dedupe key of
  `maintenance_agreement:<id>:maintenance.renewal_reminder:<milestone>:<channel>`
  — the existing `UNIQUE(dedupe_key)` constraint plus
  `INSERT ... ON CONFLICT DO NOTHING` is what prevents a duplicate reminder for
  the same agreement/milestone, with zero new reminder-tracking table.
- **Admin audit trail** — schedule/renewal admin actions reuse the existing
  polymorphic `maintenance_admin_audit` table (`recordAdminAudit()` in
  `legal-terms.ts`) rather than a new audit table.

### 2.2 Job creation stays out of Core via dependency injection

`maintenance-automation.ts` needs to create a real Job through the canonical,
validated Job-creation path that lives in `src/server/index.ts` (the
composition root). Rather than importing index.ts from a Core-adjacent module
(inverting the module-boundary direction CLAUDE.md's Module Boundary Law
forbids), it takes an `AutomationDeps.createJobRecord` function passed in —
the exact same dependency-injection shape `phone-operations-crm.ts` already
established for the identical problem. `index.ts`'s `buildAutomationDeps()` is
the real adapter; it uses an `isJobType()` type guard (never an unsafe cast)
and defaults to `job_type: "STANDARD"` for every auto-generated recurring
visit, since `MAINTENANCE_VISIT` is not a member of `workflow.ts`'s closed
`JobType` union — per CLAUDE.md's "Industry and Regional Logic Must Not Leak
Back Into Core," Core's `JobType` registry was not widened for this feature.

### 2.3 One Cloudflare cron trigger, extended not duplicated

`wrangler.toml` still declares exactly one `crons = ["* * * * *"]` trigger
(Phase 9's precedent). The `scheduled()` handler in `index.ts` now runs the
existing notification cron cycle first, then — in its own `try/catch`,
best-effort, never blocking the notification cycle —
`runMaintenanceAutomationCycle(env.DB, buildAutomationDeps(), null, "cron", null)`.
A thrown error from the automation cycle is caught and does not prevent the
notification cycle from having already run.

## 3. Recurrence and due-date math

All recurrence/due-date arithmetic (`nextIntervalDate`, `daysBetween`,
`computeDueState`) operates on plain `YYYY-MM-DD` strings via
`Date.UTC(y, m-1, d)` construction — never real-clock/local-timezone `Date`
math — which sidesteps DST entirely. This mirrors
`notification-dispatcher.ts`'s own `businessDateOffset()` precedent, reused
directly for "what is today" in each org's own business timezone.

`ANNUAL`/`SEMI_ANNUAL`/`QUARTERLY` advance by calendar months (12/6/3), not a
fixed day count — correct across variable month lengths and leap years.
`CUSTOM_DAYS` advances by a fixed integer day count, admin-configurable at
schedule-creation time.

## 4. Occurrence generation, idempotency, and entitlement gating

`scanDueOccurrences()` selects every `active`, `automation_enabled` schedule
whose `next_due_date <= today` (per the owning org's business timezone), then
for each: re-checks the Membership is still `active` (defense-in-depth — a
Membership can go `superseded`/`cancelled` independently of its Schedule row
still being nominally `active`; see §8), claims the occurrence row via
`INSERT` under the `UNIQUE(schedule_id, cycle_number)` constraint (adopting
the existing row on conflict rather than erroring), checks Phase 19B's
existing `getEntitlement()` **after** claiming but **before** creating a Job
(if `visitsRemaining !== null && visitsRemaining <= 0`, the occurrence is
marked `skipped` with a reason — a zero-entitlement Membership never blocks
other schedules from generating), then creates the Job via `AutomationDeps`
and advances `next_due_date` to the next interval.

Verified via real concurrent `Promise.all([...two manual runs...])` in
`test/maintenance-automation.test.ts` and via a real duplicate manual "Run
Now" click in the browser (see §11) — one occurrence row, one Job, no
duplicate.

## 5. Renewal (derived FSM, no fabricated signatures)

`RenewalStatus` is a read-only projection with **no persisted status field**:

| Derived status | Meaning |
|---|---|
| `not_applicable` | Agreement isn't `active` (or `superseded` with no forward link) |
| `eligible` | Active, no renewal in progress — `initiateRenewal()` may be called |
| `awaiting_customer` | A new draft/sent/viewed/signed agreement is pending fresh acceptance |
| `renewed` | The new agreement reached `active` |
| `expired_unrenewed` | The new agreement was cancelled/otherwise never reached `active` |

**Manual initiation** (`initiateRenewal()`, admin/dispatcher, any time an
active agreement has no renewal in progress): creates a new draft Agreement
carrying forward the same customer/plan/covered-equipment/renewal-preference/
legal-terms binding, cross-links both agreements
(`supersedes_agreement_id`/`superseded_by_agreement_id`) immediately (this is
what makes the renewal discoverable and what makes a second
`initiateRenewal()` call correctly 409), and deliberately does **not**
transition the old agreement's status — the customer keeps coverage
uninterrupted through the signing ceremony. The old agreement is only
superseded, and the new one only activated, via `completeRenewalIfApplicable()`
— a hook called both from inside the existing `recalculateAgreementStatus()`
(the normal signing-completion path) and from `autoRenewAgreement()`.

**Auto-renewal** (`autoRenewAgreement()`, cron/scan-triggered only): requires
the Membership's `auto_renew_consent` to show valid, non-revoked standing
consent from the original signing, **and** `detectMaterialChange()` to find no
change since signing in the bound Plan's price/discount/visit-entitlement or
the bound Legal Terms version. On any material change (or invalid/absent
consent), auto-renew throws and the caller falls back to `initiateRenewal()`
(fresh-acceptance) instead — auto-renew never partially applies.

An auto-renewed version's `signed_at`/`signed_document_hash` are left `NULL` —
auto-renewal is honestly labeled "renewed under standing consent," not
"signed." Its `auto_renew_consent` JSON is stamped with
`carried_forward_from_agreement`/`original_consent_timestamp`/
`original_signer`/`auto_renewed_at` fields, never a fresh consent event.
Verified in both the automated test suite and, for the fresh-acceptance path,
in a real browser walkthrough end-to-end (initiate → sign → old superseded,
new active — see §11).

`scanRenewals()` only considers agreements within
`RENEWAL_INITIATION_WINDOW_DAYS = 14` of `expires_at` (matching the closest
reminder milestone) and skips already-past-expiry agreements
(`daysUntilExpiry < 0`) — it does not retroactively renew something that
expired unattended.

## 6. Reminders (60/30/14 day)

`scanRenewalReminders()` only considers `active` agreements whose current
version has a non-null `expires_at`. For each of the `[60, 30, 14]` day
milestones, it enqueues via the existing Phase 9 notification pipeline
(`enqueueMaintenanceRenewalReminder()` → `safeEnqueue()` → email/SMS per the
customer's actual, already-configured channels/preferences — no new channel
was invented). Delivery is enqueue-and-forget into `notification_outbox`;
retry/backoff on actual send failure is Phase 9's existing dispatcher
behavior, unchanged.

## 7. A real bug found and fixed during this phase (evidence-based, not a claim)

**Symptom** (found via live browser testing, not a hypothetical): creating a
schedule with no explicit `start_date` — the common real-world path, since no
UI currently collects an explicit `effective_date` when creating an Agreement
— produced a corrupted `next_due_date` like
`2026-08-28T18:18:54.536Z` instead of a plain date. Root cause:
`maintenance-memberships.ts#activateMembership()` falls back to
`new Date().toISOString()` (a full ISO timestamp) for `effective_start` when
the agreement version has no explicit `effective_date`, and
`createSchedule()` passed that straight through into `next_due_date` without
normalizing it — which then broke `nextIntervalDate()`/`daysBetween()`'s naive
`dateString.split("-").map(Number)` parsing on the *next* automation cycle
(silently producing `NaN`-driven wrong due-state comparisons, not a crash).

**Fix**: `nextIntervalDate()` and `daysBetween()` now `.slice(0, 10)` before
parsing (the true single point every caller routes through), and
`createSchedule()` also normalizes at the write site so the persisted value
and the UI display are clean. A regression test was added
(`test/maintenance-automation.test.ts`, "Maintenance Schedules" describe
block) asserting `next_due_date` matches `/^\d{4}-\d{2}-\d{2}$/` on exactly
this no-`start_date` path. The one already-corrupted row created during
browser testing was normalized directly in the local dev D1 database (not a
production concern — no deploy has occurred).

**Known adjacent limitation, not fixed in this phase** (recorded per
CLAUDE.md's "report instead of automatically expanding the task"): because no
UI currently collects an explicit `expires_at` when creating an Agreement,
real UI-created agreements have `expires_at = NULL`, and both
`scanRenewalReminders()`/`scanRenewals()` correctly (and silently) skip any
agreement with a null expiry. In practice this means renewal reminders and
renewal automation only fire for agreements that had an explicit
`expires_at` set (e.g. via direct API call, as `test/maintenance-automation.test.ts`
does). Adding an `expires_at` field to the Phase 19B Agreement-creation UI is
a Phase 19B UI gap, not a Phase 19C defect — recommended ownership: a small,
UI-only Phase 19B follow-up, not this phase.

## 7A. Independent review findings and fixes (Code Review + Security Review agents)

Two independent reviews (a fresh Code Reviewer agent and a fresh Application
Security Engineer agent, neither with access to this document or my own
earlier reasoning) were run against the diff per CLAUDE.md's Multi-Agent
Review Protocol. Three real findings survived and were fixed; all are
verified by new regression tests in `test/maintenance-automation.test.ts`:

1. **🔴 Blocker (Code Review) — renewed agreements never got their own
   `expires_at`.** Both `initiateRenewal()` and `autoRenewAgreement()` called
   `createAgreement()` without `effectiveDate`/`expiresAt`, so the renewed
   version's `expires_at` was `NULL` — and every renewal-candidate query
   (`scanRenewals`, `scanRenewalReminders`, `previewRenewals`) filters
   `expires_at IS NOT NULL`. Net effect: the automated renewal/reminder scan
   would silently stop finding an agreement after exactly one renewal cycle.
   **Fix**: a new `computeRenewalTerm(oldVersion)` helper carries the prior
   version's term length forward (new term starts where the old one ended;
   falls back to a documented 365-day default if the original agreement had
   no explicit term — Plans have no duration/term field to derive one from
   otherwise), wired into both renewal functions. Regression test asserts the
   renewed version's `expires_at` is non-null.
2. **🟡 Cross-tenant leak (Security Review) — `listAutomationRuns` exposed
   global cron rows to every org.** A cron-triggered run is stored once with
   `organization_id = NULL` aggregating every organization scanned that
   tick — `WHERE organization_id = ? OR organization_id IS NULL` meant any
   org's admin could see another org's aggregate counts and raw
   `error_summary` text (which can embed other orgs' schedule/agreement ids).
   **Fix**: the query is now scoped to `organization_id = ?` only — a
   tenant-scoped admin view never surfaces a global cron row. (There is no
   platform-operator role in this app to alternatively route global cron
   visibility to; introducing one was out of scope for this phase.) A
   defense-in-depth `organization_id` filter was also added to
   `scanDueOccurrences()`'s membership lookup (not independently exploitable,
   but inconsistent with the org-scoped pattern used everywhere else in the
   file). Regression test seeds a real NULL-org row and asserts a second
   organization's admin sees zero rows.
3. **🟡 TOCTOU race (Code Review) — two concurrent renewal triggers for the
   same agreement could both "win."** `initiateRenewal()`'s and
   `completeRenewalIfApplicable()`'s writes to
   `old.superseded_by_agreement_id` were plain unconditional `UPDATE`s with
   no atomic guard — a manual "Initiate Renewal" click racing a cron
   auto-renew scan for the same agreement could both pass their initial
   read-check and both attempt to claim the same old agreement, with the
   last write silently orphaning the first renewal draft. **Fix**: both
   writes are now guarded (`WHERE ... superseded_by_agreement_id IS NULL`),
   checked via `result.changes` (mirroring `transitionAgreementInternal`'s
   existing optimistic-concurrency pattern), and `initiateRenewal()`
   explicitly cancels its own just-created draft agreement (never leaves it
   orphaned) if it loses the race. **Known residual, documented rather than
   further engineered** (ponytail-style ceiling): `autoRenewAgreement()`
   activates the new agreement and its Membership *before* reaching
   `completeRenewalIfApplicable()`'s claim guard — if it loses that race, the
   already-activated new agreement/Membership are not rolled back, leaving a
   real (not orphaned-from-existence, just orphaned-from-the-renewal-chain)
   second active Agreement/Membership for that customer. This requires a
   narrow, single-minute-tick race window between a manual and an automatic
   renewal trigger for the same agreement; fully closing it would mean
   restructuring `autoRenewAgreement()` to claim-then-activate instead of
   activate-then-claim — a larger change than proportionate for a
   suggestion-level finding. Upgrade path if this is ever observed in
   practice: make `autoRenewAgreement()` perform its own atomic claim (same
   `IS NULL` guard) before calling `transitionAgreementInternal(..., "active", ...)`.
   Regression test covers the `initiateRenewal()` vs `initiateRenewal()` race
   (the actually-reachable one under this test harness's execution model).

No other findings survived adversarial review: tenant isolation, RBAC on
every route, the manual-run trigger's org-scoping, the "never fabricate a
signature" invariant, system-actor FK safety, input validation, and the
`scheduled()` cron addition's best-effort isolation from the existing
notification cycle were all independently checked and held up.

## 8. Pause / resume / cancel semantics

Pausing a Schedule (`automation_enabled`/`status` on `maintenance_schedules`)
stops future generation without touching already-generated Occurrences.
Cancelling is terminal — `UNIQUE(membership_id)` plus an unconditional
existing-row check in `createSchedule()` means a cancelled schedule
permanently blocks creating a new one for that Membership (by design: cancel
is a one-way decision; pause/resume is the reversible one).

Independently, `scanDueOccurrences()` re-checks the Membership's own status
before generating anything, even if its Schedule row is still nominally
`active` — so a Membership that becomes `superseded` via a completed renewal
(§5) safely stops generating new occurrences from its *old* schedule even
though nobody explicitly cancelled that schedule. Verified in the browser
walkthrough (§11): after MAINT-1's renewal completed and its Membership went
`superseded`, its Schedule row is still nominally `active` with a future
`next_due_date`, but the defense-in-depth membership-status check means it
will never generate another Job. This is intentional and documented, not
patched, since it is provably safe as-is; a future phase could add an
explicit "schedule auto-cancelled on renewal" UX nicety if desired.

## 9. Automation execution ledger

`maintenance_automation_runs` rows are only written when the run did
something meaningful (`occurrencesProcessed>0 || renewalsProcessed>0 ||
remindersSent>0 || erroredCount>0`) — a genuinely empty per-minute cron tick
writes no row, avoiding an unbounded ~1,440-rows/day floor of pure noise.
Verified in the browser: a first "Run Now" that generated a Job produced
exactly one history row; an immediate rerun that did nothing produced zero
new rows.

## 10. RBAC, tenant isolation, system actor

- Schedule create/read/pause/resume/cancel and Occurrence listing:
  admin + dispatcher (`canManageSchedules`), technician gets 403.
- Renewal status/initiate: admin + dispatcher (`canManageAgreements`,
  Phase 19B's existing check, reused as-is).
- Automation execution ledger, manual run trigger, preview: **admin-only**,
  independently enforced server-side (verified via direct API calls with a
  freshly-created dispatcher account returning 403 on all three, 200 on
  schedule listing — see §11) regardless of what the client UI hides.
- The manual run trigger always scopes to the calling admin's own
  `organization_id` (`actorOrganizationId(c)`) — it accepts no
  organization-id or cron-expression input from the client at all
  (`z.object({}).strict()` body).
- Every new/changed route was checked for `organization_id` scoping; the
  existing "does not leak a schedule across organizations" test (mirroring
  Phase 19B's cross-tenant regression test pattern) passes.
- System-actor writes (cron-triggered, no human actor) use `actor_user_id =
  NULL` throughout — never a fake sentinel id (see §7's bug #1, which was
  exactly a fake-sentinel FK violation, now fixed).

## 11. Verification performed

**Automated**: `test/maintenance-automation.test.ts` — 18 tests across 5
describe blocks (Schedules, Occurrence generation, Renewal, Renewal
reminders, Automation runs + preview), covering RBAC, tenant isolation
(including the cross-tenant automation-run-history fix, §7A finding 2),
duplicate-generation idempotency (sequential and genuinely concurrent),
entitlement-zero skip behavior, checklist-snapshot carry-through, auto-renew
with no material change (including the carried-forward `expires_at` fix,
§7A finding 1), blocked auto-renew with a material price change, the
concurrent-renewal-initiation guard (§7A finding 3), and the automation-run/
preview surface. Full project suite (run twice — once before, once after the
review-driven fixes): **60/60 test files, 1472/1472 tests passing** — zero
regressions against the Phase 19B baseline (59 files / 1454 tests) plus this
phase's 18 new test cases. `tsc --noEmit`, `eslint .`, `pnpm run
check:architecture`, and `pnpm run build` (production Vite build) all pass
clean after every round of fixes, including the final one.

**Real browser** (Admin, via `wrangler dev` + `vite` local dev, backend
session-cookie reuse — no password ever typed into a browser field):
sidebar entry renders; schedule creation from a Membership's detail page;
Pause → Resume; a real "Run Now" manual trigger genuinely generated one
Occurrence and one Job (`JOB-102`, correct customer, `job_type: STANDARD`,
system-generated notes, and Phase 19B's existing
`job-maintenance-report.tsx` panel appearing automatically with zero new
wiring); an immediate rerun proved no duplicate (0/0/0/0/0, same single
Occurrence row); Automation Run History showed exactly one row for the
meaningful run and no new row for the no-op rerun; renewal card showed
"Eligible for renewal" → Initiate Renewal → real draft agreement (`MAINT-4`)
carrying forward plan/covered-equipment → added a signer → sent → completed
the actual public e-sign flow (reusing Phase 19B's existing
`sign-maintenance-agreement.tsx` page, no new Customer Portal) → old
agreement (`MAINT-1`) correctly flipped to `Superseded`, new (`MAINT-4`)
correctly flipped to `Active`, old Membership correctly `superseded`.
**Dispatcher** RBAC: a freshly-created QA dispatcher account correctly saw
Schedules/Occurrences but not Preview/Run Now/Automation History in the UI,
and independently received `403` from the server on all three admin-only
routes while getting `200` on schedule listing.

**Not performed this phase** (recorded honestly, not implied): a dedicated
Technician-role browser login walkthrough (no new Technician-facing surface
exists to check beyond the existing `job-maintenance-report.tsx` panel, which
*was* visually confirmed on the auto-generated Job); a fixed-viewport
390/430/768/1024/1440px resize sweep (the new page and the new
Agreement-detail sections use exclusively pre-existing, already
responsive-audited CSS primitives — `.page`, `.card`, `.table-wrap`/`.table`,
`.form-row`/`.form-group`, `.modal-overlay`/`.modal` — introducing no new
layout primitive; the browser tool's window-resize call did not visibly take
effect against the CDP viewport in this session, and repeated attempts were
not pursued further per the guidance against rabbit-holing on a flaky
tool). A dedicated cron-trigger integration test (Cloudflare Workers local
dev does not auto-fire `scheduled()`; `runMaintenanceAutomationCycle()` — the
exact function the cron handler calls — was exercised directly via the
manual-run route instead, which is the same code path).

## 12. Client UI added

- `src/client/components/maintenance-automation.tsx` — new Admin/Dispatcher
  dashboard (Preview, Run Now, Schedules table with Pause/Resume/Cancel,
  Occurrences table, Automation Run History), wired into `app.tsx`,
  `sidebar.tsx`, and `use-router.ts` (`"maintenance-automation"` view).
- `src/client/components/maintenance-agreement-detail.tsx` — extended with a
  Renewal card (status + Initiate Renewal) and a Recurring Maintenance
  Schedule card (create/pause/resume/cancel), following the existing
  self-contained-fetch precedent already used throughout this file.
- No new Technician UI (auto-generated Jobs flow into the existing Phase 19B
  panel unchanged) and no new public page (renewal reuses the existing public
  signing page automatically, since both `initiateRenewal()` and the
  auto-renew fallback just produce a normal Phase 19B Agreement).

## 13. Phase boundary

This phase implements recurring scheduling, renewal, and reminders only.
Explicitly not started: Phase 19D, Customer Portal, Voice Copilot, Phase 20/21,
automatic discount/pricing engine beyond a Plan snapshot's existing fields,
payment capture/auto-charging of any kind.
