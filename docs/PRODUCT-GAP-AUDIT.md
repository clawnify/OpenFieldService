# Open FieldService Product Gap Audit

**Repository:** `clawnify/open-fieldservice`
**Audit date:** 2026-08-14
**Audit scope:** product, HVAC workflow, architecture, persistence, backend/API, frontend/UX, security, testing, schedule, dashboard, and reporting
**Implementation status:** audit only; no application behavior, dependencies, or database schema were changed

## 1. Executive summary

Open FieldService is a compact, functional field-service CRUD prototype. It can create customers and jobs, assign one technician, show a basic weekly schedule, record checklist items/notes/materials, create invoices, and display a small dashboard. Its implementation is understandable and the Vite bundle builds successfully.

It is not presently production-grade or an adequate system of record for an HVAC company. The largest blockers are:

1. There is no authentication, authorization, company/tenant boundary, or API protection. Every read, mutation, and destructive endpoint is public (`src/server/index.ts`; no auth middleware or user/company entities exist in `src/server/schema.sql`).
2. There is no migration system, automated test suite, lint task, or passing strict typecheck. `package.json` exposes only `dev` and `build`; the schema is reapplied from `src/server/schema.sql` every development start.
3. Core HVAC workflow entities are absent: leads, contacts, multiple service locations, estimates/quotes, equipment/assets and history, agreements, dispatch events, technician availability/time off, work timestamps, payments, attachments/signatures, notifications, and audit records.
4. Schedule is a seven-column list grouped by date, not a dispatch calendar. It has week navigation and multiple jobs per day, but no time axis, filters, availability/conflicts, drag/drop, duration geometry, month/day modes, or robust timezone model (`src/client/components/schedule-view.tsx`).
5. Reports do not exist. Some simple aggregates are possible from current tables, but financial, utilization, lifecycle, recurring-service, and payment reporting either has ambiguous semantics or requires schema changes.
6. Data integrity is risky. Customer deletion cascades through jobs and invoices, material deletion cascades through usage history, generated identifiers are race-prone, invoice multi-step writes are not transactional, money uses floating-point `REAL`, and enumerated statuses are not constrained (`src/server/schema.sql`, `src/server/index.ts`).

The README's description of a “production-ready” ServiceTitan alternative is not supported by the implementation. It also describes a `data.db`, `better-sqlite3`, a missing `src/server/dev.ts`, and ports 5174/3004, while the actual runtime is Cloudflare Wrangler/D1 with Vite normally on 5173 and API on 8787 (`README.md`, `package.json`, `wrangler.toml`, `vite.config.ts`).

**Recommended maturity classification:** useful demonstration/MVP scaffold; not safe for production business data.

## 2. Current architecture

### 2.1 Runtime and deployment

- **Frontend:** Preact single-page application bundled by Vite (`src/client/main.tsx`, `src/client/app.tsx`, `vite.config.ts`).
- **Backend:** one Cloudflare Worker-compatible Hono/OpenAPI application (`src/server/index.ts`, 1,344 lines), created through `@clawnify/app`.
- **Database:** Cloudflare D1 in production and Wrangler's SQLite-backed local D1 emulation in development (`wrangler.toml`). `src/server/db.ts` only re-exports `query`, `get`, `run`, and `initDB` from `@clawnify/db`.
- **Development:** `package.json` first executes the entire schema against local D1, then runs Vite and Wrangler concurrently. Vite proxies `/api` to `http://localhost:8787` (`vite.config.ts`).
- **Production frontend delivery is unspecified:** `wrangler.toml` declares only the Worker entry and D1 binding; it has no static assets binding. `vite build` produces `dist`, but the repository provides no deployment script showing how the frontend and Worker are jointly hosted.
- **Configuration/secrets:** no `.env` examples, environment-variable reads, or secret requirements were found. There is also no company/business configuration model.
- **Package manager:** pnpm, evidenced by `pnpm-lock.yaml` and `pnpm-workspace.yaml`.

### 2.2 Client architecture

- `src/client/app.tsx` instantiates a single global `AppContext`, uses a custom History API router, and conditionally renders one page component.
- `src/client/hooks/use-router.ts` maps a fixed first path segment to eight views. Unknown paths silently fall back to Dashboard; there is no explicit 404 route.
- `src/client/hooks/use-app.ts` is the entire client data layer and mutation layer. It maintains all domain state and performs REST calls through the 17-line `src/client/api.ts` helper.
- Initial render makes nine logical loads in one `Promise.all`: stats, jobs, customers, technicians, service types, materials, invoices, schedule, and two lookups (`use-app.ts:116-130`). This over-fetches data regardless of active route and makes the whole app depend on every resource succeeding.
- Job/customer/invoice list pagination is client state backed by server `LIMIT/OFFSET`; service types, technicians, materials, and dropdown lookups are unpaginated.
- There is no query cache, request cancellation, stale-request protection, optimistic concurrency, URL-synchronized filters/page, or state/data library.
- “Agent mode” is a query-string-driven presentation mode (`app.tsx:20-29`), not an authentication or permission mode.

### 2.3 Server/API architecture

- All schemas, handlers, SQL, and route declarations live in `src/server/index.ts`.
- Hono route schemas use Zod through `@hono/zod-openapi`. Prepared positional parameters are used for user values, which is a meaningful SQL-injection defense.
- Update SQL column names are assembled dynamically, but only from keys surviving each route's explicit Zod object, so current update routes have an effective field allowlist (`updateJob`, `updateCustomer`, `updateTechnician`, `updateServiceType`, `updateMaterial`, `updateInvoice`).
- Handlers directly issue SQL. There is no domain/service/repository separation, central error mapping, structured logging, audit service, or transaction boundary.
- OpenAPI response schemas exist for many routes, but several use `z.any()` and the implementation does not typecheck against declared response schemas.

### 2.4 Persistence and migrations

- `src/server/schema.sql` contains the full schema, seed rows, and indexes. There is no migrations directory, version table, rollback strategy, or production migration command.
- `CREATE TABLE/INDEX IF NOT EXISTS` makes first-run initialization repeatable but cannot safely evolve existing tables.
- Seed data uses fixed IDs with `INSERT OR IGNORE`, mixing demo/reference data with schema initialization (`schema.sql:133-164`).
- The README's claim that data persists in root-level `data.db` is inaccurate for the current scripts; Wrangler stores local D1 state under `.wrangler/state`.
- `.gitignore` ignores `docs/` but not `.wrangler/` or the `.dev-server.*.log` files created during local execution. Ignoring `docs/` also means this requested audit will not appear in a future Git commit unless the ignore rule is changed or the file is force-added; that rule was not changed during this audit.

## 3. Existing capabilities

The following inventory is based on implemented schema, endpoints, and UI—not README claims.

### 3.1 Jobs

- Create a job for one customer with optional one technician and one service type, date, time, priority, address, and notes (`CreateJob`; `POST /api/jobs`).
- Defaults duration/price from the selected service type server-side and copies the customer's current address when job address is blank (`createJob`, `index.ts:295-343`).
- Status values represented in the client are scheduled, confirmed, in progress, completed, and cancelled (`types.ts:3`; `JobDetail`).
- Job list has server pagination (50/page), free-text search over identifier/customer/address, and a single status filter (`listJobs`; `JobList`). Backend additionally accepts exact date and technician filters, but the Job list UI does not expose them (`index.ts:163-205`).
- Job detail shows basic schedule/customer/service/technician/price data and permits status and technician changes (`JobDetail`). It does not provide a general job edit form for date, time, duration, price, priority, address, notes, or service type despite the API supporting updates.
- One technician per job only (`jobs.technician_id`).

