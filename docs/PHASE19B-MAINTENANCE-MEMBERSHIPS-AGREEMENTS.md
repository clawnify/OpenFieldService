# Phase 19B — Maintenance Plans, Memberships, Agreements, Legal Terms, Checklists, Service Reports

Status at the end of this phase: **IMPLEMENTED / VERIFIED / BROWSER-ACCEPTED / NOT COMMITTED.**
Sits on top of Phase 19A (`17b99a6`). No push, no deploy, no Phase 19C/19D, no Voice
Copilot, no Customer Portal performed in this phase.

## 1. Objective

Build the production-grade Residential maintenance foundation: Maintenance Plan
catalog, Customer Memberships, Maintenance Agreements with e-sign, Covered
Equipment (reusing Assets), a versioned Legal Terms library, separate
auto-renew consent evidence, Maintenance Checklist Templates, a Technician
maintenance workflow, Digital Maintenance Service Reports with PDF, and
entitlement tracking — with full tenant/RBAC/audit/security/browser/responsive
verification, on the existing Core Field Service platform.

Explicitly out of scope this phase (unimplemented, not silently dropped):
automatic recurring Job creation, 60/30/14 reminder automation, automatic
renewal execution, renewal billing, seasonal campaigns, referrals, loyalty
credits, post-job campaign automation, Reporting/Accounting expansion, Voice
Copilot, Commercial/Construction industries.

## 2. Architecture

### 2.1 Why a separate domain from Contracts, not a reuse of the `contracts` tables

