# Phase 17 — Pricebook

Status: **IMPLEMENTED / VERIFIED / BROWSER-ACCEPTED / NOT COMMITTED** (a
separate future "Phase 17 — Safe Commit" task handles the actual commit,
matching the Phase 15/16 precedent exactly).

## What this phase is

A production-grade, organization-scoped **Pricebook** catalog: the
authoritative source of Equipment/Parts/Materials/Services/Labor items —
SKU, manufacturer/model, cost vs. sell price (integer cents), taxability,
active/inactive status, category, and structured equipment/warranty
metadata. It is the foundation Quote line-item selection, Contract
equipment metadata, Invoice line items, maintenance-plan pricing, and a
future Phase 18 "Good/Better/Best" estimate builder will consume — none of
those consumers beyond the Quote line-item snapshot integration are built
in this phase.

**Explicitly out of scope, not started**: Phase 18 Good/Better/Best
package tiers, Voice Copilot/Jarvis, any change to migrations 0001–0024,
any change to Answermachine, effective-dated/scheduled pricing, a
full price-version/history table (beyond the audit log described below),
and a multi-level category tree UI.

## Pre-implementation catalog audit (Section 4)

Before writing migrations/0025_pricebook.sql, the existing schema was
read in full (migrations 0001, 0007, 0015–0017, 0022) to avoid duplicating
an existing concept:

| Existing concept | Verdict |
| --- | --- |
| `assets` (Phase 11.4) — an installed equipment **instance** at a customer's property (serial number, install date, warranty dates it owns independently) | Fundamentally different from a catalog **definition** — kept separate. Linked only via a new optional `assets.pricebook_item_id` (nullable, `ON DELETE SET NULL`) — provenance, never a live dependency. |
| `service_types` (migration 0001, tenant-scoped since 0015) — a minimal job-scheduling default helper: name/duration/REAL-dollar price/color | No SKU, no cost/sell-price split, no taxability, no category, no cents-money convention. Left untouched — unifying it would mean a destructive REAL→cents rebuild (like invoices' own Phase 5 migration) plus reshaping its tenant semantics, exactly the large, risky, out-of-scope change this phase's own instructions warn against. Documented coexistence, not an oversight; a future phase may choose to unify. |
| `materials` / `job_materials` (migration 0001, tenant-scoped since 0015) — a job-material-usage/inventory tracker, REAL-dollar cost only | Same verdict as `service_types` above: no sell price/SKU/taxability/category, left untouched. |
| Quote/Invoice line items | Already had a `taxable` column (added migration 0022) — Pricebook's taxability integration required **no** change to the tax engine, only a snapshot-copy of the item's own `taxable` default at line-creation time. |

Both `service_types` and `materials` remain fully functional and
unmodified; nothing in this phase reads from, writes to, or migrates data
out of either table.

## Architecture

### New tables (migrations/0025_pricebook.sql)

- **`pricebook_categories`** — flat-ish category list (`parent_category_id`
  self-FK exists per spec but is deliberately unenforced beyond a plain FK
  — no depth limit, no cycle guard — since the shipped UI is a
  single-level picker, not a tree; a documented extension point, not a
  load-bearing feature).
- **`pricebook_items`** — the catalog row itself: `type` (EQUIPMENT | PART
  | MATERIAL | SERVICE | LABOR | OTHER, app-validated, no DB CHECK — same
  convention as `jobs.status`/`leads.status` elsewhere), `sku` (unique per
  org only when non-empty — partial unique index), `cost_cents` /
  `sell_price_cents` (separate integer-cents columns), `taxable`,
  `status` (active/inactive), `equipment_metadata` / `warranty_metadata`
  (opaque JSON-object TEXT blobs — see below), `preferred_vendor` /
  `vendor_sku` / `internal_notes` (admin/cost-tier only).
- **`pricebook_item_audit`** — append-only log (`created`, `price_changed`,
  `activated`, `deactivated` events with an actor and a JSON details
  blob) — same shape as `invoice_audit`/`phone_operations_audit`. This is
  the auditability mechanism (Section 47), **not** a full versioned-row
  history like `quote_versions` — the actual historical-price guarantee
  comes from the snapshot mechanism below, not from versioning the catalog
  row itself.
- **Additive nullable FK columns** (`ON DELETE SET NULL`, no DEFAULT
  clause — the only shape D1/SQLite accepts for `ALTER TABLE ADD COLUMN`
  combined with a `REFERENCES` clause):
  `quote_line_items.pricebook_item_id`, `invoice_lines.pricebook_item_id`,
  `assets.pricebook_item_id`.

### Tenant model

`organization_id INTEGER NOT NULL DEFAULT 1`, no inline `REFERENCES`,
application-enforced only — matching every other genuinely-new tenant-root
table in this codebase (`jobs`/`customers`/`quotes`/`assets`), not
`tax_profiles`' inline-`REFERENCES` exception (an earlier-precedent
artifact, not the pattern for new tables). `pricebook_item_audit` carries
its **own** `organization_id` rather than relying solely on the parent FK
chain, matching `invoice_audit`'s precedent — audit rows stay
independently queryable per-org even if a referenced item is later
cleaned up.

