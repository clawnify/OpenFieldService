# Platform Generalization Audit — Phase 11.0

**Repository:** `open-fieldservice` (Cloudflare Workers + D1 + Preact)
**Audit date:** 2026-08-21
**Scope:** architecture discovery, classification, and boundary definition only. No refactor performed except where noted in §20.
**Baseline at audit time:** Phase 10.0–10.6 complete and verified, 923/923 tests passing, TypeScript/ESLint clean, HEAD `b7e3479`.

This document supersedes nothing in `docs/PRODUCT-GAP-AUDIT.md` (2026-08-14) — that audit predates the entire FSM upgrade (auth, RBAC, migrations, workflow engine, financials, leads, notifications, maps/routing all postdate it) and several of its findings (no auth, no migrations, no tests) are now resolved. Its multi-tenancy finding ("no company/tenant boundary... every endpoint is public") is **partially superseded**: auth/RBAC now exists, but the tenant-boundary gap it identified is **still accurate today** — see §14.

---

## 1. Executive summary

Open Fieldservice's core domain — authentication, RBAC, customers, jobs, scheduling, dispatch, the workflow engine, compliance, leads, notifications, Google Calendar sync, and the Maps/Geocoding/Routing stack — is **already substantially industry-neutral**. This was not a deliberate "build a platform" effort; it fell out of a series of narrowly-scoped, well-disciplined feature phases that consistently avoided baking HVAC assumptions into generic tables and generic endpoints. Concretely: of ~75 API endpoints, only 6 are HVAC/BC-rebate-specific, and every one of them is its own dedicated route (`/api/jobs/{id}/eligibility*`, `/api/customers/{id}/rebate-eligibility`, `/api/invoices/{id}/rebate`) rather than a branch inside a generic CRUD handler. Leads, technician compliance, financials, notifications, and the entire Maps/Routing stack (Phase 10) have **zero** HVAC or BC-program coupling anywhere in their schema or logic.

The HVAC/BC coupling that does exist is narrow but real, and concentrated in exactly four places:

1. **`jobs.job_type`** is constrained to a hardcoded 3-member TypeScript union (`"STANDARD" | "CLEANBC" | "BC_HYDRO"`) duplicated in three files (`src/server/workflow.ts`, `src/client/types.ts`, `src/client/job-type-labels.ts`) and enforced at the API boundary via `z.enum(JOB_TYPES)`. Adding a new job type — for a new industry OR a new region's incentive program — requires editing code in at least 4 files today.
2. **Five HVAC/rebate-profile columns sit directly on the generic `customers` table** (`house_size`, `primary_heating_source`, `number_of_adults`, `number_of_children`, `household_income`) rather than in a separate program-profile table.
3. **`src/server/rebate.ts`'s eligibility *calculation* engine is already generic and data-driven** (criteria read their thresholds from Global Settings by key name), but the *dispatch* from `job_type` to "which criteria apply" is a hardcoded `if (jobType === "CLEANBC") ... else if (jobType === "BC_HYDRO")` — the one place a real "incentive program registry" abstraction is missing.
4. **A handful of client-side label files and one nav item** (`Eligibility Tracker`) carry CleanBC/BC Hydro/Heat Pump wording, unconditionally shown regardless of whether a given deployment uses rebate-type jobs at all.

Separately, and more significantly for a SaaS roadmap: **the product has no tenant/organization concept anywhere** — not in the schema, not in auth, not in Global Settings, not in the identifier-numbering scheme. This is not a regression or an oversight to fix quickly; it is a genuinely unaddressed architectural layer. See §14 for the full, evidence-based classification: **NOT_READY**.

Nothing in this audit requires or recommends a big-bang rewrite. §19 proposes six small, independently-shippable sub-phases, each additive and each preserving current HVAC/CleanBC/BC Hydro behavior byte-for-byte.

---

## 2. Current architecture summary

```
Cloudflare Worker (Hono + @hono/zod-openapi)  ←→  Cloudflare D1 (SQLite)
        │                                              │
        └── src/server/index.ts (~4,900 lines,          13 migrations (0001–0013),
            every route registered here)                src/server/schema.sql = historical/inert
        │
        ├── workflow.ts        — job status state machine (3 hardcoded job types)
        ├── scheduling.ts      — conflict detection, schedule validation
        ├── rebate.ts          — CleanBC/BC Hydro eligibility calculator
        ├── financial.ts       — invoices/payments (integer cents, generic)
        ├── lead-workflow.ts, lead-conversion.ts — Lead pipeline (generic)
        ├── compliance.ts      — photos/reports/signatures (generic)
        ├── notification-*.ts  — outbox/dispatcher/templates (generic)
        ├── calendar-sync.ts, google-calendar.ts — Google Calendar (generic, provider-specific adapter)
        ├── geocoding.ts, google-geocoding.ts     — Geocoding (generic contract + Google adapter)
        ├── routing.ts, google-routing.ts         — Routing (generic contract + Google adapter)
        ├── settings.ts        — versioned Global Settings store (generic)
        └── auth.ts            — session auth, single global user pool, no tenant discriminator

Preact SPA (src/client/) — one build, no white-label/theming layer, "Field Scheduler" as a
hardcoded product name (not "Coreline" — the app's own branding is already generic)
```

**No organization/company/tenant table exists anywhere.** `users`, `customers`, `jobs`, `technicians`, `leads`, `invoices` are all flat, deployment-wide tables. RBAC is a single global `role` column on `users` (`admin | dispatcher | technician`) — there is no "admin of company A, technician of company B" concept because there is no company concept.

---

## 3. Core-vs-industry classification model

| Category | Definition used in this audit |
|---|---|
| **CORE** | Reusable across virtually any field-service business regardless of trade or region. |
| **INDUSTRY_HVAC** | Specific to HVAC as a trade (equipment types, HVAC vocabulary). |
| **REGIONAL_BC** | Specific to a jurisdiction/government/utility program (CleanBC, BC Hydro). |
| **TENANT_SPECIFIC** | Would plausibly differ per company even within the same industry/region (custom job types, branding, lead sources) — **not the same as "configurable"**: a field can be CORE and still be tenant-configurable (e.g. `service_types` rows). |
| **INFRASTRUCTURE** | An external provider's own implementation detail (Google Calendar OAuth shape, Google Maps tile requests). |
| **UNCLEAR** | Insufficient evidence to classify confidently without a product decision. |

---

## 4. HVAC-specific inventory

