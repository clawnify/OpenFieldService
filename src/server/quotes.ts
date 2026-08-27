import { get, query, run } from "./db.js";
import type { Role } from "./auth.js";
import { resolveTaxProfile, calculateTaxes, createTaxSnapshot, getTaxSnapshot, type TaxProfile, type TaxComponentResult } from "./tax-jurisdiction.js";
import { getCompanyProfile } from "./company-profile.js";
import { getItem as getPricebookItemRecord } from "./pricebook.js";

/**
 * Phase 12 — Quotes / Estimates (Core). A Quote is a commercial proposal to
 * a Customer, optionally originating from a Lead. Durable identity
 * (`quotes`) + immutable, versioned commercial snapshots (`quote_versions` +
 * `quote_line_items`) — see migrations/0017_quotes.sql's header comment for
 * the full versioning rationale. This file owns all Quote storage/business
 * logic; src/server/quote-workflow.ts owns ONLY the lifecycle-status FSM
 * (mirrors the existing financial.ts / workflow.ts split).
 *
 * Money: every field is integer cents (Section 10) — see
 * mem:architecture/data-model's "Monetary-representation rule." Quote
 * accepted != legally signed contract (Section 15) — `accepted_by`/
 * `accepted_at` are internal/manual staff-recorded metadata only; Phase 13
 * (Contracts/E-Sign) owns any legally-traceable signature flow and is
 * expected to layer on top of, not replace, this audit trail.
 */

export interface Actor {
  id: number;
  role: Role;
}

/** Same admin/dispatcher-manage, technician-blocked split as Leads and
 *  Financial (Section 26) — Quotes are a front-office/sales concern with no
 *  field-work component, identical reasoning to why Leads is entirely
 *  blocked for technicians (see mem:architecture/auth). */
export function canManageQuotes(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "dispatcher";
}

export const DISCOUNT_TYPES = ["none", "fixed", "percent"] as const;
export type DiscountType = typeof DISCOUNT_TYPES[number];

export const LINE_ITEM_CATEGORIES = ["service", "labor", "material", "equipment", "other"] as const;
export type LineItemCategory = typeof LINE_ITEM_CATEGORIES[number];

export class QuoteError extends Error {
  code: "not_found" | "invalid_customer" | "invalid_lead" | "invalid_asset" | "invalid_pricebook_item" | "not_draft" | "invalid_input" | "referenced" | "conflict";
  constructor(code: QuoteError["code"], message: string) {
    super(message);
    this.name = "QuoteError";
    this.code = code;
  }
}