### 3.2 Customers

- CRUD for one customer record containing one name, email, phone, address, city/state/ZIP, and undifferentiated notes (`customers`; customer components and endpoints).
- Paginated search over name, email, phone, and address (`listCustomers`).
- Customer detail includes all associated jobs as an unpaginated service-history table (`getCustomer`, `CustomerDetail`).
- There are no separate contacts or locations; the job stores an address snapshot/string.

### 3.3 Technicians and service types

- Technician CRUD with name/contact/color and an `active` roster flag (`technicians`; `TechnicianList`). Active technicians populate assignment dropdowns (`GET /api/technicians/all`).
- “Active jobs” count means all current jobs in scheduled/confirmed/in-progress status, with no date bound (`listTechnicians`, `index.ts:657-664`). It is not current workload hours or availability.
- Service-type CRUD includes description, default minutes, default price, and display color (`service_types`; `ServiceTypeList`).

### 3.4 Job work records

- Free-text timestamped job notes can be added/deleted (`job_notes`, `JobDetail`). They have no author, type, visibility, or immutable event semantics.
- Per-job checklist labels can be added, toggled, and deleted (`job_checklist`, checklist routes/UI). There are no reusable templates, required items, attribution, timestamps, or captured values.
- Materials can be attached to a job with quantity and a snapshot unit cost (`job_materials`, material routes/UI).

### 3.5 Materials

- Material CRUD supports name, unit, unit cost, and an editable `in_stock` number (`materials`; `MaterialList`).
- Job material usage preserves `unit_cost`, enabling historical cost calculations if the link remains present.
- Adding/removing job material does not decrement/restore stock (`addJobMaterial`, `deleteJobMaterial`). There are no receipts, adjustments, warehouses/trucks, reorder points, or inventory transaction ledger.

### 3.6 Invoices

- REST API can create an invoice with free-form line items, calculate subtotal/tax/total, list/filter it, update limited status/date/note fields, and delete it (`index.ts:1099-1279`).
- UI can create an invoice from any job (not only completed jobs), view lines, change status, set due date, and delete (`JobDetail`, `InvoiceList`, `InvoiceDetail`).
- `use-app.ts` contains `addInvoice`, but no component provides a general new-invoice form. The practical UI creation path is “Create Invoice” from a job.
- Invoice-from-job includes job price and material costs as charge lines (`invoiceFromJob`). It can be invoked repeatedly for the same job.

### 3.7 Navigation and feedback

- Bookmarkable client paths exist for list/detail pages (`use-router.ts`).
- Tables have basic empty states, CRUD forms show a submitting label in modal create flows, and API failures can surface in a dismissible global error banner (`ErrorBanner`, `api.ts`).
- Job/customer/invoice lists have previous/next pagination (`Pagination`).

## 4. Missing capabilities

### Critical—production blockers

- **Identity and security:** authentication, sessions/tokens, user accounts, authorization/RBAC, technician-vs-dispatcher permissions, tenant/company isolation, protected API, rate limiting, CSRF strategy, and security audit trail. Evidence: no corresponding schema entities or middleware; all routes in `src/server/index.ts` are directly registered.
- **Safe persistence evolution:** versioned migrations, backups/restores, retention policy, recovery testing, production database configuration, and explicit deployment procedure.
- **Data integrity and accounting semantics:** transactional identifiers/invoice writes, integer/decimal money representation, payment ledger, immutable invoice/payment history, safe deletion/archive policies, domain constraints, and concurrency controls.
- **Quality gates:** passing typecheck, automated tests, linting, CI enforcement. Current direct typecheck fails and no test/lint script exists.
- **Operational ownership:** company profile, business timezone, locale/currency/tax configuration, business hours, and service areas.

### High priority

- Professional scheduler/dispatch board: day/week/month/resource views, date navigation/picker, filters, unassigned queue, time geometry, conflicts, availability, business hours/time off, drag/drop/resize with concurrency protection, and timezone-safe date handling.
- Real customer/property model: accounts, multiple contacts, multiple service locations, access instructions, billing/service address separation.
- HVAC equipment/assets: equipment type, make/model/serial, install/warranty dates, location, service history, readings, and replacement recommendations.
- Estimates/quotes: estimate lifecycle, structured lines, discounts/taxes, approval/decline, conversion to job/invoice, versioning, and PDFs.
- Dispatch/work execution: assignment events, multiple technicians/crews, dispatch/en-route/arrived/work-start/work-complete timestamps, technician notes, attachments/photos, signatures, and completion controls.
- Recurrence and maintenance: recurrence rules/series/occurrences, preventive maintenance plans and agreements, entitlements, renewal/billing state, and generation jobs.
- Payments: payment/refund records, methods/reference, partial payments, balance, allocation, settlement dates, and processor integration boundary.
- Reporting foundation and initial operational/financial reports with consistent business definitions.
- Notifications: customer/technician email/SMS confirmations, reminders, dispatch updates, templates, consent, and delivery status.

### Medium priority

- Leads/request intake and conversion funnel.
- Inventory transaction ledger, purchase/receipt flows, truck stock, reorder thresholds, reservations, and material markup.
- Search across the product; advanced filters, sorting, saved views, and exports.
- Invoice/estimate PDF generation and email delivery.
- Dispatch map, geocoded service locations, travel estimates, routing, and service-area enforcement.
- Better status workflow rules, cancellation reasons, reassignment reasons, SLA windows, skills/certifications, and job tags.
- Responsive navigation/mobile technician workflow, offline/retry strategy, accessibility and keyboard support.
- Observability: structured logs, request IDs, metrics, error monitoring, health/readiness checks.

### Nice to have

- Route optimization, GPS/vehicle tracking, customer portal, online booking, accounting integrations, payroll/commission support, barcode scanning, custom fields/forms, and advanced forecasting.

## 5. Schedule audit

### 5.1 Exact current behavior

| Capability | Actual repository state | Evidence |
|---|---|---|
| Week view | Yes, fixed seven inclusive days | `ScheduleView.getDaysInRange`; `use-app.ts:40-47` |
| Previous/Next | Yes, exactly ±7 days | `ScheduleView.shiftWeek`, lines 23-29 |
| Today | Yes, resets to computed Monday-Sunday | `ScheduleView.goToday`, lines 31-38 |
| Day/month view | No | No view-mode state/control; grid maps the current range only |
| Date picker/arbitrary jump | No UI | `ScheduleView` header only has Today and chevrons |
| Multiple jobs per day | Yes | `dayJobs = scheduleJobs.filter(...)` then maps all jobs, lines 57-80 |
| Time-based data | Start string and duration exist | `jobs.scheduled_time`, `jobs.duration` |
| Time-based visualization | No | Cards are sequential; no vertical time axis or duration-derived size |
| Technician assignment/color | One tech/job; technician color shown as left border | `jobs.technician_id`; `schedule-view.tsx:72,78` |
| Technician filter | Backend only | Optional `technician_id` in `getSchedule`; client never sends it |
| Service/status/unassigned filters | No | Not accepted by schedule route or represented in Schedule UI |
| All-day jobs | No explicit concept | `scheduled_time` defaults to `09:00`; no all-day field |
| Current-time indicator | No | Only current-day background highlighting |
| Drag/drop/resizing | No | Schedule cards only navigate on click |
| Conflict/double-book warning | No | No overlap query, constraint, or UI |
| Availability/hours/time off | No | Only technician `active`; no schedule availability tables |
| Recurring job expansion | No | Fields are stored/displayed only; no generator/series logic found |
| Proper timezone handling | No | No company timezone; mixed local `Date` and UTC `toISOString()` |
| Responsive/mobile calendar | No meaningful implementation | No CSS media queries; `.schedule-grid` is fixed to seven columns |

