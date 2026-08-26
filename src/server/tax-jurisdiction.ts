import { get, query, run } from "./db.js";

/** Phase 13D — Tax & Jurisdiction Settings.
 *
 *  This module is the ONE authoritative place tax is resolved and
 *  calculated. Quote (quotes.ts), Invoice (financial.ts), and Contract
 *  (contracts.ts, via the Quote Version it snapshots) all route through
 *  `resolveTaxProfile()` + `calculateTaxes()` + `createTaxSnapshot()` —
 *  never their own copy of the arithmetic. This is deliberate: Section 20
 *  of the phase spec requires Quote and Invoice to never calculate
 *  identical rules differently.
 *
 *  This is NOT a tax/legal compliance engine. Canadian province presets
 *  (CA_PROVINCES / CA_PRESETS below) are editable starting points an admin
 *  may apply, adjust, or ignore — the admin's own saved Tax Profile is the
 *  only authoritative configuration. Nothing here certifies correctness for
 *  any real jurisdiction. */

export class TaxJurisdictionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TaxJurisdictionError";
    this.code = code;
  }
}

export interface TaxComponentInput {
  code: string;
  name: string;
  rate_percent: number;
}

export interface TaxComponent extends TaxComponentInput {
  id: number;
}

export interface TaxProfile {
  id: number;
  organization_id: number;
  tax_enabled: boolean;
  country_code: string;
  region_code: string;
  currency: string;
  prices_include_tax: boolean;
  default_taxable: boolean;
  effective_from: string;
  effective_until: string | null;
  created_by: number | null;
  created_at: string;
  components: TaxComponent[];
}

interface TaxProfileRow {
  id: number;
  organization_id: number;
  tax_enabled: number;
  country_code: string;
  region_code: string;
  currency: string;
  prices_include_tax: number;
  default_taxable: number;
  effective_from: string;
  effective_until: string | null;
  created_by: number | null;
  created_at: string;
}

interface TaxProfileComponentRow {
  id: number;
  tax_profile_id: number;
  code: string;
  name: string;
  rate_percent: number;
  sort_order: number;
}

async function attachComponents(row: TaxProfileRow): Promise<TaxProfile> {
  const components = await query<TaxProfileComponentRow>(
    "SELECT * FROM tax_profile_components WHERE tax_profile_id = ? ORDER BY sort_order ASC, id ASC", [row.id]
  );
  return {
    id: row.id,
    organization_id: row.organization_id,
    tax_enabled: !!row.tax_enabled,
    country_code: row.country_code,
    region_code: row.region_code,
    currency: row.currency,
    prices_include_tax: !!row.prices_include_tax,
    default_taxable: !!row.default_taxable,
    effective_from: row.effective_from,
    effective_until: row.effective_until,
    created_by: row.created_by,
    created_at: row.created_at,
    components: components.map((c) => ({ id: c.id, code: c.code, name: c.name, rate_percent: c.rate_percent })),
  };
}

/** The Tax Profile version in effect at `asOf` (defaults to now) — same
 *  effective-dated resolution shape as settings.ts#getSettingRow. Returns
 *  null if the organization has never configured one, which is always the
 *  safe "tax disabled" case (see calculateTaxes). */
export async function resolveTaxProfile(organizationId: number, asOf?: string): Promise<TaxProfile | null> {
  const at = asOf ?? new Date().toISOString();
  const row = await get<TaxProfileRow>(
    `SELECT * FROM tax_profiles
     WHERE organization_id = ? AND effective_from <= ?
       AND (effective_until IS NULL OR effective_until > ?)
     ORDER BY effective_from DESC LIMIT 1`,
    [organizationId, at, at]
  );
  return row ? attachComponents(row) : null;
}

export async function getTaxProfileHistory(organizationId: number): Promise<TaxProfile[]> {
  const rows = await query<TaxProfileRow>(
    "SELECT * FROM tax_profiles WHERE organization_id = ? ORDER BY effective_from DESC", [organizationId]
  );
  return Promise.all(rows.map(attachComponents));
}

const RATE_MIN = 0;
const RATE_MAX = 100;