export interface Quote {
  id: number;
  organization_id: number;
  identifier: string;
  customer_id: number;
  lead_id: number | null;
  status: string;
  current_version_id: number | null;
  accepted_by: number | null;
  accepted_at: string | null;
  /** Explicit, permanent snapshot of which version was current at the exact
   *  moment of acceptance (hardening addendum) — set once by
   *  transitionQuote() when toStatus === "accepted", never touched again.
   *  Phase 13 (Contracts/E-Sign) should reference THIS, not
   *  `current_version_id`, when identifying exactly what was approved. */
  accepted_version_id: number | null;
  /** Phase 18 — explicit, permanent snapshot of which Good/Better/Best
   *  option the customer (or staff, recording a selection) chose, set once
   *  by transitionQuote() alongside accepted_version_id. NULL for every
   *  pre-Phase-18 accepted Quote and for any Quote accepted the ordinary
   *  way without ever having options — both are valid, unambiguous states. */
  accepted_option_id: number | null;
  rejected_reason: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface QuoteVersion {
  id: number;
  quote_id: number;
  version_number: number;
  subtotal_cents: number;
  discount_type: DiscountType;
  discount_percent: number;
  discount_cents: number;
  tax_rate: number;
  tax_amount_cents: number;
  total_cents: number;
  notes: string;
  expires_at: string | null;
  created_by: number | null;
  created_at: string;
}

export interface QuoteLineItem {
  id: number;
  quote_version_id: number;
  description: string;
  category: LineItemCategory;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  total_cents: number;
  sort_order: number;
  asset_id: number | null;
  taxable: number;
  pricebook_item_id: number | null;
}

export interface LineItemInput {
  description?: string;
  category?: string;
  quantity?: number;
  unit?: string;
  unit_price_cents?: number;
  sort_order?: number;
  asset_id?: number | null;
  taxable?: boolean;
  // Phase 17 — Pricebook integration (Section 36). Providing this alone
  // (with no description/unit_price_cents/taxable) snapshot-copies those
  // fields from the CURRENT Pricebook item at insert time — a one-time
  // copy, never a live reference; a later Pricebook price change never
  // touches this row (Section 11's historical-integrity invariant).
  // Explicitly supplying description/unit_price_cents/taxable alongside
  // pricebook_item_id overrides the snapshot default (Section 37 — the
  // catalog augments manual entry, it doesn't remove the ability to
  // customize a line).
  pricebook_item_id?: number | null;
}

export interface ComputedQuoteTotals {
  subtotalCents: number;
  discountCents: number;
  taxAmountCents: number;
  totalCents: number;
  effectiveTaxRatePercent: number;
  taxComponents: TaxComponentResult[];
  taxableBaseCents: number;
}

/** Deterministic, side-effect-free totals computation — the ONLY place a
 *  Quote's money is calculated. Client-supplied totals are never trusted
 *  (Section 10/28): the API layer never even declares a `total_cents`
 *  request field for create/update, so there's nothing to accidentally
 *  trust. Every value is rounded to the nearest cent at each step (matching
 *  financial.ts#computeTotals's precedent) so rounding error can never
 *  accumulate across many lines. Discount is capped so a subtotal can never
 *  go negative (Section 13) — resolved the same "unconfigured/invalid means
 *  the safe zero, never a fabricated number" way computeRebateAmountCents
 *  already does. */
export function computeQuoteTotals(
  lineItems: { quantity: number; unit_price_cents: number; taxable?: boolean }[],
  discountType: string,
  discountPercent: number,
  discountCentsInput: number,
  profile: TaxProfile | null
): ComputedQuoteTotals {
  let subtotalCents = 0;
  let taxableGrossCents = 0;
  let nonTaxableGrossCents = 0;
  for (const line of lineItems) {
    const lineTotal = Math.round(line.quantity * line.unit_price_cents);
    subtotalCents += lineTotal;
    if (line.taxable ?? true) taxableGrossCents += lineTotal; else nonTaxableGrossCents += lineTotal;
  }

  let discountCents = 0;
  if (discountType === "percent") {
    const pct = Math.min(Math.max(discountPercent, 0), 100);
    discountCents = Math.round(subtotalCents * (pct / 100));
  } else if (discountType === "fixed") {
    discountCents = Math.min(Math.max(discountCentsInput, 0), subtotalCents);
  }
  // Defense in depth beyond the branch-specific caps above — never let a
  // discount exceed its subtotal regardless of how it was resolved.
  discountCents = Math.min(discountCents, subtotalCents);

  // A discount is a single whole-quote figure (Section 13's existing
  // design, unchanged) but tax (Phase 13D) only applies to taxable lines —
  // so the discount is allocated pro-rata across the taxable/non-taxable
  // gross split before tax sees a discounted taxable base. The remainder
  // (not a second independent rounding) goes to the non-taxable share, so
  // the two allocated pieces always sum to exactly discountCents.
  const discountOnTaxable = taxableGrossCents > 0 && subtotalCents > 0
    ? Math.round(discountCents * (taxableGrossCents / subtotalCents))
    : 0;
  const discountOnNonTaxable = discountCents - discountOnTaxable;
  const discountedTaxableCents = taxableGrossCents - discountOnTaxable;
  const discountedNonTaxableCents = nonTaxableGrossCents - discountOnNonTaxable;

  const calc = calculateTaxes(profile, [
    { amountCents: discountedTaxableCents, taxable: true },
    { amountCents: discountedNonTaxableCents, taxable: false },
  ]);
  const effectiveTaxRatePercent = calc.taxableBaseCents > 0 ? Math.round((calc.totalTaxCents / calc.taxableBaseCents) * 10000) / 100 : 0;

  // Displayed Subtotal (hardening — independent Architecture review,
  // Phase 13D): under exclusive pricing `subtotalCents` (raw, pre-discount
  // gross) already reconciles as Subtotal − Discount + Tax = Total, since
  // Tax is genuinely added on top. Under INCLUSIVE pricing that identity
  // breaks if the raw gross is shown as-is, because `calc.totalTaxCents`
  // is the tax embedded in the DISCOUNTED total, not the raw one — showing
  // raw gross next to a discounted-basis tax figure silently fails to sum
  // to Total on screen (Financial.ts's Invoice never hits this: it has no
  // discount step at all). Subtracting the embedded tax from the raw gross
  // here restores the identity in both modes — verified: (subtotalCents −
  // discountCents + taxAmountCents) === totalCents always, not just when
  // prices_include_tax is false.
  const displaySubtotalCents = profile?.prices_include_tax ? subtotalCents - calc.totalTaxCents : subtotalCents;

  return {
    subtotalCents: displaySubtotalCents,
    discountCents,
    taxAmountCents: calc.totalTaxCents,
    // calc.totalCents already handles both pricing modes correctly: in
    // exclusive mode it's the discounted lines plus tax added on top; in
    // inclusive mode tax was already embedded in the discounted lines, so
    // it's just their sum, unchanged — computing `subtotal - discount +
    // tax` here directly would double-count an already-embedded tax.
    totalCents: calc.totalCents,
    effectiveTaxRatePercent,
    taxComponents: calc.components,
    taxableBaseCents: calc.taxableBaseCents,
  };
}

async function nextQuoteIdentifier(): Promise<string> {
  const prefixRow = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'quote_prefix'");
  // Same atomic UPDATE...RETURNING pattern as nextInvoiceIdentifier() —
  // a single indivisible SQLite statement, no read-then-write race.
  const counterRow = await get<{ value: string }>(
    "UPDATE _meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'quote_counter' RETURNING value"
  );
  return `${prefixRow?.value || "QUOTE"}-${counterRow!.value}`;
}

async function assertCustomerInOrganization(organizationId: number, customerId: number): Promise<void> {
  const row = await get<{ id: number }>("SELECT id FROM customers WHERE id = ? AND organization_id = ?", [customerId, organizationId]);
  if (!row) throw new QuoteError("invalid_customer", "Customer not found");
}

async function assertLeadInOrganization(organizationId: number, leadId: number): Promise<void> {
  const row = await get<{ id: number }>("SELECT id FROM leads WHERE id = ? AND organization_id = ?", [leadId, organizationId]);
  if (!row) throw new QuoteError("invalid_lead", "Lead not found");
}

/** An Asset line-item reference must belong to the SAME customer as the
 *  quote (cross-customer denial, same reasoning as Phase 11.4's
 *  linkAssetToJob) — verified via a single org+customer-scoped lookup, not
 *  by trusting a client-supplied organization_id or customer_id on the
 *  asset itself. */
async function assertAssetBelongsToCustomer(organizationId: number, customerId: number, assetId: number): Promise<void> {
  const row = await get<{ id: number }>(
    "SELECT id FROM assets WHERE id = ? AND organization_id = ? AND customer_id = ?", [assetId, organizationId, customerId]
  );
  if (!row) throw new QuoteError("invalid_asset", "This asset does not belong to the quote's customer");
}

/** Phase 17 — resolves a Pricebook item for snapshot purposes only. Returns
 *  `null` fields when `pricebookItemId` is absent (an ordinary manual line);
 *  throws when the id is given but doesn't resolve to a real, same-
 *  organization item — never silently falls back to a blank line for a bad
 *  reference. The returned category is intentionally NOT derived from the
 *  Pricebook item's own `type` (PART/MATERIAL/EQUIPMENT/etc — a different,
 *  wider vocabulary than Quote's own five-value LINE_ITEM_CATEGORIES) —
 *  category selection stays exactly as flexible as it already was for a
 *  manual line, matching Section 37 ("Pricebook should augment, not
 *  unnecessarily remove flexibility"). */
async function resolvePricebookSnapshot(organizationId: number, pricebookItemId: number | null | undefined): Promise<{ description?: string; unit?: string; unit_price_cents?: number; taxable?: boolean } | null> {
  if (pricebookItemId === undefined || pricebookItemId === null) return null;
  const item = await getPricebookItemRecord(organizationId, pricebookItemId);
  if (!item) throw new QuoteError("invalid_pricebook_item", "Pricebook item not found");
  return { description: item.name, unit: item.unit, unit_price_cents: item.sell_price_cents, taxable: item.taxable };
}

function normalizeLineItem(input: LineItemInput, sortOrder: number, defaultTaxable: boolean, snapshot: { description?: string; unit?: string; unit_price_cents?: number; taxable?: boolean } | null): { description: string; category: LineItemCategory; quantity: number; unit: string; unit_price_cents: number; sort_order: number; asset_id: number | null; taxable: boolean; pricebook_item_id: number | null } {
  const category = LINE_ITEM_CATEGORIES.includes((input.category ?? "other") as LineItemCategory)
    ? (input.category as LineItemCategory) ?? "other"
    : "other";
  return {
    description: input.description ?? snapshot?.description ?? "",
    category,
    quantity: input.quantity ?? 1,
    unit: input.unit ?? snapshot?.unit ?? "",
    unit_price_cents: input.unit_price_cents ?? snapshot?.unit_price_cents ?? 0,
    sort_order: input.sort_order ?? sortOrder,
    asset_id: input.asset_id ?? null,
    taxable: input.taxable ?? snapshot?.taxable ?? defaultTaxable,
    pricebook_item_id: input.pricebook_item_id ?? null,
  };
}

/** Recomputes and re-stores `versionId`'s totals from its CURRENT set of
 *  line items in the database — the single call site every line-item
 *  mutation (add/update/delete) and version-metadata update (discount/tax
 *  change) routes through, so `quote_versions`'s stored totals can never
 *  drift out of sync with its actual line items.
 *
 *  Concurrency (hardening addendum, pre-Safe-Commit): the read (line items)
 *  and write (stored totals) below are two separate round-trips, so two
 *  genuinely concurrent mutations on the same version could otherwise race
 *  — request A reads, request B reads+writes, then A's stale-based write
 *  overwrites B's change with out-of-date totals (a lost update). Closed
 *  via `row_version` (migrations/0017's hardening addendum): the write is a
 *  `WHERE id = ? AND row_version = ?` compare-and-swap, exactly the
 *  `converted_customer_id IS NULL` idiom already used in
 *  lead-conversion.ts. A lost race (`changes === 0`) retries — bounded to 3
 *  attempts, since a genuine collision here is rare and each retry re-reads
 *  the now-current line items, so the loop converges to a real, consistent
 *  snapshot rather than surfacing a spurious conflict for what is, from the
 *  caller's perspective, an ordinary single-user edit that merely happened
 *  to land a few milliseconds after someone else's. */
export async function recomputeAndStoreVersionTotals(organizationId: number, versionId: number): Promise<QuoteVersion> {
  const profile = await resolveTaxProfile(organizationId);
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const version = await get<QuoteVersion & { row_version: number }>("SELECT * FROM quote_versions WHERE id = ?", [versionId]);
    if (!version) throw new QuoteError("not_found", "Quote version not found");
    const lines = await query<{ quantity: number; unit_price_cents: number; taxable: number }>(
      "SELECT quantity, unit_price_cents, taxable FROM quote_line_items WHERE quote_version_id = ?", [versionId]
    );
    const totals = computeQuoteTotals(
      lines.map((l) => ({ quantity: l.quantity, unit_price_cents: l.unit_price_cents, taxable: !!l.taxable })),
      version.discount_type, version.discount_percent, version.discount_cents, profile
    );
    const result = await run(
      `UPDATE quote_versions SET subtotal_cents = ?, discount_cents = ?, tax_rate = ?, tax_amount_cents = ?, total_cents = ?, row_version = row_version + 1
       WHERE id = ? AND row_version = ?`,
      [totals.subtotalCents, totals.discountCents, totals.effectiveTaxRatePercent, totals.taxAmountCents, totals.totalCents, versionId, version.row_version]
    );
    if (result.changes > 0) {
      // Tax Snapshot (Section 10/21): re-written on every recompute while
      // this version is still in `draft` — every caller of this function
      // is itself draft-gated (assertDraftAndGetCurrentVersion) except
      // createQuote, which only ever creates version 1 as a fresh draft —
      // so this line can never run for a sent/accepted version. Once the
      // quote leaves draft, nothing calls this function again, and the
      // last-written snapshot freezes with it, exactly like tax_rate/
      // tax_amount_cents above already do.
      const company = await getCompanyProfile(organizationId);
      await createTaxSnapshot({
        documentType: "quote_version", documentId: versionId, profile,
        calc: { taxableBaseCents: totals.taxableBaseCents, totalTaxCents: totals.taxAmountCents, components: totals.taxComponents },
        businessNumber: company.business_number, taxNumber: company.tax_number,
      });
      return {
        id: version.id, quote_id: version.quote_id, version_number: version.version_number,
        subtotal_cents: totals.subtotalCents, discount_type: version.discount_type, discount_percent: version.discount_percent,
        discount_cents: totals.discountCents, tax_rate: totals.effectiveTaxRatePercent, tax_amount_cents: totals.taxAmountCents,
        total_cents: totals.totalCents, notes: version.notes, expires_at: version.expires_at,
        created_by: version.created_by, created_at: version.created_at,
      };
    }
  }
  throw new QuoteError("conflict", "This quote's totals could not be updated due to concurrent changes — please retry");
}