The imported `technicianLookup` in `ScheduleView` is unused (`schedule-view.tsx:18`), suggesting a filter may have been intended but is not implemented.

### 5.2 Answers to the required architecture questions

1. **Why seven days?** `useAppState` computes Monday and Sunday by adding six days (`use-app.ts:40-46`). `shiftWeek` always shifts seven days and reconstructs an end six days later (`schedule-view.tsx:23-29`). `goToday` repeats the same calculation. CSS defines `.schedule-grid { grid-template-columns: repeat(7, 1fr) }` (`styles.css:803-811`). There is no view-mode abstraction.
2. **UI-only or backend restriction?** The seven-day restriction is UI/state-level. The API accepts required arbitrary string `start` and `end` and applies inclusive `>=`/`<=` comparisons (`getSchedule`, `index.ts:866-903`).
3. **Initialization?** `today = new Date()`, then `monday.setDate(today.getDate() - today.getDay() + 1)`, Sunday is Monday + 6, and both are converted using `toISOString().split("T")[0]` (`use-app.ts:40-46`). On Sunday (`getDay() === 0`) this selects the *next* Monday, not the Monday six days earlier.
4. **Fetching?** `fetchSchedule` sends `GET /api/schedule?start=...&end=...` and stores the returned array (`use-app.ts:100-103`). It runs on initial app load and whenever range changes (`use-app.ts:116-153`), plus after job mutations.
5. **Arbitrary ranges?** Yes syntactically, including month ranges. However `start/end` are only `z.string()`—not validated ISO dates, ordered, or capped—and comparison relies on lexically sortable `YYYY-MM-DD` values.
6. **Month view effort?** A basic month grid can reuse the current endpoint with a calendar-grid start/end; no mandatory backend change is needed for correctness at small volume. A production month view should extend the backend for filters, field projection, result limits/density summaries, and range validation.
7. **Scale risks?** Schedule returns every full job row plus joined customer/technician/service data with no limit. A broad/malformed range can cause large D1 reads, response payloads, memory use, and DOM work. The UI repeatedly filters the full job array for every day (`days × jobs`) and renders every card. `idx_jobs_scheduled_date` helps the range query, but likely composite indexes such as `(scheduled_date, scheduled_time)`, `(technician_id, scheduled_date, scheduled_time)`, and filtered variants are needed after query-plan measurement.
8. **Pagination?** No. The schedule response has no cursor/limit/total (`getSchedule`). Month resource views may need bounded ranges and server-enforced maximums rather than ordinary page pagination; dense days can use per-day counts and progressive detail.
9. **Timezone bugs?** Yes. UI date-only values are built with local midnight but serialized as UTC, which can move the calendar date in positive UTC offsets. `todayStr` and default job date use current UTC date (`schedule-view.tsx:21`, `create-job.tsx:8`), so users west of UTC can see tomorrow late in their local evening. The Monday algorithm has the Sunday bug above. Server dashboard “today” uses Worker runtime UTC (`index.ts:139-143`). `job_notes.created_at` is SQLite UTC-like text then parsed by `new Date()` without an explicit `Z` (`JobDetail:220`), which browsers can interpret as local time. DST and company/user timezone are undefined.
10. **Safe redesign?** Preserve the current `scheduled_date`, `scheduled_time`, and `duration` contract initially, but put calendar state behind a typed model and make all moves use the existing job update operation with server-side validation/versioning. Introduce timezone/settings and conflict primitives before advanced interactions, then add modes incrementally behind tests.

### 5.3 Recommended target scheduling architecture

**Domain model**

- Establish `company.timezone`, business hours, location timezone policy, and explicit date/time semantics. For a single-timezone HVAC company, store service-local date/start time plus timezone and derive UTC start/end instants; do not rely on browser UTC conversions of date-only strings.
- Add technician availability rules and exceptions/time off.
- Replace one assignment column with `job_assignments` for primary/support technicians and assignment history. Retain a compatibility projection during migration.
- Add job lifecycle timestamps and an optimistic concurrency/version field.
- Model recurrence as series/rule plus generated occurrences, exception/override relationships, generation horizon, and idempotency—not flags on individual jobs.
- Add optional all-day/service-window semantics only if a defined business case exists.

**API**

- Evolve `GET /api/schedule` to validate `start`, `end`, maximum span, timezone, and filters (`technician_ids`, service types, statuses, assigned/unassigned). Return a deliberately small schedule-event DTO, not the full `JobSchema`.
- Add availability alongside events or in a parallel endpoint, conflict preview, and atomic reschedule/assignment commands with expected version.
- Return structured 409 conflicts with override policy; do not make UI-only warnings the integrity boundary.
- Use SQL range/filter queries server-side. Do not download general job lists and derive the calendar client-side.

**Client**

- Introduce calendar state: `anchorDate`, `viewMode`, visible range, timezone, filters. Synchronize important state into URL query parameters.
- Fetch by visible range and cache range/filter keys. Cancel obsolete requests and debounce filter changes.
- Implement in order: correct date utilities/navigation → day/week/month rendering → filters/unassigned → resource timeline/availability → guarded drag/drop and resize.
- Virtualize resource/time-grid rows and summarize dense month cells. Provide keyboard-accessible move/edit alternatives to drag/drop.
- Keep existing click-to-job navigation and job update flows available throughout migration.

## 6. Reports audit

### 6.1 Architecture recommendation

Reports should use **dedicated server-side aggregate endpoints backed by SQL aggregation**, separated from CRUD handlers into report query/service modules. Existing list endpoints are paginated, return operational DTOs, and cannot safely/efficiently support broad aggregation. `/api/stats` can share metric definitions/query helpers but should not become a single giant reports endpoint.

Recommended shape:

- `GET /api/reports/overview?from&to&timezone&basis=...`
- `GET /api/reports/jobs?...`, `/technicians?...`, `/customers?...`, `/invoices?...`, `/materials?...`
- Stable response metadata containing effective filters, timezone, currency, comparison period, and metric definitions.
- SQL `GROUP BY`/conditional aggregates in D1, server-side date bucketing consistent with company timezone, bounded date ranges, authorization/company predicates, and export endpoints that reuse the same query definitions.
- A reporting service/query layer rather than adding more SQL to `src/server/index.ts`. Pre-aggregation/materialized summaries should be considered only after measured D1 limits; current scale does not justify them by default.
- Define “revenue” explicitly (completed job value, invoiced amount, or recognized cash/payment amount). The current dashboard calls completed job prices revenue, which is not cash revenue.

### 6.2 Report feasibility matrix

“Supported now” means derivable with current persisted fields, not that a report endpoint/UI exists. All reports require new API/UI work.