export function validateTaxProfileInput(input: {
  tax_enabled: boolean;
  country_code: string;
  region_code: string;
  currency: string;
  prices_include_tax: boolean;
  default_taxable: boolean;
  components: TaxComponentInput[];
}): void {
  if (input.tax_enabled) {
    if (!input.country_code.trim()) throw new TaxJurisdictionError("invalid_country", "Country is required when tax is enabled");
    if (!input.currency.trim()) throw new TaxJurisdictionError("invalid_currency", "Currency is required when tax is enabled");
  }
  if (input.components.length > 20) throw new TaxJurisdictionError("too_many_components", "A tax profile may have at most 20 components");
  const seenCodes = new Set<string>();
  for (const comp of input.components) {
    const code = comp.code.trim().toUpperCase();
    if (!code) throw new TaxJurisdictionError("invalid_component", "Every tax component needs a code (e.g. GST, PST, HST)");
    if (!comp.name.trim()) throw new TaxJurisdictionError("invalid_component", `Tax component "${code}" needs a display name`);
    if (seenCodes.has(code)) throw new TaxJurisdictionError("duplicate_component", `Duplicate tax component code: ${code}`);
    seenCodes.add(code);
    if (!Number.isFinite(comp.rate_percent) || comp.rate_percent < RATE_MIN || comp.rate_percent > RATE_MAX) {
      throw new TaxJurisdictionError("invalid_rate", `Tax component "${code}" rate must be between ${RATE_MIN} and ${RATE_MAX}`);
    }
  }
}

export interface SaveTaxProfileInput {
  organizationId: number;
  tax_enabled: boolean;
  country_code: string;
  region_code: string;
  currency: string;
  prices_include_tax: boolean;
  default_taxable: boolean;
  components: TaxComponentInput[];
  effectiveFrom?: string;
  actorId: number;
}

/** Publishes a new Tax Profile version — never edits an existing one in
 *  place (same non-destructive-versioning discipline as
 *  settings.ts#publishSetting): closes the currently-open version's
 *  `effective_until` at the new version's start, then inserts a fresh
 *  profile + component rows. Every tax_snapshots row already written keeps
 *  pointing at the OLD (still fully intact) tax_profiles row, so existing
 *  Quotes/Invoices are structurally unaffected by this call. */