### Industry-neutral Core, HVAC-specific attributes stay in JSON

`equipment_metadata` / `warranty_metadata` are opaque JSON-object TEXT
blobs (`{}` default, 8000-char cap, must parse as a non-array JSON
object) — `src/server/pricebook.ts` never inspects or validates specific
HVAC keys (capacity, fuel type, refrigerant, voltage, warranty duration,
etc.). Those live entirely in application code — actually, they don't
live anywhere as a fixed schema at all: the client's `MetadataEditor` is a
generic key/value editor over whatever the JSON object happens to
contain, not a hardcoded HVAC form, because the server genuinely never
enforces specific keys. This keeps Core free of hardcoded HVAC concepts
per CLAUDE.md's "industry logic must not leak back into Core" law, and
avoids building a fixed-schema UI for a feature the server intentionally
treats as open-ended.

### Historical price integrity (Section 11) — the central invariant

A Quote line item created from a Pricebook selection copies a **snapshot**
(`description`/`unit`/`unit_price_cents`/`taxable`) into its own,
already-existing, independently-stored columns **once**, at creation time
(`resolvePricebookSnapshot` in `src/server/quotes.ts`, called from
`insertLineItem`). `pricebook_item_id` is stored purely as a
provenance/audit pointer — no code path ever re-derives a line's price
from the live catalog item after creation. A later Pricebook price change:

