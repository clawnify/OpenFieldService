# Phase 18 — Good / Better / Best Estimates

Status: **IMPLEMENTED / VERIFIED / BROWSER-ACCEPTED / NOT COMMITTED** (a
separate future "Phase 18 — Safe Commit" task handles the commit, matching
the Phase 15/16/17 precedent).

## What this phase is

A Good/Better/Best presentation and selection workflow built directly on
top of the existing Quote/Version architecture (Phase 12): office staff
add 1 or more "options" (GOOD/BETTER/BEST/CUSTOM tiers, not a rigid
3-option limit) to a Quote's current draft version, each with its own
independent line items, discount, and computed totals. The customer
receives a secure public link, compares options on a mobile-friendly page,
and selects one — which becomes the sole authoritative commercial content
of the accepted Quote and any Contract created from it.

**Explicitly out of scope, not started**: Phase 19 Customer Portal, Voice
Copilot, a full Contract Terms engine (Phase 19B), a Change-Order flow
beyond the existing Quote revision mechanism, reporting/accounting UI
(only the underlying data — `accepted_option_id`, tier — is now
queryable), and reusable option templates (deferred, documented below).

## Pre-implementation Quote/Estimate audit

Before writing `migrations/0026_quote_options.sql`, the existing Quote
architecture (`migrations/0017_quotes.sql`, `src/server/quotes.ts`,
`quote-workflow.ts`) was read in full:

| Existing capability | Reusable for Good/Better/Best? |
| --- | --- |
| `quotes` (durable identity) + `quote_versions` (immutable-once-sent snapshot) + `quote_line_items` | Yes — Options are a new layer living BENEATH a `quote_version`, sibling to `quote_line_items`, not a parallel system. |
| `quote-workflow.ts`'s draft/sent/accepted/rejected/expired/cancelled FSM | Yes, reused as-is. A customer selecting an option via the public link IS the existing "sent → accepted" transition, just `actor_user_id = NULL` (system/customer-triggered) — mirrors `contracts.ts`'s own `transitionContractInternal(..., null, "Derived from signature request completion")` precedent. |
| `computeQuoteTotals`/`recomputeAndStoreVersionTotals` (Phase 12, with Phase 13D tax integration) | Yes — reused directly for per-option totals (exported from `quotes.ts`), never re-derived. |
| `quote_versions.row_version` CAS pattern | Yes — the same idiom applied to `quote_options.row_version`. |
| Phase 17 Pricebook snapshot-at-selection discipline | Yes — `quote_option_line_items` uses the identical `pricebook_item_id` provenance + snapshot-once pattern as `quote_line_items`. |
| Contract creation (`assertQuoteAcceptedInOrganization`/`buildCommercialSnapshot`) | Yes, **unchanged** — see "Selected-option → Contract conversion" below. |
| Public token-gated approval flow | **None existed for Quotes** — only Contracts (e-sign) and Invoices (payment) had one. Built new (`quote_share_links`/`quote_share_events`), mirroring `contract_signature_requests`/`contract_signature_events`'s security shape exactly (256-bit random token, SHA-256 hashed at rest, status-guarded UPDATE, generic "invalid or expired" error with no enumeration signal). |

No parallel "Estimate" system was created — the term "Quote" remains
canonical throughout the API and database; the client UI may say
"Estimate" where natural (Section 6).

## Architecture

### New tables (`migrations/0026_quote_options.sql`)

- **`quote_options`** — tier (GOOD\|BETTER\|BEST\|CUSTOM, app-validated),
  name/headline/description (customer-facing), `internal_notes`
  (staff-only), `highlights` (JSON string array, e.g. `["Best value",
  "Longest warranty"]` — deliberately not a fixed set of boolean columns,
  keeping the comparison engine genuinely industry-neutral), its own
  discount fields and computed subtotal/tax/total (mirrors
  `quote_versions`), `recommended` (at most one per version, application-
  enforced), `row_version` (CAS).
- **`quote_option_line_items`** — same shape as `quote_line_items` plus
  `cost_cents` (nullable, admin-cost-tier only, snapshotted from the
  Pricebook item at line-creation time — never populated for a manual line
  or when the creating actor lacks cost access).