A Maintenance Agreement is not a signed Quote — it carries genuinely different
fields (a Plan snapshot, covered equipment, auto-renew consent, entitlements)
and has no `quotes`/`quote_versions` binding. Contracts is an already-shipped,
independently-reviewed, historically-relied-upon module (Phase 13/13A); adding
a new, different lifecycle onto its tables would have meant either widening its
schema with Agreement-only columns (polluting a stable module) or overloading
its FSM with states that don't apply to Contracts. Per CLAUDE.md's Shared
Kernel Minimalism ("duplication is temporarily safer than premature
coupling"), Maintenance Agreements got their own parallel table set
(`maintenance_agreements` / `maintenance_agreement_versions` /
`maintenance_agreement_signers` / `maintenance_agreement_signature_requests` /
`maintenance_agreement_signature_events` / `maintenance_agreement_status_history`)
mirroring Contracts' shape field-for-field where the concept is the same.

What WAS reused directly, not duplicated:
- The PDF kernel (`src/server/pdf-writer.ts`) — `maintenance-agreement-pdf.ts`
  and `maintenance-service-report-pdf.ts` are new per-document renderers built
  on the exact same `PdfWriter` class as `contract-pdf.ts`/`invoice-pdf.ts`.
- R2 storage helpers (`src/server/storage.ts` — `putObject`/`getObject`/
  `assertUploadAllowed`).
- The Tax engine (`src/server/tax-jurisdiction.ts`) — `TaxSnapshotDocumentType`
  gained one new literal, `"maintenance_agreement"`; `resolveTaxProfile`/
  `calculateTaxes`/`createTaxSnapshot` are called as-is from
  `maintenance-agreements.ts#createAgreement`. Zero new tax logic.
- Company Profile (`src/server/company-profile.ts#getCompanyProfile`).
- Assets (`src/server/assets.ts` — covered equipment reads/validates against
  the existing `assets` table; no parallel equipment table).
- Job compliance RBAC (`src/server/workflow.ts#canActorAccessJobCompliance`/
  `actorTechnicianId`) — reused verbatim for Service Report access.
- `job_media` (Phase 4) — Service Report photos use a new `MediaKind` value
  (`"maintenance_report_photo"`) on the existing table, not a parallel one.

What was deliberately duplicated (small, low-risk, matches an existing
codebase convention): the bearer signing-token primitives (`generateSigningToken`/
`hashSigningToken`/`sha256HexBytes`, ~15 lines) in `maintenance-agreements.ts`
— `auth.ts` and `contracts.ts` already each keep their own copy of the same
tiny Web-Crypto primitives rather than sharing a "crypto-utils" module, so this
follows established precedent rather than introducing a new one.

### 2.2 Schema (migration `0027`, 18 new tables, fully additive)

- `legal_terms_documents` / `legal_terms_versions` — mirrors
  `contract_templates`/`contract_template_versions` exactly: identity row +
  versioned content rows, DRAFT freely editable, PUBLISH one-way and
  supersedes the prior published version (never rewritten/deleted).
- `maintenance_plans` — org-scoped catalog, `tier` a plain string (not a DB
  enum), integer-cents pricing, optional `visit_entitlement_count` (null =
  unlimited), discount/benefit fields as JSON arrays.
- `maintenance_agreements` / `maintenance_agreement_versions` /
  `maintenance_agreement_covered_equipment` / `maintenance_agreement_signers`
  / `maintenance_agreement_signature_requests` /
  `maintenance_agreement_signature_events` /
  `maintenance_agreement_status_history` / `maintenance_agreement_audit` — see
  §2.1. `maintenance_agreement_covered_equipment` stores an `asset_snapshot`
  JSON blob alongside a nullable `asset_id` (`ON DELETE SET NULL`) — an Asset
  CAN be hard-deleted once it has zero `job_assets` links, so the snapshot is
  the actual historical-reproduction guarantee, not the live FK alone.
- `maintenance_memberships` / `maintenance_membership_status_history` — a
  Membership is 1:1 with a signed Agreement (`UNIQUE(agreement_id)`), created
  as an idempotent side effect the moment an Agreement reaches `active`
  (mirrors `generateInvoiceForJob()`'s pattern from Phase 5).
- `maintenance_checklist_templates` / `maintenance_checklist_template_versions`
  — same versioned-identity shape as Legal Terms / Contract Templates.
- `maintenance_service_reports` — `job_id INTEGER NOT NULL UNIQUE REFERENCES
  jobs(id) ON DELETE CASCADE`. **No column was added to `jobs` itself** — see
  §2.3.
- `maintenance_entitlement_events` — append-only ledger,
  `UNIQUE(idempotency_key)` is the real double-consumption guard.
- `maintenance_admin_audit` — one polymorphic table (`entity_type`/`entity_id`)
  for low-volume admin-config events (plan/legal-terms/checklist-template
  create/update/publish/version), deliberately following
  `notification_outbox`'s entity_type/entity_id precedent rather than
  `job_status_history`'s per-domain-table precedent, since these three
  genuinely share one shape and volume — documented as a deliberate, reasoned
  deviation, not an oversight.

Full design rationale for every table is in the migration file's own header
comment (`migrations/0027_maintenance_plans.sql`) — not duplicated here.

### 2.3 Job/Technician integration without touching Core

Section 19's "a maintenance Job may reference Agreement/Membership, covered
asset, entitlement, checklist snapshot/template and Service Report" is
satisfied entirely through `maintenance_service_reports.job_id` (a reverse
lookup by job id) — **zero changes to the `jobs` table or
`src/server/workflow.ts`**. "Dispatcher manually associates a maintenance Job"
(Section 19/29) is modeled as *creating a DRAFT service report scoped to that
job* — the report row IS the association record; there is no separate
join/association table. This keeps Core's own schema and FSM completely
untouched, per CLAUDE.md's Module Boundary Law.

### 2.4 Agreement FSM

`draft → sent → viewed → signed → active`, with `cancelled` reachable
(reason-required) from any non-terminal state, and `expired`/`superseded`
reachable only as DERIVED transitions (never a bare user-chosen `to_status`):

- `signed`/`expired` are derived from signature-request aggregate status,
  exactly mirroring Contracts' `recalculateContractStatus()` pattern.
- `signed` collapses synchronously to `active` in the same call (no separate
  manual "activate" step, no cron) — this is the "safe, deterministic" rule
  Section 22 explicitly allows in place of real date-based activation
  scheduling, which is out of scope. Two distinct status-history rows are
  still written so both states remain individually auditable.
- `superseded` is new relative to Contracts (Contracts has no equivalent) —
  reachable only via `supersedeAgreement()`, an explicit staff action that
  creates a brand-new DRAFT Agreement and cross-links
  `supersedes_agreement_id`/`superseded_by_agreement_id`. Never automatic.
- Deliberately no `partially_signed` state (unlike Contracts) — this phase
  does not require multi-signer partial-completion tracking.

### 2.5 Legal Terms Library

Generic, org-scoped, versioned. `type` is one of `MAINTENANCE` /
`EQUIPMENT_SALE` / `INSTALLATION` / `QUOTE` / `CONTRACT` / `PAYMENT` /
`WARRANTY` — only `MAINTENANCE` is actually wired into a workflow this phase
(bound at Agreement creation via `legal_terms_document_id`); the other six
exist as usable, generic infrastructure a future phase can wire in without a
schema change, per the task's own explicit "not every type must be wired into
every existing workflow" instruction. Publishing computes a real SHA-256
`content_hash`; the exact `terms_version_id` + `content_hash` are frozen onto
the Agreement Version at creation time (`terms_snapshot_hash`) — a later
Terms edit/republish can never alter an already-created Agreement's frozen
reference. All seed/sample Terms content in this phase is placeholder text,
never presented as lawyer-approved — no legal-review claim is made anywhere
in code or UI.

### 2.6 E-Sign and auto-renew consent

Reuses Contracts' proven MECHANISMS (bearer token-hash link, append-only
signature-event ledger, snapshot-once-at-finalization PDF/hash/R2), applied
to the Agreement domain's own tables (§2.1). Auto-renew consent (Section 14)
is captured as a **separate, explicit, never-preselected** choice
(`auto_renew_enabled: boolean`, required, no default) at the same moment as
signing, stamped with the same real `ip`/`userAgent` already captured for the
signature, and logged as its own distinct `auto_renew_consent_recorded` event
in the signature-event ledger (not folded into the generic `signed` event) —
so a future audit can see it was captured as its own act.

### 2.7 Entitlements

`maintenance_entitlement_events` is an append-only ledger: one `grant` event
(+`visits_included`) at membership activation, one `consume` event (-1) per
finalized Service Report tied to that membership, each `consume` event keyed
by a `UNIQUE(idempotency_key)` derived from the triggering Service Report's
own id (`report:{id}:consume`) — a retry or concurrent duplicate finalize call
is a safe no-op, never a double-decrement (proven under real concurrency, see
§4). `visits_consumed`/`visits_remaining` are NEVER stored columns — always
computed live via `SUM(visit_delta)`, the same ledger-over-mutable-counter
discipline `getInvoiceFinancials()` established in Phase 5.

## 3. RBAC

Reuses the existing three roles only (`admin`/`dispatcher`/`technician`) — no
new role.

| Surface | Admin | Dispatcher | Technician |
|---|---|---|---|
| Plan catalog (write) | ✅ | ❌ | ❌ |
| Plan catalog (read) | ✅ | ✅ | ❌ |
| Legal Terms (publish/edit) | ✅ | ❌ | ❌ |
| Legal Terms (read) | ✅ | ✅ | ❌ |
| Checklist Templates (write) | ✅ | ❌ | ❌ |
| Checklist Templates (read) | ✅ | ✅ | ❌ |
| Agreements (full CRUD, send, cancel, supersede) | ✅ | ✅ | ❌ |
| Memberships (view/cancel) | ✅ | ✅ | ❌ |
| Service Reports — associate a job | ✅ | ✅ | ❌ |
| Service Reports — read/edit/finalize | ✅ | ✅ | own assigned job only |

Every RBAC gate runs before any database query on its route, matching this
codebase's established "RBAC before existence lookup" discipline
(`updateJob`'s own historical fix, reused verbatim as the pattern). Service
Report RBAC is not new logic — it's `canActorAccessJobCompliance`/
`actorTechnicianId` from `src/server/workflow.ts`, imported and reused as-is.

## 4. Historical integrity, entitlement idempotency — proven, not assumed

`test/maintenance-plans.test.ts`'s "Historical integrity" block: creates a
Plan + published MAINTENANCE Terms v1, creates and fully signs an Agreement,
records its signed-document hash, THEN edits the Plan's name/price and
publishes Terms v2 — re-fetches the already-signed Agreement and asserts its
frozen `plan_snapshot`, `total_price_cents`, `terms_version_id`, and
`signed_document_hash` are all byte-identical to before the edits.

`test/maintenance-plans.test.ts`'s "Membership entitlement" block: signs an
Agreement (creating a Membership with a fixed visit entitlement), finalizes
one Service Report, and fires **two genuinely concurrent** finalize requests
against the SAME report via `Promise.all` — asserts the ledger contains
exactly one `consume` event and the computed remaining-visits count decreases
by exactly one, not two.

## 5. Tenant isolation, IDOR, mass assignment

Every tenant-root table (`maintenance_plans`, `maintenance_agreements`,
`maintenance_memberships`, `maintenance_checklist_templates`,
`legal_terms_documents`) is scoped by `organization_id`, always derived
server-side via `actorOrganizationId(c)`, never from client input. Covered
equipment attachment verifies `asset.customer_id === agreement.customer_id`
before attaching — a cross-customer attempt is a 400, not silently ignored.
Public signing tokens follow Contracts' exact discipline: 256 bits of
randomness, only a SHA-256 hash stored, bound to exactly one agreement
version + one signer at creation, single-use (idempotent re-submit is a
no-op, not an error), auto-expiring on view past `expires_at`. Every Zod input
schema uses `.strict()` — no route accepts `organization_id`/`status`/
`created_by`/`token`/`token_hash`/`signed_document_*`/actor fields from the
client.

## 6. Verification gate

- `tsc --noEmit` — clean.
- `eslint .` — clean.
- `pnpm run check:architecture` — clean (no Core→module import, no
  HVAC→regional import).
- `pnpm run build` — clean.
- Migration `0027` applied cleanly as a genuine upgrade against the real,
  pre-existing local D1 database (not fresh-DB-only).
- Full `pnpm test` (final, post-review-fixes run): **59/59 test files,
  1454/1454 tests passing** — up from the Phase 19A baseline of 1414 (+40
  new `test/maintenance-plans.test.ts` tests: 23 written during
  implementation, 14 added by the independent Testing review closing real
  coverage gaps, 3 added afterward as regression tests for the Security
  review's P0 finding). An earlier full-suite run (during the independent
  Testing review, run concurrently with other activity) showed one
  unrelated transient timeout in `test/financial.test.ts` — a pre-existing,
  already-documented flakiness pattern in this codebase (full details in
  the Testing review's own report); the final clean run confirms it was
  not a regression.

## 7. Independent reviews (CLAUDE.md Multi-Agent Review Protocol)

Security, Architecture, and Testing reviews were run independently via the
Agent tool, in parallel, each with a fresh (non-forked) agent instance and a
complete, self-contained briefing — none saw the others' findings before
reporting.

**Security (Application Security Engineer) — found 1 P0, fixed:**
`createOrGetServiceReport()` (`maintenance-service-reports.ts`) accepted
client-supplied `agreement_id`/`membership_id`/`asset_id`/
`checklist_template_version_id` with **zero ownership validation** — an
authenticated actor in any organization could attach another organization's
Agreement/Membership/Asset/Checklist-Template-Version to their own Job,
reading the victim org's checklist content and, via `finalize` →
`consumeEntitlement`, silently draining the victim org's membership
entitlement with no record visible to the victim. **Fixed**: every optional
reference is now validated against `organization_id` (and, where a customer
relationship applies, the job's own `customer_id`) before being persisted,
mirroring the discipline `attachCoveredEquipment()` already applied to
Agreement covered-equipment. A new tenant-safe
`getChecklistTemplateVersionInOrganization()` was added (the prior bare
`getChecklistTemplateVersion(id)` had no tenant filter at all — never call
it with a client-supplied id again). Closed with 3 new regression tests
(`test/maintenance-plans.test.ts`, "Maintenance Service Reports" block)
proving the cross-org rejection on all four fields, that no report is left
behind by a rejected attempt, and that the victim org's entitlement ledger
is untouched. Three P3s disclosed, not fixed (low-impact, no action needed
this phase): `consumeEntitlement`'s catch-block is broader than strictly
necessary (fails closed either way); a theoretical TOCTOU window on asset
reassignment during `attachCoveredEquipment`; missing magic-byte validation
on signature/acknowledgement image uploads (currently unreachable — no
route exists yet that serves those bytes back out).

**Architecture (Software Architect) — ACCEPT WITH FINDINGS, 2 fixed:**
Confirmed the core design decisions are sound (separate-domain-from-
Contracts rationale, snapshot/versioning discipline traced through every
write path, entitlement ledger proportionate to its actual concurrency
requirement, RBAC split correct route-by-route, generic Legal Terms types
reasonable forward-compatible infrastructure, PDF/storage/tax reuse
genuine, scope control clean). Two real findings:
- **(HIGH, fixed)** The shipped client UI never wired several of its own
  headline capabilities: creating a Service Report never offered a
  Checklist Template, Agreement, or Asset picker (always POSTed `{}`), and
  creating an Agreement never offered a Legal Terms document picker —
  making the Checklist Templates feature and Terms-binding logic
  unreachable from the actual product despite being fully implemented and
  server-tested. **Fixed**: `job-maintenance-report.tsx`'s "Add Maintenance
  Report" flow now offers Agreement/Equipment/Checklist-Template pickers
  before creating (with the report's Membership auto-derived server-side
  from the picked Agreement — see below); `maintenance-agreement-list.tsx`'s
  "New Agreement" modal now offers a published-MAINTENANCE-Terms picker.
- **(MODERATE, fixed)** The audit trail (`maintenance_admin_audit`,
  `maintenance_agreement_audit`) was write-only — populated on every action
  but never read back by any route, and the three per-domain audit-write
  helpers (`recordPlanAudit`/`recordTemplateAudit`/`recordAdminAudit` in
  `legal-terms.ts`) each independently re-implemented an identical INSERT
  instead of sharing one, undercutting the migration's own consolidation
  rationale. **Fixed**: `legal-terms.ts#recordAdminAudit` is now genuinely
  shared (entity_type parameterized) and imported by `maintenance-plans.ts`/
  `maintenance-checklists.ts` instead of duplicated; a new
  `GET /api/maintenance/agreements/{id}/audit` route
  (`listAgreementAudit()`) exposes the Agreement-level trail. Plan/
  Checklist-Template/Legal-Terms admin-audit browsing UI is still not built
  this phase (Section 9 — disclosed limitation, not silently dropped).
- Also noted, not fixed (low priority, disclosed in Section 9): no
  un-associate/re-associate path for a Service Report's Agreement/
  Membership/Asset/Checklist once created; the client hardcodes the
  cancel-eligible Agreement status list instead of consuming a server
  "allowed transitions" endpoint the way Contracts does; the ~15-line
  crypto-token-helper duplication is judged proportionate (matches
  `auth.ts`/`contracts.ts`'s own established precedent).

**Testing (Test Automation Engineer) — found 1 real implementation bug
(fixed) and closed 14 coverage gaps:** Judged the original 23 tests
genuinely rigorous (real assertions throughout, no bare-200-status tests) —
the gaps were entirely breadth, not rigor: RBAC/tenant-isolation spot-checks
instead of full per-route coverage, `supersedeAgreement()` never exercised
at all, no forced-token-expiry test, and PDF content never text-extracted
(only hash existence checked). Added 14 tests closing exactly those gaps
(discount-validation edge cases, cross-org 404s for Memberships/Checklist-
Templates/Legal-Terms, a different-org — not just different-customer —
covered-equipment rejection, forced-expiry-then-404 on the public signing
token mirroring `contracts.test.ts`'s own precedent, illegal-bare-transition
and cancel-without-reason rejection, cancelling an already-active agreement,
`extractPdfText`-verified real content in both PDFs, and a SELECT-item-
with-no-options validation test). **Real bug found**: the new
`supersedeAgreement()` test (exercising a function that had zero prior
coverage) caught that `newAgreement` in the function's return value was
never re-fetched after its own `supersedes_agreement_id` UPDATE, so the API
response's `newAgreement.supersedes_agreement_id` was always `null` even
though the database row was correct. **Fixed**: both `oldAgreement` and
`newAgreement` are now re-fetched after all writes complete before being
returned.

## 8. Real browser acceptance

Real Playwright (`@playwright/test`) driven from a fork with a full,
self-contained briefing — never a typed password, only backend-login-then-
cookie-injection (the Phase 19A-established technique). **30/30 checks
passed, zero bugs found, zero console/network errors.**

- **Admin**: created a Plan, published Legal Terms (draft → publish, content
  hash confirmed), created a Checklist Template, created an Agreement,
  attached covered equipment, added a signer, sent for signature, copied
  the signing link.
- **Public signer** (separate unauthenticated tab): consent → typed
  signature → auto-renew Yes/No radios confirmed genuinely unselected
  before interaction → signed → "Signed successfully".
- **Admin** (same tab, reloaded): Agreement flipped to Active, a Membership
  section appeared, the signed PDF fetched and confirmed real (`%PDF`
  header, non-trivial byte length). Created a Job, used "Add Maintenance
  Report" (this walkthrough predates the picker-UI fix in Section 7 —
  re-verify the picker controls specifically in a future pass), filled in
  Work Performed/Findings/Recommendations, saved the draft, finalized —
  fields went read-only, status showed "(Finalized)", the Report PDF
  fetched and confirmed real.
- **Dispatcher**: sidebar shows all Maintenance nav items; can `GET` plans
  (200); cannot `POST` a new plan (403 — server-authoritative, not just UI
  hiding).
- **Technician**: sidebar hides all Maintenance nav items entirely; can
  read their own assigned job's report (200); a second, unassigned
  technician gets 403 on that same job's report via direct API probe; the
  assigned technician's Job Detail view never shows the association
  controls.
- **Public signer, invalid token**: generic "Link invalid or expired" page,
  not a crash.
- **Responsive spot-check** (1440×900 and 390×844 only — explicitly **not**
  the full 5-breakpoint sweep Phase 19A performed for the whole app; flagged
  as a spot-check, not full coverage): zero horizontal overflow on the
  Maintenance Agreements list, Agreement detail, and the public sign page,
  at both sizes checked.

**Follow-up real-browser re-verification of the Architecture Finding 1 fix
(picker UI)** — the Security P0 fix, the audit-trail fix, and the Testing-
found `supersedeAgreement` bug are all covered by real HTTP-level automated
tests only (`test/maintenance-plans.test.ts`, 59/59 files / 1454/1454 tests
passing including the new regression tests); the picker-UI addition
specifically was re-driven through a real Playwright session afterward
(same backend-login-then-cookie-injection technique, never a typed
password): the Agreement-creation modal's Legal Terms select correctly
listed a real published document and the created Agreement's version
correctly bound its `terms_version_id`; after signing the Agreement to
`active`, the Job Detail "Add Maintenance Report" panel correctly offered
Agreement/Equipment/Checklist-Template selects; picking all three and
creating the report correctly set `agreement_id`/`asset_id` from the
picker, rendered the selected checklist's item ("Filter OK") in the UI, and
**correctly auto-derived `membership_id`** from the picked Agreement with
no separate membership field required — the exact behavior Section 2.7's
auto-derivation fix was meant to provide. Zero console/network errors.
10/10 real checks passed (an 11th assertion in the verification script was
the author's own stale expectation, corrected before recording this
result). Scratch script deleted after use; dev server processes stopped.

## 9. Known limitations, documented not oversights

- Automatic renewal execution, reminder automation, and recurring Job
  creation are explicitly NOT implemented (Section 5's own boundary) —
  `renewal_preference`/auto-renew consent are captured as data only.
- No resend-signing-link route exists for Agreements (Contracts has one,
  `resendSignatureRequest`) — deferred; a fresh `sendAgreementForSignature`
  call is not idempotent-safe against an already-sent draft the way a
  dedicated resend would be, since `sendAgreementForSignature` requires
  `status === "draft"`.
- No decline-to-sign path for Agreements (Contracts has one) — the task's own
  public-signer walkthrough spec only requires
  valid/invalid/expired/reused-token behavior, not decline; omitted to keep
  scope tight.
- Checklist item types `MEASUREMENT`/`NUMBER` render as plain text inputs
  client-side (no numeric-only input mode or unit-of-measure field) — a
  reasonable first cut, not a data-model limitation (the server stores
  whatever string is submitted).
- No admin UI exists yet to browse `maintenance_admin_audit`/
  `maintenance_agreement_audit` — the data is recorded and queryable via the
  underlying server functions, but no dedicated route/page surfaces it this
  phase (mirrors several other audit tables in this codebase that also have
  no dedicated browsing UI yet).
- Dispatcher's UI for Plans/Legal Terms/Checklist Templates shows the same
  create/edit controls Admin sees rather than a genuinely read-only rendering
  (unlike Pricebook's own dispatcher-read-only UI treatment) — the
  server-side RBAC (`canManagePlans`/`canManageLegalTerms`/
  `canManageChecklistTemplates`, all admin-only) is what actually enforces
  this; a dispatcher clicking "New Plan" gets a real 403, not silent success.
  Disclosed as a UX rough edge, not a security gap.
- No dedicated Equipment Sale/Installation workflow consumes the
  `EQUIPMENT_SALE`/`INSTALLATION` Legal Terms types this phase (see §2.5).
