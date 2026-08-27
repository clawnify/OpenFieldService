import { get, query, run } from "./db.js";
import type { Role } from "./auth.js";
import {
  computeQuoteTotals, recomputeAndStoreVersionTotals,
  DISCOUNT_TYPES, LINE_ITEM_CATEGORIES, type DiscountType, type LineItemCategory,
} from "./quotes.js";
import { resolveTaxProfile, createTaxSnapshot, getTaxSnapshot, type TaxComponentResult } from "./tax-jurisdiction.js";
import { getItem as getPricebookItem, canManagePricebook } from "./pricebook.js";
import { transitionQuote } from "./quote-workflow.js";
import { getCompanyProfile } from "./company-profile.js";

/**
 * Phase 18 — Good / Better / Best Estimate Options (Core). A `quote_option`
 * is a self-contained commercial alternative living inside an existing
 * Quote Version — GOOD/BETTER/BEST/CUSTOM presentation tiers, each with its
 * own line items and independently-computed totals. This file owns all
 * Option storage/business logic plus the public, token-gated share/
 * selection flow the customer uses to compare options and choose one.
 * `src/server/quote-workflow.ts` still owns the Quote-level status FSM
 * unchanged — selecting an option IS the existing "sent -> accepted"
 * transition (see `commitSelection` below), never a parallel status
 * machine (Section 37).
 *
 * Platform-general by design (Section 58): nothing in this file knows
 * about HVAC, heat pumps, CleanBC, or any other industry/regional concept.
 * `tier`/`highlights`/`description` are free-form staff-authored content,
 * not fixed schema.
 */

export const OPTION_TIERS = ["GOOD", "BETTER", "BEST", "CUSTOM"] as const;
export type OptionTier = typeof OPTION_TIERS[number];

export class QuoteOptionError extends Error {
  code: "not_found" | "not_draft" | "invalid_tier" | "invalid_input" | "invalid_pricebook_item" | "invalid_asset"
    | "invalid_token" | "conflict" | "already_selected" | "no_options" | "not_sent";
  constructor(code: QuoteOptionError["code"], message: string) {
    super(message);
    this.name = "QuoteOptionError";
    this.code = code;
  }
}

/** Same admin-only policy as Pricebook cost visibility (Section 16) —
 *  reused directly rather than re-declared, since it's genuinely the same
 *  rule applied to the same underlying data (a Pricebook item's cost,
 *  snapshotted onto an option line). */
export const canViewOptionCost = canManagePricebook;

export interface QuoteOption {
  id: number;
  quote_version_id: number;
  tier: OptionTier;
  name: string;
  headline: string;
  description: string;
  internal_notes: string;
  sort_order: number;
  recommended: boolean;
  discount_type: DiscountType;
  discount_percent: number;
  discount_cents: number;
  subtotal_cents: number;
  tax_rate: number;
  tax_amount_cents: number;
  total_cents: number;
  highlights: string[];
  created_at: string;
  updated_at: string;
}

interface QuoteOptionRow extends Omit<QuoteOption, "recommended" | "highlights"> { recommended: number; highlights: string; row_version: number }
function toOption(row: QuoteOptionRow): QuoteOption {
  let highlights: string[] = [];
  try {
    const parsed = JSON.parse(row.highlights || "[]");
    if (Array.isArray(parsed)) highlights = parsed.filter((h) => typeof h === "string").slice(0, 20);
  } catch { /* malformed/legacy value — treat as no highlights rather than fail the whole read */ }
  return { ...row, recommended: !!row.recommended, highlights };
}

export interface QuoteOptionInput {
  tier?: string;
  name?: string;
  headline?: string;
  description?: string;
  internal_notes?: string;
  sort_order?: number;
  recommended?: boolean;
  discount_type?: string;
  discount_percent?: number;
  discount_cents?: number;
  highlights?: string[];
}

export interface QuoteOptionLineItem {
  id: number;
  quote_option_id: number;
  description: string;
  category: LineItemCategory;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  cost_cents: number | null;
  total_cents: number;
  sort_order: number;
  asset_id: number | null;
  taxable: number;
  pricebook_item_id: number | null;
}

export interface QuoteOptionLineItemInput {
  description?: string;
  category?: string;
  quantity?: number;
  unit?: string;
  unit_price_cents?: number;
  sort_order?: number;
  asset_id?: number | null;
  taxable?: boolean;
  pricebook_item_id?: number | null;
}

/** Cost stripped for any role without `canViewOptionCost` — an explicit
 *  field-allowlist reconstruction (Phase 17's `stripCost()` precedent),
 *  not a destructuring omit, so a future field added to
 *  `QuoteOptionLineItem` fails closed rather than leaking by default. */
export type QuoteOptionLineItemPublicView = Omit<QuoteOptionLineItem, "cost_cents">;
export function stripLineCost(line: QuoteOptionLineItem): QuoteOptionLineItemPublicView {
  return {
    id: line.id, quote_option_id: line.quote_option_id, description: line.description, category: line.category,
    quantity: line.quantity, unit: line.unit, unit_price_cents: line.unit_price_cents, total_cents: line.total_cents,
    sort_order: line.sort_order, asset_id: line.asset_id, taxable: line.taxable, pricebook_item_id: line.pricebook_item_id,
  };
}

/** Section 17 — a pure derived aggregate, never itself stored as
 *  authoritative financial truth. Cost coverage is necessarily PARTIAL:
 *  a line only carries `cost_cents` when it was Pricebook-sourced AND
 *  created by an actor with cost access (see `resolveCostSnapshot` below)
 *  — a manual line or a dispatcher-created Pricebook line contributes 0 to
 *  `totalCostCents`, which is the honest, disclosed behavior, not a bug:
 *  margin here is "known margin on cost-tracked lines," not a guaranteed
 *  whole-option P&L. */
export function computeOptionCostSummary(lines: { unit_price_cents: number; cost_cents: number | null; quantity: number }[]): {
  totalCostCents: number; totalSellCents: number; grossProfitCents: number; grossMarginPercent: number; markupPercent: number;
} {
  let totalCostCents = 0;
  let totalSellCents = 0;
  for (const l of lines) {
    totalSellCents += Math.round(l.quantity * l.unit_price_cents);
    if (l.cost_cents !== null) totalCostCents += Math.round(l.quantity * l.cost_cents);
  }
  const grossProfitCents = totalSellCents - totalCostCents;
  const grossMarginPercent = totalSellCents > 0 ? Math.round((grossProfitCents / totalSellCents) * 10000) / 100 : 0;
  const markupPercent = totalCostCents > 0 ? Math.round((grossProfitCents / totalCostCents) * 10000) / 100 : 0;
  return { totalCostCents, totalSellCents, grossProfitCents, grossMarginPercent, markupPercent };
}