- does **not** alter any existing Quote/Invoice line item that already
  referenced it (proven by `test/pricebook.test.ts`'s
  "a later Pricebook price change never retroactively alters an
  already-created Quote line item" test);
- **does** apply to a brand-new line item created after the change;
- archiving a Pricebook item likewise never affects a Quote that already
  selected it (separately tested).

Explicitly supplying `description`/`unit_price_cents`/`taxable` alongside
`pricebook_item_id` overrides the snapshot default — the catalog augments
manual line-item entry, it doesn't remove the ability to customize a line
(Section 37).

### RBAC (`canManagePricebook` / `canViewPricebook`, `src/server/pricebook.ts`)

| Role | Access |
| --- | --- |
| **Admin** | Full CRUD (items + categories), cost/internal fields, archive/activate, audit log. |
| **Dispatcher** | Read + select items into Quotes. `cost_cents`/`internal_notes`/`preferred_vendor`/`vendor_sku` are **never present** in the response body — server-side stripping (`stripCost()`, an explicit field-allowlist reconstruction, not a destructuring omit, so a future field added to `PricebookItem` fails closed rather than leaking by default) — not client-side hiding. Any management route (create/update/archive/categories) returns 403. |
| **Technician** | No route access at all — `canViewPricebook` returns `false` for this role. Matches the established binary front-office/sales-vs-field-work split already used for Leads/Quotes/Contracts/Phone-Operations (`hideFromTechnician: true` sidebar convention) rather than the task spec's tentative "Possible: partial technician read" suggestion — a technician's actual field-work surface is the Job/Asset data they're assigned, not catalog browsing; dispatch/quoting stays a human/dispatcher decision. |

### Client UI

- `pricebook-list.tsx` — search/type/status/category filters, pagination,
  cost column present only when the API response actually contains
  `cost_cents` (i.e. the field's mere absence for a dispatcher governs
  what renders — the same "server strips it, client just renders what's
  present" split as the RBAC design above).
- `pricebook-item-form.tsx` — create/edit modal with sectioned fields
  (General / Pricing & Tax / Equipment Details + Warranty — shown only for
  `type === "EQUIPMENT"` / Internal — shown only when the caller has cost
  access / Price & Status History from the audit log). Doubles as a
  read-only detail view for a dispatcher (`canManage=false`): every input
  renders `disabled`, no Save button.
- `pricebook-category-manager.tsx` — admin-only category CRUD modal.
- `pricebook-picker.tsx` — search-and-select modal used from
  `quote-detail.tsx`'s line-item editor; selecting an item copies its
  snapshot fields into the line-item draft once (mirroring the server-side
  discipline above) and is cleared if the description is hand-edited
  afterward.

## RBAC / tenant / historical-integrity test coverage

`test/pricebook.test.ts` (26 tests, all passing) — admin CRUD for items
and categories; negative cost/price rejection; type/status/category/search
filtering and pagination; search wildcard-density guard; SKU uniqueness on
create and update, including a genuine concurrent-race test asserting
exactly one of two simultaneous same-SKU creates succeeds; equipment/
warranty metadata JSON validation (non-object / malformed / oversized all
rejected); category delete blocked when referenced by an item or a child
category, self-parent rejected, cross-org category assignment rejected;
dispatcher read-with-cost-stripped and management-denied; technician
denied on every route; tenant isolation (cross-org 404, same SKU reusable
across two orgs); audit-log event recording (`created`/`price_changed`/
`deactivated`, and confirms an unrelated field edit does **not** produce a
spurious `price_changed` event); mass-assignment rejection on both item
and category create; the historical-price-integrity scenario described
above; invalid `pricebook_item_id` on a Quote line-item create rejected
with 404.

## Real-browser acceptance

Tested live (Admin/Dispatcher/Technician) against a local dev server via
backend-login-then-fetch session cookies — never a typed password in any
browser field. Found and fixed two real client-side input-corruption bugs
that `tsc`/`eslint`/the server-only test suite could not have caught:

1. **Money inputs (Sell Price/Cost) fought the user while typing.** The
   form stored the price as a number and reformatted the displayed value
   via `formatCentsForInput`/`parseDollarsToCents` on every keystroke, so
   a partial value like "4" immediately snapped to "4.00" mid-entry.
   Fixed by holding the raw typed dollar string in state and converting to
   cents once, at submit — the pattern `quote-detail.tsx` already used
   correctly.
2. **Equipment/Warranty metadata key field dropped characters while
   typing.** The metadata editor keyed each row on the attribute NAME
   itself — the exact field being edited — so renaming a key gave React a
   new key every keystroke, forcing an unmount/remount that lost focus and
   dropped characters. Fixed by keying on the row's stable position
   instead.

Both fixes verified live after the fix. Confirmed end-to-end: Admin
create/edit (Equipment type, conditional Equipment Details/Warranty
sections, Categories manager), the Quote "Select from Pricebook" picker
(snapshot-copies fields into the line-item draft, saves, tax computes
correctly), Dispatcher read-only view (no Cost column, no Categories/New
Item buttons, detail modal has no Cost/Internal section at all),
Technician (no sidebar entry, direct navigation falls back to their own
home view, a direct API call confirmed a real server-side 403).

**Responsive breakpoints not verified** — the same disclosed, pre-existing
tooling limitation as every OFS phase since 13A: `resize_window` reports
success but does not actually change `window.innerWidth`/`innerHeight`
(confirmed via direct JS check, stuck at 1920×889). Disclosed honestly,
not fabricated as PASS.

## Known limitations / deferred (documented, not oversights)

- No effective-dated/scheduled pricing (`effective_from`/`effective_until`)
  — immediate-only active pricing, per the task's own "don't over-build if
  immediate pricing is enough" instruction. Extension point: mirror
  `tax_profiles`' own effective-dated versioning without touching this
  migration.
- No full price-version/history table — the audit log plus the Quote/
  Invoice snapshot mechanism together satisfy Section 11/47 without a
  `quote_versions`-style full row-history model.
- `pricebook_categories.parent_category_id` has no depth limit or
  cycle-prevention trigger, and the shipped UI is single-level only.
- `service_types`/`materials` remain a documented, deliberate coexistence,
  not migrated into Pricebook.
- Contract equipment metadata / Invoice-composition-from-Pricebook / a
  Phase-18 package builder are **not** built — the additive
  `invoice_lines.pricebook_item_id` column is the forward-compatible
  foundation only, since invoices in this codebase are still generated
  from Job/Quote data, not composed directly from a Pricebook picker.
- **No optimistic-concurrency control on `pricebook_items` updates** —
  unlike `quote_versions` (which uses a `row_version` CAS column),
  `pricebook_items` has no version column and `updateItem` is a plain
  last-write-wins `UPDATE`. Two admins editing the same item's price
  concurrently can silently lose one write. Flagged by the independent
  Testing review as a possible real gap, not fixed — accepted as a known,
  documented limitation for a catalog table (lower stakes than a Quote
  transition). Extension point: add a `row_version` column plus a
  conditional `UPDATE ... WHERE row_version = ?` if this becomes a real
  operational problem, mirroring `quote_versions`' own pattern.
