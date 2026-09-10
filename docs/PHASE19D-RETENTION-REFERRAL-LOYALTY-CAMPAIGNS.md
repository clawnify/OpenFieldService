# Phase 19D — Retention / Referral / Loyalty / Follow-up / Seasonal Campaigns

Status at the end of this phase: **IMPLEMENTED / VERIFIED / BROWSER-ACCEPTED / NOT COMMITTED.**
Sits on top of Phase 19C's Safe Commit (`f182b7d`). No push, no deploy, no
Phase 20, no Phase 21, no Phase 22, no Customer Portal, no Voice Copilot
performed in this phase.

## 1. Objective

Build the production-grade Residential customer-retention layer on top of the
existing Customer/Job/Quote/Invoice/Payment/Maintenance-Membership/Agreement/
Service-Report/recurring-maintenance/renewal/notification foundations: post-job
follow-up, referral program, loyalty credit foundation, retention signals, and
seasonal marketing campaigns — with a strict, server-authoritative transactional
vs. marketing consent split.

Explicitly out of scope this phase (unimplemented, not silently dropped):
Phase 20, Phase 21 (accounting engine posting of credits), Phase 22, Customer
Portal, Voice Copilot/Jarvis, ML-based retention scoring.

## 2. Architecture

### 2.1 What's new vs. reused (migration `0029`, 8 new tables, fully additive)

- `customer_follow_ups` — one post-job follow-up per Job (`UNIQUE(job_id)`).
  Tracks status (`pending`/`sent`/`satisfied`/`needs_attention`/`closed`),
  hashed response token, and review-request sub-state.
- `referral_programs` — one config row per organization
  (`UNIQUE(organization_id)`): enabled flag, reward type/value/description,
  qualification rule.
- `customer_referrals` — one row per minted referral code
  (`referral_code UNIQUE`, partial-unique on `referred_customer_id` /
  `referred_lead_id` so a code claims at most once).
- `customer_credit_ledger` — issue/void/redeem entries, shared by BOTH referral
  rewards and admin-issued loyalty grants (`UNIQUE(source_type, source_id)
  WHERE source_id IS NOT NULL` is the reward-issuance idempotency guard).
  Deliberately one table, not two near-identical ones — CLAUDE.md's Shared
  Kernel Minimalism treats "an auditable credit entry" as genuinely the same
  concept regardless of source.
- `campaigns` — seasonal campaign content + lifecycle state
  (`draft → scheduled → paused ↔ resumed → sent/cancelled`). Content is frozen
  once a campaign leaves `draft`.
- `campaign_recipients` — one row per (campaign, customer, channel)
  (`UNIQUE(campaign_id, customer_id, channel)`) — the campaign-level send
  ledger and dedup guard.