| Location | Concept | Classification | Evidence |
|---|---|---|---|
| `src/server/workflow.ts:10` | `export type JobType = "STANDARD" \| "CLEANBC" \| "BC_HYDRO"` | **HARDCODED_HVAC+BC_LOGIC** | Compile-time-closed union; no 4th value possible without editing this file |
| `src/server/workflow.ts:21-28` | `WORKFLOWS: Record<JobType, readonly string[]>` — 3 fixed status sequences | **HARDCODED_HVAC+BC_LOGIC** | `CLEANBC`/`BC_HYDRO` sequences (`free_estimate`, `application_pending`, `gov_portal_submitted`, etc.) are BC-program vocabulary; `STANDARD`'s sequence (`scheduled → in_progress → completed → invoiced`) is already trade-neutral |
| `src/server/index.ts:749` | `job_type: z.enum(JOB_TYPES as [JobType, ...])` on `POST /api/jobs` | **HARDCODED_HVAC+BC_LOGIC** | API-level enforcement, not just TS — a client cannot create a job with any other `job_type` value |
| `src/server/index.ts:2004` | `if (job.job_type !== "CLEANBC") return c.json({error: "Only CleanBC jobs have an eligibility code"}, 400)` | **HARDCODED_BC_LOGIC** | Literal string comparison inside an otherwise-generic eligibility route |
| `src/client/types.ts:16` | `export type JobType = "STANDARD" \| "CLEANBC" \| "BC_HYDRO"` | **HARDCODED_HVAC+BC_LOGIC** (duplicate #2) | Independent client-side copy of the same union |
| `src/client/job-type-labels.ts:3-9` | `JOB_TYPE_LABELS`, `JOB_TYPE_OPTIONS` | **HARDCODED_HVAC+BC_LOGIC** (duplicate #3) | "CleanBC Rebate" / "BC Hydro Rebate" hardcoded display strings |
| `migrations/0004_rebate_eligibility.sql:29-33` | `customers.house_size`, `.primary_heating_source`, `.number_of_adults`, `.number_of_children`, `.household_income` | **HARDCODED_HVAC_LOGIC (schema)** | HVAC-rebate-profile fields on the generic `customers` table, not a separate profile table |
| `src/server/rebate.ts:41-57` | `houseSizeCriterion(profile, asOf, key, used)` | **GENERIC_INFRASTRUCTURE_MISNAMED** | Function itself is fully generic — takes a Global Settings *key name* as a parameter; would work unchanged for any future square-footage-capped program |
| `src/server/rebate.ts:82-99` | `evaluateRebateEligibility()`'s `if (jobType === "CLEANBC") ... else if (jobType === "BC_HYDRO")` dispatch | **HARDCODED_BC_LOGIC** | The ONE place the generic criterion engine is wired to two specific, hardcoded program names — see §5 for the proposed fix boundary |
| `migrations/0004_rebate_eligibility.sql:53-58` | `HEATING_SOURCE_OPTIONS` Global Settings seed (`Electric/Natural Gas/Oil/Propane/Wood/Heat Pump/Other`) | **HARDCODED_HVAC_LOGIC (seed data)** | Already stored as admin-editable JSON (not hardcoded in a component), but conceptually HVAC-specific reference data living in the generic settings catalog |
| `src/client/settings-catalog.ts:69-126` | 6 of 9 catalog entries are `category: "Rebate Programs"`, `group: "CleanBC"` / `"BC Hydro"` | **HARDCODED_BC_LOGIC (presentation)** | Already naturally sub-grouped by program — a strong signal the eventual module boundary is easy to draw here |
| `src/client/components/sidebar.tsx:27` | `"Eligibility Tracker"` nav item | **HVAC_MODULE_UI** | Shown unconditionally to every admin/dispatcher regardless of whether the deployment uses rebate job types at all — no module-gating exists yet |
| `src/client/components/eligibility-tracker.tsx`, `create-customer.tsx`, `global-settings.tsx` | CleanBC/BC Hydro/heating-source form fields and copy | **HVAC_MODULE_UI / BC_PROGRAM_UI** | Confirmed via grep: exactly these 3 component files + the 2 label files above are the ENTIRE surface of HVAC/BC terminology in the client — it does not leak into `dashboard.tsx`, `sidebar.tsx` (beyond the one nav item), `schedule-view.tsx`, `job-detail.tsx`'s generic sections, or any Notification/Calendar/Maps component (all confirmed clean via grep) |
| `migrations/0001_baseline.sql:232-239, 256-262` | Seed `service_types` ("Standard Service", "Inspection", "Emergency"...) and `materials` ("Filter Replacement", "Sealant"...) | **TEST_FIXTURE_ONLY / TENANT_SPECIFIC** | Explicitly commented `-- Example service types (users customize for their vertical)` — this is starter data an admin is expected to replace, not hardcoded business logic; "Filter Replacement" is HVAC-flavored but trivially editable via the existing `service_types`/`materials` CRUD, already data not code |
| `src/server/notification-templates.ts` | Notification copy | **FALSE_POSITIVE (clean)** | Grepped for CleanBC/Heat/HVAC/Furnace: zero matches — fully generic |
| `src/client/components/dashboard.tsx` | Dashboard cards/metrics | **FALSE_POSITIVE (clean)** | Grepped: zero HVAC/rebate-specific content |

**Summary judgment**: the rebate/eligibility *mechanism* (Global-Settings-driven threshold criteria, append-only audit trail, expiring-code tracker) is already ~90% generic infrastructure. The coupling is concentrated in ONE dispatch function (`evaluateRebateEligibility`'s if/else) plus the `JobType` union's closure. This is a small, well-contained refactor target, not a systemic problem — see §19, Phase 11.3.

---

## 5. BC / CleanBC / BC Hydro inventory

Boundary answers (Section 4 of the task):

1. **Generic incentive-program infrastructure** (reusable as-is): `global_settings` versioned/effective-dated store; `job_rebate_audit` append-only trail; `houseSizeCriterion()`/`incomeCriterion()`; `listEligibilityCodes()`'s active/expiring/expired classification logic; `jobs.eligibility_code`/`eligibility_code_expiry` columns (generic "program code + expiry" shape, not BC-specific in name or type).
2. **HVAC-specific**: none of the rebate mechanism is HVAC-specific per se — it's a generic "government incentive program for a qualifying home-improvement job" shape that happens to only be wired to two BC programs today, both of which happen to be about heating equipment.
3. **BC-specific**: the `job_type` values themselves (`CLEANBC`, `BC_HYDRO`), the `evaluateRebateEligibility()` dispatch, the two `WORKFLOWS` sequences, the "Rebate Programs" settings category.
4. **CleanBC-specific**: `CLEANBC_MAX_HOUSE_SIZE`, `CLEANBC_MAX_HOUSEHOLD_INCOME`, `CLEANBC_ELIGIBILITY_WARNING_DAYS`, `CLEANBC_REBATE_AMOUNT_CENTS`, the `free_estimate → application_pending → eligibility_approved → install_scheduled → in_progress → completed → gov_portal_submitted` sequence.
5. **BC-Hydro-specific**: `BC_HYDRO_MAX_HOUSEHOLD_INCOME`, `BC_HYDRO_REBATE_AMOUNT_CENTS`, the (shorter) `free_estimate → install_scheduled → in_progress → completed → gov_portal_submitted` sequence.
6. **Hardcoded values**: **none** — this was a deliberate, audited decision as far back as Phase 3 (`migrations/0004_rebate_eligibility.sql`'s own comment: *"Deliberately NOT seeded here: any CleanBC/BC Hydro dollar, square-footage, or day-count threshold... this migration has no authority to invent those rules"*). Every real number lives in `global_settings`, admin-editable, versioned.
7. **Already in Global Settings**: all seven numeric/day thresholds above, plus `HEATING_SOURCE_OPTIONS`.
8. **Eligibility rules embedded in generic domain logic**: exactly one point — `workflow.ts`'s `validateRequiredData()` requires `eligibility_code`+`eligibility_code_expiry` before the `eligibility_approved` transition, gated by `job.job_type === "CLEANBC"` (a hardcoded string check inside the otherwise-generic `transitionJob()`).

### Proposed future boundary

```
Core Platform
  └── Incentive / Program Capability   (global_settings + job_rebate_audit + criterion evaluators — already ~built)
        ├── HVAC Program Module
        │     └── BC Programs
        │           ├── CleanBC      (job_type=CLEANBC, its WORKFLOWS sequence, its 4 settings keys)
        │           └── BC Hydro     (job_type=BC_HYDRO, its WORKFLOWS sequence, its 2 settings keys)
        └── future industry/region programs (e.g. a future province's own heat-pump rebate,
              or a future non-HVAC incentive program) — would reuse the SAME criterion
              evaluators and audit trail, just register a new job_type + WORKFLOWS entry +
              settings-key set
```

This matches the codebase's own already-emerging shape (`settings-catalog.ts`'s `group: "CleanBC"` / `"BC Hydro"` sub-grouping under one `"Rebate Programs"` category) closely enough that no redesign is needed — only a data-driven registry to replace the `if/else` in `evaluateRebateEligibility()` (§19, Phase 11.3).

---

## 6. Tenant-specific inventory

| Concept | Evidence | Notes |
|---|---|---|
| Product name "Field Scheduler" | Hardcoded string literal in ~14 places (`login.tsx:38`, `sidebar.tsx:48`, several toast/copy strings) | Already a generic, non-"Coreline" name — good baseline for future white-labeling, but not sourced from config today (P3) |
| `REFERRAL_SOURCE_OPTIONS` seed list | `migrations/0004`: `Google, Google Ads, Word of Mouth, Advertisement, Facebook, Instagram, Website, Referral, Existing Customer, Home Show, Other` | Plausible per-company customization (a different company's actual lead-source list) — already fully admin-editable via Global Settings, no code change needed to customize per deployment |
| `LEAD_LOST_REASON_OPTIONS` seed list | `migrations/0010` | Same as above — tenant-plausible, already configurable |
| Seed `service_types`/`materials` | `migrations/0001` | Starter/example data, explicitly documented as such, fully editable |
| Seeded admin account | `admin@fieldscheduler.local` | Single hardcoded bootstrap account — fine for single-tenant, would need per-tenant seeding in a real SaaS onboarding flow |

**No occurrence of "Coreline" found anywhere in `src/`.** No branding/theming layer, no per-company logo/color config, exists.

---

## 7. Database coupling findings

Every table across all 13 migrations, classified:

| Table | Tenant-scoping status | Recommendation |
|---|---|---|
| `users` | NONE (global) | `KEEP_IN_CORE` — would be the tenant-boundary ROOT if tenancy is added |
| `sessions` | NONE, but derives from `users` | `KEEP_IN_CORE` |
| `customers` | NONE (global) | `KEEP_IN_CORE`, but see below re: rebate columns |
| `customers.house_size/primary_heating_source/number_of_adults/number_of_children/household_income` | N/A | `MOVE_TO_HVAC_MODULE_LATER` — candidate for a separate `customer_hvac_rebate_profile` table, 1:1 with `customers`, only created for rebate-track customers |
| `technicians` | NONE (global) | `KEEP_IN_CORE` |
| `service_types` | NONE (global) | `KEEP_IN_CORE` — already fully data-driven/admin-editable |
| `materials` | NONE (global) | `KEEP_IN_CORE` |
| `jobs` | NONE (global) | `KEEP_IN_CORE` |
| `jobs.job_type` | N/A | `MAKE_CONFIGURABLE` — see §11/§19 Phase 11.3 |
| `jobs.eligibility_code/eligibility_code_expiry` | N/A | `KEEP_IN_CORE` (generic "program code" shape) but only meaningful when paired with a program-module job type |
| `job_notes`, `job_checklist`, `job_materials` | NONE (derive from `jobs`) | `KEEP_IN_CORE` |
| `invoices`, `invoice_lines`, `payments`, `invoice_audit` | NONE (global) | `KEEP_IN_CORE` — fully generic, integer-cents, payer-type-as-string already extensible |
| `job_status_history` | NONE (derives from `jobs`) | `KEEP_IN_CORE` |
| `job_rebate_audit` | NONE (derives from `jobs`) | `KEEP_IN_CORE` (generic audit shape; content is program-specific but the table isn't) |
| `job_media`, `job_completion_reports`, `job_signatures`, `job_compliance_audit` | NONE (derive from `jobs`) | `KEEP_IN_CORE` — zero HVAC coupling found |
| `leads`, `lead_status_history` | NONE (global) | `KEEP_IN_CORE` — explicitly audited at design time to have zero rebate/HVAC coupling (`migrations/0010`'s own comment) |
| `calendar_integrations`, `calendar_oauth_states`, `calendar_event_mappings`, `calendar_sync_claims` | Scoped to `user_id` (not tenant) | `KEEP_IN_CORE` (provider adapter) |
| `notification_outbox`, `notification_preferences`, `notification_delivery_attempts` | NONE (global) | `KEEP_IN_CORE` |
| `global_settings` | **NONE — single global table, no tenant column** | `NEEDS_MORE_EVIDENCE` for tenancy (would need either a `tenant_id` column + composite resolution key, or a documented "some settings stay global, some become per-tenant" split — e.g. `BUSINESS_TIMEZONE` is obviously per-tenant, but the *versioned/effective-dated resolution mechanism itself* is reusable as-is) |
| `_meta` | **NONE — single global key/value table, holds `job_counter`/`invoice_counter`/`lead_counter`/`identifier_prefix`/`invoice_prefix`/`lead_prefix`/`timezone`** | `NEEDS_MORE_EVIDENCE` — this is the single sharpest tenancy blocker in the schema: two tenants today would share one job-number sequence |
| `jobs.identifier`, `invoices.identifier`, `leads.identifier` | `UNIQUE` constraint, global | Would need to become `UNIQUE(tenant_id, identifier)` if tenancy is added |
| `users.email` | `UNIQUE` constraint, global (`migrations/0001:137`) | Would need to become `UNIQUE(tenant_id, email)` for genuine multi-tenant self-serve signup |

No historical migration was rewritten, no data was dropped, no destructive migration was created, per instruction.

---

## 8. API coupling findings

75 registered `/api/*` routes were enumerated (`grep -oE 'path: "/api/[^"]*"' src/server/index.ts`). Only **6 are HVAC/BC-rebate-specific**, and every one is its own dedicated route:

```
GET  /api/customers/{id}/rebate-eligibility
POST /api/jobs/{id}/eligibility-check
PUT  /api/jobs/{id}/eligibility
GET  /api/jobs/{id}/rebate-audit
GET  /api/jobs/eligibility-codes
GET  /api/invoices/{id}/rebate
```

The other ~69 routes (auth, customers, jobs CRUD, scheduling, workflow transitions, leads, materials/service-types, invoices core, compliance, notifications, Google Calendar, Maps/Geocoding/Routing, settings, users/technicians) are generic — **confirmed by direct inspection, not assumption**.

**One leak point found**: `POST /api/jobs` and `PUT /api/jobs/{id}`'s Zod schemas embed `z.enum(JOB_TYPES)` directly (`index.ts:749`), and `index.ts:2004` has a literal `job.job_type !== "CLEANBC"` string check inside the `eligibility` route. This is the API-layer mirror of the `workflow.ts` coupling in §4 — not a second, independent problem.

A `/api/core/...` vs `/api/modules/hvac/...` URL restructure is **not recommended** — the existing flat `/api/jobs/{id}/eligibility*` naming already communicates the module boundary clearly enough, and a URL reshuffle would be pure churn with no architectural benefit (every consumer, test, and OpenAPI doc would need updating for zero behavior change).

---

## 9. UI/terminology findings

See §4's table for the full inventory. Summary: HVAC/BC terminology is confirmed (via grep across all of `src/client/components/*.tsx`) to be contained to exactly 5 files: `job-type-labels.ts`, `settings-catalog.ts`, `create-customer.tsx`, `eligibility-tracker.tsx`, `global-settings.tsx`, plus one sidebar nav item. `dashboard.tsx`, `schedule-view.tsx`, `job-detail.tsx`'s core sections, and every Notification/Calendar/Maps component are confirmed clean.

Recommended terminology sourcing model for a future phase (not built now):
- **Core fixed terminology** (Job, Customer, Technician, Schedule, Invoice) — stays as literal strings in core components; not worth externalizing without a real second industry to prove the abstraction.
- **Module-owned terminology** ("Eligibility Tracker", "CleanBC Rebate") — should move to a small per-module label registry (mirroring the existing `job-type-labels.ts`/`role-labels.ts` precedent) so a deployment without the HVAC/BC module loaded never renders it.
- **Tenant configuration** — out of scope until real tenancy exists (§14); premature to build a white-label terminology layer before there's a second tenant to prove it against.
- Full i18n/localization: explicitly not recommended this phase — no evidence of demand, would be pure speculative investment.

---

## 10. Workflow findings

| Rule | Classification | Evidence |
|---|---|---|
| Universal `cancelled` transition + reopen-to-prior-status | **CORE** | `workflow.ts`'s `resolveAllowedTransitions()` — job-type-agnostic |
| `STANDARD` sequence (`scheduled → in_progress → completed → invoiced`) | **CORE** | Already trade-neutral; would fit Electrical/Plumbing/Cleaning unchanged |
| `CLEANBC`/`BC_HYDRO` sequences | **INDUSTRY** (BC-program, not HVAC-trade per se) | See §5 |
| `canActorTransition()` RBAC (admin/dispatcher any; technician only `in_progress`/`completed` on own job) | **CORE** | Job-type-agnostic |
| `canCompleteJob()`'s "technician must be assigned" + Phase 4's photo/report/signature requirements | **CORE** | Generic compliance-gate shape, zero HVAC coupling |
| `job_status_history` append-only audit | **CORE** | Generic shape, reused verbatim by 5 other domain audit tables |
| `eligibility_approved` transition's required-data gate | **INDUSTRY/REGIONAL** | The only transition-level rule with a hardcoded `job_type === "CLEANBC"` check |

**Is the workflow engine genuinely industry-neutral?** Mostly yes — the *mechanism* (`WORKFLOWS: Record<JobType, string[]>`, RBAC, history, completion-gate) is fully generic and already proven to support 3 independently-shaped sequences without any special-casing beyond a lookup by `job_type`. **Can different tenants/industries define their own workflow later?** Structurally yes, IF `JobType` and `WORKFLOWS` become data (a `job_type_definitions` table or Global-Settings-driven registry) instead of a closed TS union — this is a well-scoped, low-risk change because every consumer already goes through `resolveAllowedTransitions()`/`entryStatus()`/`WORKFLOWS[jobType]` rather than hardcoding a status list independently (confirmed in `mem:phase2/workflow-engine`: *"the client has zero transition-validation logic of its own by design, it only ever renders what the server's `/transitions` endpoint says is allowed"*).

---

## 11. Job/service-type findings

`job_type` today supports exactly 3 hardcoded values (§4). `service_type_id` (a proper FK to the `service_types` table) is **already fully generic and data-driven** — an admin can add/edit/delete service types via `/api/service-types` with zero code change, and nothing in scheduling, invoicing, or reporting assumes a specific service-type value. **These are two different axes that are easy to conflate**: `service_type_id` already supports Electrical/Plumbing/Cleaning/etc. today (just add rows); `job_type` (the workflow-selector) does not.

Recommendation: **do not collapse these into one concept.** `service_type_id` should remain the "what kind of visit is this" data-driven axis (already correct). `job_type` should become a small, admin-manageable **registry** (new table, e.g. `job_type_definitions(code, label, workflow_json, ...)`) rather than either (a) a free-form string (would lose the compile-time/API-time safety that currently prevents typos and enforces a real, intentional workflow) or (b) staying a closed TS union (blocks any new type without a code change). This is a controlled-extensibility model, not a "convert everything to strings" shortcut — consistent with the explicit constraint not to do the latter.

---

## 12. Customer/property/asset findings

There is **no Property/Location/Asset/Equipment entity anywhere** in the schema. `jobs.address` is a single flat TEXT column, snapshotted from the customer's address at job-creation time (already confirmed in `mem:phase10/maps-routing-architecture-audit`: *"jobs.address... is the authoritative, already-snapshotted service location"*). A customer with multiple properties, or a piece of tracked equipment (an HVAC unit, an electrical panel, a water heater) with its own service history, has no home in the current model.

This is a genuine future gap for any industry where equipment-level history matters (which is most of them — HVAC units, electrical panels, appliances, generators, security systems all benefit from a persistent asset record independent of any one job). **Not recommended to build now** — no current feature needs it, and inventing the shape speculatively risks getting it wrong. Flagged as `NEEDS_MORE_EVIDENCE` / a real future phase (§19 mentions it as an optional 11.4, gated on actual demand).

---

## 13. Technician/workforce findings

`technicians` is a flat `name/email/phone/color/active/user_id` record — **zero skills/certification/trade/capability modeling exists anywhere** (confirmed via repo-wide grep for `skill|certification|trade|specialt`: zero matches). Assignment is entirely manual (a dispatcher picks a technician from a dropdown); scheduling conflict-detection (`scheduling.ts`) and routing (Phase 10) are both technician-agnostic beyond "this technician is busy at this time" / "this technician's own scheduled jobs today."

This is **already trade-neutral by omission** — nothing assumes an HVAC technician specifically — but also means there's no way to prevent (or assist) assigning an electrician to a plumbing job once multiple trades coexist. A future `skills`/`certifications`/`trade` concept is a real, evidence-supported future need once a second industry module exists, not before. Not built now.

---

## 14. Integration/provider findings

| Integration | Classification | Evidence |
|---|---|---|
| Google Calendar (`google-calendar.ts`, `calendar-sync.ts`) | **DOMAIN_COUPLED** | Corrected on re-verification: unlike Geocoding/Routing/Email/SMS below, **no generic `CalendarProvider` interface exists**. `google-calendar.ts` exports only Google-named types (`GoogleOAuthEnv`, `GoogleTokenResponse`, `GoogleCalendarListEntry`, `GoogleEventInput`) and Google-shaped functions (`insertEvent`/`updateEvent`/`deleteEvent`); `calendar-sync.ts` (the business-logic layer) imports these Google-specific types directly rather than a provider-agnostic contract. It IS cleanly isolated to 2 files (a real positive), but "isolated" and "abstracted behind a swappable interface" are different properties — this one only has the former today. |
| Google Geocoding (`geocoding.ts` contract + `google-geocoding.ts` adapter) | **GENERIC_CAPABILITY + PROVIDER_ADAPTER** | `GeocodingProvider` interface is provider-agnostic by design (Phase 10.0); `NoopGeocodingProvider`/`MockGeocodingProvider` already prove the contract doesn't leak Google specifics |
| Google Routes (`routing.ts` contract + `google-routing.ts` adapter) | **GENERIC_CAPABILITY + PROVIDER_ADAPTER** | Same pattern, `RoutingProvider`/`RouteResult` — confirmed clean in Phase 10.4/10.5's own audits |
| Google Maps JS (browser loader) | **PROVIDER_ADAPTER** | `google-maps-loader.ts` is Google-specific by necessity (no generic "map renderer" interface exists client-side — not needed until a second map provider is actually required) |
| Resend (email) | **GENERIC_CAPABILITY + PROVIDER_ADAPTER** | `notification-providers.ts` defines a zero-dependency `EmailProvider { send(input): Promise<ProviderSendResult> }` interface; `notification-dispatcher.ts` imports only that interface + the adapter factory, never Resend-specific types directly — same clean shape as Geocoding/Routing |
| Twilio (SMS) | **GENERIC_CAPABILITY + PROVIDER_ADAPTER** | Same file/pattern as Resend — a generic `SmsProvider` interface in `notification-providers.ts`, Twilio specifics isolated to `notification-twilio.ts` |
| Cloudflare R2 (`storage.ts`) | **DOMAIN_COUPLED** | `StorageEnv.MEDIA` is typed directly as the Workers-native `R2Bucket`, and `getObject()`/`putObject()` take/return R2-native types (`R2ObjectBody`) directly — no generic `ObjectStorage` interface exists. The business logic around it (key-building, content-type allowlist, size limits) is itself generic and well-isolated; only the binding/return types are R2-coupled. A future S3-compatible swap would mean changing this file's public signatures, not just adding a new adapter file. |
| Cloudflare D1 (`db.ts`) | **GENERIC_CAPABILITY** (access layer), informational SQLite coupling elsewhere | `db.ts` is a 1-line re-export of `@clawnify/db`'s generic `query`/`get`/`run`/`initDB` — no D1-specific API leaks through it. Business logic throughout `src/server/*.ts` does write raw SQL inline (no query builder/ORM) with some SQLite-specific syntax (`INSERT OR IGNORE`, `db.batch()` atomicity) — informational only, not a blocker at current scale, and explicitly out of this audit's scope to fix. |

**No generic capability is unnecessarily branded around one provider.** The Geocoding/Routing (Phase 10) and Email/SMS (Phase 9.2) integrations already demonstrate the correct shape — a zero-dependency interface + isolated adapter file(s) + a `buildXProvider(env)` factory — and should be the template for any future work on Calendar or Storage, which do not yet have this shape (real but moderate, P2, architectural couplings — see §17 G13/G14 — not blockers, since both integrations already degrade gracefully when unconfigured).

---

## 15. SaaS/multi-tenant readiness audit

**Classification: NOT_READY**

Direct evidence:

1. **No organization/tenant/company/account table or column exists anywhere** — confirmed via a repo-wide grep of every migration and `schema.sql` for `tenant`, `organization`, `company`, `org_id`, `account_id`: zero matches beyond ordinary English words in comments (e.g. "company" in prose).
2. **Global singleton counters**: `_meta` (`migrations/0001_baseline.sql:218-229`) holds exactly one `job_counter`, one `invoice_counter`, one `lead_counter`, one `identifier_prefix`, one `invoice_prefix`, one `lead_prefix`, one `timezone` — a second tenant today would collide on job/invoice/lead numbering and would be forced to share one business timezone.
3. **Global uniqueness**: `users.email UNIQUE` (`migrations/0001:137`), `jobs.identifier UNIQUE`, `invoices.identifier UNIQUE`, `leads.identifier UNIQUE` (`migrations/0010:91`) — all single-column, not `UNIQUE(tenant_id, ...)`.
4. **`global_settings` is a single global table** (`migrations/0002:30-43`) — `BUSINESS_TIMEZONE`, every CleanBC/BC-Hydro threshold, `REFERRAL_SOURCE_OPTIONS`, etc. are shared across the entire deployment, not per-tenant.
5. **RBAC roles are global, not per-tenant** — `users.role` is a single column; there is no concept of a user having different roles in different companies, because there is no company concept for a role to be scoped to.
6. **`calendar_integrations` is scoped to `user_id`**, which incidentally makes Calendar OAuth tokens "safe" in a narrow sense (no cross-user leakage), but provides no company-level isolation — a second tenant's users would simply be more rows in the same global table, invisible to each other only because nothing currently lets one user query another's data (an accident of the current app's read-scoping, not a designed tenant boundary).
7. **Auth (`src/server/auth.ts`) assumes one global user pool** — login resolves `email` against the entire `users` table with no tenant discriminator; there is no "which company are you signing into" step anywhere in the login flow.
8. **Notifications, leads, jobs, invoices** — all flat, all globally queryable by any admin/dispatcher role (by design, today, since there's only one company).

**Invasiveness estimate for adding tenancy later**: the **schema change itself is mechanically additive and NOT deeply invasive** — the foreign-key graph is clean (nearly everything roots through `users`/`customers`/`technicians`/`jobs`, no problematic many-to-many tangles were found). A `tenant_id` column would need to be added to roughly 10 root/near-root tables (`users`, `customers`, `technicians`, `jobs`, `leads`, `invoices`, `materials`, `service_types`, `global_settings`, and a per-tenant `_meta`-equivalent), with 4 unique constraints becoming composite (`users.email`, and the 3 identifier columns). The genuinely invasive part is **application-layer**: every one of the ~75 API endpoints that currently trusts "there is only one company" would need a tenant-scoping filter added to its queries — comparable in scope to this codebase's own prior technician-read-scoping and job-update-ownership-bypass retrofits (both real, completed prior efforts, each touching many endpoints one at a time; see `mem:risks/technician-job-read-scoping` and `mem:risks/job-update-ownership-bypass`). This is a **precedented, systematic, endpoint-by-endpoint rollout**, not a rewrite — realistically a dedicated multi-session phase (§19, Phase 11.5), not a quick patch.

---

## 16. Future-module readiness

**Quotes/Estimates/Contracts**: no blocking architectural conflict found. The existing `invoice_lines`/integer-cents/`invoice_audit` patterns (Phase 5) are a strong, directly reusable template for quote line-items and versioning. `leads.estimated_value_cents` already exists as an informational placeholder with an explicit "never written to `jobs.price` or any invoice table" boundary (migration 0010) — a real Quote entity would sit between Lead and Job/Invoice, linked by FK, without touching either's current schema.

**Reporting**: no blocking conflict. The consistent integer-cents convention (Phase 5), the consistent append-only audit-table pattern (6 domain audit tables already exist, same shape), and generic `service_type_id`/`job_type` foreign keys give a reporting layer clean joins to build from. No current design decision (e.g. a JSON blob standing in for structured data) would need undoing first.

**Accounting/Financial Management**: the existing `payments.payer_type` (a plain string, not an enum or FK — explicitly designed for exactly this kind of future extensibility per `mem:phase5/financial-invoicing`) and the `invoice_audit` trail are solid foundations. The one real constraint: `jobs.price` remains a `REAL` dollar column (never converted to cents in Phase 5, explicitly deferred) — a future Accounting module would need to either accept this one inconsistency or fund a small migration to convert it, doesn't block anything today.

**No current architectural choice found that would meaningfully complicate any of the three.**

---

## 17. Risk register

| ID | Finding | Severity |
|---|---|---|
| G1 | `JobType` union hardcoded/duplicated in 3 files, enforced at API boundary | **P1** — major architectural coupling; blocks adding any new job type (industry or region) without a code change |
| G2 | `evaluateRebateEligibility()`'s hardcoded `if/else` program dispatch | **P2** — meaningful future constraint, small and well-scoped to fix |
| G3 | HVAC-rebate columns on generic `customers` table | **P2** — meaningful future constraint; harmless today, dead weight for a non-HVAC tenant later |
| G4 | No tenant/organization concept anywhere (schema, auth, settings, numbering) | **P1** — major architectural coupling for the SaaS roadmap specifically; NOT a P0 because nothing about it blocks continued safe single-tenant operation or further Core feature work |
| G5 | Global `_meta` counters (job/invoice/lead numbering) and global `global_settings` | **P1** (bundled with G4) — the sharpest concrete blocker if tenancy is ever added |
| G6 | `users.email`/`jobs.identifier`/`invoices.identifier`/`leads.identifier` single-column uniqueness | **P1** (bundled with G4) |
| G7 | No Property/Asset/Equipment entity | **P3** — real future gap, not urgent, no current feature blocked |
| G8 | No technician skills/certification/trade concept | **P3** — same reasoning as G7 |
| G9 | "Eligibility Tracker" nav item shown unconditionally regardless of module relevance | **P3** — minor UX cleanliness, not a data or security issue |
| G10 | `jobs.price` still `REAL`, not integer cents (pre-existing, unrelated to Phase 11) | **P3** — carried over from Phase 5's own disclosed deferral, noted here only because it touches the future Accounting module |
| G11 | No white-label/branding config layer (product name is a hardcoded literal) | **INFO** — no current requirement demonstrates need |
| G12 | `HEATING_SOURCE_OPTIONS` sits in the generic "Customer Information" settings category rather than an HVAC-specific one | **P3** — presentation-only miscategorization |
| G13 | Google Calendar has no generic `CalendarProvider` interface — Google-specific types flow directly into `calendar-sync.ts`'s business logic (§14) | **P2** — meaningful future constraint if a second calendar provider is ever needed; not urgent, integration already degrades gracefully when unconfigured |
| G14 | Cloudflare R2 storage has no generic `ObjectStorage` interface — `storage.ts` types directly against `R2Bucket`/`R2ObjectBody` (§14) | **P2** — same reasoning as G13, for a future non-Cloudflare deployment or S3-compatible swap |

No P0 was found. Nothing here blocks safe continued operation of the current HVAC/BC product.

*Correction note (same-day follow-up pass): §14's original classification of Google Calendar as "PROVIDER_ADAPTER" was too generous — re-verified against the actual interface exports and corrected to DOMAIN_COUPLED, and Cloudflare R2 Storage (omitted from the original integration table despite being named in this audit's own scope) was added as G14. No other section required correction. See the Serena memory's revision note for the full record.*

---

## 18. Recommended target architecture

```
Core Field Service Platform
├── Identity & RBAC              (users, sessions, roles — already generic)
├── CRM                          (customers, leads — already generic)
├── Customers / Locations        (customers — generic; "Locations" is future work, §12)
├── Jobs / Work Orders           (jobs core fields, job_notes, job_checklist, job_materials)
├── Scheduling / Dispatch        (scheduling.ts — already generic)
├── Workflow                     (workflow.ts's MECHANISM — already generic; job_type
│                                  REGISTRY needs to become data, see §19 Phase 11.2)
├── Technicians / Workforce      (technicians — already generic)
├── Calendar                     (calendar-sync.ts + google-calendar.ts adapter)
├── Notifications                (already fully generic)
├── Maps / Geocoding / Routing   (already fully generic — Phase 10's own provider
│                                  abstraction is the template for future providers)
├── Financial                    (invoices/payments/audit — already fully generic)
├── Settings                     (global_settings — generic mechanism; VALUES are a mix
│                                  of core/module/tenant, see §6/§9)
└── Integration Framework        (the Geocoding/Routing provider-interface pattern,
                                   generalized as the house style for any new provider)

Industry Modules
├── HVAC                         (job_type registry entries: heating-equipment vocabulary,
│                                  HEATING_SOURCE_OPTIONS)
├── Electrical / Plumbing / etc. (future — same registry mechanism, zero Core changes needed
│                                  once Phase 11.2/11.3 land)

Regional / Program Modules
├── BC
│   ├── CleanBC                  (job_type=CLEANBC, its WORKFLOWS entry, its settings keys)
│   └── BC Hydro                 (job_type=BC_HYDRO, its WORKFLOWS entry, its settings keys)
└── future regions/programs      (same registry mechanism)

Future Business Modules (not started, no blocking conflict found)
├── Quotes / Estimates / Contracts
├── Reporting
└── Accounting / Financial (extends existing Financial domain, doesn't replace it)

Tenant / SaaS Boundary (NOT YET BUILT — see §14, §19 Phase 11.5)
```

This model is **grounded in what already exists**, not invented — the only structural addition it requires beyond the current codebase is (a) a `job_type_definitions`-style registry table and (b) a `tenant_id` column rollout. Everything else in the diagram already matches the current file/table layout.

---

## 19. Proposed implementation phases

| Phase | Objective | Scope | Risk | Migrations | Test strategy | Rollback | User-visible change? |
|---|---|---|---|---|---|---|---|
| **11.0** | Audit / classification (this document) | Documentation only | None | 0 | N/A | N/A | No |
| **11.1** | Introduce Core/Module boundary *documentation and code organization* (e.g. a `src/server/modules/hvac-bc/` grouping for `rebate.ts` + its routes, re-exported unchanged) | File organization only, zero logic change | Low | 0 | Full existing suite must stay 923/923 unchanged | Trivial (pure file move + re-export) | No |
| **11.2** | Extract `job_type`/`WORKFLOWS` into a data-driven registry (new table or Global-Settings-backed), replacing the closed TS union, while seeding it with EXACTLY today's 3 values so behavior is identical | New `job_type_definitions`-shaped table; `workflow.ts` reads from it instead of a hardcoded `Record` | Medium — this is the riskiest phase, touches the core state machine | 1 new (additive, seeds current 3 values) | New tests proving STANDARD/CLEANBC/BC_HYDRO behavior is byte-identical before/after; existing `workflow.test.ts`'s 22 tests must still pass unmodified | Straightforward — registry seeded from the current hardcoded values means reverting is a data no-op | No (existing 3 job types behave identically) |
| **11.3** | Extract the BC/rebate program dispatch (`evaluateRebateEligibility()`'s if/else) into the same data-driven registry from 11.2, plus move the 5 HVAC-rebate columns off `customers` into a dedicated 1:1 profile table | 1 migration (additive `customer_hvac_rebate_profile` table + data copy, old columns kept and deprecated, not dropped) | Medium | 1 new | Existing `rebate.test.ts` suite must pass unmodified against the new storage | Old columns remain readable during a transition window — no destructive step | No |
| **11.4** | Generalize Assets/Service Types **only if** a second industry module is actually being built at that time | Deferred — explicitly not scheduled; §12/§13 gaps are real but unproven by current demand | Low (because deferred) | TBD | TBD | TBD | TBD |
| **11.5** | Tenant/SaaS boundary preparation — add `tenant_id` to the ~10 root tables identified in §15, composite-unique the 4 identifier/email columns, roll out per-endpoint scoping using the same pattern as the prior technician-read-scoping effort | Largest phase; explicitly NOT a rewrite — additive columns + systematic endpoint audit | High (breadth), Medium (depth per endpoint, well-precedented) | 1-2 new (additive only) | New RBAC/IDOR test suite mirroring the existing `technician-job-read-scoping`/`job-update-ownership-bypass` test patterns, applied per-tenant instead of per-technician | Additive columns default to a single "tenant 1" for all existing data — zero data loss, fully reversible by ignoring the new column | No, if done correctly (single-tenant deployments see zero behavior change) |
| **11.6** | Regression / production-readiness pass across everything touched in 11.1–11.5 | Full suite, TypeScript, ESLint, build, browser verification | Low | 0 | Full existing + new suites | N/A | No |

Phases 11.2, 11.3, and 11.5 are the only ones with real schema/logic risk; each is independently shippable and independently revertible, and none is required to unblock the others except in numeric order (11.5 is easiest once 11.2's registry pattern already exists as a precedent).

---

## 20. Explicit list of things NOT to refactor yet

- Do **not** convert `jobs.job_type` to a free-form string — the controlled-registry model (§11, §19 Phase 11.2) preserves type safety while adding extensibility; a bare string would lose real value (typo protection, guaranteed-valid workflow lookup).
- Do **not** build a Property/Asset/Equipment entity now (§12) — no current feature needs it; inventing the shape without a second industry's real requirements risks getting it wrong.
- Do **not** build a technician skills/certification system now (§13) — same reasoning.
- Do **not** implement multi-tenancy now (§14/§19 Phase 11.5) — it is real, scoped, future work, not a quick fix, and doing it prematurely without full endpoint-by-endpoint discipline would reintroduce exactly the class of IDOR bug this codebase has already had to fix twice before (technician read-scoping, job-update ownership bypass).
- Do **not** touch `jobs.price`'s `REAL`-vs-cents inconsistency (§16, G10) — pre-existing, unrelated to Phase 11, already disclosed and deferred since Phase 5.
- Do **not** build a white-label/branding/i18n layer (§9, §6) — no demonstrated need yet.
- Do **not** restructure API URLs into `/api/core/...`/`/api/modules/...` (§8) — the existing flat structure already communicates the boundary; a URL change would be pure churn.
- Do **not** remove or alter any CleanBC or BC Hydro functionality, values, or wording — confirmed fully preserved; this audit changed zero application code.
- Do **not** rewrite historical migrations or drop any column/table — confirmed none were touched.

---

*This audit found the platform in materially better generalization shape than a from-scratch inspection might expect, precisely because prior phases were consistently disciplined about keeping HVAC/BC specifics out of generic tables and generic endpoints. The remaining work is narrow, well-understood, and additive.*

---

## 21. Phase 11.1 addendum — Core / Module file-organization boundary (2026-08-21)

Implemented the first real structural step: introduced `src/{server,client}/modules/{hvac,programs/bc}/` and moved the two files that were safely separable **as pure moves, with zero logic change**.

### Architectural adaptation from the task's suggested layout

The task's example target (`src/core/`, `src/modules/hvac/`) assumes one unified `src/`. This codebase has a hard, pre-existing, security-relevant boundary between `src/server/` (Cloudflare Worker, has access to secrets/DB/R2) and `src/client/` (Preact SPA, ships to the browser) — collapsing them into one `src/core/` would blur exactly the boundary Phase 10's own audit repeatedly verified stays clean (no server secret ever reaches the client bundle). Adapted structure, applied **within each** of `src/server/` and `src/client/` separately:

```
src/server/
  modules/
    hvac/               (reserved, empty — see below)
    programs/bc/
      rebate.ts          ← moved from src/server/rebate.ts, zero logic change
  index.ts               (composition root — imports every module; the only Core-tier file allowed to)
  workflow.ts, scheduling.ts, financial.ts, compliance.ts, lead-*.ts,
  notification-*.ts, calendar-sync.ts, google-calendar.ts, geocoding.ts,
  google-geocoding.ts, routing.ts, google-routing.ts, settings.ts,
  business-timezone.ts, auth.ts, customers.ts, storage.ts, db.ts, ...
                          (Core — everything else, unchanged)

src/client/
  modules/
    hvac/               (reserved, empty — see below)
    programs/bc/
      eligibility-tracker.tsx  ← moved from src/client/components/eligibility-tracker.tsx, zero logic change
  app.tsx                (composition root — imports every module)
  components/*.tsx, context.tsx, auth-context.tsx, api.tsx, types.ts, ...
                          (Core — everything else, unchanged, including job-type-labels.ts, see below)
```

### Why only 2 files moved, not more

Every other HVAC/BC candidate identified in §4/§9/§10/§11 was deliberately **not** moved, per the explicit "do not force dependency cleanup when it requires behavior changes" instruction:

- **`workflow.ts`'s `JobType` union + `WORKFLOWS` record** — the engine (generic mechanism) and the data (3 hardcoded sequences, including the 2 BC-specific ones) are one exported `const` in one file; splitting them is real logic work (Phase 11.2's own charter), not a file move.
- **`src/client/job-type-labels.ts`** — a direct 1:1 label mirror of that same union, including the generic `STANDARD` entry. Moving only the label file while the union it labels stays in Core would split a tightly-coupled pair across the boundary in a confusing half-migrated state — it moves together with the union in 11.2 (see the new `src/client/modules/hvac/README.md` placeholder).
- **`src/client/settings-catalog.ts`** — genuinely mixed content (`BUSINESS_TIMEZONE` is Core, 6 of 9 catalog entries are BC-program-specific) in one file with one shared mechanism (`SettingKind`, `formatSettingValue`, etc.) — not safely splittable without touching the shared type/formatting logic. Deferred to 11.3.
- **`index.ts`'s 6 inline HVAC/BC routes** (`GET /api/customers/{id}/rebate-eligibility`, `POST /api/jobs/{id}/eligibility-check`, `PUT /api/jobs/{id}/eligibility`, `GET /api/jobs/{id}/rebate-audit`, `GET /api/jobs/eligibility-codes`, `GET /api/invoices/{id}/rebate`) — extracting route registrations into a separate file is real structural work with a genuine behavior risk: Hono/`@hono/zod-openapi` matches routes in **registration order** (a documented gotcha in `mem:architecture/data-model` — a static route registered after a same-depth `{id}`-parameterized route gets swallowed by it). Moving these safely requires verifying the extracted registration call lands at the exact same relative position, which is a real (if small) risk best done as its own careful, tested step — not bundled into a "pure file move" phase. Deferred to 11.2/11.3.
- **`customers.house_size`/`primary_heating_source`/`number_of_adults`/`number_of_children`/`household_income`** — DB columns, not files; no migration is permitted this phase.
- **Google Calendar, Cloudflare R2 Storage** — explicitly out of scope per this phase's own instruction.

`src/server/modules/hvac/` and `src/client/modules/hvac/` were still created (each with a `README.md`, since git doesn't track empty directories) — this is honest scaffolding for Phase 11.2's landing spot, not a fabricated move.

### Architecture guard

`scripts/check-architecture-boundaries.mjs` (new, zero new dependencies — plain `node:fs`/`node:path`) statically verifies: no Core file imports a `modules/**` path except the two composition roots (`src/server/index.ts`, `src/client/app.tsx`); no `modules/hvac/**` file imports a `modules/programs/**` path (wrong dependency direction). Run via `pnpm run check:architecture`.

**Not implemented as a vitest test**, despite the task's "architecture-boundary tests" phrasing — empirically verified this session that `@cloudflare/vitest-pool-workers` runs test files inside a bundled sandbox with no access to the real project filesystem (a probe `readdir("./src/server")` from inside a test file resolved against a virtual `/bundle/` root and failed with `ENOENT`, not because the check was wrong but because the Workers runtime environment genuinely has no disk). `vitest.config.ts`'s own `buildSchemaStatements()` only gets away with real `node:fs` because it runs at Vite **config-build time**, in plain Node, before the Workers pool environment exists — the same trick isn't available inside a `*.test.ts` file. The script was verified to actually catch violations (not just trivially pass) by temporarily injecting a fake Core→module import into `scheduling.ts`, confirming the script both detects it and exits non-zero, then reverting.

### Verification

Both moves confirmed pure renames via `git diff --find-renames` (net diff: 5 files, 12 insertions/11 deletions — the two files' own import-path corrections plus the two composition roots' import lines plus `package.json`'s new script entry). Production build output is **byte-identical** before/after (`dist/assets/index-B2RyNlRb.css`, `dist/assets/index-C406QDpN.js` — same hashes both times), the strongest available proof of zero client behavior change. Full suite 923/923 unchanged; targeted subsets (rebate/eligibility, workflow, scheduling, technician-route, Maps/Routing, Google Calendar, Notifications, Leads, Financial/Compliance, Global Settings) all re-run in isolation with unchanged counts.

### Status

Phase 11.1 IMPLEMENTED / VERIFIED / **NOT COMMITTED** this session (a separate Phase 11.1 Safe-Commit checkpoint follows, matching the established Phase 10/11.0 pattern). Zero intentional behavior change anywhere. Phase 11.2 (data-driven `JobType`/`WORKFLOWS` registry) is the natural next step and is NOT STARTED.

*(Editorial note, added during the Phase 11.2 addendum below without altering the record above: Phase 11.1 was committed at `5b20035` in its own Safe-Commit checkpoint before Phase 11.2 began.)*

## 22. Phase 11.2 addendum — Data-Driven Job Type / Workflow Registry (2026-08-21)

Removed the §17 risk-register P1 ("hardcoded `JobType` union + `WORKFLOWS` duplicated across files") to the extent achievable without a database-driven job-type system (explicitly out of scope this phase) or an excessive engine-wide dependency-injection refactor (explicitly discouraged by the task). **Zero intentional runtime/business-logic change.**

### Old architecture

`src/server/workflow.ts` declared `JobType`, `JOB_TYPES`, `isJobType()`, and `WORKFLOWS` as independent hardcoded literals in one file, with CLEANBC's and BC_HYDRO's full status sequences inlined directly alongside STANDARD's. `src/client/types.ts` (`JobType`) and `src/client/job-type-labels.ts` (`JOB_TYPE_OPTIONS`) duplicated the same 3-value union as a second, physically separate declaration, with no automated check that the two stayed in sync.

### New architecture

`src/server/workflow.ts` is now the single authoritative **registry**: a `JOB_TYPE_REGISTRY` object composed from Core's own `STANDARD` definition plus `BC_PROGRAM_JOB_TYPES` (new file: `src/server/modules/programs/bc/workflow-definitions.ts` — pure data, zero business logic, sibling to `rebate.ts`). `JobType`, `JOB_TYPES`, `isJobType()`, `WORKFLOWS`, and `STATUS_LABELS` are all **derived** from that one object rather than separately hardcoded. `TERMINAL_STATUSES` is now derived too (the last status of each job type's sequence), removing Core's last remaining hardcoded literal reference to the BC-specific status name `gov_portal_submitted`. The registry and `STATUS_LABELS` are both `Object.freeze()`d (immutable runtime configuration, per the task's §23). A small explicit accessor API was added: `getJobTypeDefinition(id)` and `listJobTypeDefinitions()` (§15) — additive, existing call sites (`WORKFLOWS`, `JOB_TYPES`, `isJobType`, `entryStatus`, `transitionJob`, etc.) are unchanged and were not required to switch to the new accessors.

### Registry ownership / composition root

```
Core (workflow.ts): engine mechanics (forwardTransitions, transitionJob,
                     resolveAllowedTransitions, canCompleteJob, ...) +
                     STANDARD's own definition + the registry-composition
                     itself
        ↑ imports (narrowly-scoped exception, see below)
        |
modules/programs/bc/workflow-definitions.ts: pure CLEANBC/BC_HYDRO
        status-sequence and status-label DATA, no logic
```

This is a **documented, narrow exception** to Phase 11.1's "Core never imports `modules/**`" rule, added to `scripts/check-architecture-boundaries.mjs`'s `COMPOSITION_ROOTS` alongside `index.ts`/`app.tsx`. The reason it has to live in `workflow.ts` itself rather than a separate composition file: the registry and the engine functions that close over it (`WORKFLOWS`, `TERMINAL_STATUSES`, `transitionJob`, etc.) must share one module scope in JavaScript — there is exactly one registry in this application (no per-tenant/per-request swapping), so a full dependency-injection refactor threading a registry parameter through every engine function and all of its callers (`index.ts`, `financial.ts`, `modules/programs/bc/rebate.ts`) was judged **excessive refactoring for no behavioral benefit**, which the task explicitly says to avoid (§4, §5). This is a considered trade-off, not an oversight — see workflow.ts's own header comment for the full reasoning, restated inline where the exception is used.

**Honesty note (§20's own requirement):** this does NOT mean Core is fully decoupled from the BC program. `workflow.ts` still literally names `"CLEANBC"`/`"BC_HYDRO"` as registry keys when composing `JOB_TYPE_REGISTRY` (`{ STANDARD: {...}, ...BC_PROGRAM_JOB_TYPES }`) — there is no dynamic/database-driven job-type system (explicitly out of scope, §6). What changed is that the actual workflow **shape** (status order, status labels) for CLEANBC/BC_HYDRO no longer lives in Core as an inline literal — it's sourced from the BC module. The Core engine functions themselves (`forwardTransitions`, `resolveAllowedTransitions`, `transitionJob`, `canCompleteJob`) contain **no** `if (jobType === "CLEANBC")`-style dispatch and never did — they were already generic lookups into the data structure; the P1 issue was the *data's location*, not engine dispatch logic.

### JobType source of truth

Server: `keyof typeof JOB_TYPE_REGISTRY` in `workflow.ts` — genuinely derived, not a duplicate beside the registry. Client: `src/client/types.ts`'s `JobType` type remains a **second, physically necessary** declaration — the server/client bundle boundary (preserved from Phase 11.1, security-relevant: server code must never ship to the browser) means there is no shared module either side can import from. This second declaration is not left to silently drift: a new test (`test/job-type-registry.test.ts`, "client job-type mirror stays in sync with the server registry") imports both `JOB_TYPES` (server) and `JOB_TYPE_OPTIONS`/`JOB_TYPE_LABELS` (client) into the same test file — both are plain, dependency-free data modules with no DOM/preact runtime requirement — and asserts they match. This is the accepted, documented mitigation for the one duplication a hard bundle boundary makes structurally unavoidable without a database-driven or shared-package system (both out of scope).

### Registered job types / stable IDs / API compatibility

Unchanged: `STANDARD`, `CLEANBC`, `BC_HYDRO` — same 3 values, same order, same persisted/API strings. No migration. No API contract change: `job_type: z.enum(JOB_TYPES as [JobType, ...JobType[]])` in `index.ts` still sources its enum from the same exported `JOB_TYPES`, which still contains the identical 3 values.

### Behavioral equivalence — verified live, not just by test

Beyond the automated suite, this session created one job of each type through the real running application (`pnpm run dev`, Playwright, admin login, the actual "New Job" form) and queried the resulting rows directly in the local D1 database:

| job_type | entry status (live DB row) | expected (pre-refactor `WORKFLOWS[type][0]`) |
|---|---|---|
| STANDARD | `scheduled` | `scheduled` |
| CLEANBC | `free_estimate` | `free_estimate` |
| BC_HYDRO | `free_estimate` | `free_estimate` |

All three match exactly. Fixture jobs deleted after verification (`job_status_history` then `jobs` rows for the 3 created IDs) — no synthetic data left in the local dev DB.

### Remaining BC/rebate coupling — explicitly deferred to Phase 11.3

Untouched by this phase, exactly as instructed: `workflow.ts`'s one status-name check (`if (input.toStatus === "eligibility_approved")` inside `transitionJob`, required for the eligibility-code data capture on that specific transition), `financial.ts`'s `computeRebateAmountCents()` dispatch (`jobType === "CLEANBC" ? ... : ...`), `index.ts`'s 6 inline rebate/eligibility routes, and `settings-catalog.ts`'s mixed BC/Core settings catalog. All are rebate **business logic**, not job-type/workflow **shape** — Phase 11.3's own charter.

### Verification result

`tsc`/`eslint`/`check:architecture`/`vite build` all clean; production client bundle byte-identical (`index-B2RyNlRb.css`, `index-C406QDpN.js` — unchanged, since Phase 11.2 touched zero client files). Full suite: 923 pre-existing + 13 new registry tests = **936/936**. Targeted domain subset (rebate/workflow/scheduling/technician-route/maps-routing/google-calendar/notifications/leads/financial/compliance/global-settings/timezone/job-type-registry): 623/623. This session observed intermittent, non-deterministic test timeouts under full-parallel-suite load (a different random unrelated test each run — calendar-sync-concurrency, customer-referral, notification-history-api, rebate's own referral-profile test, settings category filter, technician-stats-scoping) that always passed cleanly when re-run in isolation; classified as pre-existing environmental/PBKDF2-cost resource contention (consistent with `vitest.config.ts`'s own documented timeout-headroom comment), not a Phase 11.2 regression — none of the intermittently-failing tests touch `JobType`/workflow code.

### Status

Phase 11.2 IMPLEMENTED / VERIFIED / COMMITTED (`db335bd`, on top of `5b20035`). Zero intentional behavior change anywhere. §17's P1 "hardcoded JobType/WORKFLOWS" risk is **PARTIALLY CLOSED** (single authoritative server-side registry; client mirror now automatically verified in sync; Core's workflow *shape* knowledge of CLEANBC/BC_HYDRO relocated to the BC module) — not CLOSED outright, since Core's registry composition still names the BC program's job-type IDs by design (see honesty note above).

---

## §22 Addendum — Phase 11.3: Rebate / Regional Program Extraction (2026-08-21)

**Status: IMPLEMENTED / VERIFIED / NOT COMMITTED, NOT PUSHED, NOT DEPLOYED.** Targets §16's finding #3 (rebate dispatch if/else) and #2 (5 HVAC-rebate columns on `customers`).

### What moved

**Customer rebate profile** — the 5 columns (`house_size`, `primary_heating_source`, `number_of_adults`, `number_of_children`, `household_income`) are extracted into a new table, `bc_rebate_customer_profiles` (migration `0014_bc_rebate_customer_profile.sql`), owned by `src/server/modules/programs/bc/customer-profile.ts`. `customer_id` is the table's own PRIMARY KEY (natural 1:1, `ON DELETE CASCADE` from `customers`) — the simplest structural guarantee of "at most one profile row per customer." The table is **optional per customer**, matching the original Phase 3 design intent ("do not assume these fields apply to every customer") rather than the "eager row for every customer" alternative that was considered and rejected as unfaithful to that intent.

**Rebate program dispatch** — `rebate.ts`'s `evaluateRebateEligibility()` no longer branches with `if (jobType === "CLEANBC") ... else if (jobType === "BC_HYDRO")`. A frozen `REBATE_PROGRAM_REGISTRY` object (keyed by `JobType`, each entry owning its own `buildCriteria()`) replaces the chain. A job type absent from the registry (STANDARD, or any future non-rebate type) safely yields zero criteria — never a crash, never a borrowed program's rules. This registry lives inside `rebate.ts` itself (not a separate file) — a 2-entry frozen object didn't justify its own module.

**Workflow rebate hook** — `workflow.ts`'s `transitionJob()` previously hardcoded the literal string `"eligibility_approved"` to decide when to require an eligibility code. `JobTypeDefinition` gained an optional `eligibilityCodeGateStatus?: string` capability field; only CLEANBC's definition (`workflow-definitions.ts`) sets it. Core now asks the job type's own definition rather than naming the BC-specific status literal — behaviorally identical (verified: `input.toStatus` is already constrained to `resolveAllowedTransitions(job)` before this check runs, and `"eligibility_approved"` only appears in CLEANBC's own `statusSequence`).

### Legacy columns — RETAINED, not authoritative

The 5 legacy `customers` columns are **not dropped**. Application code no longer writes to them (no dual-write) — they are a frozen, inert rollback/compatibility safety net only. `bc_rebate_customer_profiles` is the sole authoritative store. Reads that need the full `Customer` API shape (`listCustomers`, `getCustomer`, the post-Lead-conversion customer fetch) `LEFT JOIN` the new table and select its columns *after* `c.*`, so the profile table's values win when the row object is built from duplicate column names — verified correct against `@clawnify/db`'s real D1 driver (not the Drizzle/Facet path), and directly exercised by tests that would fail if this assumption were wrong (a customer's rebate data is created, then updated, and the API response is asserted against the *new* table's values while the legacy column is independently confirmed frozen at `NULL`).

A customer that predates this phase, or that was created through a path that never touches rebate fields (e.g. Lead conversion, which has never written these columns), correctly shows blank/null rebate data through the same compatibility read path — proven live via a real Lead→Customer conversion in both the automated suite and a real browser session.

### API contract — unchanged

Zero request/response shape changes on any customer or job-eligibility route. A client cannot observe that storage moved.

### Remaining BC/rebate coupling — explicitly out of scope, unchanged by this phase

`financial.ts`'s `computeRebateAmountCents()` (`jobType === "CLEANBC" ? ... : ...`, a single-line job-type→Global-Settings-key mapping) was judged out of this phase's tightly-scoped mission (customer profile + rebate.ts dispatch + the one workflow hook) — moving it would touch Financial architecture edges this phase was explicitly told not to redesign. `index.ts`'s 6 inline rebate/eligibility routes and `settings-catalog.ts`'s mixed BC/Core catalog remain as they were — structurally fine (each route is its own dedicated, non-generic endpoint per §16's own finding), not required by this phase's charter. Core's `JOB_TYPE_REGISTRY` composition still names `"CLEANBC"`/`"BC_HYDRO"` as registry keys, unchanged from Phase 11.2 — no dynamic/database-driven job-type system exists or was added.

### Verification

Full suite: **950/950** (936 baseline + 14 new, `test/bc-rebate-customer-profile.test.ts`). `tsc`/`eslint`/`check:architecture`/`vite build` all clean; production bundle unchanged (1770 modules, zero client files touched). Live-verified against a real running `wrangler dev` + real local D1 via Chrome browser automation: created a rebate-profile customer, confirmed round-trip through the new table, created a CleanBC job, ran a real eligibility check (correctly resolved both CleanBC criteria via the registry), viewed the Eligibility Tracker, zero console errors, zero non-200 API responses. Independent code review and a focused security review (IDOR, mass assignment, data over-exposure, SQL injection, migration data-loss, transaction integrity, secrets) both completed with no blocking findings — see `mem:phase11/platform-generalization-audit` for the full record. Fixtures cleaned up; real local D1 confirmed back to baseline (0 orphaned profile rows).

### §16 findings #2 and #3 reassessed

#2 (HVAC columns on `customers`): **CLOSED** — extracted to a dedicated, module-owned table; legacy columns retained only as an inert compatibility fallback. #3 (rebate dispatch if/else): **CLOSED** — replaced by a registry; Core's one remaining rebate-adjacent literal (the `eligibility_approved` gate) is also closed. `financial.ts`'s job-type→settings-key mapping remains **OPEN**, unchanged, explicitly deferred (P3, narrow, single line, not required by this phase).

Phase 11.4 (Assets/Equipment) remains DEFERRED, not started.

---

## §22 Addendum — Phase 11.5: Tenant / SaaS Boundary Preparation (2026-08-21)

**Status: IMPLEMENTED / VERIFIED / NOT COMMITTED, NOT PUSHED, NOT DEPLOYED.** Targets §15's `NOT_READY` classification and §17's G4/G5/G6. Scope is deliberately the minimum durable tenant boundary, not multi-tenant UX, billing, self-signup, or white-labeling — see §26 below.

### Organization model

A single new root table, `organizations` (`migrations/0015_organizations.sql`): `id`, `name`, `status`, `created_at`, `updated_at`. One user belongs to exactly one organization (`users.organization_id`) — no multi-org membership, no org switcher, no session-level org selection. A default organization (`id = 1`, "Default Organization") is created by the migration and owns every pre-existing row, so current single-company behavior is unchanged for the existing deployment.

### Tenant-owned table classification

- **DIRECT_TENANT_COLUMN** (gained `organization_id` in this migration): `users`, `customers`, `technicians`, `service_types`, `materials`, `jobs`, `invoices`, `leads`, `global_settings`.
- **INHERITED_THROUGH_PARENT** (no new column; safety enforced via the route layer joining/subquerying against the owning parent's `organization_id`): `job_notes`, `job_checklist`, `job_materials`, `invoice_lines`, `payments`, `job_status_history`, `job_rebate_audit`, `job_media`, `job_completion_reports`, `job_signatures`, `job_compliance_audit`, `lead_status_history`, `calendar_*`, `notification_*`, `bc_rebate_customer_profiles`.
- **GLOBAL_SYSTEM_TABLE** (deliberately unscoped, disclosed below): `_meta` (identifier counters).
- **USER_SCOPED** (safe by virtue of already being keyed to `user_id`, which is itself now organization-bound): `calendar_integrations`, `calendar_oauth_states`.

### Migration and backfill

`NOT NULL DEFAULT 1` on each new `organization_id` column (not a separate `UPDATE` backfill) — a single mechanism that correctly handles a fresh database's own seed rows, an existing/upgraded database's pre-existing rows, and this project's test harness's `INSERT OR IGNORE`-only reseed replay, all at once (see the migration file's own header comment for the full reasoning). No inline `REFERENCES organizations(id)`: D1/SQLite rejects `ALTER TABLE ... ADD COLUMN` combining a `REFERENCES` clause with a non-NULL `DEFAULT` ("Cannot add a REFERENCES column with non-NULL default value") — confirmed live against the real D1 test pool (a full 44-file test run failed identically until the clause was removed), not assumed. `organization_id` is therefore application-enforced only, a disclosed trade-off, not an oversight. 10 composite indexes were added matching this phase's actual new query shapes (`organization_id` first, then the pre-existing filter column).

### Authentication and tenant context resolution

`getSessionUser()` (`src/server/auth.ts`) now returns `organizationId` alongside the existing public user shape, resolved from the authenticated session's own `users` row — never from client input. The `PublicUser` type and `sanitizeUser()` are unchanged, so `organizationId` is never serialized to the client. The `/api/*` auth middleware (`src/server/index.ts`) sets it as a separate Hono context variable (`c.set("organizationId", ...)`), read via a new `actorOrganizationId(c)` helper, mirroring the existing `currentUser(c)` pattern. No route derives `organization_id` from a request body or query string; a grep for `organization_id`/`organizationId` as a client-facing Zod field name across `index.ts` returns zero matches, and Zod's default unknown-key stripping means a client-supplied value would be dropped even if sent.

### API scoping strategy

Systematically applied across roughly 80 route handlers: every list/get/update/delete query for the 9 DIRECT_TENANT_COLUMN tables filters on `organization_id` first (pagination/count queries always match the identical `WHERE` and params as their data query — verified line-by-line for `listJobs`/`listCustomers`/`listInvoices` — so no page-2 existence leakage); every INSERT for those 9 tables writes `organization_id` from the actor's own context; every cross-entity reference in a request body (`customer_id`, `technician_id`, `service_type_id`, `job_id`, `material_id`, `referred_by_customer_id`, `assigned_user_id`) is verified to belong to the actor's own organization before being trusted. For financial routes, a single reusable guard (`assertInvoiceInOrganization`) is called before the underlying mutation runs, rather than deep-threading `organizationId` through all of `financial.ts`'s call graph — judged the lower-risk shape for a sensitive, already-complex domain. INHERITED_THROUGH_PARENT tables are scoped by joining/subquerying against their owning parent's `organization_id` at the route layer, with no duplicated column.

Two genuine pre-existing security gaps (unrelated to multi-tenancy, but surfaced by this pass) were fixed as part of the same scoping work: `addJobMaterial`/`addJobNote`/`addChecklistItem` previously had **no** job-ownership check of any kind (any authenticated user could attach data to any job by numeric id); `invoiceFromJob`/`updateInvoice` previously had **no** ownership check. Both now require organization ownership before writing, same as every other mutation in this diff.

### Cross-tenant security review — one P0 found and fixed

Two independent adversarial reviews (Code Reviewer, Application Security Engineer — see §27) each separately found the same real, exploitable gap that the systematic route-by-route pass and the 22-test isolation suite had both missed: `calendar-sync.ts`'s `syncAllJobsForUser()` (reached via `POST /api/integrations/google-calendar/sync`, the "Sync Now" button) selected **every job in the database, across every organization**, and pushed each one into the calling user's own personal Google Calendar — a bulk, self-triggered export of every tenant's customer names, addresses, technician assignments, and job notes through a legitimate external channel. This is the same bug class the implementation had already found and fixed for the single-job `/retry` route, just missed on the bulk-sync caller. **Fixed**: `syncAllJobsForUser` now resolves the caller's own `organization_id` and scopes its job query to it. A new regression test (`test/calendar-sync.test.ts`, "Sync Now only syncs jobs belonging to the caller's own organization") creates jobs in two real organizations and asserts only the caller's own organization's job is ever synced. A second, low-severity finding (both reviewers, independently) — `GET /api/invoices/{id}/payments` returned `403` instead of the codebase's consistent `404`-for-cross-org-id convention — was also fixed. A third finding (Code Reviewer only) — `updateCustomer`'s new organization-ownership check returned `404` for an unknown/cross-org id, diverging from its own pre-existing (and its sibling routes' — `updateTechnician`/`updateServiceType`/`updateMaterial`, all touched by this same diff) silent-no-op-on-unknown-id convention — was fixed to match; the isolation test suite was updated accordingly. All three fixes were re-verified: full suite, `tsc`, `eslint`, `check:architecture`, and `vite build` all clean after the fixes (see Verification below).

### Unique constraints and numbering — kept global, documented and deferred

`users.email`, `jobs.identifier`, `invoices.identifier`, and `leads.identifier` remain single-column globally-unique constraints — **KEEP_GLOBAL**, not scoped to `(organization_id, ...)`, in this phase. This is a deliberate, disclosed deferral, not an oversight: it is consistent with the one-user-one-org model (a user's email is still a single global login identity) and with `_meta`'s identifier counters, which also remain a single global sequence per identifier type rather than becoming per-organization (**GLOBAL_SYSTEM_TABLE**, deferred). A second organization today would compete for the same global job/invoice/lead number sequence and could not reuse an email address already registered to another organization's user. Making these tenant-scoped requires a real migration (composite unique indexes, and — for `_meta` — either a per-organization row or a redesigned counter scheme) plus deciding the numbering/collision behavior during the transition; both are correctly sized as Phase 11.6+ work, not something to absorb opportunistically here. Nothing in this phase's scope required changing them, and nothing about deferring them weakens the isolation guarantees implemented — no route resolves data by `identifier` or `email` alone across an organization boundary without an accompanying `organization_id` check.

### Global Settings

`src/server/settings.ts` was rewritten to take `organizationId` as the first parameter on every exported function (`getSettingRow`, `getSettingValue`, `listCurrentSettings`, `publishSetting`, `retireSetting`, `getSettingHistory`), and `global_settings` gained `organization_id` as a DIRECT_TENANT_COLUMN. Every caller (`business-timezone.ts`'s `getBusinessTimezone`, `financial.ts`'s `computeRebateAmountCents`, `rebate.ts`'s eligibility criteria, `lead-workflow.ts`'s lost-reason catalog) threads it through from the route layer. The existing API shape, versioning, and audit-history behavior are unchanged — a client cannot observe that settings are now organization-scoped, only that a second organization now genuinely has its own independent settings rather than sharing the one deployment-wide row set.

### Integration and background-scan scoping

`notification-dispatcher.ts`'s `enqueueDayBeforeReminders()` (a cron-triggered scan) now loops per active organization, resolving each organization's own business timezone before scanning that organization's jobs — previously a single global scan assuming one timezone for the whole deployment. `calendar-sync.ts`'s single-job sync/retry path was already organization-scoped by the implementation; the bulk "Sync Now" gap is covered above. `lead-conversion.ts`'s duplicate-customer matching (`findMatchingCustomerIds`) now scopes its phone/email scan to the lead's own organization — previously a global scan across every organization's customers, which could have silently merged a Lead in Org A into an unrelated Customer in Org B on a coincidental phone/email match.

### Testing

`test/tenant-isolation.test.ts` (new, 22 tests) is the required Org A / Org B isolation matrix: users, customers (including referral cross-org rejection), leads (including proof that Lead conversion never merges across organizations even on identical contact info), jobs (including cross-org `customer_id`/`technician_id` rejection on create), technicians, Scheduler/dashboard, Maps/technician routes, BC rebate profiles, financial/compliance (read, issue, payment, cross-org invoice creation), Global Settings (effect isolation and list visibility), and `organization_id` mass-assignment resistance. It uses a real second organization seeded via a new `createSecondOrganization()` test helper (raw SQL + the real `hashPassword()`, since there is no API path to create a user in another organization — that is the point of the boundary) and drives every assertion through the real API with that organization's own real login, not fabricated database state. A new calendar-sync cross-org test (above) covers the P0 fix.

### Verification

Full suite: **973/973** (972 baseline-after-Phase-11.5-implementation + 1 new calendar-sync regression test for the P0 fix; the tenant-isolation suite's own 22 tests are included in that count). `tsc`/`eslint`/`pnpm run check:architecture`/`vite build` all clean. Live-verified against a real running `wrangler dev` + real local D1 via Chrome browser automation: confirmed the `organizations` table seeded with exactly the expected default row; Dashboard, Customers, User Management, Global Settings, and Schedule all rendered identically to pre-Phase-11.5 baseline with the same 13-item sidebar and zero new tenant-related UI; created a real customer through the org-scoped `createCustomer` write path; a fresh batch of 16 `/api/*` requests triggered from the Schedule page all returned HTTP 200 with zero console errors. Fixtures cleaned up (browser-verification customer deleted) and real local D1 confirmed back to exact baseline (1 customer, 1 organization). Two independent adversarial security reviews and one independent code review completed — see §27; all findings were fixed and re-verified, no findings remain open.

### §15 reassessed

**Classification: PARTIALLY_READY** (was `NOT_READY`). The durable tenant boundary now exists and is enforced server-side across every read, write, search, and background scan touching tenant-owned data — a second organization can be created today (via direct seeding, as no self-signup UI exists by design) and operate with genuinely isolated customers, jobs, leads, technicians, invoices, settings, and calendar sync, with zero cross-tenant data leakage found after adversarial review. What remains before a real second paying tenant could safely onboard: tenant-scoped uniqueness and numbering (deferred above, Phase 11.6+ candidate), an actual provisioning/self-signup flow (explicitly out of scope for this phase), billing/subscriptions (explicitly out of scope), and a tenant admin/org-switcher UX (explicitly out of scope — this phase is boundary preparation, not multi-org UX). None of these block continued safe single-tenant operation of the current deployment, which is unchanged.

### §17 risk register reassessed

G4 (no tenant/organization concept): **CLOSED** — the boundary now exists, is enforced, and is tested. G5 (global `_meta` counters and global `global_settings`): **PARTIALLY CLOSED** — `global_settings` is now organization-scoped; `_meta` counters remain global, deliberately deferred (see Unique constraints and numbering above), tracked as a new, narrower finding G15. G6 (global uniqueness on `users.email`/3 identifier columns): **OPEN, deliberately deferred** — same reasoning, tracked as G15.

**New finding — G15**: `_meta` identifier counters (job/invoice/lead numbering) and `users.email`/3 identifier-column global uniqueness remain unscoped to organization. **P2** — a real constraint for a genuine second tenant (collision on numbering/email), not urgent for the current single-tenant deployment, and correctly sized as dedicated follow-up work rather than something to fold into this phase.

Phase 11.6+ (tenant-scoped numbering/uniqueness, provisioning, billing, tenant UX) remains NOT STARTED — explicitly out of this phase's scope per its own final stop condition.

## §22 Addendum — Phase 11.4: Assets / Equipment Generalization (2026-08-22)

**Status: IMPLEMENTED / VERIFIED / NOT COMMITTED, NOT PUSHED, NOT DEPLOYED.** Closes §12's finding above ("no Property/Location/Asset/Equipment entity anywhere in the schema") with a generic, tenant-safe Core concept — deliberately scoped to a Customer-owned Asset with a many-to-many Job link, not the full Property/Location domain §12 explicitly deferred (still not built; Customers continue to represent service locations, per §12's own original reasoning, unchanged here).

### Asset model and terminology

Core term is **Asset** (`assets`/`job_assets` tables, `src/server/assets.ts`); the UI labels it "Equipment" for HVAC users (`src/client/components/customer-assets.tsx`'s "Equipment" section header, `job-assets.tsx`'s "Linked Equipment"). One stable Core entity, no competing generic concept introduced. Fields: `id`, `organization_id`, `customer_id`, `asset_type`, `display_name`, `manufacturer`, `model`, `serial_number`, `installation_date`, `status`, `notes`, `created_at`, `updated_at` — an additive table (`migrations/0016_assets.sql`), no existing table/column touched.

### Tenant ownership

Organization → Customer → Asset. `assets` is classified **DIRECT_TENANT_COLUMN** (Phase 11.5's own taxonomy) rather than INHERITED_THROUGH_PARENT, because it needs its own independently listable/searchable/paginated endpoint (`GET /api/assets`), unlike e.g. `job_notes`. `organization_id` is a plain `INTEGER NOT NULL DEFAULT 1` column with no inline `REFERENCES` — for consistency with the 9 existing DIRECT_TENANT_COLUMN tables, even though this is a brand-new `CREATE TABLE` (not an `ALTER TABLE ADD COLUMN`), so the D1 REFERENCES+non-NULL-DEFAULT restriction that forced that shape on the other 9 tables doesn't technically apply here — the inconsistency of a first-of-its-kind exception was judged worse than the marginal integrity gain. `job_assets` (the Job↔Asset junction) is **INHERITED_THROUGH_PARENT**: no own `organization_id`, safety flows from both `job_id` and `asset_id` already being org-scoped, matching `job_notes`/`job_checklist`/`job_materials`'s precedent.

### Customer/Property/Location

No Property/Location entity was introduced — an Asset belongs directly to a Customer, exactly as §12 recommended ("not recommended to build now... risks getting it wrong"). If a future phase needs multiple service addresses per Customer, that remains separate, gated future work.

### Asset type architecture

Mirrors Phase 11.2's `JOB_TYPE_REGISTRY` pattern for "avoid an HVAC-only Core union," but is structurally simpler and needs **no architecture-guard composition-root exception** (unlike `workflow.ts`): `src/server/modules/hvac/asset-types.ts` is a pure-data file (7 HVAC types: heat pump, furnace, boiler, air conditioner, water heater, thermostat, air handler — only types with an actual current business need, no speculative categories) contributed to a registry composed directly in `src/server/index.ts` (already an allowed composition root). `src/server/assets.ts` (Core) imports zero files from `modules/**` — verified by an independent architecture review reading the actual imports, not just trusting the file's own header comment. The registry composition needs no exception because, unlike job-type workflows, asset types carry no per-type engine behavior to close over — just a flat label lookup, used for `z.enum()` request validation and the `GET /api/assets/types` listing endpoint (reachable by every authenticated role, including technician — the one Asset-adjacent route with no RBAC gate, since it returns no tenant or customer data, only static labels).

### Serial number uniqueness

Deliberately **unconstrained** — no UNIQUE index at any scope (global, tenant, or customer). Real-world HVAC serial data is frequently missing, mistyped, or legitimately duplicated across manufacturers/eras; a hard constraint would produce false rejections on messy real field data. `idx_assets_serial` (an index with no UNIQUE constraint, for search performance) was added then removed during independent code review after tracing that the only query touching `serial_number` is a leading-wildcard `LIKE` search, which SQLite cannot use a B-tree index for — the index was dead weight relative to actual usage, not incorrect, just cut.

### Job ↔ Asset relationship

Many-to-many via `job_assets` (a plain junction table, `UNIQUE(job_id, asset_id)`, no extra columns) — chosen over a single nullable `jobs.asset_id` because real HVAC visits commonly service multiple units (e.g. both a furnace and an AC on one call), a scenario the migration's own header comment documents. Independent architecture review confirmed this is justified, not overbuilt.

### Historical/snapshot decision

No point-in-time snapshot of Asset fields at the moment a Job references them — `job_assets` is a live FK reference, not a copy. Documented tradeoff (migration header comment): unlike money (deliberately snapshotted elsewhere in this codebase, e.g. `invoice_lines`), equipment identity fields essentially never change after install; an edit is a correction, not a new fact needing history. Flagged by independent architecture review as worth remembering if a future compliance/warranty use case emerges, not something to build preemptively now.

### API, RBAC, and cross-customer safety

9 new routes (`GET/POST /api/assets`, `GET/PUT/DELETE /api/assets/{id}`, `GET /api/assets/types`, `GET/POST /api/jobs/{id}/assets`, `DELETE /api/jobs/{id}/assets/{assetId}`). RBAC: admin + dispatcher manage Assets directly (`canManageAssets`/`canDeleteAsset`, matching the Customer-delete precedent, not the Technician-delete admin-only precedent — an Asset is operational customer-equipment data, not a staff record); technician blocked from all direct Asset routes and from linking/unlinking equipment on any job (blanket block, matching `updateJob`'s precedent — no legitimate technician use case exists); a technician CAN view linked equipment on their own assigned job via `GET /api/jobs/{id}/assets`, reusing the exact same `canActorAccessJobCompliance` ownership predicate already used at 12+ other job-sub-resource call sites (verified by grep, not a new mechanism). Cross-customer linking (Job for Customer A ↔ Asset of Customer B, same org) is default-DENY, checked at link time in `linkAssetToJob`; cross-org linking is denied identically to every other cross-tenant reference in this codebase (the foreign id resolves as not-found before any comparison is even possible). `AssetInputSchema`/`AssetUpdateInputSchema` are `.strict()` and never accept `organization_id` — mass assignment is structurally impossible, not just discouraged.

### Delete / retire semantics

`status` (`active`/`inactive`/`retired`) is the soft-delete mechanism (same precedent as `jobs.status='cancelled'`) — a genuinely unreferenced Asset (zero `job_assets` links) can be hard-deleted; a linked Asset's `DELETE` is refused with 409, directing the caller to retire instead. **Independent architecture review found and this phase fixed a real gap**: `updateAsset` originally allowed silently reassigning a linked Asset's `customer_id` to a different customer, which would leave `job_assets` rows pointing at a Job whose customer no longer matched — contradicting the migration's own "cross-customer linking is impossible by construction" claim. Fixed: `updateAsset` now refuses a `customer_id` change (409, same "unlink/retire first" pattern as delete) whenever the Asset has any active job link. One known, disclosed, **not fixed** gap remains, matching existing app-wide precedent rather than introducing a new inconsistency: deleting a Customer (`DELETE /api/customers/{id}`, unconditional, no reference check) cascades through `assets` → `job_assets`, bypassing the Asset-delete guard entirely — `jobs.customer_id` and `invoices.customer_id` already cascade the exact same way, so this is inherited behavior, not a Phase 11.4 regression.

### Security review — one real bug found and fixed

Independent adversarial security review found a genuine, reproducible bug (also independently caught by the testing review, confirmed as an already-red test in the working tree at the time): `listAssets`'s `manufacturer`/`search` filters built raw `%...%` LIKE patterns from unescaped user input. A wildcard-dense value (many `%`/`_` characters) tripped D1/SQLite's own "LIKE or GLOB pattern too complex" limit, producing an **uncaught, non-JSON 500** — not a SQL-injection risk (values were always bound parameters), but a real input-robustness gap and a raw-error leak this codebase otherwise avoids. **Fixed in two layers**: (1) `%`/`_`/`\` are now escaped (`ESCAPE '\'` clause) so literal wildcard characters in real search terms match correctly instead of being misinterpreted; (2) escaping alone does NOT prevent D1's complexity limit (confirmed live — it triggers on raw wildcard-character count before ESCAPE semantics apply), so a proactive count cap (`assertSearchableFilter`, >20 `%`/`_` characters) now rejects pathological input with a clean 400 before the query is ever built, rather than pattern-matching D1's internal error text. Also confirmed clean by the same review: cross-org IDOR (all denied), cross-customer link mismatch (409, no TOCTOU exploitable in the single-request case), mass assignment (`.strict()` holds), technician access (fully blocked per the RBAC design above), delete/history safety (409 while linked, enforced in the storage function not just the route), pagination/count-query parity (identical `WHERE`+params, no leak), and zero new dependencies/external calls/secret handling. One P3 noted, not fixed (matches an app-wide pre-existing pattern, not a Phase 11.4 regression, recommended as separate follow-up): Asset API responses include `organization_id` in the raw serialized row (same as `GET /api/customers/{id}` already does) even though the response Zod schema omits it — `c.json()` doesn't strip fields against the OpenAPI schema. Low sensitivity (only the actor's own already-known org id), tracked as a global follow-up rather than an ad-hoc Assets-only fix.

### Testing

`test/assets.test.ts` (new, 30 tests): CRUD, delete/retire (including the reparent-block fix above), validation (invalid type/date/oversized-strings/mass-assignment), RBAC per role, Job linking (link/unlink/duplicate-rejection/cross-customer-denial/cross-org-denial/technician-scoped read, and a dedicated many-to-many test proving one Asset can link to two Jobs independently with unlink-one-leaves-the-other-untouched), search/pagination (including the LIKE-escaping regression test), and tenant isolation (list/read/update/delete, create-under-foreign-customer, reassign-to-foreign-customer, cross-org link, cross-org technician view — all denied). `test/helpers.ts`'s `resetDatabase()` gained `DELETE FROM job_assets`/`DELETE FROM assets` entries in FK-safe order (child-before-parent, independently verified by the testing review by tracing the actual FK chain, not just trusting the comment).

### Verification result

Full suite: **1009/1009** (979 baseline, matching Phase 11.6's own committed baseline exactly, + 30 net new — all in `test/assets.test.ts`). `tsc`/`eslint`/`pnpm run check:architecture`/`vite build` all clean. Four independent reviews completed (Software Architect, Code Reviewer, Application Security Engineer, Test Automation Engineer) — all findings fixed and re-verified: one P1 (cross-customer reparent gap), one P2/effectively-BLOCKER-by-the-time-fixed (LIKE-pattern crash), one P2 (lint unused import), plus several P3s addressed opportunistically (dead index removed, 3 test coverage gaps closed) or explicitly deferred with documented reasoning (organization_id response-shape leak — app-wide pattern, not new). No findings remain open. Real-browser verification (Chromium): admin Customer→Equipment→Add/Edit Asset→Job→Link Equipment→Scheduler→Job Detail; Technician read-only linked-equipment view with zero edit/link/unlink controls and no Equipment section on the Customer page at all; Org B tenant isolation (empty Equipment list, graceful cross-org URL handling, zero data leak) — all confirmed live, console clean throughout. Full detail in the phase's own final report and in the `project/fsm-upgrade-plan` Serena memory's Phase 11.4 entry.

### §12 reassessed

**CLOSED** for the Asset half of the original finding ("no Property/Location/Asset/Equipment entity anywhere in the schema") — a generic, tenant-safe Asset now exists. Property/Location remains explicitly out of scope, unchanged, per §12's own original recommendation.

### Deferred / explicitly out of scope

Quotes/Contracts/E-Sign, Reporting, Accounting, maintenance plans, inventory/warehouse, procurement, tenant switching, billing/subscriptions, an asset-type admin designer, depreciation/accounting, warranty-claim tracking, and BC rebate profile field migration into Assets (CleanBC/BC Hydro's 5 rebate-profile fields remain exactly where Phase 11.3 left them — `bc_rebate_customer_profiles` — unchanged by this phase) all remain explicitly deferred, per this phase's own scope boundary.

## §22 Addendum — Phase 12: Quotes / Estimates Foundation (2026-08-24)

**Status: IMPLEMENTED / VERIFIED / NOT COMMITTED, NOT PUSHED, NOT DEPLOYED.** Closes the "Quotes" half of §22's Phase 11.4 deferred list above with the first complete Quote/Estimate module: `Customer → Quote → Line Items → Pricing/Tax/Discount → Revision/Versioning → Status Lifecycle`, deliberately scoped to stop short of Contracts/E-Sign (Phase 13), which this phase's design was reviewed against for compatibility rather than built.

### Quote model and terminology

Domain/API term is **Quote**; the UI may say "Quote / Estimate". A Quote (`quotes` table) is a durable identity; its commercial content lives in an immutable, versioned `quote_versions` row, with `quote_line_items` as that version's children — additive tables (`migrations/0017_quotes.sql`), no existing table/column touched. `quote_status_history` is the audit trail (same shape as `lead_status_history`). `src/server/quotes.ts`/`quote-workflow.ts` sit at the top level of `src/server/`, matching `financial.ts`/`assets.ts`/`lead-workflow.ts`'s precedent — no `modules/**` coupling, confirmed by `pnpm run check:architecture` and an independent architecture review's own grep for HVAC/regional-program terms in the new files (none found).

### Tenant ownership

Organization → Customer → Quote. `quotes.organization_id` is classified **DIRECT_TENANT_COLUMN** (Phase 11.5's taxonomy), same reasoning as Assets: it needs its own independently listable/searchable/paginated endpoint (`GET /api/quotes`). `quote_versions`/`quote_line_items`/`quote_status_history` are **INHERITED_THROUGH_PARENT** — no own `organization_id`, safety flows from `quote_id`/`quote_version_id` already being org-scoped.

### Versioning / immutability

A Quote's current commercial content lives in exactly one `quote_versions` row (`quotes.current_version_id`), with sequential `version_number`s per quote (`UNIQUE(quote_id, version_number)`). Every mutating line-item/version-metadata function routes through `assertDraftAndGetCurrentVersion()`, which independently re-checks `status = 'draft'` server-side rather than trusting the caller — "editing a sent/accepted version's numbers would be the single worst bug this phase could ship," per the function's own doc comment. `createQuoteRevision()` never mutates a past version: it only reads the source version/line items and INSERTs a new version row, then resets the quote to `draft`. Verified by a dedicated test that edits the new (v2) version's line items after a revision and re-reads v1's totals — provably unchanged, not just asserted unchanged by omission.

### Money, tax, and discount

Integer cents throughout (`*_cents` columns), matching the codebase-wide monetary-representation rule. `computeQuoteTotals()` sums `Math.round(quantity * unit_price_cents)` per line, applies the discount (capped so it can never exceed the subtotal — a fixed discount larger than the subtotal produces a `$0.00` total, never negative), then computes tax on the **post-discount** subtotal. Totals are computed server-side and stored at write time via `recomputeAndStoreVersionTotals()` — the single call site every mutation routes through — never derived live later, matching invoices' precedent of storing (not recomputing) computed money. No route ever accepts a total/subtotal/tax-amount field from the client (`.strict()` schemas simply never declare them).

### Status lifecycle (FSM)

A real transition matrix (`QUOTE_TRANSITIONS` in `quote-workflow.ts`), not scattered conditionals: `draft → sent, cancelled`; `sent → accepted, rejected, expired, cancelled`; `accepted/rejected/expired/cancelled → (none)`. `accepted` is genuinely terminal — no reopen path exists at all (a customer wanting changes after accepting gets a NEW Quote via a future flow, not a mutated one, out of this phase's scope). `rejected`/`expired`/`cancelled` are terminal to a bare status transition but ARE reachable again via the separate, explicit `createQuoteRevision` operation, which resets `quotes.status` to `draft` — the same "reopening only through one named, audited mechanism" discipline as Lead's `lost → contacted`. `rejected`/`cancelled` both require a non-empty `reason`; expiration is deterministic (checked only at the moment someone attempts to accept a `sent` quote whose current version's `expires_at` has passed — no scheduler, no background sweep) and is itself a normal, audited transition. Concurrency: `transitionQuoteInternal()`'s optimistic `WHERE status = ?` guard plus a compensating history-row delete on a lost race — identical shape to `lead-workflow.ts#transitionLead()`.

### Customer / Lead / Job / Asset integration

`customer_id` is required and validated same-organization (`assertCustomerInOrganization`); `lead_id` is optional, validated the same way when present, and immutable after creation (no update route sets it) — traceability without letting the origin drift. No `job_id` column exists anywhere in the schema — a Quote never forces or auto-triggers Job conversion; that direction of dependency (a future `jobs.source_quote_id`) is left for a later phase to add additively. A line item's optional `asset_id` is validated against the **Quote's own customer** (`assertAssetBelongsToCustomer`), on both the create and update path, preventing a same-organization cross-customer asset reference. `RelatedQuotes` (`src/client/components/related-quotes.tsx`) is a small, self-fetching embedded section on both Customer detail (populated, with a "New Quote" action since a Customer is always known) and Lead detail (read-only list filtered by `lead_id`; "New Quote" is deliberately absent pre-conversion, since a Quote requires an already-known Customer — the natural real-world flow is Lead → convert to Customer → Quote, not a Quote directly off an unconverted Lead).

### Quote-vs-Contract/E-Sign boundary (Phase 13 readiness)

`accepted_by`/`accepted_at` are explicit internal/manual metadata only — the migration header and `quotes.ts` both state "Quote accepted != legally signed contract." No signature, no legal-effect claim anywhere in the schema or client. `quotes.id`/`quote_versions.id` are stable, immutable-once-created anchor points a future `quote_signatures` or `contracts` table can reference via a plain additive FK, with nothing on the Quote side needing to change or be reinterpreted. An independent architecture review explicitly evaluated this boundary and returned ACCEPT — "the explicit disclaimer... prevents Phase 13 from having to reinterpret or deprecate a field that already claims legal weight."

### Quote-vs-Invoice boundary

Zero coupling in either direction — no `invoices` table read or write anywhere in `quotes.ts`/`quote-workflow.ts` (confirmed by grep during the architecture review), no receivable/payment field on any Quote table. Accepting a Quote is a pure status flip plus metadata; it creates no financial obligation and generates no Invoice. Converting an accepted Quote into a Job/Invoice remains explicitly future work.

### API, RBAC, and mass-assignment safety

14 routes (`GET/POST /api/quotes`, `GET/DELETE /api/quotes/{id}`, `PUT /api/quotes/{id}/version`, `POST/PUT/DELETE` line-items, `GET` versions/version-detail, `POST` revisions, `GET/POST` transitions, `GET` status-history). RBAC: `canManageQuotes()` (admin + dispatcher; technician blanket-blocked) gates every route identically — verified live in the browser, not just by test: a technician session gets no sidebar entry, a direct `/quotes` URL falls back to the technician home view, and a raw `fetch('/api/quotes')` from the browser console returns a real `403`, not just client-side hiding. Every `.strict()` input schema omits `organization_id`, every computed total field, `version_number`, `accepted_by`/`accepted_at`, `created_by`, and `current_version_id` — mass assignment of any of these is structurally impossible, not just discouraged. Search uses the same wildcard-count-cap-plus-ESCAPE-clause defense Phase 11.4's security review discovered for Assets (`MAX_LIKE_WILDCARD_CHARS`), applied here proactively from the start and, after code review, moved into `listQuotes()` itself (not just the route) for defense-in-depth parity with `assets.ts`.

### Independent reviews — two real bugs found and fixed, one residual risk disclosed

Four independent reviews (Software Architect, Code Reviewer, Application Security Engineer, Test Automation Engineer, via the Agent tool) ran against the implementation. **Architecture: ACCEPT**, no blocking findings. **Security: no P0/P1** — tenant isolation, RBAC, and mass-assignment defense all independently verified route-by-route. **Code Review: ACCEPT-WITH-FIXES** and **Testing: initially INSUFFICIENT**, both converging on the same two real defects, since fixed and re-verified:

1. **Line items accepted negative/zero `quantity` and negative `unit_price_cents`**, letting a quote's total go negative despite the discount-cap logic (which only clamps the discount, not a raw negative line input) — contradicting the migration's own documented invariant. Fixed by adding `.positive()`/`.min(0)` to `LineItemInputSchema` (matching the existing `InvoiceLineInputSchema` precedent), adding matching client-side `min` attributes, and a new rejection test.
2. **A "two concurrent revision-creation attempts never produce a duplicate version_number" test was vacuous** — its `Promise.all` array held only one request, so the `UNIQUE(quote_id, version_number)` backstop it claimed to cover was never actually exercised. Fixed to genuinely race two concurrent requests, asserting one 201 and a safe 400/409 on the loser.

One residual risk was found and explicitly **disclosed rather than fixed** this phase (security review, P2, non-blocking per the reviewer's own assessment): line-item mutation and its totals-recompute are a separate read-then-write with no transaction or optimistic lock, so two genuinely concurrent edits to the same draft quote's line items could race and leave stored totals stale until the next mutation corrects them. Low blast radius today — no Job/Invoice conversion exists yet for a stale total to actually cost anyone anything — but flagged as a follow-up to close before a future phase trusts `quote_versions.total_cents` as authoritative for billing.

Several P2/P3 items were also fixed opportunistically: a `quote-list.tsx` display bug (`total_cents !== undefined` guarding a field the API actually returns as `null`, so the guard never fired), `deleteQuoteRoute` not reusing the shared error-mapping helper, a missing upper bound on `tax_rate`.

### Testing

`test/quotes.test.ts` (36 tests, up from an initial 33 after the review-driven additions): CRUD, line items (add/update/delete, and rejection once non-draft — extended during review to cover version-metadata updates and line-item update/delete, not just add), totals/tax/discount (percent, fixed-capped, negative-input rejection), versioning/revisions (including the old-version-provably-unchanged test), lifecycle (the full transition matrix, illegal-transition rejection, terminal-state coverage for accepted/rejected/expired, and an explicit cancel-with-reason execution test for both draft and sent), concurrency (both the status-transition race and — after the fix — a genuine revision-creation race), RBAC (technician blanket-blocked across every route), Customer/Lead reference safety, search/pagination (including the wildcard-cap rejection), tenant isolation, and cross-customer Asset line-item-reference safety. `test/helpers.ts`'s `resetDatabase()` required a real fix, not just an addition: the initially-naive child-before-parent DELETE order for the new quote tables hit `SQLITE_CONSTRAINT_FOREIGNKEY`, because `quotes.current_version_id` references `quote_versions` — the reverse of the normal cascade direction. Fixed by deleting `quotes` first (letting its own `ON DELETE CASCADE` chain remove the rest); confirmed this doesn't regress `leads.test.ts`/`assets.test.ts` (55/55 together).

### Verification result

Full suite: **1045/1045** (1009 baseline + 36 net new, all in `test/quotes.test.ts`). `tsc`/`eslint`/`pnpm run check:architecture`/`vite build` all clean. Real local-D1 migration verified (`wrangler d1 migrations apply open-fieldservice-db --local` applied `0017_quotes.sql` cleanly against the existing dev database). Real-browser verification (Chromium): admin flow (Customer → Create Quote → add line item → set tax rate → save draft → Mark Sent → Mark Accepted, watching totals/status/status-history/revision-history update live at each step); Related Quotes confirmed on both Customer detail (populated) and Lead detail (empty state, no premature create action); Technician confirmed blocked client-side AND server-side (a raw `fetch()` 403s); Dispatcher confirmed full parity with Admin; a synthetic Org B (fresh organization + admin user, real PBKDF2-hashed credential, created directly in local D1) confirmed zero cross-org exposure across list, direct-URL read, search, and a mutation attempt — all cleanly 404'd, console clean throughout. Two real bugs were also found and fixed live during this pass, outside the four formal reviews: a client routing gap (`use-router.ts`'s `VIEW_ROUTES` map was missing a `"quotes"` entry, so the URL silently fell through to the Dashboard view despite the sidebar correctly highlighting "Quotes") and a layout overflow bug (the Line Items table's inline-edit row had no horizontal-scroll container at the `detail-main` column width — wrapped in the existing `.table-wrap` CSS class already used elsewhere in the app). All synthetic browser-verification fixtures (Org B, its admin user, the technician/dispatcher test accounts, the test lead, the test quote) were deleted afterward; local dev DB counts confirmed restored to the pre-verification baseline.

### Deferred / explicitly out of scope

Contracts/E-Sign, Reporting, full Accounting, Maintenance Plans, Inventory/Purchasing, SaaS billing, tenant switching, PDF/print generation, actual outbound email delivery (quotes can be marked "sent" but no email is actually dispatched), a public customer-facing approval link, Quote templates, and BC rebate eligibility logic (informational display only, if ever added, is left to a future phase) all remain explicitly deferred, per this phase's own scope boundary. The one disclosed-not-fixed residual risk from this phase (the line-item-mutation totals race) was subsequently closed in the hardening pass below.

## §22 Addendum — Phase 12 hardening pass: ServiceTitan-residential compatibility review (2026-08-24)

**Status: IMPLEMENTED / VERIFIED / HARDENED / NOT COMMITTED, NOT PUSHED, NOT DEPLOYED.** A focused pre-Safe-Commit review of the (still uncommitted) Phase 12 Quote foundation against several future ServiceTitan-residential-style capabilities — evaluating *compatibility*, not building any of them. Only two genuine gaps were found worth closing now; everything else was confirmed already compatible with no code change.

### Good / Better / Best (`Quote → Version → Option → Item`) — ADDITIVE WITH SMALL MIGRATION, decision: no code built now

No `quote_options` table exists, and none was added. `quote_line_items.quote_version_id` still points directly at a version, exactly as before. **Correction to an earlier draft of this assessment** (an independent architecture review caught this): a future `quote_options` layer is schema-additive (a new table + a nullable `quote_line_items.quote_option_id`, `NULL` meaning today's single-proposal model), but it is **not** totally free — `quote_versions`-level totals (`subtotal_cents`/`total_cents`/etc.) and `recomputeAndStoreVersionTotals()`'s scan key (`WHERE quote_version_id = ?`) both assume exactly one commercial total per version. Once Options exist, summing every line item under a version would blend two differently-priced options into one meaningless number — totals will need to move to (or be duplicated at) an option-scoped table, and the recompute query will need to re-key on `quote_option_id`. This is real, disclosed, additive-but-not-trivial future work, not a silent gap discovered later. Given no Options feature was requested this phase, building `quote_options` now would be premature — the honest classification is **ADDITIVE WITH SMALL MIGRATION when that day comes**, and the decision made was **Option 1 (no code change now)**, with this paragraph as the disclosed roadmap for whoever picks it up.

### Pricebook — PRICEBOOK_READY_WITH_SMALL_EXTENSION

`quote_line_items` rows (`description`/`category`/`quantity`/`unit`/`unit_price_cents`/`sort_order`/`asset_id`) are plain captured values, never dynamically re-derived from any external pricing table at insert or read time (`insertLineItem`/`normalizeLineItem` in `quotes.ts`). The snapshot boundary Pricebook integration needs already exists structurally. The only future work is a nullable traceability column (e.g. `pricebook_item_id`) for "what this line item was copied from" — purely additive, zero impact on `computeQuoteTotals` or historical correctness. No code added this phase (none needed).

### Historical snapshot integrity — confirmed sound, no change

Traced `getQuote`/`getQuoteVersion`/`listQuotes`: none recompute totals live or join to Global Settings, tax config, or any mutable reference data. `quote_line_items.description`/`unit_price_cents` are true captured values, never re-resolved from `asset_id` at read time (that FK is write-time-validated only, for cross-navigation). A sent/accepted version's displayed numbers cannot drift if unrelated settings change later.

### Technician Present Mode / internal-field-visibility boundary — architecturally supported, no change

No cost/margin/commission/internal-SKU/internal-notes column exists anywhere in the Quote schema today — there is nothing to leak. The response-shaping layer (`QuoteSchema`/`QuoteVersionSchema`/`QuoteLineItemSchema` in `index.ts`) is already separate from the business-logic layer (`quotes.ts`), so a future narrower "customer-facing" response schema can be added without touching `computeQuoteTotals` or any calculation logic. `canManageQuotes()` (admin/dispatcher only, technician blanket-blocked) is unchanged by this pass — confirmed by the RBAC test still passing unmodified.

### Phase 13 (Contracts/E-Sign) — exact accepted-version identity, FIXED

**Schema** (amended in place in `migrations/0017_quotes.sql` — see below for why amending was correct here): `quotes.accepted_version_id` (nullable FK → `quote_versions`). **Code**: `quote-workflow.ts#transitionQuoteInternal()` now sets it, snapshotting `quote.current_version_id`, in the same parameterized UPDATE that already sets `accepted_by`/`accepted_at`, only when `toStatus === "accepted"`. Before this, "the accepted version" was correctly inferable (`createQuoteRevision()` is structurally blocked from an `"accepted"` quote, so `current_version_id` provably cannot change afterward) but only as an *inference*; Phase 13 now has an *explicit*, permanent, server-only snapshot to reference (`accepted_quote_id` + `accepted_quote_version_id`) without depending on that invariant holding forever. Verified: mass-assignment-blocked (not settable via any `.strict()` input schema — new test), and — the test that actually matters — correct on a **non-first** acceptance (`draft → sent → rejected → revision (v2) → sent → accepted`, asserting `accepted_version_id` equals v2's id and explicitly NOT v1's — closing a gap an independent testing review correctly identified: a happy-path-only "accept version 1" test can't distinguish a genuine snapshot from an API handler that just echoes `current_version_id`).

### Line-item mutation concurrency race — CLOSED

**Root cause** (from the base phase's disclosed P2): `recomputeAndStoreVersionTotals()` did a read (line items) then a separate write (stored totals) as two round-trips with no guard — two genuinely concurrent line-item mutations on the same draft version could race, with a stale read-based write overwriting a newer one (a lost update on the *version-level* stored totals; the underlying `quote_line_items` rows themselves were never at risk of loss, only the cached aggregate).

**Fix**: `quote_versions` gains `row_version INTEGER NOT NULL DEFAULT 0` (plain optimistic-concurrency counter, amended into `migrations/0017_quotes.sql`). Every totals write is now `UPDATE quote_versions SET ..., row_version = row_version + 1 WHERE id = ? AND row_version = ?` — the same `WHERE x IS NULL`/`WHERE status = ?` compare-and-swap idiom already used elsewhere in this codebase (`lead-conversion.ts`, `quote-workflow.ts`'s own transition guard). A lost race retries, bounded to 3 attempts, re-reading the now-current line items each time so the loop converges to a real, consistent total rather than surfacing a spurious conflict for what is, from the caller's perspective, an ordinary edit. Exhausting all 3 attempts throws a `QuoteError("conflict", ...)`, mapped to **409** (corrected during review from an initial, inconsistent 400 — matching `transitionQuoteInternal`'s existing conflict-status precedent for the identical failure shape).

**Verified — with an honest caveat about test rigor.** An independent testing review found the original 2-request race test was potentially non-discriminating: because both requests follow an identical, equal-length await chain, they can interleave in near-lockstep and happen to converge to the correct total even *without* the fix, since fair scheduling means each request's own final read already sees the other's earlier write. No mock/fault-injection seam exists in this real-D1 test harness to force a guaranteed collision deterministically. The test was widened from 2 to 5 concurrent line-item additions (raising, not guaranteeing, the odds that at least one pair's read/write genuinely interleaves out of lockstep) and the test's own comment now states plainly that this is probabilistic evidence reinforcing the code-level CAS guarantee, not a substitute for it — consistent with this project's standing rule against overclaiming what was verified.

**Residual, disclosed, not fixed**: a narrower race remains in `updateLineItem()` — two concurrent edits to *different fields of the same individual line item* could leave that one row's own `total_cents` computed from a stale mixed read (found by the independent architecture review). This does **not** corrupt the version-level aggregate total (`recomputeAndStoreVersionTotals()` re-sums raw `quantity`/`unit_price_cents` fresh from the database on every call, not the potentially-stale `total_cents` column), so no billing-relevant number can end up wrong — only a single line item's own display could show a `total_cents` momentarily inconsistent with its own `quantity × unit_price_cents` until the next mutation corrects it. Narrow blast radius, not fixed this pass; recorded here as a specific, named follow-up rather than a silent gap, matching this codebase's standing disclosure convention.

**Also fixed during review**: `row_version` was leaking into 3 of 4 read paths (`getQuoteVersion`, `listQuoteVersions`, `createQuoteRevision`'s return value) even though `recomputeAndStoreVersionTotals()` had been deliberately written to keep it out of its own return value — an independent security review caught the inconsistency (assessed as low-severity: `row_version` is never client-settable and has no business meaning, so this was a completeness gap, not an exploitable leak). All quote-version reads that can reach an API response now use an explicit column list (`QUOTE_VERSION_COLUMNS`) excluding it.

### Migration handling

`migrations/0017_quotes.sql` was amended in place rather than adding a new `0018` migration. Verified before doing so (`git status`/`git log`) that this migration has never been committed, pushed, or applied anywhere beyond this developer's own local dev D1 — an uncommitted, unshipped migration for the same still-in-flight phase is fair game to amend; fragmenting it across two files for no real historical reason would have been worse. Confirmed with an independent security review specifically on this point: zero schema-drift risk to any shared/deployed environment, since none exists yet.

### Independent reviews

Three independent reviews (Software Architect, Application Security Engineer, Test Automation Engineer) ran against this hardening pass specifically (not re-litigating the base phase's own prior four-review cycle). **Architecture: ACCEPT WITH NON-BLOCKING RISKS** (the Options-claim correction and the 400→409 status-code fix above both came from this review, along with the disclosed per-line-item-field race). **Security: no BLOCKER/P1** (the `row_version` leak fix above came from this review; CAS-exhaustion was assessed as a non-exploitable, self-inflicted, same-org availability edge case, not a DoS vector). **Testing: found the concurrency test's rigor gap and the `accepted_version_id` non-first-version gap** described above, both closed. All findings from all three reviews were fixed and re-verified; none remain open beyond the two explicitly disclosed residual risks (Options' future totals-rework, and the narrow per-line-item-field race).

### Verification result

Full suite: **1048/1048** (1045 prior baseline + 3 net new tests — the `accepted_version_id` mass-assignment test, the non-first-version snapshot test, and the widened concurrency test replacing the original 2-request version in place). `tsc`/`eslint`/`pnpm run check:architecture`/`vite build` all clean. Local D1 schema re-synced (`ALTER TABLE` for both new columns, verified via `sqlite_master`). Real browser re-verification (Chromium, admin flow: create quote → add line item → confirm `row_version` absent from the API response → mark sent → mark accepted → confirm `accepted_version_id` present and equal to `current_version_id` via a raw `fetch()`); a fresh synthetic Org B re-confirmed zero cross-org exposure on list/read/transition against the newly-created quote — all cleanly 404'd or empty, console clean throughout. All synthetic fixtures (Org B, its admin user, the test quote) deleted afterward; local dev DB counts confirmed restored to baseline (0 quotes, 2 pre-existing users, 1 organization).

### Deferred / explicitly out of scope (unchanged from the base phase)

No Good/Better/Best UI, no Pricebook, no Present Mode UI, no Contracts/E-Sign, no Customer Portal, and nothing else from the base phase's own deferred list was built in this pass — this was a compatibility review and minimal hardening, not new feature work.