export async function saveTaxProfile(input: SaveTaxProfileInput): Promise<TaxProfile> {
  validateTaxProfileInput(input);
  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();
  const latest = await get<TaxProfileRow>(
    "SELECT * FROM tax_profiles WHERE organization_id = ? ORDER BY effective_from DESC LIMIT 1",
    [input.organizationId]
  );
  if (latest && effectiveFrom <= latest.effective_from) {
    throw new TaxJurisdictionError("invalid_effective_date", `New version must be effective after the current one (${latest.effective_from})`);
  }
  if (latest && latest.effective_until === null) {
    await run("UPDATE tax_profiles SET effective_until = ? WHERE id = ?", [effectiveFrom, latest.id]);
  }
  const result = await run(
    `INSERT INTO tax_profiles (organization_id, tax_enabled, country_code, region_code, currency, prices_include_tax, default_taxable, effective_from, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.organizationId, input.tax_enabled ? 1 : 0, input.country_code.trim(), input.region_code.trim(),
      input.currency.trim() || "CAD", input.prices_include_tax ? 1 : 0, input.default_taxable ? 1 : 0,
      effectiveFrom, input.actorId,
    ]
  );
  const profileId = Number(result.lastInsertRowid);
  let sortOrder = 0;
  for (const comp of input.components) {
    await run(
      "INSERT INTO tax_profile_components (tax_profile_id, code, name, rate_percent, sort_order) VALUES (?, ?, ?, ?, ?)",
      [profileId, comp.code.trim().toUpperCase(), comp.name.trim(), comp.rate_percent, sortOrder++]
    );
  }
  const row = await get<TaxProfileRow>("SELECT * FROM tax_profiles WHERE id = ?", [profileId]);
  return attachComponents(row!);
}

// ── Calculation (Section 20) ────────────────────────────────────────────

export interface TaxableLine {
  amountCents: number; // this line's already-computed total (quantity * unit price), before tax
  taxable: boolean;
}

export interface TaxComponentResult {
  code: string;
  name: string;
  rate_percent: number;
  amount_cents: number;
}

export interface TaxCalculationResult {
  taxableBaseCents: number;
  nonTaxableCents: number;
  components: TaxComponentResult[];
  totalTaxCents: number;
  subtotalCents: number; // sum of all lines, net of tax (never includes embedded tax)
  totalCents: number; // subtotal + totalTax
}

/** The one place tax arithmetic happens. `lines` are pre-tax-decision line
 *  amounts (already quantity * unit price, rounded to the cent — matching
 *  every existing line-total convention in this codebase). `profile: null`
 *  means "no Tax Profile configured for this organization" — treated
 *  identically to `tax_enabled: false` (Section 6: always the safe zero).
 *
 *  Exclusive pricing (prices_include_tax = false): each line amount is
 *  already tax-free. Tax is computed on top of the taxable lines' sum and
 *  added to reach the total.
 *
 *  Inclusive pricing (prices_include_tax = true): each line amount already
 *  has tax embedded. The taxable lines' sum is treated as a tax-inclusive
 *  gross figure; the net (pre-tax) base is extracted by dividing out the
 *  combined component rate, and the resulting tax is allocated back across
 *  components proportional to each component's share of the combined rate.
 *  `subtotalCents`/`totalCents` in the inclusive case reflect the EXTRACTED
 *  net subtotal and the ORIGINAL gross total respectively — the total never
 *  changes as a side effect of tax being embedded vs. added on top; only
 *  how it's split into subtotal/tax changes. This is what "never double-tax"
 *  means here: an inclusive line's total_cents is never increased by tax a
 *  second time.
 *
 *  Rounding: the combined tax amount for the taxable base is computed once
 *  (Math.round), then allocated across components by rate share, each
 *  rounded down to the cent, with any leftover cent(s) from rounding
 *  assigned to the LAST component — guaranteeing sum(component amounts) is
 *  always exactly totalTaxCents, never off by a cent from split-then-round
 *  drift. A single-component profile has no allocation step at all (its
 *  amount IS totalTaxCents). */
export function calculateTaxes(profile: TaxProfile | null, lines: TaxableLine[]): TaxCalculationResult {
  const nonTaxableCents = lines.filter((l) => !l.taxable).reduce((sum, l) => sum + l.amountCents, 0);
  const taxableLinesCents = lines.filter((l) => l.taxable).reduce((sum, l) => sum + l.amountCents, 0);
  const grossLinesCents = lines.reduce((sum, l) => sum + l.amountCents, 0);

  if (!profile || !profile.tax_enabled || profile.components.length === 0) {
    return {
      taxableBaseCents: taxableLinesCents,
      nonTaxableCents,
      components: [],
      totalTaxCents: 0,
      subtotalCents: grossLinesCents,
      totalCents: grossLinesCents,
    };
  }

  const combinedRatePercent = profile.components.reduce((sum, c) => sum + c.rate_percent, 0);

  if (!profile.prices_include_tax) {
    const taxableBaseCents = taxableLinesCents;
    const totalTaxCents = Math.round(taxableBaseCents * (combinedRatePercent / 100));
    const components = allocateComponents(profile.components, combinedRatePercent, totalTaxCents);
    return {
      taxableBaseCents,
      nonTaxableCents,
      components,
      totalTaxCents,
      subtotalCents: grossLinesCents,
      totalCents: grossLinesCents + totalTaxCents,
    };
  }

  // Inclusive: taxableLinesCents is gross (tax already embedded). Extract
  // the net base; combinedRatePercent === 0 degenerates to no extraction
  // (avoid a divide-by-zero, and correctly yields zero tax either way).
  const netTaxableBaseCents = combinedRatePercent > 0
    ? Math.round(taxableLinesCents / (1 + combinedRatePercent / 100))
    : taxableLinesCents;
  const totalTaxCents = taxableLinesCents - netTaxableBaseCents;
  const components = allocateComponents(profile.components, combinedRatePercent, totalTaxCents);
  const netNonTaxableCents = nonTaxableCents; // non-taxable lines carry no embedded tax by definition
  return {
    taxableBaseCents: netTaxableBaseCents,
    nonTaxableCents: netNonTaxableCents,
    components,
    totalTaxCents,
    subtotalCents: netTaxableBaseCents + netNonTaxableCents,
    totalCents: grossLinesCents, // gross total is unchanged — tax was already embedded
  };
}

function allocateComponents(components: TaxComponent[], combinedRatePercent: number, totalTaxCents: number): TaxComponentResult[] {
  if (components.length === 1) {
    const c = components[0];
    return [{ code: c.code, name: c.name, rate_percent: c.rate_percent, amount_cents: totalTaxCents }];
  }
  if (combinedRatePercent === 0 || totalTaxCents === 0) {
    return components.map((c) => ({ code: c.code, name: c.name, rate_percent: c.rate_percent, amount_cents: 0 }));
  }
  const results: TaxComponentResult[] = [];
  let allocated = 0;
  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    if (i === components.length - 1) {
      results.push({ code: c.code, name: c.name, rate_percent: c.rate_percent, amount_cents: totalTaxCents - allocated });
    } else {
      const share = Math.round(totalTaxCents * (c.rate_percent / combinedRatePercent));
      results.push({ code: c.code, name: c.name, rate_percent: c.rate_percent, amount_cents: share });
      allocated += share;
    }
  }
  return results;
}

// ── Snapshots (Section 10) ──────────────────────────────────────────────

export type TaxSnapshotDocumentType = "quote_version" | "invoice";

export interface TaxSnapshot {
  id: number;
  document_type: TaxSnapshotDocumentType;
  document_id: number;
  tax_profile_id: number | null;
  tax_enabled: boolean;
  country_code: string;
  region_code: string;
  currency: string;
  prices_include_tax: boolean;
  taxable_base_cents: number;
  total_tax_cents: number;
  business_number: string;
  tax_number: string;
  legacy: boolean;
  created_at: string;
  components: TaxComponentResult[];
}

interface TaxSnapshotRow {
  id: number;
  document_type: TaxSnapshotDocumentType;
  document_id: number;
  tax_profile_id: number | null;
  tax_enabled: number;
  country_code: string;
  region_code: string;
  currency: string;
  prices_include_tax: number;
  taxable_base_cents: number;
  total_tax_cents: number;
  business_number: string;
  tax_number: string;
  legacy: number;
  created_at: string;
}

/** Persists exactly one tax_snapshots row (+ its component rows) for a
 *  document, replacing any prior snapshot for that same document — this is
 *  the intentional exception to "never overwrite a snapshot": while a Quote
 *  Version is still in `draft`, quotes.ts recomputes and re-snapshots on
 *  every line-item/discount edit (mirroring how subtotal_cents/tax_rate are
 *  already recomputed in place today). Once the document leaves draft (or,
 *  for an Invoice, once it's created at all — Invoices have no draft-edit
 *  recompute loop), nothing calls this again, so the snapshot freezes. */
export async function createTaxSnapshot(input: {
  documentType: TaxSnapshotDocumentType;
  documentId: number;
  profile: TaxProfile | null;
  // Only the fields this function actually persists (hardening —
  // independent Architecture review, Phase 13D) — narrowed from the full
  // TaxCalculationResult so a caller can't be misled into constructing
  // subtotalCents/nonTaxableCents/totalCents values that look meaningful
  // here but are silently discarded; those live on the invoice/quote
  // version row itself, not on the snapshot.
  calc: Pick<TaxCalculationResult, "taxableBaseCents" | "totalTaxCents" | "components">;
  businessNumber: string;
  taxNumber: string;
  legacy?: boolean;
}): Promise<void> {
  await run("DELETE FROM tax_snapshots WHERE document_type = ? AND document_id = ?", [input.documentType, input.documentId]);
  const result = await run(
    `INSERT INTO tax_snapshots (document_type, document_id, tax_profile_id, tax_enabled, country_code, region_code, currency, prices_include_tax, taxable_base_cents, total_tax_cents, business_number, tax_number, legacy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.documentType, input.documentId, input.profile?.id ?? null,
      input.profile?.tax_enabled ? 1 : 0, input.profile?.country_code ?? "", input.profile?.region_code ?? "",
      input.profile?.currency ?? "CAD", input.profile?.prices_include_tax ? 1 : 0,
      input.calc.taxableBaseCents, input.calc.totalTaxCents, input.businessNumber, input.taxNumber,
      input.legacy ? 1 : 0,
    ]
  );
  const snapshotId = Number(result.lastInsertRowid);
  let sortOrder = 0;
  for (const comp of input.calc.components) {
    await run(
      "INSERT INTO tax_snapshot_components (tax_snapshot_id, code, name, rate_percent, amount_cents, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      [snapshotId, comp.code, comp.name, comp.rate_percent, comp.amount_cents, sortOrder++]
    );
  }
}