// ── Internal helpers ─────────────────────────────────────────────────

interface QuoteRow { id: number; organization_id: number; customer_id: number; status: string; current_version_id: number | null; accepted_version_id: number | null }

async function assertQuoteInOrganization(organizationId: number, quoteId: number): Promise<QuoteRow> {
  const quote = await get<QuoteRow>("SELECT id, organization_id, customer_id, status, current_version_id, accepted_version_id FROM quotes WHERE id = ? AND organization_id = ?", [quoteId, organizationId]);
  if (!quote) throw new QuoteOptionError("not_found", "Quote not found");
  return quote;
}

/** Options may only be created/edited/removed while the Quote is still
 *  draft (Section 10: "Draft -> editable, Sent -> snapshot/version
 *  frozen") — same "route layer expected to check, function re-checks
 *  independently" discipline as quotes.ts's own assertDraftAndGetCurrentVersion. */
async function assertDraftQuoteAndVersion(organizationId: number, quoteId: number): Promise<{ quote: QuoteRow; versionId: number }> {
  const quote = await assertQuoteInOrganization(organizationId, quoteId);
  if (quote.status !== "draft" || quote.current_version_id === null) {
    throw new QuoteOptionError("not_draft", "This quote is not in draft status — create a revision to make further changes");
  }
  return { quote, versionId: quote.current_version_id };
}

async function getOptionRow(optionId: number): Promise<QuoteOptionRow | undefined> {
  return get<QuoteOptionRow>("SELECT * FROM quote_options WHERE id = ?", [optionId]);
}

/** Verifies `optionId` belongs to `versionId` — the same "cross-entity
 *  reference must be same-parent before trust" check every other domain in
 *  this app applies. */
async function assertOptionBelongsToVersion(optionId: number, versionId: number): Promise<QuoteOptionRow> {
  const row = await getOptionRow(optionId);
  if (!row || row.quote_version_id !== versionId) throw new QuoteOptionError("not_found", "Option not found");
  return row;
}

function normalizeTier(value: string | undefined, fallback: OptionTier = "CUSTOM"): OptionTier {
  return value && (OPTION_TIERS as readonly string[]).includes(value) ? (value as OptionTier) : fallback;
}

function normalizeHighlights(value: string[] | undefined): string[] {
  if (!value) return [];
  return value.filter((h) => typeof h === "string" && h.trim() !== "").slice(0, 20).map((h) => h.slice(0, 200));
}

async function recordOptionAudit(optionId: number, eventType: string, actorUserId: number | null, details: Record<string, unknown>): Promise<void> {
  await run(
    "INSERT INTO quote_option_audit (quote_option_id, event_type, actor_user_id, details) VALUES (?, ?, ?, ?)",
    [optionId, eventType, actorUserId, JSON.stringify(details)]
  );
}

/** Security-review finding: every other option-scoped function verifies
 *  `optionId` belongs to a caller-owned `quoteId`/`organization_id`
 *  before touching it — this one, originally, did not (it only checked
 *  the caller's ROLE, never tenant ownership), letting any admin read
 *  another organization's audit trail (tier/name/price-change history) by
 *  guessing a numeric option id. Fixed by requiring the same quoteId +
 *  organizationId scoping as `getOption`. */
export async function listOptionAudit(organizationId: number, quoteId: number, optionId: number): Promise<Array<{ id: number; event_type: string; actor_user_id: number | null; details: string; created_at: string }>> {
  const quote = await assertQuoteInOrganization(organizationId, quoteId);
  await assertOptionBelongsToVersion(optionId, quote.current_version_id ?? -1);
  return query("SELECT id, event_type, actor_user_id, details, created_at FROM quote_option_audit WHERE quote_option_id = ? ORDER BY created_at DESC", [optionId]);
}

// ── Option CRUD ──────────────────────────────────────────────────────

export async function listOptions(organizationId: number, quoteId: number): Promise<{ options: QuoteOption[]; lineItems: Map<number, QuoteOptionLineItem[]> }> {
  const quote = await assertQuoteInOrganization(organizationId, quoteId);
  if (quote.current_version_id === null) return { options: [], lineItems: new Map() };
  const rows = await query<QuoteOptionRow>(
    "SELECT * FROM quote_options WHERE quote_version_id = ? ORDER BY sort_order ASC, id ASC", [quote.current_version_id]
  );
  const options = rows.map(toOption);
  const lineItems = new Map<number, QuoteOptionLineItem[]>();
  for (const option of options) {
    const lines = await query<QuoteOptionLineItem>(
      "SELECT * FROM quote_option_line_items WHERE quote_option_id = ? ORDER BY sort_order ASC, id ASC", [option.id]
    );
    lineItems.set(option.id, lines);
  }
  return { options, lineItems };
}

/** Reads options for a SPECIFIC version (not necessarily the current one)
 *  — used by the public share flow, which pins to the version it was
 *  generated for (Section 9's "existing Estimate options remain unchanged"
 *  even if a later revision creates a new current version). */
async function listOptionsForVersion(versionId: number): Promise<{ options: QuoteOption[]; lineItems: Map<number, QuoteOptionLineItem[]> }> {
  const rows = await query<QuoteOptionRow>("SELECT * FROM quote_options WHERE quote_version_id = ? ORDER BY sort_order ASC, id ASC", [versionId]);
  const options = rows.map(toOption);
  const lineItems = new Map<number, QuoteOptionLineItem[]>();
  for (const option of options) {
    const lines = await query<QuoteOptionLineItem>("SELECT * FROM quote_option_line_items WHERE quote_option_id = ? ORDER BY sort_order ASC, id ASC", [option.id]);
    lineItems.set(option.id, lines);
  }
  return { options, lineItems };
}

export async function getOption(organizationId: number, quoteId: number, optionId: number): Promise<{ option: QuoteOption; lineItems: QuoteOptionLineItem[] } | null> {
  const quote = await assertQuoteInOrganization(organizationId, quoteId);
  const row = await getOptionRow(optionId);
  if (!row || row.quote_version_id !== quote.current_version_id) return null;
  const lineItems = await query<QuoteOptionLineItem>("SELECT * FROM quote_option_line_items WHERE quote_option_id = ? ORDER BY sort_order ASC, id ASC", [optionId]);
  return { option: toOption(row), lineItems };
}

