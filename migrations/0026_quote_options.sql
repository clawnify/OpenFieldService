-- Migration number: 0026 	 2026-08-27T12:00:00.000Z
--
-- Phase 18 (Good / Better / Best Estimates): adds a Quote Option layer —
-- GOOD/BETTER/BEST/CUSTOM presentation tiers, each an independent,
-- self-contained commercial line-item set living inside an existing Quote
-- Version — plus a public, token-gated share/selection flow the customer
-- uses to compare options and choose one. Fully additive — no existing
-- table, column, or row is altered destructively.
--
-- Pre-implementation audit (see docs/PHASE18-GOOD-BETTER-BEST-ESTIMATES.md
-- for the full write-up) confirmed the existing Quote architecture
-- (migrations/0017_quotes.sql) does NOT need a parallel "Estimate" system:
-- `quotes` (durable identity) + `quote_versions` (immutable-once-sent
-- snapshot) + `quote_line_items` already gives exactly the identity/
-- versioning/lifecycle/tax-snapshot machinery Good/Better/Best needs — this
-- migration extends it with one new sub-layer (Options, living BENEATH a
-- quote_version, sibling to quote_line_items) rather than duplicating any
-- of it. `quotes.status`'s existing FSM (draft/sent/accepted/rejected/
-- expired/cancelled — quote-workflow.ts) is reused as-is: no new top-level
-- Quote status is introduced. A customer selecting an option via the public
-- link IS the existing "sent -> accepted" transition (transitionQuote),
-- just actor_user_id=NULL (system/customer-triggered) instead of a staff
-- id, exactly mirroring contracts.ts's own `transitionContractInternal(...,
-- null, "Derived from signature request completion")` precedent for a
-- publicly-triggered status change.
--
-- Design decisions:
--
--   * `quote_options`/`quote_option_line_items` are INHERITED_THROUGH_PARENT
--     (Phase 11.5's taxonomy) — no own organization_id column, tenant
--     safety flows entirely through quote_version_id -> quote_id, exactly
--     matching `quote_versions`/`quote_line_items`'s own established
--     pattern (not DIRECT_TENANT_COLUMN — these are children of an
--     existing tenant-root, not a new tenant-root themselves).
--   * `quote_options.tier` is a plain TEXT column (GOOD|BETTER|BEST|CUSTOM),
--     not a DB CHECK — app-validated at the API boundary in
--     src/server/quote-options.ts, same "app-validated enum, no DB CHECK"
--     precedent as jobs.status/pricebook_items.type throughout this
--     codebase. CUSTOM exists because Good/Better/Best is a presentation
--     pattern, not a rigid 3-row limit (Section 7) — a quote_version may
--     have 1, 2, 3, or more options.
--   * Exactly one option per quote_version may have `recommended = 1` —
--     enforced at the application layer (src/server/quote-options.ts
--     unsets any prior recommended option before setting a new one in the
--     same transaction-equivalent sequential-write), not a DB constraint,
--     matching this codebase's "no CHECK/partial-unique-index shortcuts
--     for cross-row business rules" convention (see e.g. Pricebook's own
--     per-organization SKU uniqueness, which DOES use a partial unique
--     index because that rule genuinely is expressible as one — this rule,
--     "at most one TRUE per parent," is not expressible as a single-column
--     partial unique index without a fragile WHERE-clause-on-a-boolean
--     trick, so it stays application-enforced like `assets.pricebook_item_id`
--     provenance validation).
--   * `quote_options.highlights` is a JSON TEXT array (`'[]'` default) of
--     short staff-authored strings (Section 14: "Best value", "Longest
--     warranty") — deliberately NOT a fixed set of boolean flag columns
--     (no `is_best_value`/`is_most_efficient`/etc.) so the comparison UI
--     stays genuinely industry-neutral (Section 58) and never needs a
--     schema change to add a new highlight phrase.
--   * `quote_options.cost visibility`: line-item cost is NOT a column on
--     `quote_options` itself (only sell-price-derived subtotal/tax/total,
--     same shape as `quote_versions`) — cost lives per-LINE on
--     `quote_option_line_items.cost_cents` (nullable — populated only when
--     a line is created by an actor with Pricebook cost access, snapshotted
--     from the Pricebook item's cost_cents at that moment, mirroring
--     `unit_price_cents`'s own snapshot discipline; a dispatcher-created
--     Pricebook line never has cost_cents populated in the first place —
--     same "never had it to leak" discipline as Phase 17's `stripCost()`).
--     Margin/markup (Section 17) is a pure derived display value computed
--     from `cost_cents`/`unit_price_cents` at the API/UI layer for an
--     authorized caller only — never itself stored as separate "authoritative
--     financial truth" columns, per this phase's own "derived values should
--     not become authoritative stored financial truth unless justified"
--     instruction.
--   * `quote_option_line_items.pricebook_item_id` (nullable, `ON DELETE SET
--     NULL`) is the SAME provenance signal `quote_line_items` already uses
--     (non-null = Pricebook-sourced snapshot, null = manual/custom line) —
--     no separate `source` enum column invented (Section 33's "where
--     useful" is already satisfied by the existing convention).
--   * `quote_options.row_version` (optimistic-concurrency CAS counter) —
--     same idiom as `quote_versions.row_version` (migration 0017's
--     hardening addendum) and `pricebook_items` does NOT have (Phase 17's
--     disclosed, accepted last-write-wins risk) — Options DO get one here
--     because Section 50 explicitly calls out "staff revises while
--     customer page open" as a concurrency scenario this phase must define
--     safe behavior for, unlike Pricebook's lower-stakes catalog-only risk.
--   * `quote_share_links`/`quote_share_events` mirror
--     `contract_signature_requests`/`contract_signature_events`
--     (migration 0018) as closely as the different domain allows — same
--     raw-256-bit-token/SHA-256-hash-at-rest/status-guarded-UPDATE/
--     IP+UA-capture-at-completion discipline, since this is genuinely the
--     same "public, token-gated, unauthenticated approval flow" shape
--     Contracts already solved securely; no separate signer concept is
--     needed (Quote acceptance is a single customer decision, not a
--     multi-party signature collection), so there is no signer table here.
--   * No `quote_option_selections` table — a customer's selection is a
--     single atomic write (mirrors "chooses one -> confirms acceptance" as
--     ONE public endpoint call, Section 23), recorded directly on
--     `quote_share_links.selected_option_id`/`selected_at` plus one
--     `quote_share_events` row and, critically, `quotes.accepted_option_id`
--     (an explicit, permanent snapshot of which option was accepted — same
--     "explicit snapshot, not an inference" reasoning as `quotes.
--     accepted_version_id` itself, migration 0017's hardening addendum).
--   * `quote_option_audit` mirrors `pricebook_item_audit` (migration 0025)
--     verbatim — an append-only log (option created/duplicated/
--     recommended_changed/price_changed events, Section 54), not a full
--     version-history table; the REAL historical-integrity guarantee for
--     an already-selected option comes from the copy-into-quote_line_items
--     step at selection time (see below), not from versioning the option
--     row itself.
--   * Selected-option -> Contract conversion strategy (Section 25): at the
--     exact moment a customer selects an option (or staff records a
--     selection internally), the selected option's line items are copied
--     into the quote_version's OWN existing `quote_line_items` table (which
--     stays empty/unused while options exist and the version is only
--     draft/sent), and that version's stored totals are recomputed from
--     them via the EXISTING, already-hardened `recomputeAndStoreVersionTotals`
--     — meaning `src/server/contracts.ts`'s `createContract`/
--     `buildCommercialSnapshot`/`assertQuoteAcceptedInOrganization` require
--     ZERO changes: they already read `quote_line_items WHERE
--     quote_version_id = accepted_version_id` and `quote_versions`'
--     stored totals, which now correctly reflect ONLY the selected
--     option's content. Unselected options' line items are never copied
--     anywhere, so they structurally cannot reach a Contract. The Estimate
--     option rows themselves (`quote_options`/`quote_option_line_items`)
--     are never touched by this copy — they remain the permanent,
--     unmodified historical record of everything that was offered.
--   * `quotes.accepted_option_id` is nullable, no DEFAULT clause, `ON
--     DELETE SET NULL` — the required shape for D1's `ALTER TABLE ADD
--     COLUMN` + `REFERENCES` restriction (same pattern already used
--     repeatedly, e.g. migration 0025's `assets.pricebook_item_id`). NULL
--     for every pre-Phase-18 accepted Quote (no options ever existed) and
--     for any Phase-18 Quote accepted the traditional staff-only way
--     without ever having options — both are valid, unambiguous states,
--     not migration gaps.

CREATE TABLE IF NOT EXISTS quote_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_version_id INTEGER NOT NULL REFERENCES quote_versions(id) ON DELETE CASCADE,
  tier TEXT NOT NULL DEFAULT 'CUSTOM',
  name TEXT NOT NULL DEFAULT '',
  headline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  internal_notes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  recommended INTEGER NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'none',
  discount_percent REAL NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  highlights TEXT NOT NULL DEFAULT '[]',
  row_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quote_options_version ON quote_options(quote_version_id);

CREATE TABLE IF NOT EXISTS quote_option_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_option_id INTEGER NOT NULL REFERENCES quote_options(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT '',
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  -- Admin-only, snapshotted at line-creation time from the referenced
  -- Pricebook item's cost_cents (never populated for a manual line, and
  -- never populated when the creating actor lacked Pricebook cost access —
  -- see this migration's header comment). NULL is the safe/common case.
  cost_cents INTEGER,
  total_cents INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  taxable INTEGER NOT NULL DEFAULT 1,
  pricebook_item_id INTEGER REFERENCES pricebook_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_quote_option_line_items_option ON quote_option_line_items(quote_option_id);

CREATE TABLE IF NOT EXISTS quote_option_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_option_id INTEGER NOT NULL REFERENCES quote_options(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quote_option_audit_option ON quote_option_audit(quote_option_id);

CREATE TABLE IF NOT EXISTS quote_share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  -- Bound to ONE exact version at creation time (mirrors
  -- contract_signature_requests.contract_version_id) — a link generated
  -- for version N always shows/accepts version N's options, even if a
  -- later revision creates version N+1; a stale link on a since-revised
  -- quote simply fails its "quote still sent, still this version" guard
  -- at selection time rather than silently jumping to newer content.
  quote_version_id INTEGER NOT NULL REFERENCES quote_versions(id),
  status TEXT NOT NULL DEFAULT 'pending',
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  selected_option_id INTEGER REFERENCES quote_options(id) ON DELETE SET NULL,
  selected_at TEXT,
  selector_name TEXT NOT NULL DEFAULT '',
  selector_ip TEXT,
  selector_user_agent TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quote_share_links_quote ON quote_share_links(quote_id);

CREATE TABLE IF NOT EXISTS quote_share_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_link_id INTEGER NOT NULL REFERENCES quote_share_links(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quote_share_events_link ON quote_share_events(share_link_id);

ALTER TABLE quotes ADD COLUMN accepted_option_id INTEGER REFERENCES quote_options(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_quotes_accepted_option ON quotes(accepted_option_id);