export async function getTaxSnapshot(documentType: TaxSnapshotDocumentType, documentId: number): Promise<TaxSnapshot | null> {
  const row = await get<TaxSnapshotRow>(
    "SELECT * FROM tax_snapshots WHERE document_type = ? AND document_id = ?", [documentType, documentId]
  );
  if (!row) return null;
  const components = await query<TaxComponentResult & { id: number; tax_snapshot_id: number; sort_order: number }>(
    "SELECT * FROM tax_snapshot_components WHERE tax_snapshot_id = ? ORDER BY sort_order ASC, id ASC", [row.id]
  );
  return {
    id: row.id, document_type: row.document_type, document_id: row.document_id, tax_profile_id: row.tax_profile_id,
    tax_enabled: !!row.tax_enabled, country_code: row.country_code, region_code: row.region_code, currency: row.currency,
    prices_include_tax: !!row.prices_include_tax, taxable_base_cents: row.taxable_base_cents, total_tax_cents: row.total_tax_cents,
    business_number: row.business_number, tax_number: row.tax_number, legacy: !!row.legacy, created_at: row.created_at,
    components: components.map((c) => ({ code: c.code, name: c.name, rate_percent: c.rate_percent, amount_cents: c.amount_cents })),
  };
}

// ── Canadian presets (Section 5/22) — editable starting points only ─────
// NOT legal advice, NOT auto-applied to any organization. Offered by the
// client UI as one-click-fill buttons an admin may accept, edit, or ignore
// before saving their own Tax Profile.