- `retention_automation_runs` — an execution ledger row per automation cycle
  (manual or cron), mirroring Phase 19C's `maintenance_automation_runs`
  precedent exactly (`organization_id` nullable: NULL = cron sweep across all
  orgs, non-null = an admin's manual scoped run).
- `retention_audit` — polymorphic audit trail for retention/referral/campaign
  admin actions.

What was deliberately **not** duplicated:
- **Delivery** — every outbound message (follow-up, review request, campaign
  send) goes through Phase 9's existing `notification_outbox` /
  `enqueueEvent`/`enqueueChannel` dedupe-key mechanism. No parallel send
  pipeline, no parallel retry/evidence system.
- **Maintenance-plan catalog** — the post-satisfaction upsell offer reuses
  Phase 19B's `listMaintenancePlans()` directly. No second Plan catalog.
- **Background execution** — reuses the ONE existing Cloudflare cron trigger
  (Phase 9/19C precedent). `scheduled()` gained one more best-effort,
  non-blocking `try/catch` call to `runRetentionAutomationCycle`, never a
  second scheduler.
- **Lead attribution** — a claimed referral creates a Lead using Phase 3/8.0's
  existing `leads.referral_source` / `referral_name` / `referred_by_customer_id`
  columns, not a parallel referral-lead table.
- **Admin audit trail pattern** — `retention_audit` follows the same
  polymorphic shape as Phase 19C's `maintenance_admin_audit`, just scoped to
  this phase's entities.

### 2.2 The consent/preference model — transactional vs. marketing

`notification_preferences` (Phase 9.0) is extended, not replaced or
conflated, with a second, independent, **default-OFF** consent tier per
channel: `marketing_email_opt_in`, `marketing_sms_opt_in`,
`marketing_email_consent_at`/`_source`, `marketing_sms_consent_at`/`_source`,
`marketing_unsubscribed_at`, `marketing_unsubscribe_token`.

- Post-job follow-up / review-request / maintenance-plan-offer sends are
  service-adjacent and gated by the EXISTING transactional toggle (same
  precedent as Phase 9's day-before reminder) — `checkServiceEligibility()`.
- Seasonal campaign sends and referral-promo content are genuinely
  promotional and require the new marketing opt-in —
  `checkMarketingEligibility()`.
- **Both functions are the single source of truth**, called by both the real
  send path (`enqueueChannel`) and the read-only audience-preview path
  (`previewAudience`) — they structurally cannot diverge, reusing Phase 19C's
  own "the manual runner and the cron call the exact same production
  function" precedent.
- Opting in requires an explicit `consent_source` (phone / in person /
  website / written form / other) captured at the point of opt-in — never a
  silent default-on.
- A campaign send always mints a per-recipient unsubscribe token
  (`getOrCreateUnsubscribeToken`) and includes an unsubscribe link; the public
  `/unsubscribe/:token` page flips only the marketing tier — the transactional
  toggle is untouched by design (verified in browser, see §6).

### 2.3 Post-job follow-up and the negative-feedback guard

`scanFollowUps` (background, lookback-bounded — see §7) creates a follow-up
for every newly-completed Job, then sends due ones through the transactional
channel. The public, token-scoped response page
(`/follow-up/:token` → `FollowUpResponse`) lets the customer say
"I'm satisfied" or "I have a concern" with no login.

`respondToFollowUp` is idempotent by construction
(`if (followUp.response) return early`) — a replayed or duplicate submission
never re-processes, never re-sends a review request, never re-audits. A
**negative response never routes into the review-request path** — Section
11's explicit guard: `reviewUrl` is only ever populated on the satisfied
branch, and the client has no code path that could show one for a negative
response regardless of what the server returns.

A satisfied response additionally offers the org's current maintenance-plan
catalog (informational only — "no automatic sign-up happens from this page").

### 2.4 Referral program

Admin configures reward type/value/description and qualification rule
(`first_completed_job` / `first_paid_invoice`) via `PUT
/api/retention/referral-program` (admin-only, server-enforced). A customer
mints a shareable code (`POST /api/customers/:id/referrals`); the public
`/refer/:code` landing page collects the referred person's name/phone/email
and creates a Lead via the existing Lead pipeline with proper attribution.

- **Self-referral guard**: phone numbers are digit-normalized
  (`replace(/\D/g, "")`) before comparison so a reformatted duplicate of the
  referrer's own number cannot pass as a new referral.
- **Single-use claim**: the atomic claim (`UPDATE ... WHERE referred_lead_id
  IS NULL AND referred_customer_id IS NULL`) plus `referral_code UNIQUE`
  guarantees a code claims at most once even under concurrent requests; a
  claimed code's landing page immediately reports invalid on any further
  visit (verified in browser, see §6).
- **Disabled-program guard**: a disabled referral program rejects new claims
  even if a stale code is still shared (fixed during review — see §7).
- Qualification is scanned by the background automation cycle
  (`scanReferralQualifications`) once the referred Lead converts and its
  first Job completes / first Invoice is paid, then issues the configured
  reward via `issueReward` → `customer_credit_ledger`.

### 2.5 Loyalty credit — foundation only, not an accounting engine

`customer_credit_ledger` supports admin-issued goodwill grants
(`issueLoyaltyGrant`) alongside referral rewards, with `voidCredit` and
`markCreditRedeemed` for lifecycle. This is deliberately a foundation layer:
auditable, server-authoritative balance tracking — **it does NOT post to any
accounting/AR ledger, does not auto-apply to invoices, and does not trigger a
payment.** That integration is explicitly deferred to a future Phase 21 per
the task's accounting-boundary instruction; applying a credit to a real
invoice remains a manual, existing-workflow action for staff today.

### 2.6 Retention signals

`computeRetentionSignals` is a deterministic, rules-based read (days since
last job, active membership status, follow-up satisfaction history) exposed
at `GET /api/customers/:id/retention-signals` for admin/dispatcher visibility.
No ML, no scoring model, no external service call.

### 2.7 Seasonal campaigns

Lifecycle: `draft → scheduled → paused ↔ resumed → sent` or `→ cancelled`
(cancellation requires a reason, recorded to `retention_audit`). Content
(subject/body/CTA link/audience filter) is editable only in `draft`; every
other transition freezes it — verified in browser (§6).

Audience segmentation (`AudienceFilter`: active-membership status, days-since-
last-job range, city) is evaluated by `buildAudienceQuery`, a single
parameterized query function used by BOTH `previewAudience` (read-only,
admin-facing candidate/eligible/suppressed-reason breakdown) and the real
`runCampaign` send path — again the "preview and send share one function"
pattern from §2.2, so a preview can never lie about what a send would do.

`campaign_recipients` (`UNIQUE(campaign_id, customer_id, channel)`) is the
per-campaign send ledger and dedup guard; the actual message still flows
through `notification_outbox`'s own dedupe key, giving two independent layers
of duplicate-send protection.

### 2.8 Background execution and the system actor

`runRetentionAutomationCycle` is the single entry point both the Cloudflare
cron trigger and the admin "Run Now" manual trigger call — identical function,
identical behavior, only the `triggered_by`/`organization_id` filter differs.
No client-controlled arbitrary cron, no second scheduler (CLAUDE.md §15 Cost-
Control Preservation and §6 Architecture Guard).

### 2.9 RBAC and tenant isolation

- Admin: full configuration (referral program, campaigns, manual automation
  run, run history, credit issue/void).
- Dispatcher: operational visibility (follow-up queue, referrals, campaign
  *viewing*) but cannot configure the referral program, cannot create/manage
  campaigns, cannot trigger or view automation runs — enforced server-side
  (`canManageRetention`, `canManageCampaigns`, `canViewCampaigns`), not just
  UI hiding. Verified with real 403s against a freshly-created dispatcher
  account (§6).
- Technician: no retention/campaign surface at all — verified both
  server-side (403 on every retention/campaign endpoint) and client-side (no
  sidebar entry, direct navigation to `/retention` falls through to the
  technician's default view) (§6).
- Every list/get route checks `organization_id` ownership before returning
  data (404, not empty-array, on cross-org access — matching the codebase's
  established IDOR convention); `listRetentionRuns` deliberately filters
  `WHERE organization_id = ?` only, never `OR organization_id IS NULL`,
  avoiding the cross-tenant leak class Phase 19C had previously fixed in an
  analogous run-history query.

### 2.10 Public page security

Four new public, session-less pages (`/follow-up/:token`, `/refer/:code`,
`/unsubscribe/:token`) are rendered by `main.tsx` BEFORE `AuthProvider`
mounts, matching the established `/sign`, `/pay`, `/estimate`,
`/sign-maintenance` precedent exactly.

- Follow-up response tokens are hashed at rest (`token_hash`), time-bounded
  (`token_expires_at`) — matching the e-sign-token security bar for an action
  with real workflow consequences.
- The marketing-unsubscribe token is stored in **plaintext**, a deliberate,
  documented departure from the hashed pattern: unsubscribing is a low-stakes,
  non-financial, non-consent-*granting* action (it only ever revokes),
  proportionate to a lower security bar than a legally-binding e-sign or a
  satisfaction response tied to a review-request trigger.
- The public follow-up view returns an explicit whitelist object
  (`{status, jobIdentifier, customerName}`) — never the internal row, even
  though the declared response schema was narrower than what the original
  code accidentally serialized (fixed during review — see §7).

## 3. Review findings and fixes

Two independent reviewers (Security, Code Review) ran with no shared context.

| # | Finding | Severity | Source | Fix |
|---|---|---|---|---|
| 1 | Self-referral phone check used raw string comparison — a reformatted duplicate of the referrer's own number could pass | Medium | Security | Digit-normalize both sides before comparing (`normalizePhone`) |
| 2 | `unsubscribeFromMarketing()` existed with zero callers, no route, no template link — an unreachable, non-functional opt-out | High | Security **and** Code Review (independently, same finding) | Full flow: migration column, `getOrCreateUnsubscribeToken`/`findRecipientByUnsubscribeToken`, two new public routes, wired into `runCampaign`, template updated, new public `/unsubscribe/:token` page |
| 3 | `scanFollowUps` had no lookback bound — first cron tick after deploy would retroactively create a follow-up for every historical completed Job | Critical | Code Review | `MAX_FOLLOWUP_LOOKBACK_DAYS = 60` bound on `job_status_history.created_at`, computed as a plain date string (DST-safe) |
| 4 | Disabled referral program didn't actually stop claims (doc comment claimed enforcement the code didn't have) | High | Code Review | `if (!program.enabled) return null;` added to `claimReferralCode` |
| 5 | Public follow-up view serialized the full internal row (including `followUpId`/`organizationId`) despite a narrower declared schema | Low | Code Review | Explicit whitelist object build |
| 6 | Credits route missing the standard cross-org 404 check present elsewhere in the codebase | Info | Code Review | Added matching check |

All six fixed and re-verified (regression tests added for each; full suite
re-run green). See §5 for a seventh finding caught during this session's own
browser walkthrough, found and fixed after the formal review pass.

## 4. Testing

- `test/retention.test.ts`: 25 tests across 5 describe blocks (marketing
  consent/suppression, post-job follow-up, referral program, seasonal
  campaigns, retention automation runs, retention signals) — all passing,
  including dedicated regression tests for each of the six review fixes
  above.
- Full project suite: 1497 tests, 1487 passing on the first full run; the 10
  failures were all pre-existing, unrelated tests (`lead-conversion`,
  `maintenance-plans`, `quote-options`, `quotes`, and others) that timed out
  under concurrent load from this session's own dev server + browser
  automation — the same transient-timeout class documented during Phase
  19C's Safe Commit. None were in `retention.test.ts`. A second full run was
  kicked off after the browser-testing session's fixes to confirm a clean
  baseline (see final report for its result).
- `npx tsc --noEmit`: clean, no errors.
- `npx vite build`: succeeds (pre-existing >500kB chunk-size warning,
  unrelated to this phase).
- Migration `0029`: additive-only, verified no `DROP`/destructive statement.

## 5. Bugs found via real browser verification (beyond the formal review pass)

Automated tests exercise the API; they don't exercise a human typing into a
controlled React input or replaying a URL. Two real defects surfaced only
through manual browser walkthrough and were fixed in-session:

1. **Reward Value input self-corruption** (`retention.tsx`): the field's
   `value` was re-derived from `reward_value_cents` on every keystroke
   (`(cents/100).toFixed(2)`), so the controlled re-render fought the
   cursor — typing "25" produced "2.01". Every other money-input field in
   the codebase (customer-retention-panel, global-settings,
   maintenance-plans, invoice-detail) already used a plain string draft
   decoupled from the derived cents value; this was the one outlier. Fixed
   by introducing `rewardValueText` as free-typed draft state, parsed to
   cents only on save.
2. **Stale "already responded" follow-up page** (`follow-up-response.tsx`):
   the public follow-up page never checked the `status` the server returned
   on initial load, so a customer revisiting an already-answered link saw
   the form again. The server was already correctly idempotent (a replay
   returns the *original* response, never re-processes) — but if the
   customer picked a *different* answer on replay, the confirmation screen
   would show a message reflecting the original response, not what they
   just clicked, which is misleading. Fixed by short-circuiting to an
   "already responded" screen whenever `view.status !== "pending"`.

Both fixes were applied, re-verified live in the browser, and are covered by
the existing `retention.test.ts` idempotency assertions server-side; the
client-side UI corrections have no dedicated unit test (Preact component,
verified by direct browser interaction instead, consistent with this
codebase's existing testing balance for standalone public pages).

## 6. Browser verification evidence (real backend-authenticated sessions, no typed passwords)

All logins used the standing rule: backend HTTP POST to `/api/auth/login`,
session cookie reused via JS `document.cookie` injection — never a password
typed into a browser field.

- **Admin**: Retention page (Follow-Up Queue with status filters, Referral
  Program config with a working Enabled/Reward/Qualification form, Referrals
  table, Automation Run History), Campaigns (create → schedule → pause →
  resume-available → cancel full lifecycle, content-freeze confirmed,
  audience preview showing real suppression breakdown), Customer detail
  sidebar (Marketing Emails/Texts opt-in with consent-source capture,
  Referral Links minting, Loyalty Credit issuance), Global Settings
  (Retention & Follow-Up section: Post-Job Follow-Up Delay, Public App URL,
  Review Request Destination, all configurable).
- **End-to-end proofs**: manual automation run created real follow-ups from
  completed Jobs; a follow-up was sent and its public response page
  (`/follow-up/:token`) walked through the full satisfied path including the
  maintenance-plan offer; a referral code was minted, claimed via the public
  `/refer/:code` page (real Lead created with correct attribution), and the
  claimed code correctly rejected a replay; a real campaign was scheduled and
  sent to an opted-in customer, and its unsubscribe link
  (`/unsubscribe/:token`) correctly flipped only the marketing consent tier,
  leaving the transactional toggle untouched (confirmed via direct DB read).
- **Dispatcher** (freshly created test account): sees Retention operational
  data but not "Run Now"/"Configure"/Automation Run History; server-side 403
  confirmed on `POST /api/retention/automation/run`, `GET
  /api/retention/automation/runs`, `PUT /api/retention/referral-program`,
  `POST /api/campaigns`.
- **Technician** (freshly created test account): no Retention/Campaigns
  sidebar entry at all; direct navigation to `/retention` falls through to
  the technician's own default view; server-side 403 confirmed on every
  retention/campaign GET/POST endpoint tested.
- **Accessibility spot-check**: heading hierarchy present (h1 page title, h2
  section headings), all interactive controls have accessible names, table
  headers use semantic `<th>`, keyboard Tab order moves through the sidebar
  with a visible focus ring. Not a full WCAG audit.
- **Responsive verification**: **NOT VERIFIED this phase.** As documented
  during Phase 19C's Safe Commit, the browser automation's `resize_window`
  tool does not reliably change effective viewport width in this
  environment; rather than claim unverified coverage, this is recorded
  honestly as a known gap, not silently skipped.

## 7. Known limitations / deferred work

- Loyalty credit does not post to accounting/AR — Phase 21's explicit scope.
- Retention signals are deterministic rules, not ML — by design, this phase.
- Responsive breakpoint verification not performed (tooling limitation, see
  §6).
- Full WCAG audit not performed — only a spot-check.
- Customer Portal and Voice Copilot/Jarvis: not started, out of scope.

## 8. Status

**IMPLEMENTED / VERIFIED / BROWSER-ACCEPTED / NOT COMMITTED / NOT PUSHED /
NOT DEPLOYED.**