| Report/metric | Source and aggregation | Current support and limitations | Migration / likely index |
|---|---|---|---|
| Completed-job value/revenue | `jobs`; `SUM(price)` where completed, group by `scheduled_date` | Yes as a proxy; no completion timestamp, payment recognition, discounts, or currency | No for proxy. Index `(status, scheduled_date)` |
| Revenue trend/date range | `jobs` by scheduled date or `invoices` by created/paid date | Partial; semantics differ and paid date can be blank/manual | Payment/completion fields required for accounting-grade trend |
| Revenue by service type | `jobs JOIN service_types`; group `service_type_id` | Yes for completed job price; deleted service becomes null/name lost | No for proxy; archival/snapshot dimension recommended; `(status, scheduled_date, service_type_id)` |
| Revenue by technician | `jobs JOIN technicians`; group `technician_id` | Yes for single assigned tech/completed job price; no crew attribution/history | Assignment/history migration for reliable metric; composite index |
| Revenue by customer | `jobs` or `invoices`; group customer | Yes while customer exists; customer delete cascades history | Safe archival policy; `(customer_id, status, scheduled_date)` |
| Average job value | `AVG(jobs.price)` with defined statuses | Yes as quoted job price; not net/paid revenue | No for proxy; status/date index |
| Job counts by status/service/priority/technician | `jobs`; `COUNT`, grouped | Yes, current-state counts | No; composite date + dimension indexes as measured |
| Jobs by city/area | Current job `address` is unstructured; customer city can differ from job site | Not reliable. Customer-city proxy is possible only for unchanged primary address | Service-location migration and geographic columns/indexes required |
| Completion/cancellation rate | Conditional counts by current status | Partial snapshot only; no completion/cancellation timestamps or status history/cohort definition | Lifecycle/event migration required for reliable trends |
| Average scheduled duration | `AVG(jobs.duration)` | Yes for planned duration only | No; `(scheduled_date, status)` |
| Average actual duration | Work start/end events | No data | Yes—work event/timestamp fields |
| Scheduled vs completed | Conditional current status grouped by scheduled date | Partial; jobs rescheduled across periods and current state overwrites history | Lifecycle/schedule history for accurate period transitions |
| Technician jobs completed | `jobs` current technician/status | Partial; reassignment destroys attribution and one tech only | Assignment/event history required for reliable attribution |
| Scheduled hours | `SUM(duration)/60` by current technician/date | Yes planned hours | No for simple version; assignment model for crews |
| Completed hours | Sum planned duration for completed jobs | Proxy only, not actual hours | Work timestamps/time entries required |
| Technician utilization | actual/productive hours ÷ available capacity | No availability/capacity or actual time | Yes—hours, availability/time off, assignments |
| Cancellation/reassignment | Status and assignment history | Current cancellation count only; no reasons/history | Yes—job event/assignment audit model |
| New customers | `customers.created_at`; count by period | Yes, but timestamp/timezone semantics weak | Company/timezone fields; index `created_at` |
| Repeat customers/jobs per customer | `jobs GROUP BY customer_id`, threshold >1 | Yes for current retained data | No; date/customer composite helpful |
| Top customers / lifetime value | completed jobs or invoices grouped customer | Partial proxy; deletion erases history, no payments/refunds | Payments and archival required for financial CLV |
| Total invoiced | `SUM(invoices.total)` excluding cancelled as defined | Yes | No; index `(status, created_at)` |
| Total paid / payment trend | Paid invoices, `paid_date` | Partial only for full invoice marked paid; no partial payments/refunds | Yes—payments/refunds/allocation ledger; paid-date index for interim proxy |
| Outstanding/overdue balance | Sum invoice totals by status/due date | Partial: balance equals total because no payments; overdue is manual | Payments required; `(status, due_date)` |
| Aging buckets | outstanding invoice `due_date` vs as-of date | Approximate if dates/statuses maintained; empty dates and no partial balances undermine it | Payments/balance and due-date constraints; `(status, due_date)` |
| Tax collected | `SUM(tax_amount)` on paid invoices | Approximate; no jurisdiction, rounding policy, exemptions, partial payment allocation | Tax/payment model for accounting-grade result |
| Invoice status breakdown | `COUNT/SUM` by `status` | Yes current snapshot | No; `(status, created_at)` |
| Materials used/cost | `job_materials`; `SUM(quantity)`, `SUM(quantity*unit_cost)` | Yes, joined through job date/tech; usage row has no timestamp and deletion can erase it | Preserve usage on catalog delete; indexes on `material_id`, plus job/date joins |
| Usage by job/technician | `job_materials JOIN jobs` | Yes for current single technician and job assignment | Assignment history needed for robust tech attribution |
| Most-used materials | Group `job_materials.material_id` | Yes until material deletion cascades usages | Change deletion/archive strategy; add `idx_job_materials_material` |

### 6.3 Reports module gaps

- No Reports view in `View`, router map, `Sidebar`, or component tree (`types.ts:1`, `use-router.ts:9-19`, `sidebar.tsx:5-14`, `app.tsx:45-58`).
- No report/analytics API routes or SQL beyond `/api/stats`.
- No shared date range, timezone, comparison, grouping, CSV/PDF, or saved-report primitives.
- Existing full-table dropdown endpoints (`customers/all`, `technicians/all`) are unsuitable as scalable report-filter sources.
- Reports must enforce the future company/tenant predicate on every query; adding reports before tenant/security foundations risks data exposure.

## 7. HVAC-specific gaps

### 7.1 Workflow coverage

| Real HVAC step | Current support | Meaningful gaps |
|---|---|---|
| Lead/customer request | Starts only at manually created customer/job | No lead/request, channel, campaign, requested service window, qualification, conversion, or lost reason |
| Customer | One basic record | No account type, multiple contacts, communication preferences/consent, billing terms, tags, credit/tax exemption |
| Property/service location | Address fields on customer plus copied job address string | No multiple locations, billing vs service address, access/parking instructions, geocode, service area, location contacts, site history |
| Estimate/quote | None | No estimate, lines, alternatives, tax/discount, approval, e-signature, expiration, conversion |
| Job/work order | Basic job record | No work-order type, source estimate/agreement, skills, service window, diagnosis, resolution, warranty/callback, department, purchase order |
| Scheduling | Weekly date grouping | See Schedule audit; no real dispatch capacity/conflict model |
| Technician dispatch | Manual single-tech assignment/status change | No dispatcher state, crew, route, en-route/arrived events, technician acknowledgement, map/GPS |
| Technician work | Notes/checklist/materials | No mobile/offline workflow, clock events, labor/time entries, photos/files, readings, signature, customer approval, required completion checks |
| Materials | Usage and editable stock | No inventory movements, truck/warehouse, purchase/return, decrement, markup, serialization |
| Completion | Manual status | No completion timestamp, immutable lifecycle, outcome/cancellation codes, follow-up generation, warranty/callback link |
| Invoice | Basic free-form invoice | No invoice editor UI, discounts, terms, PDF, send event, immutable issued snapshot, automatic numbering transaction |
| Payment | Manual `paid` status/date only | No payment/refund/partial/balance/method/reference/processor |
| Reporting | Dashboard counts only | No Reports module; see Reports audit |

### 7.2 HVAC domain requirements

- **Equipment/assets:** furnace/air handler/condenser/heat pump/thermostat records; make, model, serial, capacity, refrigerant, fuel, install/manufacture dates, warranty, filters, location, photos, and equipment-specific service history.
- **Diagnostics and compliance:** readings, fault codes, refrigerant usage/recovery, combustion/safety checks, permit/inspection references, reusable form/checklist templates.
- **Maintenance agreements:** plan/customer/location/equipment coverage, included visits, cadence, entitlements/discounts, renewal/cancellation, billing, next-due generation.
- **Demand service:** emergency priority/SLA, service windows, callback/warranty jobs, skills/certification matching and after-hours rules.
- **Replacement sales:** opportunities/estimates with options and approvals, equipment and labor lines, deposits, installation milestones.