export const CA_REGIONS: { code: string; name: string }[] = [
  { code: "BC", name: "British Columbia" },
  { code: "AB", name: "Alberta" },
  { code: "SK", name: "Saskatchewan" },
  { code: "MB", name: "Manitoba" },
  { code: "ON", name: "Ontario" },
  { code: "QC", name: "Quebec" },
  { code: "NB", name: "New Brunswick" },
  { code: "NS", name: "Nova Scotia" },
  { code: "PE", name: "Prince Edward Island" },
  { code: "NL", name: "Newfoundland and Labrador" },
  { code: "YT", name: "Yukon" },
  { code: "NT", name: "Northwest Territories" },
  { code: "NU", name: "Nunavut" },
];

export const CA_PRESETS: Record<string, TaxComponentInput[]> = {
  BC: [{ code: "GST", name: "GST", rate_percent: 5 }, { code: "PST", name: "PST", rate_percent: 7 }],
  AB: [{ code: "GST", name: "GST", rate_percent: 5 }],
  SK: [{ code: "GST", name: "GST", rate_percent: 5 }, { code: "PST", name: "PST", rate_percent: 6 }],
  MB: [{ code: "GST", name: "GST", rate_percent: 5 }, { code: "PST", name: "PST", rate_percent: 7 }],
  ON: [{ code: "HST", name: "HST", rate_percent: 13 }],
  QC: [{ code: "GST", name: "GST", rate_percent: 5 }, { code: "QST", name: "QST", rate_percent: 9.975 }],
  NB: [{ code: "HST", name: "HST", rate_percent: 15 }],
  NS: [{ code: "HST", name: "HST", rate_percent: 15 }],
  PE: [{ code: "HST", name: "HST", rate_percent: 15 }],
  NL: [{ code: "HST", name: "HST", rate_percent: 15 }],
  YT: [{ code: "GST", name: "GST", rate_percent: 5 }],
  NT: [{ code: "GST", name: "GST", rate_percent: 5 }],
  NU: [{ code: "GST", name: "GST", rate_percent: 5 }],
};
