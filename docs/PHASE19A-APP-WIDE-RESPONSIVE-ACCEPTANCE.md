# Phase 19A — App-Wide Responsive / Mobile / Tablet Acceptance

Status: **IMPLEMENTED / VERIFIED / APP-WIDE RESPONSIVE-ACCEPTED / NOT COMMITTED**
(a separate future "Phase 19A — Safe Commit" task handles the commit,
matching the Phase 15/16/17/18 precedent).

## What this phase is

A full application-wide responsive, mobile, tablet, and focused
accessibility hardening pass across Open Fieldservice — closing the
responsive/mobile verification gap intentionally deferred since Phase 13A
(every phase since has recorded "Responsive: NOT VERIFIED — tooling
limitation": the browser extension's `resize_window` reports success but
never actually changes `window.innerWidth`/`innerHeight`).

**Tooling fix**: this phase uses real Playwright (`@playwright/test`, an
already-installed but previously-unused devDependency) launched from plain
Node scripts against the running local dev server, injecting a pre-issued
session cookie (never typing a password into any browser field, matching
this engagement's standing security constraint throughout). This is the
task's own explicitly-endorsed fallback for the disclosed tooling
limitation, and it genuinely resizes the viewport — verified via real
`window.innerWidth`/`document.documentElement.scrollWidth` reads at every
breakpoint.

## Method

Three synthetic QA accounts (`phase19a-qa-admin`/`-dispatcher`/`-technician
@example.test`) were seeded directly into the local dev D1 database with
real PBKDF2 password hashes (same algorithm as `src/server/auth.ts`,
replicated in a throwaway Node script — never a hand-typed password
anywhere). Fresh fixture data (a customer with adversarially long
name/address, a job assigned to the QA technician, a Good/Better/Best
Quote with a public Estimate share link, a Contract with a public signing
token) was created through the real HTTP API — not direct SQL — so every
route visited had real, representative content.

An automated sweep script visited every top-level authenticated route
(deep-linked, matching `use-router.ts`'s `VIEW_ROUTES`) for Admin,
Dispatcher, and Technician, plus the 3 public routes unauthenticated, at
five required breakpoints (1440/1024/768/430/390), recording: real
`scrollWidth` vs `innerWidth` (the whole-page-overflow invariant), console
errors, failed network requests, and a DOM heuristic for form inputs with
no accessible name (no `aria-label`/`aria-labelledby`/`title`/`label[for]`/
label-wrapping). 345 page loads total (23 routes × 3 roles × 5 breakpoints,
plus 3 public routes × 5 breakpoints).

A separate script did a genuinely interactive Technician mobile
walkthrough at 390 and 430px: real clicks, typed note/checklist text, a
real file upload (photo), a real canvas pointer-drag signature, a status/
completion control click, and a real logout through the mobile hamburger
drawer — 34/34 assertions passed at both breakpoints.

## Findings

**Whole-page horizontal overflow: ZERO violations** across all 345 page
loads at all 5 breakpoints, all 3 authenticated roles, and the public
routes. The app was already responsive by construction (flex/grid layouts,
CSS `repeat(auto-fit, minmax(...))` grids, an off-canvas sidebar drawer
below 640px per Phase 16's own mobile hardening) — this phase's automated
measurement CONFIRMS that for the first time with real data, closing the
tooling gap, but did not need to fix any actual overflow bug.

**Accessibility: real, measured gaps found and fixed.** The sweep's
unlabeled-input heuristic found genuine, pre-existing unassociated
`<label>` elements (visually present, not programmatically linked to their
control) on: Global Settings (Company Profile + Tax & Jurisdiction
sections), the Good/Better/Best Quote Option Builder, Job Detail's note/
checklist/material-select/assign-technician controls and its Completion
Checklist section (photos/report — only rendered once a job is
`in_progress`, so an earlier pass of the sweep against a `scheduled` job
missed it entirely), the Customers and User Management search boxes, and
the Login form. A follow-up manual audit (prompted by the independent
Accessibility review, see below) also found the same gap in two more
conditionally-rendered Job Detail states (the CLEANBC eligibility-code
correction form, and the "Change status?" eligibility-approval modal) and
the signature-capture modal's Customer Name/Relationship fields.

This is a genuine, pervasive, **pre-existing** pattern — a grep across the
whole client found **254 occurrences across 30 files** using the same
unlinked `<label>` idiom, confirming it predates every recent phase
(Login.tsx itself has it). Per CLAUDE.md's Scope Control ("smallest safe
change") and this task's own explicit allowance for a partial outcome
(Section 47: FIXED / PARTIALLY FIXED / DEFERRED WITH EXPLICIT REASON), only
the instances the sweep and the follow-up manual audit actually measured
as broken were fixed — **9 files**, all with `id`+`<label for>` pairs
(single-instance components) or `aria-label` (per-instance list rows, or
controls with no visible label by design). The Good/Better/Best option
card (`quote-option-card.tsx`) renders once per option in a list, so its
ids are namespaced with the option's own database id
(`` `qo-${option.id}-tier` `` etc.) — independently verified collision-free
by the Architecture review below. **~21 other files (~180+ remaining
occurrences) were NOT touched** and remain a known, documented, deferred
app-wide issue — see "Known limitations" below.

**Shared component fix: `ConfirmDialog`.** Used at ~26 call sites app-wide
(every destructive/confirm action), this component had no focus
management, no Escape-to-close, no `role="dialog"`/`aria-modal`, and no
focus trap. Fixed once, at the shared-component level (per this task's own
"Shared Component Strategy," Section 39), rather than patched at each call
site — closing the gap everywhere at once. The fix mirrors the exact
pattern Phase 16 already established for the sidebar's mobile drawer
(Escape closes, focus moves to a sensible default on open). Verified live:
dialog fits the 390px viewport, `aria-modal="true"` present, focus lands on
the Close button on open, Tab cycles Close → Cancel → Delete → wraps back
to Close (a real focus trap), Escape closes it, and Escape/backdrop-click
are both correctly blocked while `submitting` is true (can't dismiss
mid-request). **23 other bespoke modal implementations elsewhere in the
app** (not using this shared component — each with its own separate
`.modal-overlay`/`.modal` markup) still lack this same handling — this is
a deliberate, high-leverage "fix the shared primitive once" choice, not
full coverage; see "Known limitations."

## Independent reviews (CLAUDE.md Multi-Agent Review Protocol)

- **Architecture** (Software Architect): confirmed the `quote-option-card.tsx`
  id-namespacing is genuinely collision-free (verified via grep that every
  static-id component is a true single-instance route component), and that
  the 9-fixed/~21-deferred scoping decision is defensible evidence-scoped
  remediation, not a half-measure. Found one real, confirmed bug in the
  first `ConfirmDialog` fix: the focus/Escape `useEffect` depended on
  `onClose` (a fresh inline arrow at nearly every call site), so it
  re-fired — and re-stole focus to the Close button — on every parent
  re-render while the dialog was open. **Fixed**: the effect now runs
  mount-only (`[]`) and reads the always-current `onClose`/`submitting`
  through a ref, the standard "latest ref" pattern. No other findings; no
  scope creep, no removed functionality, no CSS/layout changes found.
- **Accessibility** (Accessibility Auditor): verified every `id`/`for`
  pair and `aria-label` added is correct and accurate, no typos. Confirmed
  the SAME `ConfirmDialog` focus-refire bug independently. Found three more
  real, previously-missed unassociated-label instances inside files this
  phase had already touched, in conditionally-rendered UI states the
  automated sweep's route-load-only crawl never triggered (signature modal,
  CLEANBC eligibility edit, status-change modal) — **fixed**, see above.
  Also flagged: Escape didn't respect `submitting` (**fixed**, gated), and
  no focus trap existed (**fixed**, Tab now cycles within the dialog).
- **Testing** (Test Automation Engineer): assessed the ad-hoc,
  uncommitted Playwright verification scripts as reasonable for the 8
  purely-additive-markup files (this repo has zero pre-existing
  client-side test infrastructure; inventing a full suite for attribute
  diffs would violate "smallest safe change"), but flagged that
  `confirm-dialog.tsx` is NOT markup-only — it carries real stateful logic
  (a keydown listener, imperative focus, a focus trap) that deserves a
  committed regression check, and that ad-hoc/uncommitted scripts make
  this phase's "34/34 passed" claims unreproducible by a future reviewer.
  **Addressed**: `test/e2e/confirm-dialog-check.mjs` is now a committed,
  documented, reusable helper (see "Testing" below) — a future reviewer can
  re-run it against their own local dev server and see the same real
  PASS/FAIL output, not just take this document's word for it.

## Testing

`test/e2e/confirm-dialog-check.mjs` (new, committed) — a real Playwright
check against the shared `ConfirmDialog` component's stateful behavior
(dialog role/aria-modal, viewport fit, initial focus, Tab focus trap,
Escape-to-close). **Not** wired into `pnpm test`/CI — this repo has no
existing E2E-server-lifecycle harness (unlike the vitest-pool-workers
suite, which gets a fresh isolated D1 per run) and building one from
scratch for a single component was judged disproportionate to this
phase's scope. It requires a running `pnpm run dev` and an admin session
(`FS_EMAIL`/`FS_PASSWORD` env vars — never hardcoded, never typed into a
browser field), documented in the file's own header. `eslint.config.js`
gained a matching `test/e2e/**/*.mjs` override (Node + browser globals,
mirroring the existing `scripts/**/*.mjs` precedent) since this script
runs partly in Node and partly inside `page.evaluate()` browser closures.

Full `pnpm test`: **58/58 files, 1414/1414 tests passing**, run in
isolation (an earlier run performed while heavy parallel Playwright
browser activity was also in flight showed 11 failed files/21 failed
tests — re-running each failing file alone, and the full suite alone,
confirmed this was transient resource contention from the concurrent
browser automation, not a regression; this phase touches zero server
code). `tsc --noEmit`, `eslint .`, `pnpm run build`, and
`pnpm run check:architecture` all clean.

## Route/breakpoint acceptance matrix

All 23 authenticated routes below were visited for Admin, Dispatcher, and
Technician at 1440/1024/768/430/390px (Technician correctly received a
403 on Customer Detail/Invoice Detail — role-appropriate, not a bug), plus
3 public routes unauthenticated at the same 5 breakpoints. **345/345 page
loads: zero overflow, zero navigation errors, zero blank-page renders,
zero unexpected console errors** (only intentional RBAC 403s and the
expected unauthenticated `/api/auth/me` boot-check 401 on Login).

| Route | Overflow | Console/Network | Notes |
| --- | --- | --- | --- |
| Dashboard / Technician Home | PASS | clean | |
| Scheduler | PASS | clean | |
| Jobs | PASS | clean | |
| Job Detail | PASS | clean | labels fixed (see Findings) |
| Customers | PASS | clean | search box label fixed |
| Customer Detail | PASS | 403 for Technician (expected) | Delete dialog live-verified (focus trap, Escape, viewport fit) |
| Leads | PASS | clean | |
| Quotes | PASS | clean | |
| Quote Detail / GBB Estimate Builder | PASS | clean | labels fixed — Phase 18 responsive/accessibility gap now CLOSED |
| Contracts | PASS | clean | |
| Contract Detail | PASS | clean | |
| Phone Operations | PASS | clean | Phase 16 hardened surfaces re-verified, no regression |
| Pricebook | PASS | clean | Phase 17 responsive gap now CLOSED |
| Technicians | PASS | clean | |
| Invoices | PASS | clean | |
| Invoice Detail | PASS | 403 for Technician (expected) | |
| Materials | PASS | clean | |
| Service Types | PASS | clean | |
| Eligibility Tracker | PASS | clean | |
| User Management | PASS | clean | search box label fixed |
| Google Calendar Integration | PASS | clean | |
| Global Settings (Company Profile + Tax & Jurisdiction) | PASS | clean | 24 unlabeled inputs found and fixed |
| Login | PASS | expected boot-check 401 only | Email/Password labels fixed |
| Public Estimate Comparison | PASS | clean | GOOD/BETTER/BEST cards, no cost/margin/internal-notes anywhere in the DOM |
| Public Contract Signing | PASS | clean | |

## Technician mobile acceptance (390px and 430px)

Real interactive walkthrough, both breakpoints, 34/34 assertions passed:
login → Technician Home ("My Jobs Today") → open assigned Job (real click
target verified reachable; direct navigation used for the specific fixture
job to avoid a stale duplicate same-day job from earlier fixture-script
iterations winning list order) → customer name/address/scheduled time
visible → add a note → add a checklist item → Technician Report (Work
Performed field) → Save Draft → real photo upload (a genuine PNG file) →
real signature pad canvas pointer-drag → the status/completion control
correctly reachable and correctly disabled ("Complete Job — 3 requirements
remaining," since only one of two required photo kinds and no report
submission had been completed — correct FSM/compliance gating, not a bug)
→ navigate back to Technician Home → open the mobile hamburger drawer →
log out for real (server-side session revoked) → confirmed redirect to the
Login form. Zero horizontal overflow at either breakpoint on Technician
Home or Job Detail. Zero console errors.

Technician tablet (768/1024): covered by the general 345-page-load sweep
above (Technician role included at both breakpoints for every route) —
zero overflow, zero errors; a dedicated second interactive pass was judged
redundant given the sweep already exercises navigation, lists, and detail
rendering at those breakpoints for this role.

## Phase 17 Pricebook responsive closure

**VERIFIED.** Pricebook list/search/categories/item form/Pricebook picker
(exercised via the Quote Detail route's "Select from Pricebook" flow, same
component reused since Phase 17) all confirmed overflow-free at all 5
breakpoints, all applicable roles (Pricebook is hidden from Technician —
confirmed correct, matching `sidebar.tsx`'s `hideFromTechnician` list).

## Phase 18 Good/Better/Best Estimate responsive closure

**VERIFIED.** The option builder, option cards, Pricebook picker reuse,
recommended badge, totals/tax, and the public comparison/selection page
all confirmed overflow-free at all 5 breakpoints. The public page's CSS
grid (`repeat(auto-fit, minmax(260px, 1fr))`) collapses to one column at
390/430 by construction — confirmed via real measurement this time, not
assumed. Accessibility gaps found on the (admin-only) option builder were
fixed (see Findings); the public-facing comparison page itself had no
label-association issues (it renders read-only option data, no form
inputs besides the final "your name" confirmation field, which already had
a proper association from Phase 18).

## Phone Operations responsive closure

**VERIFIED, no regression.** All Phase 16-hardened surfaces (Calls, Call
Detail, Settings, Voice Agents, Phone Numbers, Credentials) confirmed
overflow-free and error-free at all 5 breakpoints for Admin/Dispatcher; the
mobile drawer's existing Escape/focus-management behavior (Phase 16) was
re-exercised via the Technician walkthrough's own logout step and
confirmed still working correctly — not regressed by this phase's changes.

## Accessibility — focused sweep results

- **Form label association**: FIXED for every instance actually measured
  as broken across the in-scope route inventory (9 files, ~35 individual
  fields) — see Findings. **PARTIALLY FIXED overall**: ~21 other files
  with the same pre-existing pattern remain untouched (see Known
  limitations).
- **Table-row keyboardability**: re-audited. No table-row-as-clickable-div
  pattern requiring a keyboard fix was found in the routes this phase
  touched; the one clickable-card pattern that does exist and matters most
  for mobile (`TechJobCard` in `technician-home.tsx`) was found to already
  be fully correct (`role="button"`, `tabIndex={0}`, Enter/Space handlers)
  — pre-existing, not this phase's work, confirmed not regressed.
- **Drawer/focus behavior**: the sidebar's mobile off-canvas drawer
  (Phase 16) re-verified working correctly (Escape closes, focus moves to
  the first nav item on open) via the Technician walkthrough's real
  hamburger-toggle interaction.
- **Dialogs**: FIXED at the shared-component level (`ConfirmDialog`, ~26
  call sites) — role, aria-modal, initial focus, focus trap, Escape,
  Escape/backdrop blocked mid-request. 23 other bespoke modals not using
  this shared component remain unfixed (see Known limitations).
- **Keyboard acceptance**: spot-verified via the `ConfirmDialog` focus-trap
  check (Tab/Shift+Tab cycling) and the Technician walkthrough's real
  keyboard-adjacent interactions (Enter to submit note/checklist entries).
  No dedicated full keyboard-only pass across every route was performed —
  disclosed, not claimed.
- **Full WCAG audit**: NOT performed. This was a focused pass on
  real, measured gaps — not a certification.

## Known limitations / deferred (documented, not oversights)

- **~21 files, ~180+ occurrences** of the same unassociated-`<label>`
  pattern remain across the app (create-customer.tsx, create-job.tsx,
  create-lead.tsx, edit-user.tsx, invoice-detail.tsx, phone-operations.tsx,
  contract-detail.tsx, and others) — a genuine, pre-existing, app-wide
  issue predating this phase (and every phase before it — Login.tsx itself
  had it). Recommended: a dedicated future accessibility phase, ideally
  extracting a shared `<FormField label="...">` primitive (per this
  task's own "Shared Component Strategy") rather than continuing to patch
  individual call sites one at a time.
- **23 bespoke modal implementations** elsewhere in the app (not using the
  now-fixed shared `ConfirmDialog`) still lack focus-trap/Escape/dialog-
  role handling — same recommendation: extract a shared `<Modal>`
  primitive in a future phase, which would also reduce the real CSS/markup
  duplication already present across those 23 files.
- **Full WCAG 2.1 AA certification**: not attempted — this was a focused,
  evidence-based pass on real, measured gaps.
- **A dedicated full keyboard-only pass across every route**: not
  performed — spot-verified only (dialog focus trap, note/checklist Enter
  submission).
- **`test/e2e/confirm-dialog-check.mjs`**: not wired into CI/`pnpm test` —
  requires a running dev server and a documented env-var-provided admin
  session; a genuine E2E-server-lifecycle harness does not exist in this
  repo and building one was judged out of proportion to this phase.

## No business-logic scope creep

This phase changed zero server code, zero database schema, zero routes,
zero RBAC/authorization logic, zero financial/tax/Quote/Contract/Phone
Operations/Pricebook business rules. Every change is either a pure
additive accessibility attribute (`id`/`for`/`aria-label`) or the
`ConfirmDialog` shared component's focus/keyboard behavior — confirmed via
`git diff --stat` (10 files, 158 insertions/89 deletions, all inside
`src/client/components/*.tsx` plus one `eslint.config.js` override block)
and the full server-side test suite passing unchanged (1414/1414).