- **`quote_option_audit`** — append-only log (created/duplicated/
  recommended_changed/price_changed), mirrors Phase 17's
  `pricebook_item_audit` shape verbatim.
- **`quote_share_links`** / **`quote_share_events`** — the public
  selection flow's token record and event timeline, mirroring
  `contract_signature_requests`/`contract_signature_events`.
- **`quotes.accepted_option_id`** (additive, nullable, `ON DELETE SET
  NULL`) — an explicit, permanent snapshot of which option was accepted,
  set once by `transitionQuote()` alongside `accepted_version_id`, the
  same "explicit snapshot, never re-inferred" discipline.

### Tenant model

`quote_options`/`quote_option_line_items`/`quote_share_links`/
`quote_share_events` are all INHERITED_THROUGH_PARENT (no own
`organization_id` column) — tenant safety flows entirely through
`quote_version_id → quote_id`, exactly matching `quote_versions`/
`quote_line_items`'s own established pattern.

### Selected-option → Contract conversion (the central mechanism)

At the exact moment an option is selected (public customer flow or
internal staff action), `applySelectionToVersion()`:

1. Copies the selected option's line items into the quote **version's
   own** `quote_line_items` table (deleting whatever was there — always
   empty for a genuine Good/Better/Best quote, since its UI never routes
   through the plain add/update/delete line-item endpoints once options
   exist).
2. Recomputes and stores the version's totals from them via the
   **existing, unmodified** `recomputeAndStoreVersionTotals`.
3. Calls the **existing, unmodified** `transitionQuote(..., toStatus:
   "accepted", acceptedOptionId)`.

