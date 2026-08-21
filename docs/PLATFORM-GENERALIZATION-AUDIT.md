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