The generic `Installation` and `Maintenance` service-type seed rows (`schema.sql:140-141`) are labels only and do not implement these workflows.

## 8. Data-model gaps

### 8.1 Existing integrity risks

- **Customer deletion is catastrophic:** `jobs.customer_id ON DELETE CASCADE` and `invoices.customer_id ON DELETE CASCADE` (`schema.sql:42,100`). Deleting a customer through an unguarded UI/API deletes jobs and invoices; job cascades then delete notes/checklists/material usage. Production systems should normally archive customers and retain financial/work records.
- **Technician/service deletion loses attribution:** job foreign keys become null (`schema.sql:43-44`). This prevents orphan IDs but destroys report labels/assignment attribution unless events/snapshots are retained.
- **Material deletion destroys history:** `job_materials.material_id ON DELETE CASCADE` (`schema.sql:91`), so deleting a catalog material removes usage/cost evidence.
- **Job deletion detaches invoices:** invoice `job_id` becomes null (`schema.sql:101`), retaining invoice but losing job link. The endpoint does not check invoice state or provide an archive policy.
- **Invoice deletion destroys lines:** appropriate structurally but unsafe after issuance/payment without permissions and audit.
- **No domain checks:** statuses, priority, invoice status, active/boolean values, nonnegative quantity/duration/prices/tax/stock, date formats, and `start <= end` have no database `CHECK` constraints. Most Zod validators only assert broad string/number types.
- **Loose nullability:** many defaulted fields are not `NOT NULL`; API assumptions/types declare strings/numbers even when direct/imported SQL could store null.
- **Money/tax use binary floating point:** `REAL` is used for prices/costs/tax/totals (`schema.sql:33,50,83-84,93,103-106,118-120`), inviting rounding drift. Use integer minor units or a rigorously defined decimal strategy and round each line/tax according to policy.
- **Date/time semantics are strings:** scheduled date/time, due/paid date and recurrence date are unrelated `TEXT`; there is no timezone, UTC instant, service window, actual timestamps, or constraints.
- **Mutable current state replaces history:** job status, technician, schedule, price, and invoice status are overwritten. Notes are not a lifecycle audit because they lack actor/type/before-after values.
- **Duplicate/ambiguous invoicing:** no unique constraint on `invoices.job_id`; `invoiceFromJob` can create unlimited invoices from one job. An invoice's `customer_id` can disagree with its linked job's customer because the API/database do not enforce consistency.
- **Material stock is disconnected:** usage inserts do not alter `materials.in_stock`; the number is not a trustworthy inventory balance.
- **Recurring fields are inert:** `is_recurring`, free-text `recurrence_interval`, and `next_recurrence_date` have no series, constraints, generator, exceptions, or endpoint logic. Creation does not set next recurrence (`createJob` insert omits that column).

### 8.2 Transactions and races

- `nextIdentifier` and `nextInvoiceIdentifier` read a counter then update it in separate statements (`index.ts:94-108`). Concurrent requests can compute the same identifier; the unique constraint will reject one after the counter race.
- Create-customer/technician/service-type handlers insert and then retrieve `ORDER BY id DESC LIMIT 1` (`index.ts:577-584`, `703-709`, `802-808`). A concurrent insertion can cause the wrong record to be returned. D1 `RETURNING`/batch or a transactionally safe ID retrieval should be used.
- Invoice creation updates the counter, inserts header, loops line inserts, then reads (`index.ts:1200-1233`); invoice-from-job similarly inserts header and lines (`1295-1342`). No transaction is used, so failures can leave incomplete invoices or consumed counters.
- Checklist sort-order calculation (`MAX + 1`) has a race (`index.ts:924-925`).
- Mutations have no version/ETag/updated-at precondition; two dispatchers can silently overwrite each other.

### 8.3 Likely new/changed entities

At minimum: `companies/company_settings`, `users`, `roles/permissions` (or membership roles), `contacts`, `service_locations`, `equipment`, `equipment_service_history` or typed work observations, `leads/requests`, `estimates`, `estimate_lines`, approval/events, `job_assignments`, `job_events`, `technician_working_hours`, `technician_availability_exceptions`, `recurrence_series/occurrences`, `attachments`, `checklist_templates/responses`, `time_entries`, `maintenance_agreements/visits`, `payments`, `refunds/payment_allocations`, `inventory_locations`, `inventory_transactions`, `notifications/deliveries`, and `audit_events`.

These should be introduced through versioned, forward-only migrations with backfills and compatibility phases—not by rewriting `schema.sql` in place.

## 9. Backend/API gaps

### 9.1 Current endpoint quality

- Positive: request bodies/query objects are declared with Zod and SQL values are parameterized.
- IDs are validated only as strings (`IdParam`), allowing nonsensical values to reach SQL. Pagination accepts arbitrary strings; negative/zero/huge limits and pages are not bounded. Schedule date strings and range are not validated.
- Email is only `z.string()`, statuses/priorities are unrestricted `z.string()` server-side, colors are unrestricted, and numeric values lack minimum/maximum/finite checks.
- Many update/delete routes report `{ok:true}` even when no row exists; only get-job/get-customer/get-invoice and update-job explicitly check existence.
- There is no centralized exception handling contract in repository code. Constraint/DB failures can leak inconsistent generic behavior.
- No API versioning, idempotency keys, optimistic concurrency, request IDs, rate limits, health endpoint, or stable error-code model.
- OpenAPI response accuracy is not enforced: `tsc --noEmit` reports handler/schema incompatibilities; invoices use `z.any()` in key responses.
- The two `/all` lookup endpoints are unbounded and will not scale.
- Search uses leading-wildcard `LIKE` and no escaped/full-text strategy; it will scan at scale despite `idx_customers_name`.

### 9.2 Required services/endpoints

- Authentication/session and authorization middleware with company-scoped repositories.
- Migration/admin health tooling; explicit transactional domain commands.
- Dedicated schedule query, availability/conflict, reschedule/assignment, recurrence generation/exception services.
- Report query services/endpoints described in Section 6.
- Leads, locations/contacts, equipment, estimates/approval, agreements, payments/refunds, attachments, notification, audit, inventory movement, and lifecycle APIs.
- Export jobs that reuse report filters/definitions and enforce authorization.
- Idempotency and transactional handling for invoice/estimate generation, payment webhooks, recurrence, and notifications.

## 10. Frontend/UX gaps

### 10.1 Navigation and information architecture

- Sidebar includes Dashboard, Schedule, Jobs, Customers, Technicians, Invoices, Materials, and Service Types only (`sidebar.tsx:5-14`). Reports and all other workflow areas are absent.
- Service Types appears as a primary navigation peer rather than configuration. There is no Settings/company/admin organization.
- No breadcrumbs, global search, notification area, saved filters, or user/account controls.
- Unknown routes become Dashboard and invalid detail IDs can fall back to the list while fetching, rather than showing a clear not-found/error page (`use-router.ts:25`; `app.tsx:46-57`).

### 10.2 Loading, errors, and mutations