Because of this, `src/server/contracts.ts`'s `createContract`/
`buildCommercialSnapshot`/`assertQuoteAcceptedInOrganization` required
**zero code changes** — they already read `quote_line_items WHERE
quote_version_id = accepted_version_id` and `quote_versions`' stored
totals, which now correctly reflect only the selected option. Unselected
options' line items are never copied anywhere, so they cannot structurally
reach a Contract. The Estimate option rows themselves are never modified
by this step — the historical record of everything offered stays intact
forever (Section 25's "historical Estimate remains unchanged"), verified
end-to-end in `test/quote-options.test.ts`.

### Historical price integrity

Reuses Phase 17's exact discipline: a Pricebook-sourced option line
snapshots `description`/`unit_price_cents`/`taxable`/`cost_cents` **once**,
at creation; a later Pricebook price change never retroactively alters an
already-created option line, an already-selected Quote, or a downstream
Contract (tested explicitly, including after the Pricebook item's price
changes post-selection).

### RBAC / cost secrecy

Reuses `canManageQuotes` (admin+dispatcher manage, technician blocked) —
no new access tier invented. Cost/margin (`cost_cents` per line, and the
derived `cost_summary` aggregate) is stripped **server-side** for any role
without `canViewOptionCost` (= `canManagePricebook`, admin-only) — an
explicit field-allowlist reconstruction (`stripLineCost`), not a
destructuring omit or reliance on the Zod response schema (this
codebase's `c.json()` does not strip extra runtime fields — verified this
matters in practice; see "Bugs found and fixed" below). The Option audit
log is admin-only (price-change details).

### Margin / profitability

`computeOptionCostSummary()` is a pure derived aggregate — total cost,
gross profit, gross margin %, markup % — computed from whichever lines
happen to carry a `cost_cents` snapshot. Cost coverage is **necessarily
partial**: a manual line or a dispatcher-created Pricebook line
contributes 0 to total cost (never had a cost value to snapshot). This is
disclosed, not a bug — the summary is "known margin on cost-tracked
lines," never stored as authoritative financial truth, and never sent to
any role without cost access or to the public/customer-facing surfaces.

### Public customer flow

`GET /api/public/quotes/estimate/{token}` (view) / `POST
.../select` (choose one) — unauthenticated, token-only, mirrors the
Contract public-signing routes' security discipline exactly. The public
view (`toPublicOption`) and the staff-facing Estimate PDF loader
(`getEstimatePdfData`) both build an **explicit allowlisted** object
(never `internal_notes`, never `cost_cents`/`cost_summary`) rather than
spreading the full database row.

Selection is a single atomic call (`commitSelection`): idempotent for the
same option (safe no-op, including under a genuine concurrent-request
race — the claim is a `WHERE status IN (...)` guard, with a fallback
re-read that resolves to the same idempotent success rather than a
spurious error), rejected for a different option once one is already
selected (Section 49 — no Change-Order flow exists yet, so this is a hard
rejection, not a silent overwrite).

### PDF

`estimate-pdf.ts` renders the customer-facing Estimate PDF **live, on
every request**, from current option data — the same lifecycle decision
already made for the Invoice PDF (no frozen/R2-stored artifact exists for
this document, unlike the signed Contract PDF). Disclosed explicitly, not
implied as immutable. Never includes cost/margin/internal notes — reuses
the identical public-safe projection the customer's own comparison page
receives.

### Client UI

- `quote-options-builder.tsx` — embedded in `quote-detail.tsx` (mirrors
  `RelatedContracts`'s self-contained-fetch precedent): quick-add
  GOOD/BETTER/BEST/CUSTOM buttons, "Send Estimate"/"Generate New Link",
  share-link status table, "Preview PDF".
- `quote-option-card.tsx` — one option's editable card: tier, recommended
  toggle, name/headline/description/highlights, discount, line items
  (Pricebook picker reuse from Phase 17, or manual entry), duplicate-as-
  tier, delete. Cost/margin row shown only when the API response actually
  contains it.
- `estimate-selection.tsx` — the public, unauthenticated comparison page
  (`/estimate/:token`, wired in `main.tsx` outside `AuthProvider`, same
  precedent as `sign-contract.tsx`/`public-pay.tsx`), a responsive CSS
  grid of option cards (collapses to one column on mobile with no
  explicit breakpoint needed), a name field + "Confirm my selection".

## Bugs found and fixed during implementation

1. **Public view leaked `internal_notes`.** The first implementation of
   `getPublicQuoteView` spread the full `QuoteOption` row (`{ ...option,
   line_items, tax_breakdown }`) into the public response. A test written
   to assert `internal_notes` never appears in the public JSON caught this
   immediately — Zod's response schema `.omit()` only documents/type-
   narrows for OpenAPI, it does **not** strip extra fields at runtime in
   this codebase's `c.json()` layer. Fixed by building an explicit
   allowlisted `toPublicOption()` (same discipline as Phase 17's
   `stripCost()`), used by both the public view route and the staff PDF
   loader.
2. **Test's own wrong expectation for an invalid tier.** An early test
   assumed a garbage `tier` value would fall through to the service
   layer's own defensive `normalizeTier()` fallback (→ CUSTOM, 201). In
   fact the Zod `.enum()` at the API boundary rejects it first (400) —
   correct, intentional defense-in-depth, not a bug. The test was
   corrected, not the implementation.

## Independent reviews (CLAUDE.md Multi-Agent Review Protocol)

- **Security** (Application Security Engineer): found 2 real issues, both
  **fixed**:
  1. **Cross-tenant IDOR on the option audit-log route** — `GET
     /api/quotes/{id}/options/{optionId}/audit` checked only the caller's
     role, never that `optionId` belonged to the caller's own
     organization (the `{id}` quote param was destructured but never
     used). Fixed by threading `organizationId`/`quoteId` through
     `listOptionAudit`, matching every sibling function's scoping.
  2. **A second live share link could overwrite an already-accepted
     quote's line items.** `commitSelection` checked only the SHARE
     LINK's own status, never the underlying QUOTE's — if staff generated
     two links for the same quote (e.g. "Send Estimate" clicked twice),
     a customer using the second link after the first had already
     completed a selection could still pass its own link's claim check
     and overwrite `quote_line_items` with a different option's content,
     then hit an uncaught `QuoteWorkflowError` (unhandled 500) when
     `transitionQuote` rejected the redundant "accepted → accepted"
     transition. Fixed with an explicit `quote.status === 'sent'` guard
     immediately before the mutating write (mirrors `staffSelectOption`'s
     existing equivalent guard), plus `generateShareLink` now cancels any
     other still-live link for the same quote before issuing a new one
     (belt-and-suspenders, per the Architecture review's matching finding).
- **Architecture** (Software Architect): confirmed the same core race as
  Security's finding 2 independently, plus two more:
  1. (Same as Security finding 2 — fixed as above.)
  2. **`quote_line_items` and `quote_options` were not mutually
     exclusive** — a quote built the ordinary way (Phase 12) that later
     also got a Good/Better/Best option would have its hand-entered
     lines silently deleted the moment an option was selected. **Fixed**:
     `createOption` now rejects if the version already has plain line
     items, and `quotes.ts#insertLineItem` now rejects adding a plain
     line item if the version already has options — enforced in both
     directions, not just a UI-routing convention.
  3. (Nice-to-have) the cost/margin summary presented partial cost
     coverage as an unqualified number. **Fixed**: the admin UI now shows
     "(partial — some lines have no cost data)" whenever any line lacks a
     cost snapshot.
  All 8 confirmation points (option-lives-inside-version design,
  selection→Contract path, snapshot discipline, status FSM reuse,
  share-link design proportionality, cost/margin architecture, platform
  generalization, scope discipline) held, evidenced against actual code
  and `git diff`, not comments.
- **Testing** (Test Automation Engineer): confirmed the suite passed
  (29/29 at review time) and found real gaps, **all closed** — 17 new
  tests added (46 total): the stale-share-link-after-revision scenario
  (which the reviewer independently reproduced as a live, unhandled-500
  bug — now fixed and covered), a genuine `Promise.all` concurrent-
  selection race test, cost secrecy beyond the list route (get/update/
  duplicate/line-item-mutation responses), mass-assignment on update
  paths, the draft-only 409 guard on duplicate/reorder/line-item routes,
  staff-selection guards (wrong status, wrong option), option-level
  discount validation, expired-token handling, view-marks-viewed-and-
  records-an-event, the share-links list route, and an Estimate PDF
  smoke test (real `%PDF-` bytes, RBAC-gated, 404 for a nonexistent
  quote). One item explicitly NOT a gap: Invoice creation has no coupling
  to `quote_line_items`/`quote_versions` at all, so no Phase 18 Invoice-
  regression test was needed.

## Real-browser acceptance (2026-08-27)

Backend-login-then-fetch session cookies throughout (never a typed
password in any browser field). Confirmed end-to-end through the live
UI, not just the automated suite:

- **Admin**: created a Quote, added GOOD (Pricebook-sourced "4-Ton Heat
  Pump" line, via the reused Phase 17 Pricebook picker) and BETTER
  (manual "Premium Heat Pump Package" line, marked Recommended) options;
  cost/margin displayed correctly including the new partial-coverage
  disclosure; "Send Estimate" generated a real, copyable public link;
  "Preview PDF" rendered a genuine multi-option PDF with the company
  header, both options, and the Recommended tag.
- **Public customer** (separate, fully unauthenticated browser tab): the
  comparison page rendered both options side by side with the
  Recommended badge, no cost/internal-notes anywhere in the DOM or
  network responses; selecting BETTER and confirming with a typed name
  produced a clean "Thank you!" confirmation.
- **Admin, post-selection**: the Quote's status flipped to Accepted with
  a real Status History entry (Sent → Accepted); its Line Items section
  showed **only** the Better option's content ("Premium Heat Pump
  Package"), correct recomputed tax; creating a Contract from this Quote
  produced Commercial Terms containing **only** that same content — the
  Good option's "4-Ton Heat Pump" line never appeared anywhere in the
  Contract. This is the phase's central invariant, confirmed through the
  real UI end-to-end, not just the test suite.
- **Dispatcher**: same option cards, zero Cost column, zero Margin/
  Markup line anywhere — confirmed on an already-accepted quote's
  options too, not just a draft one. The "Customer selected this option"
  badge and the share-link status table (status/expiry/selector
  name/timestamp) rendered correctly.
- **Technician**: no "Quotes" sidebar entry at all; direct navigation to
  a Quote URL falls back to their own "My Jobs Today" home view; a
  direct `fetch('/api/quotes/16/options')` confirmed a real server-side
  403, not just UI hiding.

**Responsive breakpoints: NOT verified** — the same disclosed,
pre-existing tooling limitation as every OFS phase since 13A:
`resize_window` reports success but a live `window.innerWidth`/
`innerHeight` check afterward confirmed it does not actually change the
viewport (stuck at 1920×889). The public comparison page's CSS grid
(`repeat(auto-fit, minmax(260px, 1fr))`) is responsive by construction —
no separate breakpoint override is needed for it to collapse to one
column on a narrow viewport — but this was not live-verified at
1440/1024/768/430/390, disclosed honestly rather than fabricated as PASS.

## Phase 17 Pricebook CAS risk — reconciliation (Section 51)

Phase 17's documented, accepted risk remains true and **unsolved by this
phase**: `pricebook_items` has no `row_version`/CAS column, so two
concurrent admin edits to the same catalog item's price are last-write-
wins. Phase 18 does not fix this — it protects against its *consequences*
instead: every option line item snapshots `unit_price_cents`/`cost_cents`
**once**, at creation, and never re-derives them from the live Pricebook
item afterward (same discipline as `quote_line_items` already had). So
even if a Pricebook item's price is lost to a concurrent-edit race, an
Estimate option that already referenced it keeps its own already-snapshot
value — the historical document is safe regardless of what happens to the
catalog afterward. This is a mitigation of exposure, not a fix of the
underlying Pricebook risk, which remains open and undisclosed-as-solved.

## Known limitations / deferred (documented, not oversights)

- **Reusable option templates** (Section 31) — deferred. Nothing in the
  schema blocks adding a `quote_option_templates` table later; staff
  currently build each option from scratch or via Duplicate.
- **Attachments** (Section 36) — deferred, no existing generic Quote
  attachment mechanism was found to extend.
- **Full Change-Order flow** (Section 28) — an already-accepted option
  cannot be silently edited; the only path to change is the existing
  Quote revision mechanism (a new draft version, with fresh options built
  from scratch). A dedicated change-order UI is a documented extension
  point, not built.
- **No automated "Send Estimate" email** — mirrors the existing Contract
  signing-invitation precedent exactly (raw token/link returned to staff,
  who shares it manually); no automated email-delivery pipeline exists
  for the initial Contract signing invite either, so building one only
  for Estimates would be new, unreused infrastructure. Resend/regenerate
  is supported; automated delivery-status/retry is not, honestly, because
  there is no delivery to track.
- **Contract Terms engine** — explicitly Phase 19B's scope; this phase
  changes nothing about existing Contract terms behavior.

## Test coverage

`test/quote-options.test.ts` (46 tests: 29 initial + 17 added closing the
Testing review's gaps) — Admin/Dispatcher option CRUD, tier validation,
draft-only mutation enforcement, recommended uniqueness, duplication (with
line items, recommended reset), reorder, Pricebook-snapshot and manual
lines, historical price integrity, per-option tax computation, cost
secrecy (list, get, update, duplicate, and line-item-mutation routes, plus
the audit-log route, and confirms a dispatcher-created Pricebook line
never gets `cost_cents` populated at all), RBAC (technician denied,
dispatcher can manage), tenant isolation (cross-org option access,
cross-org Pricebook assignment), mass-assignment rejection on both create
and update paths, the public share-link flow (requires ≥1 option, generic
404 for invalid tokens, no cost/internal-notes leakage, idempotent
same-option selection, rejected different-option selection, resend
invalidates the old token, staff-initiated selection, expired-token
handling, view-marks-viewed-and-records-an-event), the share-links list
route, a genuine `Promise.all` concurrent-selection race, the
stale-share-link-after-Quote-revision guard, an Estimate PDF smoke test
(real `%PDF-` bytes, RBAC-gated, 404 for a nonexistent quote), and — the
phase's central invariant — the full GOOD/BETTER/BEST → customer selects
BETTER → Contract contains ONLY BETTER's content → Pricebook price change
after selection doesn't retroactively alter anything, end-to-end.