export interface CreateQuoteInput {
  customer_id: number;
  lead_id?: number | null;
  discount_type?: string;
  discount_percent?: number;
  discount_cents?: number;
  // Phase 13D (Section 18): tax rate is no longer client-suppliable at
  // creation — the server resolves the organization's current Tax Profile.
  // Per-line taxability may still be set via `line_items[].taxable`.
  notes?: string;
  expires_at?: string | null;
  line_items?: LineItemInput[];
}

/** Creates a Quote (durable identity, status='draft') plus its first version
 *  and initial line items in one logical operation. Sequential awaited
 *  writes (not a db.batch()) — matches this codebase's own established
 *  convention for ordinary multi-row creates (see createCustomer/createAsset
 *  et al., none of which wrap a multi-INSERT create in an explicit
 *  transaction either); the residual crash-window risk (a server death
 *  between the quotes-row insert and the version-row insert leaving an
 *  orphaned quotes row with no version) is the same narrow, disclosed class
 *  already accepted elsewhere in this codebase, not a new one. */
export async function createQuote(organizationId: number, actorUserId: number, input: CreateQuoteInput): Promise<QuoteWithNames> {
  await assertCustomerInOrganization(organizationId, input.customer_id);
  if (input.lead_id !== undefined && input.lead_id !== null) {
    await assertLeadInOrganization(organizationId, input.lead_id);
  }

  const identifier = await nextQuoteIdentifier();
  const quoteResult = await run(
    `INSERT INTO quotes (organization_id, identifier, customer_id, lead_id, status, created_by)
     VALUES (?, ?, ?, ?, 'draft', ?)`,
    [organizationId, identifier, input.customer_id, input.lead_id ?? null, actorUserId]
  );
  const quoteId = Number(quoteResult.lastInsertRowid);

  const discountType = DISCOUNT_TYPES.includes((input.discount_type ?? "none") as DiscountType) ? (input.discount_type as DiscountType) ?? "none" : "none";
  const versionResult = await run(
    `INSERT INTO quote_versions (quote_id, version_number, discount_type, discount_percent, discount_cents, notes, expires_at, created_by)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
    [quoteId, discountType, input.discount_percent ?? 0, input.discount_cents ?? 0, input.notes ?? "", input.expires_at ?? null, actorUserId]
  );
  const versionId = Number(versionResult.lastInsertRowid);

  const lineItems = input.line_items ?? [];
  for (let i = 0; i < lineItems.length; i++) {
    await insertLineItem(organizationId, input.customer_id, versionId, lineItems[i], i);
  }

  await recomputeAndStoreVersionTotals(organizationId, versionId);
  await run("UPDATE quotes SET current_version_id = ? WHERE id = ?", [versionId, quoteId]);

  return (await getQuote(organizationId, quoteId))!;
}

async function insertLineItem(organizationId: number, customerId: number, versionId: number, input: LineItemInput, sortOrder: number): Promise<number> {
  if (input.asset_id !== undefined && input.asset_id !== null) {
    await assertAssetBelongsToCustomer(organizationId, customerId, input.asset_id);
  }
  // Phase 18 architecture-review finding: a quote_version's own top-level
  // quote_line_items and its Good/Better/Best quote_options are mutually
  // exclusive (see quote-options.ts#createOption's matching guard in the
  // other direction) — a version that already has options must not also
  // grow plain line items, which would create the same "which is
  // authoritative" ambiguity from the opposite side. Harmless no-op for
  // createQuote's own initial-line-items loop (a brand-new quote can never
  // have options yet). Raw table check, not an import of quote-options.ts,
  // to avoid a circular module dependency (quote-options.ts already
  // imports from this file).
  const existingOptions = await get<{ n: number }>("SELECT COUNT(*) as n FROM quote_options WHERE quote_version_id = ?", [versionId]);
  if (existingOptions?.n) {
    throw new QuoteError("invalid_input", "This quote has Good/Better/Best options — add lines to an option instead of the plain line-item list (the two are mutually exclusive for the same version)");
  }
  const snapshot = await resolvePricebookSnapshot(organizationId, input.pricebook_item_id);
  const profile = await resolveTaxProfile(organizationId);
  const normalized = normalizeLineItem(input, sortOrder, profile?.default_taxable ?? true, snapshot);
  const totalCents = Math.round(normalized.quantity * normalized.unit_price_cents);
  const result = await run(
    `INSERT INTO quote_line_items (quote_version_id, description, category, quantity, unit, unit_price_cents, total_cents, sort_order, asset_id, taxable, pricebook_item_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [versionId, normalized.description, normalized.category, normalized.quantity, normalized.unit, normalized.unit_price_cents, totalCents, normalized.sort_order, normalized.asset_id, normalized.taxable ? 1 : 0, normalized.pricebook_item_id]
  );
  return Number(result.lastInsertRowid);
}

// Explicit column list (excludes row_version, an internal optimistic-
// concurrency counter with no business meaning) — every read of
// quote_versions that ultimately reaches an API response uses this,
// keeping the "never leak row_version" intent from
// recomputeAndStoreVersionTotals() consistent everywhere, not just there.
const QUOTE_VERSION_COLUMNS = "id, quote_id, version_number, subtotal_cents, discount_type, discount_percent, discount_cents, tax_rate, tax_amount_cents, total_cents, notes, expires_at, created_by, created_at";

export type QuoteWithNames = Quote & { customer_name: string | null; lead_identifier: string | null };

export async function getQuote(organizationId: number, id: number): Promise<QuoteWithNames | null> {
  const quote = await get<Quote & { customer_name: string | null; lead_identifier: string | null }>(
    `SELECT q.*, c.name as customer_name, l.identifier as lead_identifier
     FROM quotes q
     LEFT JOIN customers c ON q.customer_id = c.id
     LEFT JOIN leads l ON q.lead_id = l.id
     WHERE q.id = ? AND q.organization_id = ?`,
    [id, organizationId]
  );
  return quote ?? null;
}

export async function getQuoteVersion(quoteId: number, versionId: number): Promise<(QuoteVersion & { line_items: QuoteLineItem[]; tax_snapshot: Awaited<ReturnType<typeof getTaxSnapshot>> }) | null> {
  const version = await get<QuoteVersion>(`SELECT ${QUOTE_VERSION_COLUMNS} FROM quote_versions WHERE id = ? AND quote_id = ?`, [versionId, quoteId]);
  if (!version) return null;
  const line_items = await query<QuoteLineItem>(
    "SELECT * FROM quote_line_items WHERE quote_version_id = ? ORDER BY sort_order ASC, id ASC", [versionId]
  );
  // Phase 13D: the persisted per-component breakdown for THIS version —
  // never re-derived from the organization's current Tax Profile. null for
  // a pre-Phase-13D version with no snapshot row.
  const tax_snapshot = await getTaxSnapshot("quote_version", versionId);
  return { ...version, line_items, tax_snapshot };
}

export async function listQuoteVersions(quoteId: number): Promise<QuoteVersion[]> {
  return query<QuoteVersion>(`SELECT ${QUOTE_VERSION_COLUMNS} FROM quote_versions WHERE quote_id = ? ORDER BY version_number DESC`, [quoteId]);
}

export interface QuoteStatusHistoryRow {
  id: number;
  quote_id: number;
  old_status: string | null;
  new_status: string;
  actor_user_id: number | null;
  reason: string;
  created_at: string;
}

export async function getQuoteStatusHistory(quoteId: number): Promise<QuoteStatusHistoryRow[]> {
  return query<QuoteStatusHistoryRow>("SELECT * FROM quote_status_history WHERE quote_id = ? ORDER BY created_at DESC, id DESC", [quoteId]);
}

export interface QuoteListFilters {
  status?: string;
  customer_id?: number;
  lead_id?: number;
  search?: string;
}

export type QuoteListRow = QuoteWithNames & { total_cents: number | null };

export async function listQuotes(
  organizationId: number, filters: QuoteListFilters, limit: number, offset: number
): Promise<{ quotes: QuoteListRow[]; total: number }> {
  const conditions = ["q.organization_id = ?"];
  const params: unknown[] = [organizationId];

  if (filters.status) {
    conditions.push("q.status = ?");
    params.push(filters.status);
  }
  if (filters.customer_id !== undefined) {
    conditions.push("q.customer_id = ?");
    params.push(filters.customer_id);
  }
  if (filters.lead_id !== undefined) {
    conditions.push("q.lead_id = ?");
    params.push(filters.lead_id);
  }
  if (filters.search) {
    assertSearchableQuoteFilter(filters.search);
    conditions.push("(q.identifier LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')");
    const like = likePattern(filters.search);
    params.push(like, like);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const from = "FROM quotes q LEFT JOIN customers c ON q.customer_id = c.id LEFT JOIN leads l ON q.lead_id = l.id";
  // Tenant filtering (organization_id, always conditions[0]) applies
  // identically to both the count and the paginated data query, before
  // pagination is ever applied — same discipline as listAssets/listCustomers.
  const countRow = await get<{ count: number }>(`SELECT COUNT(*) as count ${from} ${where}`, params);
  const quotes = await query<QuoteListRow>(
    `SELECT q.*, c.name as customer_name, l.identifier as lead_identifier, v.total_cents as total_cents
     ${from} LEFT JOIN quote_versions v ON q.current_version_id = v.id
     ${where} ORDER BY q.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { quotes, total: countRow?.count || 0 };
}

// Same wildcard-count-cap + ESCAPE-clause discipline as Phase 11.4's
// assets.ts#likePattern/assertSearchableFilter — a security-review finding
// from that phase, applied here from the start rather than re-discovered.
const MAX_LIKE_WILDCARD_CHARS = 20;

function likePattern(value: string): string {
  return `%${value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

export function assertSearchableQuoteFilter(value: string): void {
  const wildcardCount = (value.match(/[%_]/g) || []).length;
  if (wildcardCount > MAX_LIKE_WILDCARD_CHARS) {
    throw new QuoteError("invalid_input", "Search filter is too complex — try a shorter or simpler value");
  }
}

/** Only permitted while status === 'draft' (Section 7: "draft editable...
 *  sent historically stable") — the route layer is expected to check this
 *  BEFORE calling, but this function re-checks independently rather than
 *  trusting the caller, since silently editing a sent/accepted version's
 *  numbers would be the single worst bug this phase could ship. */
async function assertDraftAndGetCurrentVersion(organizationId: number, quoteId: number): Promise<{ quote: Quote; versionId: number }> {
  const quote = await get<Quote>("SELECT * FROM quotes WHERE id = ? AND organization_id = ?", [quoteId, organizationId]);
  if (!quote) throw new QuoteError("not_found", "Quote not found");
  if (quote.status !== "draft" || quote.current_version_id === null) {
    throw new QuoteError("not_draft", "This quote is not in draft status — create a revision to make further changes");
  }
  return { quote, versionId: quote.current_version_id };
}

export interface UpdateVersionInput {
  discount_type?: string;
  discount_percent?: number;
  discount_cents?: number;
  // Phase 13D: tax_rate removed — server-resolved, no longer client-settable.
  notes?: string;
  expires_at?: string | null;
}

export async function updateQuoteVersion(organizationId: number, quoteId: number, input: UpdateVersionInput): Promise<QuoteVersion> {
  const { versionId } = await assertDraftAndGetCurrentVersion(organizationId, quoteId);
  const fields: string[] = [];
  const vals: unknown[] = [];
  if (input.discount_type !== undefined) {
    const dt = DISCOUNT_TYPES.includes(input.discount_type as DiscountType) ? input.discount_type : "none";
    fields.push("discount_type = ?"); vals.push(dt);
  }
  if (input.discount_percent !== undefined) { fields.push("discount_percent = ?"); vals.push(input.discount_percent); }
  if (input.discount_cents !== undefined) { fields.push("discount_cents = ?"); vals.push(input.discount_cents); }
  if (input.notes !== undefined) { fields.push("notes = ?"); vals.push(input.notes); }
  if (input.expires_at !== undefined) { fields.push("expires_at = ?"); vals.push(input.expires_at); }
  if (fields.length > 0) {
    await run(`UPDATE quote_versions SET ${fields.join(", ")} WHERE id = ?`, [...vals, versionId]);
  }
  return recomputeAndStoreVersionTotals(organizationId, versionId);
}

export async function addLineItem(organizationId: number, quoteId: number, input: LineItemInput): Promise<QuoteVersion> {
  const { quote, versionId } = await assertDraftAndGetCurrentVersion(organizationId, quoteId);
  const countRow = await get<{ n: number }>("SELECT COUNT(*) as n FROM quote_line_items WHERE quote_version_id = ?", [versionId]);
  await insertLineItem(organizationId, quote.customer_id, versionId, input, countRow?.n ?? 0);
  return recomputeAndStoreVersionTotals(organizationId, versionId);
}

export async function updateLineItem(organizationId: number, quoteId: number, lineItemId: number, input: LineItemInput): Promise<QuoteVersion> {
  const { quote, versionId } = await assertDraftAndGetCurrentVersion(organizationId, quoteId);
  const existing = await get<QuoteLineItem>(
    "SELECT * FROM quote_line_items WHERE id = ? AND quote_version_id = ?", [lineItemId, versionId]
  );
  if (!existing) throw new QuoteError("not_found", "Line item not found");

  if (input.asset_id !== undefined && input.asset_id !== null) {
    await assertAssetBelongsToCustomer(organizationId, quote.customer_id, input.asset_id);
  }
  // Update stays a plain field-level edit (unlike insertLineItem) — it does
  // NOT auto-repopulate description/price/taxable from the referenced
  // Pricebook item, only validates and records the linkage id. Section 37:
  // Pricebook augments manual entry rather than removing the ability to
  // freely edit an already-added line, catalog-sourced or not.
  if (input.pricebook_item_id !== undefined && input.pricebook_item_id !== null) {
    const item = await getPricebookItemRecord(organizationId, input.pricebook_item_id);
    if (!item) throw new QuoteError("invalid_pricebook_item", "Pricebook item not found");
  }
  const fields: string[] = [];
  const vals: unknown[] = [];
  const setIfPresent = (col: keyof LineItemInput, value: unknown) => {
    if (input[col] !== undefined) { fields.push(`${col} = ?`); vals.push(value); }
  };
  if (input.category !== undefined) {
    setIfPresent("category", LINE_ITEM_CATEGORIES.includes(input.category as LineItemCategory) ? input.category : "other");
  }
  setIfPresent("description", input.description);
  setIfPresent("quantity", input.quantity);
  setIfPresent("unit", input.unit);
  setIfPresent("unit_price_cents", input.unit_price_cents);
  setIfPresent("sort_order", input.sort_order);
  setIfPresent("asset_id", input.asset_id);
  setIfPresent("pricebook_item_id", input.pricebook_item_id);
  if (input.taxable !== undefined) { fields.push("taxable = ?"); vals.push(input.taxable ? 1 : 0); }

  const newQuantity = input.quantity ?? existing.quantity;
  const newUnitPrice = input.unit_price_cents ?? existing.unit_price_cents;
  fields.push("total_cents = ?");
  vals.push(Math.round(newQuantity * newUnitPrice));

  await run(`UPDATE quote_line_items SET ${fields.join(", ")} WHERE id = ?`, [...vals, lineItemId]);
  return recomputeAndStoreVersionTotals(organizationId, versionId);
}

export async function deleteLineItem(organizationId: number, quoteId: number, lineItemId: number): Promise<QuoteVersion> {
  const { versionId } = await assertDraftAndGetCurrentVersion(organizationId, quoteId);
  await run("DELETE FROM quote_line_items WHERE id = ? AND quote_version_id = ?", [lineItemId, versionId]);
  return recomputeAndStoreVersionTotals(organizationId, versionId);
}

/**
 * Section 8's explicit "Create Revision" operation. Allowed only from
 * sent/rejected/expired/cancelled (see quote-workflow.ts#canCreateRevisionFrom)
 * — never from draft (already editable) or accepted (terminal). Inserts a
 * new quote_versions row with the next sequential version_number
 * (atomic single-statement INSERT...SELECT, backstopped by
 * UNIQUE(quote_id, version_number) — see migrations/0017's header comment
 * for the full concurrency reasoning), copies the CURRENT version's line
 * items into it as an editable starting point, and resets quotes.status to
 * 'draft' — reopening the lifecycle for a genuinely new commercial
 * position without ever mutating the version being revised.
 */
export async function createQuoteRevision(organizationId: number, quoteId: number, actorUserId: number): Promise<QuoteVersion> {
  const quote = await get<Quote>("SELECT * FROM quotes WHERE id = ? AND organization_id = ?", [quoteId, organizationId]);
  if (!quote) throw new QuoteError("not_found", "Quote not found");
  if (quote.status === "draft") throw new QuoteError("not_draft", "This quote is already in draft status");
  if (quote.status === "accepted") throw new QuoteError("not_draft", "An accepted quote cannot be revised — it is final");
  if (quote.current_version_id === null) throw new QuoteError("not_found", "Quote has no current version");

  const sourceVersion = await get<QuoteVersion>("SELECT * FROM quote_versions WHERE id = ?", [quote.current_version_id]);
  if (!sourceVersion) throw new QuoteError("not_found", "Source version not found");

  let newVersionId: number;
  try {
    // tax_rate/tax_amount_cents/total_cents are intentionally NOT copied
    // here (Phase 13D) — recomputeAndStoreVersionTotals below resolves the
    // CURRENT Tax Profile for this brand-new draft version, exactly like
    // createQuote does for version 1. Copying the source version's stale
    // blended rate would only be overwritten a few lines later anyway.
    const result = await run(
      `INSERT INTO quote_versions (quote_id, version_number, discount_type, discount_percent, discount_cents, notes, expires_at, created_by)
       SELECT ?, COALESCE(MAX(version_number), 0) + 1, ?, ?, ?, ?, ?, ?
       FROM quote_versions WHERE quote_id = ?`,
      [quoteId, sourceVersion.discount_type, sourceVersion.discount_percent, sourceVersion.discount_cents, sourceVersion.notes, sourceVersion.expires_at, actorUserId, quoteId]
    );
    newVersionId = Number(result.lastInsertRowid);
  } catch {
    // UNIQUE(quote_id, version_number) backstop — see migration header.
    throw new QuoteError("invalid_input", "A revision is already being created for this quote — please retry");
  }

  const sourceLines = await query<QuoteLineItem>(
    "SELECT * FROM quote_line_items WHERE quote_version_id = ? ORDER BY sort_order ASC, id ASC", [quote.current_version_id]
  );
  for (const line of sourceLines) {
    await run(
      `INSERT INTO quote_line_items (quote_version_id, description, category, quantity, unit, unit_price_cents, total_cents, sort_order, asset_id, taxable, pricebook_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newVersionId, line.description, line.category, line.quantity, line.unit, line.unit_price_cents, line.total_cents, line.sort_order, line.asset_id, line.taxable, line.pricebook_item_id]
    );
  }

  await recomputeAndStoreVersionTotals(organizationId, newVersionId);
  await run(
    "UPDATE quotes SET current_version_id = ?, status = 'draft', updated_at = datetime('now') WHERE id = ?",
    [newVersionId, quoteId]
  );
  await run(
    "INSERT INTO quote_status_history (quote_id, old_status, new_status, actor_user_id, reason) VALUES (?, ?, 'draft', ?, ?)",
    [quoteId, quote.status, actorUserId, `Revision ${sourceVersion.version_number + 1} created`]
  );

  return (await get<QuoteVersion>(`SELECT ${QUOTE_VERSION_COLUMNS} FROM quote_versions WHERE id = ?`, [newVersionId]))!;
}

/** Hard-deletes a Quote only when it has never left draft (zero status-
 *  history rows AND still status='draft') — the same "history-preserving,
 *  only an accidental/untouched draft is truly deletable" philosophy as
 *  Phase 11.4's deleteAsset guard, applied here from the start. */
export async function deleteQuote(organizationId: number, id: number): Promise<boolean> {
  const quote = await get<Quote>("SELECT id, status FROM quotes WHERE id = ? AND organization_id = ?", [id, organizationId]);
  if (!quote) return false;
  if (quote.status !== "draft") {
    throw new QuoteError("referenced", "Only a quote that has never been sent can be deleted");
  }
  const historyRow = await get<{ id: number }>("SELECT id FROM quote_status_history WHERE quote_id = ? LIMIT 1", [id]);
  if (historyRow) {
    throw new QuoteError("referenced", "This quote has transition history and cannot be deleted");
  }
  await run("DELETE FROM quotes WHERE id = ? AND organization_id = ?", [id, organizationId]);
  return true;
}