- One global initial `loading` flag blocks the entire main area until all initial endpoints finish (`app.tsx:66-70`, `use-app.ts:116-136`). Route-level loads and skeletons do not exist.
- Only create modals consistently catch errors locally. Many inline/detail action handlers call async context operations without `try/catch`, risking unhandled rejections even though a global banner exists.
- Search fires a request on every keystroke with no debounce/cancellation. Responses can arrive out of order; filters do not reset page 1 (`use-app.ts:139-149`).
- There is no success feedback, undo, retry, offline indication, or dirty-form protection.

### 10.3 Destructive actions and forms

- Delete customer/job/invoice buttons execute immediately without confirmation (`CustomerDetail:42`, `JobDetail:56`, `InvoiceDetail:29`). Agent-mode row deletes are similarly immediate. Given cascading deletes, this is severe.
- Inline catalog edit/add actions generally do not disable while saving or surface field-level validation.
- General job editing is missing; invoice creation/editing is incomplete; no form handles recurrence despite context/API fields.
- Modal markup has no dialog role, `aria-modal`, focus trap/restoration, Escape handling, or labelled relationship. Clicking backdrop closes immediately.
- Labels are visually present but not associated with controls via `for`/`id`; icon-only buttons lack accessible names/titles.

### 10.4 Tables, filtering, and responsiveness

- Tables do not support sorting, column configuration, row selection/bulk actions, saved views, or export.
- Job filter is status-only plus search; invoice filter is status-only; customer is search-only. Technician/service/material tables have no pagination/search.
- Pagination is previous/next only and page/filter state is not encoded in URL.
- `styles.css` contains no `@media` rule. The layout uses a fixed 220px sidebar, tables have no dedicated responsive wrapper, and schedule uses seven fixed columns. Mobile usability is not credible.

### 10.5 Accessibility and visual behavior

- Native buttons/inputs provide a partial keyboard baseline, but clickable table rows are `<tr onClick>` and are not focusable/keyboard activatable (`JobRow`, `CustomerList`, `Dashboard`).
- No skip link, landmark labelling, focus-visible strategy, live-region semantics for errors, reduced-motion handling, or accessibility test tooling was found.
- Schedule color coding is not the sole content signal (names are present), but compact 10–12px text and dense fixed cells harm readability.
- Raw status text appears inconsistently; there is no locale/currency/date formatting service. Dollar signs and `en-US` are hard-coded.

## 11. Security gaps

### 11.1 Critical blockers

- **No authentication or authorization:** anyone reaching the Worker can read or mutate all data. There are no user, session, role, membership, permission, or company entities and no auth middleware in `src/server/index.ts`.
- **No isolation:** every query is global; no `company_id`/tenant predicate exists. This prevents safe multi-company hosting and even meaningful per-user controls.
- **Destructive APIs are unprotected:** unauthenticated `DELETE` routes remove jobs, customers (with cascades), technicians, service types, materials/history, invoices, notes, checklist items, and job materials.
- **No rate limiting/abuse controls:** list/search/report-like endpoints and mutations can be called without limits beyond basic list pagination.
- **Production deployment/security headers are undefined:** repository code shows no CORS policy, CSP/security headers, HTTPS/session policy, trusted origin configuration, or secrets strategy. Same-origin use through Vite avoids needing development CORS, but absence of a production policy is not a security feature.

### 11.2 Injection/browser considerations

- SQL injection risk is relatively controlled for current value inputs because queries use placeholders. Dynamic update field names are derived from Zod-stripped allowlisted body keys. This protection must be preserved in report sort/group parameters by mapping enums to SQL fragments rather than interpolating user text.
- Preact text interpolation escapes strings by default; no `dangerouslySetInnerHTML` use was found, reducing stored XSS risk from notes/names. Future rich text/PDF/email rendering needs separate encoding/sanitization.
- With future cookie authentication, CSRF protection/SameSite/origin validation will be required for all mutations. There is currently no auth cookie and therefore no implemented CSRF model.
- API responses expose customer PII without authorization. Logs/privacy, retention, data export/deletion policy, encryption expectations, and backup access are unspecified.

## 12. Testing gaps

### 12.1 Current state

- No test framework dependency, test files, test configuration, fixtures, or `test` script was found.
- No backend unit/API tests, D1 integration tests, component tests, accessibility tests, scheduling tests, invoice tests, report tests, or end-to-end tests exist.
- No `lint` or `typecheck` package script exists.
- Strict TypeScript is configured (`tsconfig.json`), but direct `pnpm exec tsc --noEmit` fails: missing global `D1Database` and multiple Hono/OpenAPI response-schema incompatibilities caused by generic `Record<string, unknown>` results.
- The Vite build does not perform TypeScript checking, so a green build currently hides these failures.

### 12.2 Minimum regression suite before major features

1. **Quality gates:** add scripts for typecheck, lint, unit/integration tests, and build; make CI run frozen install plus all gates.
2. **Database integration:** apply migrations to a fresh D1 database; validate foreign-key delete behavior, constraints, rollback/recovery approach, concurrent identifiers, and transactional invoice creation.
3. **API contract tests:** every route success/validation/not-found/conflict/authorization case; verify OpenAPI response schemas match runtime payloads.
4. **Core domain tests:** job default price/duration/address, status rules, assignment, checklist/note/material operations, stock policy, invoice totals/tax rounding, duplicate invoice policy, and customer deletion policy.
5. **Schedule tests:** Sunday/Monday range calculations, DST/timezones, arbitrary ranges, filtering, overlap boundaries, unassigned jobs, recurrence exceptions, drag/drop command conflicts.
6. **Report tests:** fixed seeded dataset with exact totals for every grouping/filter/timezone; reconcile job, invoice, and payment bases.
7. **Frontend/component tests:** loading/error/empty states, forms/validation, filters/pagination race handling, destructive confirmations, keyboard and accessibility behavior.
8. **End-to-end smoke:** authenticated dispatcher creates customer/location/equipment → estimate/job → schedules/assigns → technician completes → invoice/payment → report reconciliation.

## 13. Proposed roadmap

Work packages are deliberately dependency-ordered. Each package should produce a deployable, tested increment; none should silently bundle all field-service scope.

### WP1 — Engineering baseline and regression harness

- **Objective:** make existing behavior measurable and changes safe.
- **Scope:** fix current type errors without behavior changes; add `typecheck`, lint, unit/API/D1 integration test tooling and scripts; document environment; CI; representative baseline fixtures and smoke tests; separate test database state.
- **Likely files/modules:** `package.json`, `tsconfig.json`, `src/server/index.ts` response types, Worker type declarations/config, new test/lint/CI files, `.github/workflows/*`, developer docs.
- **Database migration required:** No.
- **Dependencies:** None.
- **Acceptance criteria:** frozen install, typecheck, lint, tests, and build all pass in CI; existing routes and core CRUD/invoice/schedule behavior have regression coverage; test totals are reported.
- **Tests required:** API smoke/validation, schema initialization, job defaults, invoice math, current schedule range/date helpers, client route/render smoke.
- **Risk:** Low–medium; type corrections must not conceal runtime mismatches.

### WP2 — Migration, integrity, and domain-convention foundation