/** Unsets any prior recommended option on this version before setting a
 *  new one — enforces "exactly one recommended option per version"
 *  (Section 11) at the application layer, sequential-write (not a single
 *  transaction — matches this codebase's established convention for
 *  ordinary multi-row writes, same residual-crash-window class already
 *  accepted elsewhere). */
async function clearRecommended(versionId: number, exceptOptionId?: number): Promise<void> {
  await run(
    exceptOptionId
      ? "UPDATE quote_options SET recommended = 0 WHERE quote_version_id = ? AND id != ?"
      : "UPDATE quote_options SET recommended = 0 WHERE quote_version_id = ?",
    exceptOptionId ? [versionId, exceptOptionId] : [versionId]
  );
}

export async function createOption(organizationId: number, actorUserId: number | null, quoteId: number, input: QuoteOptionInput): Promise<QuoteOption> {
  const { versionId } = await assertDraftQuoteAndVersion(organizationId, quoteId);
  // Architecture-review finding: a quote_version's own top-level
  // quote_line_items and its quote_options are meant to be mutually
  // exclusive (Good/Better/Best REPLACES the plain line-item editor for
  // that version, it doesn't coexist with it) — previously this was only
  // a UI-routing convention, not enforced, so a quote built the ordinary
  // way and later given an Option would have its hand-entered lines
  // silently deleted the moment an option was selected
  // (applySelectionToVersion's unconditional DELETE). Enforced here, on
  // the FIRST option only: once at least one option exists, this check is
  // moot (there's nothing ambiguous left to protect against).
  const existingLineItems = await get<{ n: number }>("SELECT COUNT(*) as n FROM quote_line_items WHERE quote_version_id = ?", [versionId]);
  if (existingLineItems?.n) {
    throw new QuoteOptionError("invalid_input", "This quote already has line items — remove them before adding Good/Better/Best options (the two are mutually exclusive for the same version)");
  }
  const tier = normalizeTier(input.tier);
  const discountType = DISCOUNT_TYPES.includes((input.discount_type ?? "none") as DiscountType) ? (input.discount_type as DiscountType) ?? "none" : "none";
  const countRow = await get<{ n: number }>("SELECT COUNT(*) as n FROM quote_options WHERE quote_version_id = ?", [versionId]);
  const sortOrder = input.sort_order ?? (countRow?.n ?? 0);

  if (input.recommended) await clearRecommended(versionId);

  const result = await run(
    `INSERT INTO quote_options (quote_version_id, tier, name, headline, description, internal_notes, sort_order, recommended, discount_type, discount_percent, discount_cents, highlights)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [versionId, tier, input.name ?? "", input.headline ?? "", input.description ?? "", input.internal_notes ?? "",
     sortOrder, input.recommended ? 1 : 0, discountType, input.discount_percent ?? 0, input.discount_cents ?? 0,
     JSON.stringify(normalizeHighlights(input.highlights))]
  );
  const optionId = Number(result.lastInsertRowid);
  await recomputeAndStoreOptionTotals(organizationId, optionId);
  await recordOptionAudit(optionId, "created", actorUserId, { tier, name: input.name ?? "" });
  return (await getOptionRow(optionId).then((r) => toOption(r!)));
}

export async function updateOption(organizationId: number, actorUserId: number | null, quoteId: number, optionId: number, input: QuoteOptionInput): Promise<QuoteOption> {
  const { versionId } = await assertDraftQuoteAndVersion(organizationId, quoteId);
  const existing = await assertOptionBelongsToVersion(optionId, versionId);

  const fields: string[] = [];
  const vals: unknown[] = [];
  const setIfPresent = (col: string, value: unknown) => { fields.push(`${col} = ?`); vals.push(value); };
  if (input.tier !== undefined) setIfPresent("tier", normalizeTier(input.tier));
  if (input.name !== undefined) setIfPresent("name", input.name);
  if (input.headline !== undefined) setIfPresent("headline", input.headline);
  if (input.description !== undefined) setIfPresent("description", input.description);
  if (input.internal_notes !== undefined) setIfPresent("internal_notes", input.internal_notes);
  if (input.sort_order !== undefined) setIfPresent("sort_order", input.sort_order);
  if (input.highlights !== undefined) setIfPresent("highlights", JSON.stringify(normalizeHighlights(input.highlights)));
  if (input.discount_type !== undefined) setIfPresent("discount_type", DISCOUNT_TYPES.includes(input.discount_type as DiscountType) ? input.discount_type : "none");
  if (input.discount_percent !== undefined) setIfPresent("discount_percent", input.discount_percent);
  if (input.discount_cents !== undefined) setIfPresent("discount_cents", input.discount_cents);

  if (input.recommended !== undefined) {
    if (input.recommended) await clearRecommended(versionId, optionId);
    setIfPresent("recommended", input.recommended ? 1 : 0);
  }

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    await run(`UPDATE quote_options SET ${fields.join(", ")} WHERE id = ?`, [...vals, optionId]);
  }
  if (input.recommended !== undefined && input.recommended !== !!existing.recommended) {
    await recordOptionAudit(optionId, "recommended_changed", actorUserId, { recommended: input.recommended });
  }
  return recomputeAndStoreOptionTotals(organizationId, optionId);
}

export async function deleteOption(organizationId: number, quoteId: number, optionId: number): Promise<void> {
  const { versionId } = await assertDraftQuoteAndVersion(organizationId, quoteId);
  await assertOptionBelongsToVersion(optionId, versionId);
  await run("DELETE FROM quote_options WHERE id = ?", [optionId]);
}

/** Section 29 — duplicates an option (with all its line items) as an
 *  efficient starting point for the next tier ("duplicate GOOD -> BETTER").
 *  `overrideTier` lets the caller relabel the copy in the same call;
 *  `recommended` is always reset to false on the copy (never silently
 *  create a second recommended option). */
export async function duplicateOption(organizationId: number, actorUserId: number | null, quoteId: number, optionId: number, overrideTier?: string): Promise<QuoteOption> {
  const { versionId } = await assertDraftQuoteAndVersion(organizationId, quoteId);
  const source = await assertOptionBelongsToVersion(optionId, versionId);
  const sourceOption = toOption(source);
  const countRow = await get<{ n: number }>("SELECT COUNT(*) as n FROM quote_options WHERE quote_version_id = ?", [versionId]);

  const result = await run(
    `INSERT INTO quote_options (quote_version_id, tier, name, headline, description, internal_notes, sort_order, recommended, discount_type, discount_percent, discount_cents, highlights)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [versionId, normalizeTier(overrideTier, sourceOption.tier), sourceOption.name, sourceOption.headline, sourceOption.description,
     sourceOption.internal_notes, countRow?.n ?? 0, sourceOption.discount_type, sourceOption.discount_percent, sourceOption.discount_cents,
     JSON.stringify(sourceOption.highlights)]
  );
  const newOptionId = Number(result.lastInsertRowid);

  const sourceLines = await query<QuoteOptionLineItem>("SELECT * FROM quote_option_line_items WHERE quote_option_id = ? ORDER BY sort_order ASC, id ASC", [optionId]);
  for (const line of sourceLines) {
    await run(
      `INSERT INTO quote_option_line_items (quote_option_id, description, category, quantity, unit, unit_price_cents, cost_cents, total_cents, sort_order, asset_id, taxable, pricebook_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newOptionId, line.description, line.category, line.quantity, line.unit, line.unit_price_cents, line.cost_cents,
       line.total_cents, line.sort_order, line.asset_id, line.taxable, line.pricebook_item_id]
    );
  }
  await recomputeAndStoreOptionTotals(organizationId, newOptionId);
  await recordOptionAudit(newOptionId, "duplicated", actorUserId, { source_option_id: optionId });
  return (await getOptionRow(newOptionId).then((r) => toOption(r!)));
}

/** Section 30 — deterministic presentation order, never left to DB
 *  insertion accident. Every id in `orderedOptionIds` must belong to the
 *  quote's current draft version; unknown ids are ignored rather than
 *  throwing (defensive against a stale client-side list). */
export async function reorderOptions(organizationId: number, quoteId: number, orderedOptionIds: number[]): Promise<void> {
  const { versionId } = await assertDraftQuoteAndVersion(organizationId, quoteId);
  const existing = await query<{ id: number }>("SELECT id FROM quote_options WHERE quote_version_id = ?", [versionId]);
  const validIds = new Set(existing.map((r) => r.id));
  let index = 0;
  for (const id of orderedOptionIds) {
    if (!validIds.has(id)) continue;
    await run("UPDATE quote_options SET sort_order = ?, updated_at = datetime('now') WHERE id = ?", [index, id]);
    index++;
  }
}

// ── Option totals (mirrors quotes.ts#recomputeAndStoreVersionTotals) ────

/** Same CAS-retry discipline as quotes.ts's own version-totals recompute
 *  (Section 50 — "staff revises while customer page open" concurrency).
 *  Also (re)writes this option's tax snapshot (documentType 'quote_option')
 *  — a later organization Tax Profile change never rewrites an
 *  already-computed option's numbers, exactly like a Quote Version's own
 *  snapshot (Section 20). */
export async function recomputeAndStoreOptionTotals(organizationId: number, optionId: number): Promise<QuoteOption> {
  const profile = await resolveTaxProfile(organizationId);
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const option = await get<QuoteOptionRow>("SELECT * FROM quote_options WHERE id = ?", [optionId]);
    if (!option) throw new QuoteOptionError("not_found", "Option not found");
    const lines = await query<{ quantity: number; unit_price_cents: number; taxable: number }>(
      "SELECT quantity, unit_price_cents, taxable FROM quote_option_line_items WHERE quote_option_id = ?", [optionId]
    );
    const totals = computeQuoteTotals(
      lines.map((l) => ({ quantity: l.quantity, unit_price_cents: l.unit_price_cents, taxable: !!l.taxable })),
      option.discount_type, option.discount_percent, option.discount_cents, profile
    );
    const priceChanged = totals.subtotalCents !== option.subtotal_cents || totals.totalCents !== option.total_cents;
    const result = await run(
      `UPDATE quote_options SET subtotal_cents = ?, discount_cents = ?, tax_rate = ?, tax_amount_cents = ?, total_cents = ?, updated_at = datetime('now'), row_version = row_version + 1
       WHERE id = ? AND row_version = ?`,
      [totals.subtotalCents, totals.discountCents, totals.effectiveTaxRatePercent, totals.taxAmountCents, totals.totalCents, optionId, option.row_version]
    );
    if (result.changes > 0) {
      const company = await getCompanyProfile(organizationId);
      await createTaxSnapshot({
        documentType: "quote_option", documentId: optionId, profile,
        calc: { taxableBaseCents: totals.taxableBaseCents, totalTaxCents: totals.taxAmountCents, components: totals.taxComponents },
        businessNumber: company.business_number, taxNumber: company.tax_number,
      });
      if (priceChanged) await recordOptionAudit(optionId, "price_changed", null, { subtotal_cents: totals.subtotalCents, total_cents: totals.totalCents });
      return toOption((await getOptionRow(optionId))!);
    }
  }
  throw new QuoteOptionError("conflict", "This option's totals could not be updated due to concurrent changes — please retry");
}

// ── Option line items (mirrors quotes.ts#insertLineItem/updateLineItem) ─

async function assertAssetBelongsToCustomer(organizationId: number, customerId: number, assetId: number): Promise<void> {
  const row = await get<{ id: number }>("SELECT id FROM assets WHERE id = ? AND organization_id = ? AND customer_id = ?", [assetId, organizationId, customerId]);
  if (!row) throw new QuoteOptionError("invalid_asset", "This asset does not belong to the quote's customer");
}

/** Snapshots cost_cents ONLY when the line is Pricebook-sourced AND the
 *  acting role has cost access (Section 16) — a dispatcher-created
 *  Pricebook line never has cost_cents populated in the first place, the
 *  same "never had it to leak" discipline as Phase 17's stripCost(). */
async function resolveLineSnapshot(organizationId: number, actorRole: Role, pricebookItemId: number | null | undefined): Promise<{ description?: string; unit?: string; unit_price_cents?: number; taxable?: boolean; cost_cents: number | null } | null> {
  if (pricebookItemId === undefined || pricebookItemId === null) return null;
  const item = await getPricebookItem(organizationId, pricebookItemId);
  if (!item) throw new QuoteOptionError("invalid_pricebook_item", "Pricebook item not found");
  return {
    description: item.name, unit: item.unit, unit_price_cents: item.sell_price_cents, taxable: item.taxable,
    cost_cents: canViewOptionCost(actorRole) ? item.cost_cents : null,
  };
}

function normalizeOptionLineItem(input: QuoteOptionLineItemInput, sortOrder: number, defaultTaxable: boolean, snapshot: { description?: string; unit?: string; unit_price_cents?: number; taxable?: boolean; cost_cents: number | null } | null) {
  const category = LINE_ITEM_CATEGORIES.includes((input.category ?? "other") as LineItemCategory) ? (input.category as LineItemCategory) ?? "other" : "other";
  return {
    description: input.description ?? snapshot?.description ?? "",
    category,
    quantity: input.quantity ?? 1,
    unit: input.unit ?? snapshot?.unit ?? "",
    unit_price_cents: input.unit_price_cents ?? snapshot?.unit_price_cents ?? 0,
    cost_cents: snapshot?.cost_cents ?? null,
    sort_order: input.sort_order ?? sortOrder,
    asset_id: input.asset_id ?? null,
    taxable: input.taxable ?? snapshot?.taxable ?? defaultTaxable,
    pricebook_item_id: input.pricebook_item_id ?? null,
  };
}

export async function addOptionLineItem(organizationId: number, actorRole: Role, quoteId: number, optionId: number, input: QuoteOptionLineItemInput): Promise<QuoteOption> {
  const { quote, versionId } = await assertDraftQuoteAndVersion(organizationId, quoteId);
  await assertOptionBelongsToVersion(optionId, versionId);
  if (input.asset_id !== undefined && input.asset_id !== null) {
    await assertAssetBelongsToCustomer(organizationId, quote.customer_id, input.asset_id);
  }
  const snapshot = await resolveLineSnapshot(organizationId, actorRole, input.pricebook_item_id);
  const profile = await resolveTaxProfile(organizationId);
  const countRow = await get<{ n: number }>("SELECT COUNT(*) as n FROM quote_option_line_items WHERE quote_option_id = ?", [optionId]);
  const normalized = normalizeOptionLineItem(input, countRow?.n ?? 0, profile?.default_taxable ?? true, snapshot);
  const totalCents = Math.round(normalized.quantity * normalized.unit_price_cents);
  await run(
    `INSERT INTO quote_option_line_items (quote_option_id, description, category, quantity, unit, unit_price_cents, cost_cents, total_cents, sort_order, asset_id, taxable, pricebook_item_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [optionId, normalized.description, normalized.category, normalized.quantity, normalized.unit, normalized.unit_price_cents,
     normalized.cost_cents, totalCents, normalized.sort_order, normalized.asset_id, normalized.taxable ? 1 : 0, normalized.pricebook_item_id]
  );
  return recomputeAndStoreOptionTotals(organizationId, optionId);
}

export async function updateOptionLineItem(organizationId: number, actorRole: Role, quoteId: number, optionId: number, lineItemId: number, input: QuoteOptionLineItemInput): Promise<QuoteOption> {
  const { quote, versionId } = await assertDraftQuoteAndVersion(organizationId, quoteId);
  await assertOptionBelongsToVersion(optionId, versionId);
  const existing = await get<QuoteOptionLineItem>("SELECT * FROM quote_option_line_items WHERE id = ? AND quote_option_id = ?", [lineItemId, optionId]);
  if (!existing) throw new QuoteOptionError("not_found", "Line item not found");

  if (input.asset_id !== undefined && input.asset_id !== null) {
    await assertAssetBelongsToCustomer(organizationId, quote.customer_id, input.asset_id);
  }
  // Same "update does not re-snapshot from the live Pricebook item"
  // discipline as quotes.ts's own updateLineItem — only validates the
  // referenced id still resolves, never overwrites description/price/cost
  // that may have been hand-edited since insert.
  if (input.pricebook_item_id !== undefined && input.pricebook_item_id !== null) {
    const item = await getPricebookItem(organizationId, input.pricebook_item_id);
    if (!item) throw new QuoteOptionError("invalid_pricebook_item", "Pricebook item not found");
  }

  const fields: string[] = [];
  const vals: unknown[] = [];
  const setIfPresent = (col: string, value: unknown) => { fields.push(`${col} = ?`); vals.push(value); };
  if (input.category !== undefined) setIfPresent("category", LINE_ITEM_CATEGORIES.includes(input.category as LineItemCategory) ? input.category : "other");
  if (input.description !== undefined) setIfPresent("description", input.description);
  if (input.quantity !== undefined) setIfPresent("quantity", input.quantity);
  if (input.unit !== undefined) setIfPresent("unit", input.unit);
  if (input.unit_price_cents !== undefined) setIfPresent("unit_price_cents", input.unit_price_cents);
  if (input.sort_order !== undefined) setIfPresent("sort_order", input.sort_order);
  if (input.asset_id !== undefined) setIfPresent("asset_id", input.asset_id);
  if (input.pricebook_item_id !== undefined) setIfPresent("pricebook_item_id", input.pricebook_item_id);
  if (input.taxable !== undefined) setIfPresent("taxable", input.taxable ? 1 : 0);

  const newQuantity = input.quantity ?? existing.quantity;
  const newUnitPrice = input.unit_price_cents ?? existing.unit_price_cents;
  fields.push("total_cents = ?");
  vals.push(Math.round(newQuantity * newUnitPrice));

  await run(`UPDATE quote_option_line_items SET ${fields.join(", ")} WHERE id = ?`, [...vals, lineItemId]);
  return recomputeAndStoreOptionTotals(organizationId, optionId);
}

export async function deleteOptionLineItem(organizationId: number, quoteId: number, optionId: number, lineItemId: number): Promise<QuoteOption> {
  const { versionId } = await assertDraftQuoteAndVersion(organizationId, quoteId);
  await assertOptionBelongsToVersion(optionId, versionId);
  await run("DELETE FROM quote_option_line_items WHERE id = ? AND quote_option_id = ?", [lineItemId, optionId]);
  return recomputeAndStoreOptionTotals(organizationId, optionId);
}

// ── Public share/selection flow (mirrors contracts.ts's signing flow) ──

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 256 bits of randomness, returned to the caller exactly once — same
 *  discipline as contracts.ts's own signing-token generation (which this
 *  intentionally duplicates rather than imports: it is module-private
 *  there, and this codebase's established convention is a small per-module
 *  duplicate over new shared infrastructure for a helper this size — see
 *  e.g. every module's own likePattern()). */
function generateShareToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

const SHARE_LINK_EXPIRY_DAYS = 30;

export interface QuoteShareLink {
  id: number; quote_id: number; quote_version_id: number; status: string; expires_at: string;
  selected_option_id: number | null; selected_at: string | null; selector_name: string;
  created_by: number | null; created_at: string; updated_at: string;
}
const SHARE_LINK_COLUMNS = "id, quote_id, quote_version_id, status, expires_at, selected_option_id, selected_at, selector_name, created_by, created_at, updated_at";

/** Section 23 — generates (or, if the quote is still draft, first sends)
 *  a public share link for the quote's CURRENT version. Requires at least
 *  one option to exist (Section 61 — Section 22 wouldn't make sense on an
 *  empty estimate). Reuses the EXACT existing "sent" transition
 *  (transitionQuote) — a Good/Better/Best quote's lifecycle is not a
 *  parallel status machine. */
export async function generateShareLink(db: D1Database, organizationId: number, actorUserId: number, quoteId: number): Promise<{ link: QuoteShareLink; token: string }> {
  const quote = await assertQuoteInOrganization(organizationId, quoteId);
  if (quote.current_version_id === null) throw new QuoteOptionError("no_options", "This quote has no version yet");
  const optionCount = await get<{ n: number }>("SELECT COUNT(*) as n FROM quote_options WHERE quote_version_id = ?", [quote.current_version_id]);
  if (!optionCount?.n) throw new QuoteOptionError("no_options", "Add at least one option before sending this estimate");

  if (quote.status === "draft") {
    await transitionQuote(db, quoteId, { toStatus: "sent", actorUserId, organizationId, reason: "" });
  } else if (quote.status !== "sent") {
    throw new QuoteOptionError("not_sent", "Only a draft or already-sent quote can generate a share link");
  }

  // Architecture-review finding: cancel any OTHER still-live link for this
  // quote before issuing a new one — belt-and-suspenders alongside
  // commitSelection's own "quote must still be sent" gate (Security
  // finding, fixed above). Without this, calling "Send Estimate" twice (or
  // a double-click) could leave two independently-valid tokens for the
  // same quote; a customer using the older one after the newer one (or a
  // different customer/tab) already completed a selection would otherwise
  // still pass its OWN link's status check before commitSelection's
  // quote-status gate catches it. Closing the vector here means there is
  // normally only ever one live link at a time, not just one that "wins."
  await run(
    "UPDATE quote_share_links SET status = 'cancelled', updated_at = datetime('now') WHERE quote_id = ? AND status IN ('sent','viewed')",
    [quoteId]
  );

  const rawToken = generateShareToken();
  const tokenHash = await hashShareToken(rawToken);
  const expiresAt = new Date(Date.now() + SHARE_LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = await run(
    `INSERT INTO quote_share_links (quote_id, quote_version_id, status, token_hash, expires_at, created_by) VALUES (?, ?, 'sent', ?, ?, ?)`,
    [quoteId, quote.current_version_id, tokenHash, expiresAt, actorUserId]
  );
  const linkId = Number(result.lastInsertRowid);
  await run("INSERT INTO quote_share_events (share_link_id, event_type, metadata) VALUES (?, 'created', '{}')", [linkId]);
  const link = (await get<QuoteShareLink>(`SELECT ${SHARE_LINK_COLUMNS} FROM quote_share_links WHERE id = ?`, [linkId]))!;
  return { link, token: rawToken };
}

/** Section 29's "Resend" — same "cancel the old request, issue a fresh
 *  one with a NEW token" discipline as contracts.ts's own
 *  resendSignatureRequest (the old token is immediately unusable). */
export async function resendShareLink(organizationId: number, actorUserId: number, quoteId: number, linkId: number): Promise<{ link: QuoteShareLink; token: string }> {
  const quote = await assertQuoteInOrganization(organizationId, quoteId);
  const existing = await get<{ id: number; status: string; quote_version_id: number }>("SELECT id, status, quote_version_id FROM quote_share_links WHERE id = ? AND quote_id = ?", [linkId, quoteId]);
  if (!existing) throw new QuoteOptionError("not_found", "Share link not found");
  await run("UPDATE quote_share_links SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = ?", [existing.id, existing.status]);

  const rawToken = generateShareToken();
  const tokenHash = await hashShareToken(rawToken);
  const expiresAt = new Date(Date.now() + SHARE_LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = await run(
    `INSERT INTO quote_share_links (quote_id, quote_version_id, status, token_hash, expires_at, created_by) VALUES (?, ?, 'sent', ?, ?, ?)`,
    [quoteId, existing.quote_version_id, tokenHash, expiresAt, actorUserId]
  );
  const linkId2 = Number(result.lastInsertRowid);
  await run("INSERT INTO quote_share_events (share_link_id, event_type, metadata) VALUES (?, 'created', ?)", [linkId2, JSON.stringify({ resent_from: linkId })]);
  void quote;
  const link = (await get<QuoteShareLink>(`SELECT ${SHARE_LINK_COLUMNS} FROM quote_share_links WHERE id = ?`, [linkId2]))!;
  return { link, token: rawToken };
}

export async function listShareLinks(organizationId: number, quoteId: number): Promise<QuoteShareLink[]> {
  await assertQuoteInOrganization(organizationId, quoteId);
  return query<QuoteShareLink>(`SELECT ${SHARE_LINK_COLUMNS} FROM quote_share_links WHERE quote_id = ? ORDER BY created_at DESC`, [quoteId]);
}

/** Public-safe option shape — an explicit field-allowlist reconstruction
 *  (same discipline as `stripLineCost`/Phase 17's `stripCost()`), NOT a
 *  destructuring omit or reliance on the Zod response schema: this
 *  codebase's `c.json()` layer does not strip extra fields at runtime, it
 *  only documents/type-narrows for OpenAPI, so `internal_notes` (and any
 *  future admin-only option field) must be excluded HERE, in the data
 *  actually returned, or it leaks regardless of what the route's response
 *  schema claims to omit. */
export type PublicQuoteOption = Omit<QuoteOption, "internal_notes"> & { line_items: QuoteOptionLineItemPublicView[]; tax_breakdown: { components: TaxComponentResult[] } | null };
function toPublicOption(option: QuoteOption, lines: QuoteOptionLineItemPublicView[], taxBreakdown: { components: TaxComponentResult[] } | null): PublicQuoteOption {
  return {
    id: option.id, quote_version_id: option.quote_version_id, tier: option.tier, name: option.name,
    headline: option.headline, description: option.description, sort_order: option.sort_order,
    recommended: option.recommended, discount_type: option.discount_type, discount_percent: option.discount_percent,
    discount_cents: option.discount_cents, subtotal_cents: option.subtotal_cents, tax_rate: option.tax_rate,
    tax_amount_cents: option.tax_amount_cents, total_cents: option.total_cents, highlights: option.highlights,
    created_at: option.created_at, updated_at: option.updated_at, line_items: lines, tax_breakdown: taxBreakdown,
  };
}

export interface PublicQuoteView {
  quote_identifier: string;
  customer_name: string;
  status: string;
  expires_at: string;
  already_selected_option_id: number | null;
  options: PublicQuoteOption[];
}

/** THE sole entry point for resolving a raw share token — every failure
 *  mode (doesn't exist, wrong hash, expired, cancelled) returns `null`
 *  uniformly so the caller can give one generic "invalid or expired" 404,
 *  never distinguishing "wrong token" from "expired token" (no enumeration
 *  signal), matching contracts.ts's own getSignatureRequestByToken. Never
 *  exposes cost_cents/internal_notes anywhere in the returned view. */
export async function getPublicQuoteView(rawToken: string): Promise<PublicQuoteView | null> {
  const tokenHash = await hashShareToken(rawToken);
  const link = await get<QuoteShareLink & { organization_id: number }>(
    `SELECT l.*, q.organization_id as organization_id FROM quote_share_links l JOIN quotes q ON l.quote_id = q.id WHERE l.token_hash = ?`,
    [tokenHash]
  );
  if (!link) return null;
  if (new Date(link.expires_at) < new Date() && link.status !== "expired") {
    await run("UPDATE quote_share_links SET status = 'expired', updated_at = datetime('now') WHERE id = ? AND status != 'expired'", [link.id]);
    link.status = "expired";
  }
  if (link.status === "expired" || link.status === "cancelled") return null;

  if (link.status === "sent") {
    await run("UPDATE quote_share_links SET status = 'viewed', updated_at = datetime('now') WHERE id = ? AND status = 'sent'", [link.id]);
    await run("INSERT INTO quote_share_events (share_link_id, event_type, metadata) VALUES (?, 'viewed', '{}')", [link.id]);
  }

  const quote = await get<{ identifier: string; customer_id: number }>("SELECT identifier, customer_id FROM quotes WHERE id = ?", [link.quote_id]);
  const customer = await get<{ name: string }>("SELECT name FROM customers WHERE id = ?", [quote?.customer_id ?? -1]);
  const { options, lineItems } = await listOptionsForVersion(link.quote_version_id);

  const optionsView = await Promise.all(options.map(async (option) => {
    const lines = (lineItems.get(option.id) ?? []).map(stripLineCost);
    const taxSnapshot = await getTaxSnapshot("quote_option", option.id);
    return toPublicOption(option, lines, taxSnapshot ? { components: taxSnapshot.components } : null);
  }));

  return {
    quote_identifier: quote?.identifier ?? "",
    customer_name: customer?.name ?? "",
    status: link.status,
    expires_at: link.expires_at,
    already_selected_option_id: link.selected_option_id,
    options: optionsView,
  };
}

/** Section 39 — data for the staff-facing (authenticated, org-scoped)
 *  Estimate PDF preview/download. Deliberately reuses the SAME public-safe
 *  option projection (`toPublicOption`/`stripLineCost`) the customer's own
 *  comparison page and public PDF would see — the document a staff member
 *  downloads to send/print must never contain cost/margin/internal notes
 *  either (Section 39: "No internal cost/margin"), so there is no separate
 *  "admin variant" of this data to keep in sync. */
export async function getEstimatePdfData(organizationId: number, quoteId: number): Promise<{
  quoteIdentifier: string; status: string; expiresAt: string | null; customerId: number;
  options: Awaited<ReturnType<typeof toPublicOption>>[];
} | null> {
  const quote = await assertQuoteInOrganization(organizationId, quoteId).catch(() => null);
  if (!quote || quote.current_version_id === null) return null;
  const version = await get<{ expires_at: string | null; identifier: string }>(
    "SELECT expires_at FROM quote_versions WHERE id = ?", [quote.current_version_id]
  );
  const identifierRow = await get<{ identifier: string }>("SELECT identifier FROM quotes WHERE id = ?", [quoteId]);
  const { options, lineItems } = await listOptionsForVersion(quote.current_version_id);
  const optionsView = await Promise.all(options.map(async (option) => {
    const lines = (lineItems.get(option.id) ?? []).map(stripLineCost);
    return toPublicOption(option, lines, null);
  }));
  return {
    quoteIdentifier: identifierRow?.identifier ?? "",
    status: quote.status,
    expiresAt: version?.expires_at ?? null,
    customerId: quote.customer_id,
    options: optionsView,
  };
}

/** Section 22/23/25/49 — THE single atomic "customer chooses one" write.
 *  Idempotent: re-selecting the SAME option on an already-selected link is
 *  a safe no-op (returns success without re-running the copy/accept
 *  machinery); selecting a DIFFERENT option after one is already selected
 *  is rejected (Section 49 — "different option after accepted -> rejected
 *  or controlled revision", and this phase does not build a change-order
 *  flow, so it is rejected outright, matching Section 28's "do not
 *  silently edit accepted option"). `actorUserId=null` for the public
 *  (customer, token-only) path; a real id for the internal staff
 *  "record a phone-confirmed selection" path (Section 43/54). */
export async function commitSelection(
  db: D1Database, rawToken: string, optionId: number, selectorName: string, ip: string | null, userAgent: string | null
): Promise<{ quoteId: number }> {
  const tokenHash = await hashShareToken(rawToken);
  const link = await get<QuoteShareLink & { organization_id: number }>(
    `SELECT l.*, q.organization_id as organization_id FROM quote_share_links l JOIN quotes q ON l.quote_id = q.id WHERE l.token_hash = ?`,
    [tokenHash]
  );
  if (!link) throw new QuoteOptionError("invalid_token", "This link is invalid or has expired");
  if (new Date(link.expires_at) < new Date()) throw new QuoteOptionError("invalid_token", "This link is invalid or has expired");
  if (link.status === "cancelled" || link.status === "expired") throw new QuoteOptionError("invalid_token", "This link is invalid or has expired");

  const option = await getOptionRow(optionId);
  if (!option || option.quote_version_id !== link.quote_version_id) throw new QuoteOptionError("not_found", "Option not found on this estimate");

  if (link.status === "selected") {
    if (link.selected_option_id === optionId) return { quoteId: link.quote_id }; // idempotent no-op
    throw new QuoteOptionError("already_selected", "A different option has already been selected for this estimate");
  }

  const claim = await run(
    "UPDATE quote_share_links SET status = 'selected', selected_option_id = ?, selected_at = datetime('now'), selector_name = ?, selector_ip = ?, selector_user_agent = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('sent','viewed')",
    [optionId, selectorName.slice(0, 200), ip, userAgent, link.id]
  );
  if (claim.changes === 0) {
    // Lost a race against another concurrent selection request for this
    // same link (Section 50) — re-read and resolve idempotently rather
    // than surfacing a spurious error for what may just be a double-click.
    const fresh = await get<{ status: string; selected_option_id: number | null }>("SELECT status, selected_option_id FROM quote_share_links WHERE id = ?", [link.id]);
    if (fresh?.status === "selected" && fresh.selected_option_id === optionId) return { quoteId: link.quote_id };
    throw new QuoteOptionError("conflict", "This estimate was already responded to");
  }

  await run(
    "INSERT INTO quote_share_events (share_link_id, event_type, ip_address, user_agent, metadata) VALUES (?, 'selected', ?, ?, ?)",
    [link.id, ip, userAgent, JSON.stringify({ option_id: optionId, selector_name: selectorName })]
  );

  // Security-review finding: `commitSelection` used to check only the
  // SHARE LINK's own status, never the underlying QUOTE's — if staff
  // generated two live links for the same quote (e.g. "Send" clicked
  // twice, or a resend that didn't get cancelled in time), a second
  // customer/browser tab holding the OTHER link could win its own claim
  // above (that link's status genuinely was still 'sent') and then
  // unconditionally overwrite `quote_line_items` with a DIFFERENT
  // option's content via `applySelectionToVersion` — even though the
  // quote had already been accepted (with a different option) through the
  // first link moments earlier. `transitionQuote` below would eventually
  // reject the resulting "accepted -> accepted" transition, but only
  // AFTER the corrupting write already happened, and as an uncaught
  // QuoteWorkflowError (not a QuoteOptionError the route catches) — an
  // unhandled 500 on top of the corruption. Checked HERE, immediately
  // before the mutating write, mirrors staffSelectOption's own existing
  // "quote must still be sent" guard — the authoritative gate sits right
  // next to the write it protects, not just at entry.
  const currentQuote = await get<{ status: string }>("SELECT status FROM quotes WHERE id = ?", [link.quote_id]);
  if (currentQuote?.status !== "sent") {
    throw new QuoteOptionError("already_selected", "This estimate has already been responded to");
  }

  await applySelectionToVersion(link.organization_id, link.quote_id, link.quote_version_id, optionId);
  await transitionQuote(db, link.quote_id, { toStatus: "accepted", actorUserId: null, organizationId: link.organization_id, acceptedOptionId: optionId });
  return { quoteId: link.quote_id };
}

/** Internal staff variant of the same selection commit (Section 43/54 —
 *  "record a phone/in-person confirmed selection"), gated by the caller's
 *  own RBAC check (canManageQuotes) before this is ever reached. Bypasses
 *  the share-link/token machinery entirely — there may be no link at all
 *  if staff never sent one. */
export async function staffSelectOption(db: D1Database, organizationId: number, actorUserId: number, quoteId: number, optionId: number): Promise<void> {
  const quote = await assertQuoteInOrganization(organizationId, quoteId);
  if (quote.status !== "sent") throw new QuoteOptionError("not_sent", "Only a sent quote can have an option selected");
  if (quote.current_version_id === null) throw new QuoteOptionError("not_found", "Quote has no current version");
  const option = await getOptionRow(optionId);
  if (!option || option.quote_version_id !== quote.current_version_id) throw new QuoteOptionError("not_found", "Option not found on this estimate");

  await applySelectionToVersion(organizationId, quoteId, quote.current_version_id, optionId);
  await transitionQuote(db, quoteId, { toStatus: "accepted", actorUserId, organizationId, acceptedOptionId: optionId });
}

/** Section 25 — THE copy that makes the selected option "the authoritative
 *  commercial basis." Copies the option's line items into the quote
 *  VERSION's own `quote_line_items` (deleting whatever was there first —
 *  always empty for a genuine Good/Better/Best quote, since its UI never
 *  routes through the plain add/update/delete line-item endpoints once
 *  options exist) and recomputes+stores the version's totals from them via
 *  the EXISTING, already-hardened `recomputeAndStoreVersionTotals`. After
 *  this, `contracts.ts`'s `createContract`/`buildCommercialSnapshot` (which
 *  already read `quote_line_items WHERE quote_version_id = ...` and
 *  `quote_versions`' stored totals) require ZERO changes — they correctly
 *  see ONLY the selected option's content. The option rows themselves
 *  (`quote_options`/`quote_option_line_items`) are never modified by this
 *  — the historical Estimate stays exactly as presented (Section 25's
 *  "historical Estimate remains unchanged"). */
async function applySelectionToVersion(organizationId: number, quoteId: number, versionId: number, optionId: number): Promise<void> {
  void quoteId;
  const lines = await query<QuoteOptionLineItem>("SELECT * FROM quote_option_line_items WHERE quote_option_id = ? ORDER BY sort_order ASC, id ASC", [optionId]);
  await run("DELETE FROM quote_line_items WHERE quote_version_id = ?", [versionId]);
  for (const line of lines) {
    await run(
      `INSERT INTO quote_line_items (quote_version_id, description, category, quantity, unit, unit_price_cents, total_cents, sort_order, asset_id, taxable, pricebook_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [versionId, line.description, line.category, line.quantity, line.unit, line.unit_price_cents, line.total_cents, line.sort_order, line.asset_id, line.taxable, line.pricebook_item_id]
    );
  }
  const option = await getOptionRow(optionId);
  await run(
    "UPDATE quote_versions SET discount_type = ?, discount_percent = ?, discount_cents = ? WHERE id = ?",
    [option!.discount_type, option!.discount_percent, option!.discount_cents, versionId]
  );
  await recomputeAndStoreVersionTotals(organizationId, versionId);
}