- **Objective:** establish safe schema evolution and explicit data conventions before adding entities.
- **Scope:** versioned D1 migrations; archive/delete policies; constraints; transactional/batched identifiers and invoices; money minor units/rounding decision; date/time/timezone conventions; optimistic versioning; lifecycle/audit baseline; backup/restore runbook.
- **Likely files/modules:** `src/server/schema.sql` transition plan, new `migrations/*`, database/repository utilities, job/invoice handlers, deployment docs.
- **Database migration required:** Yes.
- **Dependencies:** WP1.
- **Acceptance criteria:** upgrade from current schema and clean install are tested; issued history cannot be casually cascaded away; concurrent IDs/invoices are safe; money/date conventions documented and enforced; restore drill documented.
- **Tests required:** migration forward tests, constraints/cascades/archive, concurrency/idempotency, rounding, backup/restore smoke.
- **Risk:** High because existing stored data and API contracts are affected.

### WP3 — Company identity, authentication, and RBAC

- **Objective:** remove the primary production security blocker.
- **Scope:** company/settings/timezone/business hours/currency; users/memberships; secure authentication/session strategy; dispatcher/admin/technician roles; authorization and company scoping on every endpoint; security headers, origin/CSRF/rate-limit strategy; audit actor attribution.
- **Likely files/modules:** schema/migrations, app middleware, all server query modules/routes, client auth shell/navigation, deployment configuration.
- **Database migration required:** Yes.
- **Dependencies:** WP1, WP2.
- **Acceptance criteria:** anonymous requests cannot access business data; cross-company access is impossible in tests; destructive/financial actions require permissions; timezone/settings are available to scheduling/reporting.
- **Tests required:** auth/session, role matrix, tenant isolation for every resource/report family, CSRF/origin/rate-limit tests.
- **Risk:** High.

### WP4 — Customer, contact, service-location, and HVAC equipment model

- **Objective:** create the operational foundation for multi-property HVAC customers and asset history.
- **Scope:** contacts, billing/service locations, access instructions/service areas/geocode boundary, HVAC equipment fields and location-linked history; migrate current customer/job addresses safely.
- **Likely files/modules:** migrations, customer/location/equipment API services, types/context/routing/sidebar, customer/job forms/details.
- **Database migration required:** Yes.
- **Dependencies:** WP2, WP3.
- **Acceptance criteria:** one customer can have multiple contacts/locations/equipment; every job references a service location with retained snapshot semantics; historical records survive catalog/customer archival.
- **Tests required:** migration/backfill, CRUD/authorization, job-location validation, equipment history, search/pagination.
- **Risk:** High.

### WP5 — Job lifecycle, dispatch events, and field-work records

- **Objective:** turn generic jobs into auditable HVAC work orders.
- **Scope:** enforced status transitions; timestamps/reasons; assignment/crew history; dispatch/en-route/arrived/start/complete events; actual labor time; internal/customer-facing notes; attachments/photos; reusable checklists/responses; signatures and completion requirements.
- **Likely files/modules:** migrations, job/assignment/event/file services, job APIs, `JobDetail`, types/context, technician UI.
- **Database migration required:** Yes.
- **Dependencies:** WP3, WP4.
- **Acceptance criteria:** lifecycle is server-enforced and attributable; multiple techs supported; actual duration and reassignment/cancellation history retained; completion policy is configurable/tested.
- **Tests required:** transition matrix, concurrency, assignment attribution, upload security, checklist/signature completion, audit chronology.
- **Risk:** High.

### WP6 — Schedule foundation: correct navigation, modes, filters

- **Objective:** replace fixed-week rendering with a stable calendar architecture while preserving click-through/job updates.
- **Scope:** timezone-safe calendar utilities and URL state; day/week/month modes; Previous/Next/Today/date picker/jump; validated bounded event DTO endpoint; technician/service/status/unassigned filters; loading/error/empty states; responsive month/list fallback.
- **Likely files/modules:** `schedule-view.tsx`, `use-app.ts` (or extracted schedule store/query hook), `context.tsx`, `types.ts`, `styles.css`, schedule route/service, date utilities.
- **Database migration required:** No beyond WP2/WP3 conventions and indexes determined by query plans.
- **Dependencies:** WP2, WP3; integrates WP4/WP5 entities when present.
- **Acceptance criteria:** arbitrary date navigation and three views work across configured timezones/DST; filters are server-applied and URL-shareable; dense month performance meets an agreed benchmark; existing jobs remain editable/navigable.
- **Tests required:** date/DST/range tests, API bounds/filters, component interactions, responsive/accessibility, high-density performance fixture.
- **Risk:** Medium.

### WP7 — Advanced dispatch scheduling

- **Objective:** support capacity-aware dispatcher workflows.
- **Scope:** technician working hours, availability/time off, resource timeline, unassigned queue, time geometry/current-time line, conflict detection, drag/drop assignment/rescheduling, resize duration, multi-tech visualization, override permissions, optional all-day/service windows.
- **Likely files/modules:** migrations, schedule/availability/conflict services, assignment commands, calendar components/styles.
- **Database migration required:** Yes.
- **Dependencies:** WP5, WP6.
- **Acceptance criteria:** conflicts are detected atomically server-side; concurrent moves do not silently overwrite; keyboard/dialog alternatives exist; availability and overrides are visible/audited.
- **Tests required:** overlap boundaries, availability exceptions, multi-tech conflicts, concurrency/409 flows, drag/drop and keyboard E2E.
- **Risk:** High.

### WP8 — Estimates and approval workflow

- **Objective:** cover request/estimate-to-job conversion.
- **Scope:** leads/service requests, estimates/options/lines, discounts/taxes, versions, expiration, send/PDF, approval/decline/signature, conversion to job without duplicate data.
- **Likely files/modules:** migrations, lead/estimate services/APIs, new client routes/components, document generation.
- **Database migration required:** Yes.
- **Dependencies:** WP3, WP4; uses WP2 money conventions.
- **Acceptance criteria:** traceable lead → approved estimate → job conversion; issued versions immutable; totals reconcile and authorization applies.
- **Tests required:** calculation/rounding, versioning/idempotency, approval security, conversion, PDF snapshot.
- **Risk:** High.

### WP9 — Payments and financial hardening

- **Objective:** make invoices and balances financially meaningful.
- **Scope:** invoice edit/issue/send lifecycle, line taxonomy/snapshots, discounts/taxes, payment/refund/allocation ledger, partial payments, methods/references, derived balance/status/aging, PDFs/email boundary.
- **Likely files/modules:** migrations, invoice/payment services and endpoints, invoice UI, document/notification adapters.
- **Database migration required:** Yes.
- **Dependencies:** WP2, WP3; preferably WP8 for shared pricing/tax primitives.
- **Acceptance criteria:** balances derive from immutable transactions; partial/refund cases reconcile; issued records cannot be destructively edited; idempotency is enforced.
- **Tests required:** exhaustive financial calculations, allocation/refund/idempotency, status derivation, permissions and reconciliation.
- **Risk:** High.

### WP10 — Recurrence and maintenance agreements

- **Objective:** support HVAC preventive maintenance and recurring visits.
- **Scope:** recurrence series/rules/exceptions, idempotent occurrence generation, maintenance agreements/equipment coverage/entitlements/renewals, due-visit scheduling.
- **Likely files/modules:** migrations, recurrence/agreement services and scheduled jobs, schedule/job UI, agreement pages.
- **Database migration required:** Yes.
- **Dependencies:** WP4, WP5, WP6, WP9 for billed agreements.
- **Acceptance criteria:** occurrences generate exactly once, edits support series/occurrence semantics, DST and skipped/rescheduled cases are correct, agreement coverage is traceable.
- **Tests required:** recurrence matrix including DST/month-end, idempotency, exceptions, agreement entitlement and renewal.
- **Risk:** High.

### WP11 — Reporting foundation and operational reports

- **Objective:** define trusted metrics and ship job/customer/technician/material reporting.
- **Scope:** report service/query architecture; shared filters/timezone/date buckets; overview and operational reports; indexes/query-plan benchmarks; CSV exports; reconciliation fixtures.
- **Likely files/modules:** new server report modules/routes, migrations for targeted indexes, report types/hooks/routes/sidebar/components.
- **Database migration required:** Usually yes for indexes; domain fields arrive through prior WPs.
- **Dependencies:** WP2-WP7; WP10 for maintenance reporting.
- **Acceptance criteria:** metric dictionary exists; totals reconcile to source records; filters and tenant boundaries are consistent; large fixture performance meets targets; CSV matches UI.
- **Tests required:** golden datasets, timezone boundaries, every dimension/filter, authorization, export parity, performance.
- **Risk:** Medium–high because misleading metrics are a business risk.

### WP12 — Financial reports and dashboard redesign

- **Objective:** add trusted invoiced/paid/outstanding/aging/tax trends and make Dashboard a date-aware operational summary.
- **Scope:** financial report endpoints/UI, comparisons/trends, invoice/payment reconciliation, date-filtered dashboard using shared metrics, drill-down links.
- **Likely files/modules:** report services, `/api/stats` replacement/shared helpers, `Dashboard`, Reports UI/chart/table components.
- **Database migration required:** Maybe for indexes; payment schema comes from WP9.
- **Dependencies:** WP9, WP11.
- **Acceptance criteria:** invoiced/paid/outstanding/overdue/aging/tax metrics reconcile exactly; dashboard has explicit period/timezone/basis and complete today schedule source.
- **Tests required:** financial golden data, aging as-of cases, partial/refund cases, dashboard/report parity.
- **Risk:** Medium–high.

### WP13 — Notifications, responsive field UI, accessibility, and operations

- **Objective:** make the platform usable and operable by dispatchers and technicians in production.
- **Scope:** email/SMS consent/templates/delivery log; responsive/mobile technician workflow and offline/retry decision; WCAG-oriented accessibility; observability, retention, backup automation and restore drills.
- **Likely files/modules:** notification adapters/services/schema, client layout/components/styles, service worker if justified, deployment/monitoring configuration.
- **Database migration required:** Yes for preferences/delivery records; not necessarily for UI/operations portions.
- **Dependencies:** WP3, WP5, WP9/WP10 as notification sources.
- **Acceptance criteria:** critical notifications are idempotent/audited; technician core flow works on target mobile devices; accessibility testing passes agreed standard; monitored backup/restore SLO is demonstrated.
- **Tests required:** provider contract/failure/retry, consent, mobile E2E, automated/manual accessibility, recovery drill.
- **Risk:** Medium–high.

## 14. Recommended next WP

**Implement WP1 — Engineering baseline and regression harness first.**

It is the single best first package because the current repository has no automated regression protection and its strict typecheck already fails even though the production bundle succeeds. Schedule, security, schema, and reporting work will touch the densest shared modules (`src/server/index.ts`, `use-app.ts`, shared types/schema). Changing them without a trusted baseline makes it impossible to distinguish intended product evolution from regressions. WP1 is deliberately behavior-preserving and does not postpone security feature work indefinitely: WP2 and WP3 immediately follow it, and no production deployment should occur before WP3.

## Appendix A — Dashboard audit

### Current stats and calculation

`GET /api/stats` (`index.ts:112-155`) returns:

- total jobs and customers: unfiltered table counts;
- technicians: active technician count;
- service types: total count;
- today's jobs: jobs whose date equals server `new Date().toISOString().split("T")[0]`;
- upcoming jobs: scheduled/confirmed with scheduled date greater than or equal to today, with no upper bound;
- completed jobs: all-time current status count;
- “revenue”: all-time sum of `jobs.price` where current status is completed;
- outstanding invoices: count of `sent` invoices only;
- overdue invoices: count whose status was explicitly set to overdue.

### Accuracy/scalability concerns

- “Revenue” is completed job value, not invoice or payment revenue. It ignores invoice adjustments, taxes, unpaid status, refunds, and paid dates.
- Outstanding/overdue values are counts, not balances. Outstanding excludes overdue and drafts; overdue is not derived from due date.
- No metric accepts a date filter, timezone, company, comparison, or currency.
- Ten separate SQL statements run mostly sequentially per stats request. Indexed status/date predicates help some queries, but total counts and all-time aggregation scan growing tables. A shared aggregate query or small number of purpose-built queries plus measured indexes/caching would be more scalable.
- Dashboard's “Today's Schedule” is derived from the general `jobs` state, which is only the first 50 rows of a paginated list sorted from earliest scheduled date (`Dashboard:5-8`; `listJobs:214-226`). It can therefore omit today's jobs or show none while `/api/stats.today_jobs` is nonzero. It should use a bounded today schedule query.
- The dashboard can share a future reporting metric service, but `/api/stats` itself is too semantically vague to be that foundation. Define metric basis and filters once, then expose a compact dashboard composition over the same server-side definitions.

## Appendix B — Verification results

Commands run in the audit phase:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run
corepack pnpm exec tsc --noEmit
corepack pnpm run build
```

Results:

| Check | Result |
|---|---|
| Frozen dependency install | Pass; already up to date, pnpm 11.21.0 |
| Available package scripts | `dev`, `build` only |
| Typecheck | **Fail**; missing `D1Database` type and multiple Hono/OpenAPI handler response incompatibilities in `src/server/index.ts` |
| Lint | Not available; no script/dependency |
| Tests | Not available; no script/framework; **0 tests discovered/run** |
| Production build | Pass; Vite 6.4.1, 1,730 modules transformed, completed in 1.46s |
| Build output | `dist/index.html` 0.86 kB; CSS 14.10 kB; JS 83.47 kB (reported before gzip) |

The install and build touched only generated/ignored dependency/build state. No dependency was added or changed to make checks pass.

## Appendix C — Audit provenance and inspected files

The local download contains no `.git` directory. Consequently:

- **Current branch:** unavailable—not a Git worktree.
- **Current commit before work:** unavailable—not a Git worktree.
- **Git status:** unavailable; `git status` returns “not a git repository.”

Files inspected:

- Root/configuration/documentation: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `README.md`, `.gitignore`, `tsconfig.json`, `vite.config.ts`, `wrangler.toml`, `clawnify.json`, `manifest.json`, `index.html`, `agent.md`, `.github/*` inventory, and root asset/license inventory.
- Server: `src/server/schema.sql`, `src/server/db.ts`, and all of `src/server/index.ts` through route/schema/SQL searches and targeted line review.
- Client: every file under `src/client`, including `app.tsx`, `api.ts`, `context.tsx`, `types.ts`, both hooks, every component, and `styles.css` structural/responsive/accessibility searches.
- Repository-wide absence searches covered reports/analytics, auth/users/roles, leads, contacts/locations, estimates/quotes, dispatch/availability, equipment/assets, attachments/signatures, payments/refunds, notifications, audit, timezone, calendar interactions, exports, backups, and test/lint frameworks.

File created by this audit: `docs/PRODUCT-GAP-AUDIT.md`. No application code, runtime configuration, dependency declaration, lockfile, or database migration was modified.
