import { get, query, run } from "./db.js";
import type { Role } from "./auth.js";
import { transitionContractInternal, type ContractStatus } from "./contract-workflow.js";
import { putObject, type StorageEnv } from "./storage.js";

/**
 * Phase 13 — Contracts / E-Sign (Core). A Contract is a legally-traceable
 * document bound to the EXACT accepted Quote commercial version (never the
 * Quote's current/latest state — see migrations/0018's header comment).
 * Durable identity (`contracts`) + immutable, versioned legal/commercial
 * snapshots (`contract_versions`) + signers/signature-requests/append-only
 * signature-event evidence. This file owns all Contract storage/business
 * logic and the public (token-gated, unauthenticated) signing flow;
 * `contract-workflow.ts` owns ONLY the contract-level lifecycle FSM.
 *
 * LEGAL BOUNDARY (Section 7 — do not remove or soften this comment):
 * this module provides TECHNICAL evidence and traceability (who signed
 * what, when, from where, having consented to what text) suitable for
 * legal/compliance review. It does NOT itself constitute a legal opinion
 * that any given signature is enforceable in any jurisdiction — that
 * remains a business/legal decision outside this code. Consent text and
 * contract template bodies are fully admin/business-editable content, not
 * hardcoded legal conclusions.
 */

export interface Actor {
  id: number;
  role: Role;
}

/** Same admin/dispatcher-manage, technician-blocked split as Quotes/Leads/
 *  Financial — Contracts are a front-office/legal concern with no
 *  field-work component. */
export function canManageContracts(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "dispatcher";
}

export const SIGNER_ROLES = ["customer", "co_owner", "company_rep", "guarantor", "other"] as const;
export type SignerRole = typeof SIGNER_ROLES[number];

export const SIGNATURE_METHODS = ["typed", "click_to_sign"] as const;
export type SignatureMethod = typeof SIGNATURE_METHODS[number];

/** Section 16 — the ONLY placeholders a template body may resolve. A plain
 *  string-replace against this fixed list, never code execution. Any
 *  `{{...}}` NOT in this list is left exactly as-is in the rendered output
 *  (fail-safe: visibly unfilled, never silently dropped, never crashes). */
const ALLOWED_MERGE_FIELDS = [
  "customer_name", "customer_address", "quote_number", "quote_total", "company_name", "contract_date",
] as const;

export class ContractError extends Error {
  code: "not_found" | "invalid_quote" | "not_draft" | "invalid_input" | "referenced" | "conflict" | "invalid_signer" | "invalid_token";
  constructor(code: ContractError["code"], message: string) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

export interface Contract {
  id: number;
  organization_id: number;
  identifier: string;
  customer_id: number;
  quote_id: number;
  accepted_quote_version_id: number;
  status: string;
  current_version_id: number | null;
  voided_at: string | null;
  void_reason: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface ContractVersion {
  id: number;
  contract_id: number;
  version_number: number;
  title: string;
  body: string;
  template_version_id: number | null;
  commercial_snapshot: string;
  customer_snapshot: string;
  company_snapshot: string;
  effective_date: string | null;
  expires_at: string | null;
  document_hash: string | null;
  hash_algorithm: string;
  signed_document_key: string | null;
  signed_document_hash: string | null;
  signed_at: string | null;
  created_by: number | null;
  created_at: string;
}

const CONTRACT_VERSION_COLUMNS = "id, contract_id, version_number, title, body, template_version_id, commercial_snapshot, customer_snapshot, company_snapshot, effective_date, expires_at, document_hash, hash_algorithm, signed_document_key, signed_document_hash, signed_at, created_by, created_at";

export interface ContractSigner {
  id: number;
  contract_id: number;
  name: string;
  email: string;
  phone: string;
  role: SignerRole;
  sort_order: number;
  created_at: string;
}

export interface SignatureRequest {
  id: number;
  contract_id: number;
  contract_version_id: number;
  signer_id: number;
  status: string;
  provider: string;
  provider_request_id: string | null;
  expires_at: string;
  consent_text_version: string;
  consent_at: string | null;
  signed_at: string | null;
  signature_method: string | null;
  signer_ip: string | null;
  signer_user_agent: string | null;
  declined_reason: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

/** Never selects token_hash — that column must never leave this module. */
const SIGNATURE_REQUEST_COLUMNS = "id, contract_id, contract_version_id, signer_id, status, provider, provider_request_id, expires_at, consent_text_version, consent_at, signed_at, signature_method, signer_ip, signer_user_agent, declined_reason, created_by, created_at, updated_at";

export interface SignatureEvent {
  id: number;
  signature_request_id: number;
  event_type: string;
  actor_user_id: number | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: string;
  created_at: string;
}

// ── Identifier ──────────────────────────────────────────────────────

async function nextContractIdentifier(): Promise<string> {
  const prefixRow = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'contract_prefix'");
  const counterRow = await get<{ value: string }>(
    "UPDATE _meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'contract_counter' RETURNING value"
  );
  return `${prefixRow?.value || "CONTRACT"}-${counterRow!.value}`;
}

// ── Crypto helpers (mirror src/server/auth.ts's session-token discipline) ──

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Raw token: 256 bits of randomness, returned to the caller exactly once.
 *  Never logged, never persisted in plaintext — see hashSigningToken(). */
function generateSigningToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashSigningToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Validation helpers ──────────────────────────────────────────────

/** Section 9/37: a Contract may only be created from an ACCEPTED Quote,
 *  binding to its accepted_version_id — never draft/sent/rejected/expired/
 *  cancelled, and never the Quote's current (possibly-since-revised)
 *  version. */
async function assertQuoteAcceptedInOrganization(
  organizationId: number, quoteId: number
): Promise<{ customerId: number; acceptedVersionId: number }> {
  const quote = await get<{ id: number; customer_id: number; status: string; accepted_version_id: number | null }>(
    "SELECT id, customer_id, status, accepted_version_id FROM quotes WHERE id = ? AND organization_id = ?", [quoteId, organizationId]
  );
  if (!quote) throw new ContractError("invalid_quote", "Quote not found");
  if (quote.status !== "accepted" || quote.accepted_version_id === null) {
    throw new ContractError("invalid_quote", "A contract can only be created from an accepted quote");
  }
  return { customerId: quote.customer_id, acceptedVersionId: quote.accepted_version_id };
}

// ── Merge-field rendering (Section 16) ──────────────────────────────

export function renderTemplateBody(template: string, fields: Partial<Record<typeof ALLOWED_MERGE_FIELDS[number], string>>): string {
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (match, name) => {
    if ((ALLOWED_MERGE_FIELDS as readonly string[]).includes(name) && fields[name as typeof ALLOWED_MERGE_FIELDS[number]] !== undefined) {
      return fields[name as typeof ALLOWED_MERGE_FIELDS[number]]!;
    }
    return match; // unknown/unresolved placeholder — left literally in place, never dropped or executed
  });
}

function formatCentsForDoc(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

// ── Snapshot builders (Section 32/33) ───────────────────────────────

interface CommercialSnapshotLine { description: string; quantity: number; unit: string; unit_price_cents: number; total_cents: number }
interface CommercialSnapshot {
  quote_identifier: string;
  quote_version_number: number;
  line_items: CommercialSnapshotLine[];
  subtotal_cents: number;
  discount_cents: number;
  tax_rate: number;
  tax_amount_cents: number;
  total_cents: number;
}

async function buildCommercialSnapshot(quoteId: number, quoteVersionId: number): Promise<CommercialSnapshot> {
  const quote = await get<{ identifier: string }>("SELECT identifier FROM quotes WHERE id = ?", [quoteId]);
  const version = await get<{ version_number: number; subtotal_cents: number; discount_cents: number; tax_rate: number; tax_amount_cents: number; total_cents: number }>(
    "SELECT version_number, subtotal_cents, discount_cents, tax_rate, tax_amount_cents, total_cents FROM quote_versions WHERE id = ?", [quoteVersionId]
  );
  const lines = await query<CommercialSnapshotLine>(
    "SELECT description, quantity, unit, unit_price_cents, total_cents FROM quote_line_items WHERE quote_version_id = ? ORDER BY sort_order ASC, id ASC", [quoteVersionId]
  );
  return {
    quote_identifier: quote?.identifier ?? "",
    quote_version_number: version?.version_number ?? 0,
    line_items: lines,
    subtotal_cents: version?.subtotal_cents ?? 0,
    discount_cents: version?.discount_cents ?? 0,
    tax_rate: version?.tax_rate ?? 0,
    tax_amount_cents: version?.tax_amount_cents ?? 0,
    total_cents: version?.total_cents ?? 0,
  };
}

interface CustomerSnapshot { name: string; email: string; phone: string; address: string; city: string; state: string; zip: string }

async function buildCustomerSnapshot(customerId: number): Promise<CustomerSnapshot> {
  const c = await get<CustomerSnapshot>("SELECT name, email, phone, address, city, state, zip FROM customers WHERE id = ?", [customerId]);
  return c ?? { name: "", email: "", phone: "", address: "", city: "", state: "", zip: "" };
}

/** Section 33 — deliberately empty today. No company-profile Global
 *  Setting exists anywhere in this codebase yet (confirmed by audit
 *  before writing this phase) to source a company name/address/contact
 *  from. The column is captured at write time (so it is ready the moment
 *  such a setting exists, with zero schema change) but is honestly blank
 *  now — NOT a silent gap, see migrations/0018's header comment and the
 *  Phase 13 docs addendum. */
function buildCompanySnapshot(): { name: string; address: string; contact: string } {
  return { name: "", address: "", contact: "" };
}

// ── Contract CRUD ────────────────────────────────────────────────────

export type ContractWithNames = Contract & { customer_name: string | null; quote_identifier: string | null };

export interface CreateContractInput {
  quote_id: number;
  template_version_id?: number | null;
  title?: string;
  effective_date?: string | null;
  expires_at?: string | null;
}

/** Creates a Contract (durable identity, status='draft') bound to the
 *  quote's CURRENT accepted_version_id, plus its first version with a
 *  rendered body and captured snapshots. Sequential awaited writes (not a
 *  db.batch()) — matches this codebase's established convention for
 *  ordinary multi-row creates (see createQuote/createCustomer et al.). */
export async function createContract(organizationId: number, actorUserId: number, input: CreateContractInput): Promise<ContractWithNames> {
  const { customerId, acceptedVersionId } = await assertQuoteAcceptedInOrganization(organizationId, input.quote_id);

  const existingLiveContract = await get<{ id: number }>(
    "SELECT id FROM contracts WHERE quote_id = ? AND organization_id = ? AND status NOT IN ('cancelled', 'voided') LIMIT 1",
    [input.quote_id, organizationId]
  );
  if (existingLiveContract) {
    throw new ContractError("conflict", "This quote already has a contract — cancel or void it before creating another");
  }

  let templateBody = "";
  let templateVersionId: number | null = null;
  if (input.template_version_id !== undefined && input.template_version_id !== null) {
    const tv = await get<{ id: number; body: string; template_id: number }>(
      `SELECT tv.id, tv.body, tv.template_id FROM contract_template_versions tv
       JOIN contract_templates t ON tv.template_id = t.id
       WHERE tv.id = ? AND t.organization_id = ?`,
      [input.template_version_id, organizationId]
    );
    if (!tv) throw new ContractError("invalid_input", "Contract template version not found");
    templateBody = tv.body;
    templateVersionId = tv.id;
  }

  const identifier = await nextContractIdentifier();
  const contractResult = await run(
    `INSERT INTO contracts (organization_id, identifier, customer_id, quote_id, accepted_quote_version_id, status, created_by)
     VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
    [organizationId, identifier, customerId, input.quote_id, acceptedVersionId, actorUserId]
  );
  const contractId = Number(contractResult.lastInsertRowid);

  const commercialSnapshot = await buildCommercialSnapshot(input.quote_id, acceptedVersionId);
  const customerSnapshot = await buildCustomerSnapshot(customerId);
  const companySnapshot = buildCompanySnapshot();

  const mergeFields = {
    customer_name: customerSnapshot.name,
    customer_address: [customerSnapshot.address, customerSnapshot.city, customerSnapshot.state, customerSnapshot.zip].filter(Boolean).join(", "),
    quote_number: commercialSnapshot.quote_identifier,
    quote_total: formatCentsForDoc(commercialSnapshot.total_cents),
    company_name: companySnapshot.name,
    contract_date: new Date().toISOString().slice(0, 10),
  };
  const renderedBody = templateBody ? renderTemplateBody(templateBody, mergeFields) : "";

  const versionResult = await run(
    `INSERT INTO contract_versions (contract_id, version_number, title, body, template_version_id, commercial_snapshot, customer_snapshot, company_snapshot, effective_date, expires_at, created_by)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [contractId, input.title ?? "", renderedBody, templateVersionId, JSON.stringify(commercialSnapshot), JSON.stringify(customerSnapshot), JSON.stringify(companySnapshot), input.effective_date ?? null, input.expires_at ?? null, actorUserId]
  );
  const versionId = Number(versionResult.lastInsertRowid);

  await run("UPDATE contracts SET current_version_id = ? WHERE id = ?", [versionId, contractId]);

  return (await getContract(organizationId, contractId))!;
}

export async function getContract(organizationId: number, id: number): Promise<ContractWithNames | null> {
  const contract = await get<ContractWithNames>(
    `SELECT c.*, cu.name as customer_name, q.identifier as quote_identifier
     FROM contracts c
     LEFT JOIN customers cu ON c.customer_id = cu.id
     LEFT JOIN quotes q ON c.quote_id = q.id
     WHERE c.id = ? AND c.organization_id = ?`,
    [id, organizationId]
  );
  return contract ?? null;
}

export async function getContractVersion(contractId: number, versionId: number): Promise<ContractVersion | null> {
  const version = await get<ContractVersion>(`SELECT ${CONTRACT_VERSION_COLUMNS} FROM contract_versions WHERE id = ? AND contract_id = ?`, [versionId, contractId]);
  return version ?? null;
}

export async function listContractVersions(contractId: number): Promise<ContractVersion[]> {
  return query<ContractVersion>(`SELECT ${CONTRACT_VERSION_COLUMNS} FROM contract_versions WHERE contract_id = ? ORDER BY version_number DESC`, [contractId]);
}

export interface ContractListFilters {
  status?: string;
  customer_id?: number;
  quote_id?: number;
  search?: string;
}

export type ContractListRow = ContractWithNames;

const MAX_LIKE_WILDCARD_CHARS = 20;
function likePattern(value: string): string {
  return `%${value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}
export function assertSearchableContractFilter(value: string): void {
  const wildcardCount = (value.match(/[%_]/g) || []).length;
  if (wildcardCount > MAX_LIKE_WILDCARD_CHARS) {
    throw new ContractError("invalid_input", "Search filter is too complex — try a shorter or simpler value");
  }
}

export async function listContracts(
  organizationId: number, filters: ContractListFilters, limit: number, offset: number
): Promise<{ contracts: ContractListRow[]; total: number }> {
  const conditions = ["c.organization_id = ?"];
  const params: unknown[] = [organizationId];

  if (filters.status) { conditions.push("c.status = ?"); params.push(filters.status); }
  if (filters.customer_id !== undefined) { conditions.push("c.customer_id = ?"); params.push(filters.customer_id); }
  if (filters.quote_id !== undefined) { conditions.push("c.quote_id = ?"); params.push(filters.quote_id); }
  if (filters.search) {
    assertSearchableContractFilter(filters.search);
    conditions.push("(c.identifier LIKE ? ESCAPE '\\' OR cu.name LIKE ? ESCAPE '\\')");
    const like = likePattern(filters.search);
    params.push(like, like);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const from = "FROM contracts c LEFT JOIN customers cu ON c.customer_id = cu.id LEFT JOIN quotes q ON c.quote_id = q.id";
  const countRow = await get<{ count: number }>(`SELECT COUNT(*) as count ${from} ${where}`, params);
  const contracts = await query<ContractListRow>(
    `SELECT c.*, cu.name as customer_name, q.identifier as quote_identifier ${from} ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { contracts, total: countRow?.count || 0 };
}

/** Hard-deletes a Contract only when it has never left draft (zero status-
 *  history rows AND still status='draft') — same philosophy as Quotes'
 *  deleteQuote/Assets' deleteAsset. */
export async function deleteContract(organizationId: number, id: number): Promise<boolean> {
  const contract = await get<{ id: number; status: string }>("SELECT id, status FROM contracts WHERE id = ? AND organization_id = ?", [id, organizationId]);
  if (!contract) return false;
  if (contract.status !== "draft") {
    throw new ContractError("referenced", "Only a contract that has never been sent can be deleted");
  }
  const historyRow = await get<{ id: number }>("SELECT id FROM contract_status_history WHERE contract_id = ? LIMIT 1", [id]);
  if (historyRow) {
    throw new ContractError("referenced", "This contract has transition history and cannot be deleted");
  }
  await run("DELETE FROM contracts WHERE id = ? AND organization_id = ?", [id, organizationId]);
  return true;
}

// ── Version editing (draft-only) ────────────────────────────────────

async function assertDraftAndGetCurrentContractVersion(organizationId: number, contractId: number): Promise<{ contract: Contract; versionId: number }> {
  const contract = await get<Contract>("SELECT * FROM contracts WHERE id = ? AND organization_id = ?", [contractId, organizationId]);
  if (!contract) throw new ContractError("not_found", "Contract not found");
  if (contract.status !== "draft" || contract.current_version_id === null) {
    throw new ContractError("not_draft", "This contract is not in draft status — create a new version to make further changes");
  }
  return { contract, versionId: contract.current_version_id };
}

export interface UpdateContractVersionInput {
  title?: string;
  body?: string;
  effective_date?: string | null;
  expires_at?: string | null;
}

/** `row_version` compare-and-swap (migration 0018's own hardening column,
 *  same idiom as quote_versions' recomputeAndStoreVersionTotals) closes a
 *  lost-update race between two concurrent draft edits of the same version —
 *  a single-shot CAS (not a retry loop) is correct here, unlike the totals
 *  recompute: silently retrying a title/body edit could discard a real
 *  concurrent edit rather than merely re-deriving the same value. */
export async function updateContractVersion(organizationId: number, contractId: number, input: UpdateContractVersionInput): Promise<ContractVersion> {
  const { versionId } = await assertDraftAndGetCurrentContractVersion(organizationId, contractId);
  const current = await get<{ row_version: number }>("SELECT row_version FROM contract_versions WHERE id = ?", [versionId]);
  if (!current) throw new ContractError("not_found", "Contract version not found");

  const fields: string[] = [];
  const vals: unknown[] = [];
  if (input.title !== undefined) { fields.push("title = ?"); vals.push(input.title); }
  if (input.body !== undefined) { fields.push("body = ?"); vals.push(input.body); }
  if (input.effective_date !== undefined) { fields.push("effective_date = ?"); vals.push(input.effective_date); }
  if (input.expires_at !== undefined) { fields.push("expires_at = ?"); vals.push(input.expires_at); }
  if (fields.length > 0) {
    const result = await run(
      `UPDATE contract_versions SET ${fields.join(", ")}, row_version = row_version + 1 WHERE id = ? AND row_version = ?`,
      [...vals, versionId, current.row_version]
    );
    if (result.changes === 0) throw new ContractError("conflict", "This contract version was changed by another request — reload and try again");
  }
  return (await get<ContractVersion>(`SELECT ${CONTRACT_VERSION_COLUMNS} FROM contract_versions WHERE id = ?`, [versionId]))!;
}

/** Section 11/38 — a brand-new version, never mutating the one being
 *  revised. Copies forward title/body/snapshots from the source version
 *  as an editable starting point (re-render against the LATEST quote/
 *  customer state is deliberately NOT done here — Section 9's binding is
 *  to the ORIGINAL accepted_quote_version_id captured at Contract creation,
 *  which never changes; a revision only lets staff edit the Contract's own
 *  legal text/dates, not silently re-bind to different commercial terms). */
export async function createContractRevision(organizationId: number, contractId: number, actorUserId: number): Promise<ContractVersion> {
  const contract = await get<Contract>("SELECT * FROM contracts WHERE id = ? AND organization_id = ?", [contractId, organizationId]);
  if (!contract) throw new ContractError("not_found", "Contract not found");
  if (contract.status === "draft") throw new ContractError("not_draft", "This contract is already in draft status");
  if (contract.status === "signed" || contract.status === "voided") {
    throw new ContractError("not_draft", `A ${contract.status} contract cannot be revised`);
  }
  if (contract.current_version_id === null) throw new ContractError("not_found", "Contract has no current version");

  const sourceVersion = await get<ContractVersion>(`SELECT ${CONTRACT_VERSION_COLUMNS} FROM contract_versions WHERE id = ?`, [contract.current_version_id]);
  if (!sourceVersion) throw new ContractError("not_found", "Source version not found");

  let newVersionId: number;
  try {
    const result = await run(
      `INSERT INTO contract_versions (contract_id, version_number, title, body, template_version_id, commercial_snapshot, customer_snapshot, company_snapshot, effective_date, expires_at, created_by)
       SELECT ?, COALESCE(MAX(version_number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM contract_versions WHERE contract_id = ?`,
      [contractId, sourceVersion.title, sourceVersion.body, sourceVersion.template_version_id, sourceVersion.commercial_snapshot, sourceVersion.customer_snapshot, sourceVersion.company_snapshot, sourceVersion.effective_date, sourceVersion.expires_at, actorUserId, contractId]
    );
    newVersionId = Number(result.lastInsertRowid);
  } catch {
    throw new ContractError("invalid_input", "A revision is already being created for this contract — please retry");
  }

  await run("UPDATE contracts SET current_version_id = ?, status = 'draft', updated_at = datetime('now') WHERE id = ?", [newVersionId, contractId]);
  await run(
    "INSERT INTO contract_status_history (contract_id, old_status, new_status, actor_user_id, reason) VALUES (?, ?, 'draft', ?, ?)",
    [contractId, contract.status, actorUserId, `Revision ${sourceVersion.version_number + 1} created`]
  );

  return (await get<ContractVersion>(`SELECT ${CONTRACT_VERSION_COLUMNS} FROM contract_versions WHERE id = ?`, [newVersionId]))!;
}

// ── Templates (Section 15) ──────────────────────────────────────────

export interface ContractTemplate {
  id: number;
  organization_id: number;
  name: string;
  active: number;
  current_version_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface ContractTemplateVersion {
  id: number;
  template_id: number;
  version_number: number;
  title: string;
  body: string;
  created_by: number | null;
  created_at: string;
}

export async function listContractTemplates(organizationId: number): Promise<ContractTemplate[]> {
  return query<ContractTemplate>("SELECT * FROM contract_templates WHERE organization_id = ? AND active = 1 ORDER BY name ASC", [organizationId]);
}

export async function createContractTemplate(organizationId: number, actorUserId: number, name: string, body: string): Promise<ContractTemplate & { version: ContractTemplateVersion }> {
  const result = await run("INSERT INTO contract_templates (organization_id, name, created_by) VALUES (?, ?, ?)", [organizationId, name, actorUserId]);
  const templateId = Number(result.lastInsertRowid);
  const versionResult = await run(
    "INSERT INTO contract_template_versions (template_id, version_number, title, body, created_by) VALUES (?, 1, ?, ?, ?)",
    [templateId, name, body, actorUserId]
  );
  const versionId = Number(versionResult.lastInsertRowid);
  await run("UPDATE contract_templates SET current_version_id = ? WHERE id = ?", [versionId, templateId]);
  const template = (await get<ContractTemplate>("SELECT * FROM contract_templates WHERE id = ?", [templateId]))!;
  const version = (await get<ContractTemplateVersion>("SELECT * FROM contract_template_versions WHERE id = ?", [versionId]))!;
  return { ...template, version };
}

export async function createContractTemplateVersion(organizationId: number, templateId: number, actorUserId: number, title: string, body: string): Promise<ContractTemplateVersion> {
  const template = await get<{ id: number }>("SELECT id FROM contract_templates WHERE id = ? AND organization_id = ?", [templateId, organizationId]);
  if (!template) throw new ContractError("not_found", "Contract template not found");
  const result = await run(
    `INSERT INTO contract_template_versions (template_id, version_number, title, body, created_by)
     SELECT ?, COALESCE(MAX(version_number), 0) + 1, ?, ?, ? FROM contract_template_versions WHERE template_id = ?`,
    [templateId, title, body, actorUserId, templateId]
  );
  const versionId = Number(result.lastInsertRowid);
  await run("UPDATE contract_templates SET current_version_id = ? WHERE id = ?", [versionId, templateId]);
  return (await get<ContractTemplateVersion>("SELECT * FROM contract_template_versions WHERE id = ?", [versionId]))!;
}

// ── Signers (Section 17/18/34) ───────────────────────────────────────

export interface SignerInput { name?: string; email?: string; phone?: string; role?: string }

export async function listContractSigners(contractId: number): Promise<ContractSigner[]> {
  return query<ContractSigner>("SELECT * FROM contract_signers WHERE contract_id = ? ORDER BY sort_order ASC, id ASC", [contractId]);
}

/** Cross-customer assignment is prevented structurally, not by an extra
 *  FK — this is the ONLY function that ever inserts a contract_signers
 *  row, and it is always scoped by contractId (see module doc comment /
 *  migration header). */
export async function addContractSigner(organizationId: number, contractId: number, input: SignerInput): Promise<ContractSigner> {
  const contract = await get<{ id: number; status: string }>("SELECT id, status FROM contracts WHERE id = ? AND organization_id = ?", [contractId, organizationId]);
  if (!contract) throw new ContractError("not_found", "Contract not found");
  if (contract.status !== "draft") {
    throw new ContractError("not_draft", "Signers can only be added while the contract is in draft status");
  }
  const role = SIGNER_ROLES.includes((input.role ?? "customer") as SignerRole) ? (input.role as SignerRole) ?? "customer" : "customer";
  const countRow = await get<{ n: number }>("SELECT COUNT(*) as n FROM contract_signers WHERE contract_id = ?", [contractId]);
  const result = await run(
    "INSERT INTO contract_signers (contract_id, name, email, phone, role, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    [contractId, input.name ?? "", input.email ?? "", input.phone ?? "", role, countRow?.n ?? 0]
  );
  return (await get<ContractSigner>("SELECT * FROM contract_signers WHERE id = ?", [Number(result.lastInsertRowid)]))!;
}

export async function deleteContractSigner(organizationId: number, contractId: number, signerId: number): Promise<void> {
  const contract = await get<{ id: number; status: string }>("SELECT id, status FROM contracts WHERE id = ? AND organization_id = ?", [contractId, organizationId]);
  if (!contract) throw new ContractError("not_found", "Contract not found");
  const activeRequest = await get<{ id: number }>(
    "SELECT id FROM contract_signature_requests WHERE signer_id = ? AND contract_id = ? AND status NOT IN ('cancelled', 'declined', 'expired') LIMIT 1", [signerId, contractId]
  );
  if (activeRequest) throw new ContractError("referenced", "This signer has an active or completed signature request and cannot be removed");
  const result = await run("DELETE FROM contract_signers WHERE id = ? AND contract_id = ?", [signerId, contractId]);
  if (result.changes === 0) throw new ContractError("not_found", "Signer not found");
}

// ── Signature requests — admin/dispatcher side (Section 23/50/51) ──────

const SIGNATURE_REQUEST_EXPIRY_DAYS = 14;

export interface SendForSignatureResult {
  contract: ContractWithNames;
  /** Raw tokens — returned ONLY here, exactly once, never persisted in
   *  plaintext and never returned by any later read (Section 24/29). */
  signingLinks: { signerId: number; signerName: string; token: string }[];
}

/** Section 37/23 — the operation that actually issues a draft Contract for
 *  signature: computes the version's document_hash (tamper-evidence,
 *  Section 29), creates one signature_request per signer (each bound to
 *  this EXACT version and EXACT signer, Section 23), and transitions the
 *  contract draft -> sent. Requires at least one signer. */
export async function sendContractForSignature(db: D1Database, organizationId: number, contractId: number, actorUserId: number): Promise<SendForSignatureResult> {
  const { contract, versionId } = await assertDraftAndGetCurrentContractVersion(organizationId, contractId);
  const signers = await listContractSigners(contractId);
  if (signers.length === 0) throw new ContractError("invalid_signer", "At least one signer is required before sending for signature");

  const version = (await get<ContractVersion>(`SELECT ${CONTRACT_VERSION_COLUMNS} FROM contract_versions WHERE id = ?`, [versionId]))!;
  const documentHash = await sha256Hex(version.body + version.commercial_snapshot + version.customer_snapshot + version.company_snapshot);
  await run("UPDATE contract_versions SET document_hash = ? WHERE id = ?", [documentHash, versionId]);

  const expiresAt = new Date(Date.now() + SIGNATURE_REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const signingLinks: SendForSignatureResult["signingLinks"] = [];
  for (const signer of signers) {
    const rawToken = generateSigningToken();
    const tokenHash = await hashSigningToken(rawToken);
    const result = await run(
      `INSERT INTO contract_signature_requests (contract_id, contract_version_id, signer_id, status, token_hash, provider, expires_at, created_by)
       VALUES (?, ?, ?, 'sent', ?, 'local', ?, ?)`,
      [contractId, versionId, signer.id, tokenHash, expiresAt, actorUserId]
    );
    const requestId = Number(result.lastInsertRowid);
    await run(
      "INSERT INTO contract_signature_events (signature_request_id, event_type, actor_user_id, metadata) VALUES (?, 'request_created', ?, ?)",
      [requestId, actorUserId, JSON.stringify({ signer_email: signer.email })]
    );
    signingLinks.push({ signerId: signer.id, signerName: signer.name, token: rawToken });
  }

  await transitionContractInternal(db, { id: contract.id, status: "draft", organization_id: organizationId }, "sent", actorUserId, "");

  return { contract: (await getContract(organizationId, contractId))!, signingLinks };
}

export async function listSignatureRequests(contractId: number): Promise<SignatureRequest[]> {
  return query<SignatureRequest>(`SELECT ${SIGNATURE_REQUEST_COLUMNS} FROM contract_signature_requests WHERE contract_id = ? ORDER BY created_at DESC`, [contractId]);
}

/** `db`/`env` are threaded through (matching submitSignature/declineSignature)
 *  because cancelling can leave every request on the current version in a
 *  terminal non-signed state, which recalculateContractStatus() below must
 *  observe — otherwise a contract whose last active request gets cancelled
 *  would silently stay 'sent'/'partially_signed' forever with no live
 *  requests (a real bug an independent review caught: see git history). */
export async function cancelSignatureRequest(db: D1Database, env: StorageEnv, organizationId: number, contractId: number, requestId: number, actorUserId: number, reason: string): Promise<void> {
  const contract = await get<{ id: number }>("SELECT id FROM contracts WHERE id = ? AND organization_id = ?", [contractId, organizationId]);
  if (!contract) throw new ContractError("not_found", "Contract not found");
  const reqRow = await get<{ id: number; status: string }>("SELECT id, status FROM contract_signature_requests WHERE id = ? AND contract_id = ?", [requestId, contractId]);
  if (!reqRow) throw new ContractError("not_found", "Signature request not found");
  if (["signed", "declined", "cancelled", "expired"].includes(reqRow.status)) {
    throw new ContractError("conflict", `Cannot cancel a signature request that is already ${reqRow.status}`);
  }
  const result = await run("UPDATE contract_signature_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = ?", [requestId, reqRow.status]);
  if (result.changes === 0) throw new ContractError("conflict", "This signature request was changed by another request — reload and try again");
  await run("INSERT INTO contract_signature_events (signature_request_id, event_type, actor_user_id, metadata) VALUES (?, 'request_cancelled', ?, ?)", [requestId, actorUserId, JSON.stringify({ reason })]);
  await recalculateContractStatus(db, env, contractId);
}

/** Section 51 — supersedes (cancels) the prior active request and issues a
 *  fresh one with a NEW token; the old token is immediately unusable
 *  (status no longer 'pending'/'sent'/'viewed', see getSignatureRequestByToken). */
export async function resendSignatureRequest(db: D1Database, organizationId: number, contractId: number, requestId: number, actorUserId: number): Promise<{ signerId: number; signerName: string; token: string }> {
  const contract = await get<{ id: number }>("SELECT id FROM contracts WHERE id = ? AND organization_id = ?", [contractId, organizationId]);
  if (!contract) throw new ContractError("not_found", "Contract not found");
  const reqRow = await get<{ id: number; status: string; contract_version_id: number; signer_id: number }>(
    "SELECT id, status, contract_version_id, signer_id FROM contract_signature_requests WHERE id = ? AND contract_id = ?", [requestId, contractId]
  );
  if (!reqRow) throw new ContractError("not_found", "Signature request not found");
  if (!["pending", "sent", "viewed", "expired"].includes(reqRow.status)) {
    throw new ContractError("conflict", `Cannot resend a signature request that is already ${reqRow.status}`);
  }
  const signer = await get<ContractSigner>("SELECT * FROM contract_signers WHERE id = ?", [reqRow.signer_id]);
  if (!signer) throw new ContractError("invalid_signer", "Signer not found");

  const supersedeResult = await run(
    "UPDATE contract_signature_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = ?", [requestId, reqRow.status]
  );
  if (supersedeResult.changes === 0) throw new ContractError("conflict", "This signature request was changed by another request — reload and try again");
  await run("INSERT INTO contract_signature_events (signature_request_id, event_type, actor_user_id, metadata) VALUES (?, 'request_superseded', ?, '{}')", [requestId, actorUserId]);
  void db; // reserved for future provider-side cancel call (LocalEsignProvider.cancelRequest is a no-op today)

  const rawToken = generateSigningToken();
  const tokenHash = await hashSigningToken(rawToken);
  const expiresAt = new Date(Date.now() + SIGNATURE_REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = await run(
    `INSERT INTO contract_signature_requests (contract_id, contract_version_id, signer_id, status, token_hash, provider, expires_at, created_by)
     VALUES (?, ?, ?, 'sent', ?, 'local', ?, ?)`,
    [contractId, reqRow.contract_version_id, reqRow.signer_id, tokenHash, expiresAt, actorUserId]
  );
  const newRequestId = Number(result.lastInsertRowid);
  await run("INSERT INTO contract_signature_events (signature_request_id, event_type, actor_user_id, metadata) VALUES (?, 'request_created', ?, ?)", [newRequestId, actorUserId, JSON.stringify({ resend_of: requestId })]);

  return { signerId: signer.id, signerName: signer.name, token: rawToken };
}

// ── Public signing flow (token-gated, unauthenticated) — Section 24-29 ──

export interface PublicSigningView {
  request: SignatureRequest;
  contract: { identifier: string; status: string };
  version: { title: string; body: string; effective_date: string | null; expires_at: string | null; commercial_snapshot: string };
  signer: { name: string; email: string; role: string };
}

/** The SOLE entry point for resolving a raw signing token. Every failure
 *  mode — token doesn't exist, wrong hash, expired, already-terminal
 *  status — returns null identically (Section 24: "no customer data
 *  enumeration", "safe error messages"). Lazily marks a request 'expired'
 *  if its expiry has passed and it was still open — mirrors Quotes'
 *  checkExpiry lazy pattern. */
export async function getSignatureRequestByToken(rawToken: string): Promise<PublicSigningView | null> {
  if (!rawToken || rawToken.length > 200) return null;
  const tokenHash = await hashSigningToken(rawToken);
  const reqRow = await get<SignatureRequest>(`SELECT ${SIGNATURE_REQUEST_COLUMNS} FROM contract_signature_requests WHERE token_hash = ?`, [tokenHash]);
  if (!reqRow) return null;
  if (!["pending", "sent", "viewed"].includes(reqRow.status)) return null;

  if (new Date(reqRow.expires_at) < new Date()) {
    await run("UPDATE contract_signature_requests SET status = 'expired', updated_at = datetime('now') WHERE id = ? AND status = ?", [reqRow.id, reqRow.status]);
    await run("INSERT INTO contract_signature_events (signature_request_id, event_type, metadata) VALUES (?, 'request_expired', '{}')", [reqRow.id]);
    return null;
  }

  if (reqRow.status === "sent") {
    await run("UPDATE contract_signature_requests SET status = 'viewed', updated_at = datetime('now') WHERE id = ? AND status = 'sent'", [reqRow.id]);
    await run("INSERT INTO contract_signature_events (signature_request_id, event_type, metadata) VALUES (?, 'viewed', '{}')", [reqRow.id]);
    reqRow.status = "viewed"; // keep the in-memory row in sync with the write above — the caller reads THIS object, not a fresh SELECT
  }

  const contract = await get<{ identifier: string; status: string }>("SELECT identifier, status FROM contracts WHERE id = ?", [reqRow.contract_id]);
  const version = await get<{ title: string; body: string; effective_date: string | null; expires_at: string | null; commercial_snapshot: string }>(
    "SELECT title, body, effective_date, expires_at, commercial_snapshot FROM contract_versions WHERE id = ?", [reqRow.contract_version_id]
  );
  const signer = await get<{ name: string; email: string; role: string }>("SELECT name, email, role FROM contract_signers WHERE id = ?", [reqRow.signer_id]);
  if (!contract || !version || !signer) return null;

  return { request: reqRow, contract, version, signer };
}

export async function recordConsent(rawToken: string, consentTextVersion: string, ip: string, userAgent: string): Promise<void> {
  const view = await getSignatureRequestByToken(rawToken);
  if (!view) throw new ContractError("invalid_token", "This signing link is invalid or has expired");
  const tokenHash = await hashSigningToken(rawToken);
  await run(
    "UPDATE contract_signature_requests SET consent_text_version = ?, consent_at = datetime('now'), updated_at = datetime('now') WHERE token_hash = ? AND status IN ('pending','sent','viewed')",
    [consentTextVersion, tokenHash]
  );
  await run(
    "INSERT INTO contract_signature_events (signature_request_id, event_type, ip_address, user_agent, metadata) VALUES (?, 'consented', ?, ?, ?)",
    [view.request.id, ip, userAgent, JSON.stringify({ consent_text_version: consentTextVersion })]
  );
}

export interface SubmitSignatureInput {
  signerName: string;
  signatureMethod: string;
}

/** Idempotent (Section 56): re-submitting against an ALREADY-signed request
 *  is a safe no-op, never a double-count or duplicate event. `env` is
 *  needed (not just `db`) because a completed-by-this-call signature can
 *  trigger the final signed-document R2 write — see recalculateContractStatus. */
/** No organizationId parameter — deliberately. This is the public,
 *  unauthenticated flow: there is no session-derived "actor org" to check
 *  against. The token itself (resolved exclusively through
 *  getSignatureRequestByToken()) already deterministically identifies
 *  exactly one contract/version/signer/organization; every downstream
 *  write and the recalculateContractStatus() call below operate on that
 *  already-resolved contractId, not on any client-supplied identity. */
export async function submitSignature(db: D1Database, env: StorageEnv, rawToken: string, input: SubmitSignatureInput, ip: string, userAgent: string): Promise<void> {
  const tokenHash = await hashSigningToken(rawToken);
  const existing = await get<{ id: number; status: string; contract_id: number }>(
    "SELECT id, status, contract_id FROM contract_signature_requests WHERE token_hash = ?", [tokenHash]
  );
  if (existing?.status === "signed") return; // idempotent — already done, nothing to re-process

  const view = await getSignatureRequestByToken(rawToken);
  if (!view) throw new ContractError("invalid_token", "This signing link is invalid or has expired");
  if (!view.request.consent_at) throw new ContractError("invalid_input", "Consent is required before signing");
  if (!SIGNATURE_METHODS.includes(input.signatureMethod as SignatureMethod)) throw new ContractError("invalid_input", "Unsupported signature method");
  if (!input.signerName || !input.signerName.trim()) throw new ContractError("invalid_input", "A typed legal name is required");

  const result = await run(
    `UPDATE contract_signature_requests SET status = 'signed', signed_at = datetime('now'), signature_method = ?, signer_ip = ?, signer_user_agent = ?, updated_at = datetime('now')
     WHERE token_hash = ? AND status IN ('pending','sent','viewed')`,
    [input.signatureMethod, ip, userAgent, tokenHash]
  );
  if (result.changes === 0) throw new ContractError("conflict", "This signing link was already used or is no longer valid");

  await run(
    "INSERT INTO contract_signature_events (signature_request_id, event_type, ip_address, user_agent, metadata) VALUES (?, 'signed', ?, ?, ?)",
    [view.request.id, ip, userAgent, JSON.stringify({ signer_name: input.signerName, signature_method: input.signatureMethod })]
  );

  await recalculateContractStatus(db, env, view.request.contract_id);
}

/** Same "no organizationId" reasoning as submitSignature() above. */
export async function declineSignature(db: D1Database, env: StorageEnv, rawToken: string, reason: string, ip: string, userAgent: string): Promise<void> {
  const view = await getSignatureRequestByToken(rawToken);
  if (!view) throw new ContractError("invalid_token", "This signing link is invalid or has expired");
  const tokenHash = await hashSigningToken(rawToken);
  const result = await run(
    "UPDATE contract_signature_requests SET status = 'declined', declined_reason = ?, updated_at = datetime('now') WHERE token_hash = ? AND status IN ('pending','sent','viewed')",
    [reason, tokenHash]
  );
  if (result.changes === 0) throw new ContractError("conflict", "This signing link was already used or is no longer valid");
  await run(
    "INSERT INTO contract_signature_events (signature_request_id, event_type, ip_address, user_agent, metadata) VALUES (?, 'declined', ?, ?, ?)",
    [view.request.id, ip, userAgent, JSON.stringify({ reason })]
  );
  await recalculateContractStatus(db, env, view.request.contract_id);
}

// ── Status derivation (mirrors financial.ts's recalculateStatus()) ──────

/** Derives contracts.status from the aggregate status of the CURRENT
 *  version's signature requests — the same "derive, don't directly set"
 *  precedent as invoices.status's partially_paid/paid (financial.ts's
 *  recalculateStatus()), applied to signature completion instead of
 *  payment completion. Also finalizes the signed document (Section 30)
 *  the moment every signer has completed. `contractId` is already fully
 *  resolved (from either an org-scoped admin action or a token lookup) by
 *  every caller — this function trusts it, matching quotes.ts's own
 *  internal-helper convention of not re-deriving trust it already has. */
async function recalculateContractStatus(db: D1Database, env: StorageEnv, contractId: number): Promise<void> {
  const contract = await get<Contract>("SELECT * FROM contracts WHERE id = ?", [contractId]);
  if (!contract || contract.current_version_id === null) return;
  const requests = await query<{ status: string }>("SELECT status FROM contract_signature_requests WHERE contract_version_id = ?", [contract.current_version_id]);
  if (requests.length === 0) return;

  let nextStatus: ContractStatus | null = null;
  if (requests.every((r) => r.status === "signed")) {
    nextStatus = "signed";
  } else if (requests.some((r) => r.status === "declined")) {
    nextStatus = "declined";
  } else if (requests.some((r) => r.status === "signed")) {
    nextStatus = "partially_signed";
  } else if (requests.every((r) => r.status === "expired" || r.status === "cancelled")) {
    nextStatus = "expired";
  }

  if (nextStatus && nextStatus !== contract.status) {
    await transitionContractInternal(db, { id: contract.id, status: contract.status, organization_id: contract.organization_id }, nextStatus, null, "Derived from signature request completion");
    if (nextStatus === "signed") {
      await finalizeSignedDocument(env, contract.organization_id, contractId, contract.current_version_id);
    }
  }
}

function renderSignedDocumentText(version: ContractVersion, requests: SignatureRequest[], signers: ContractSigner[]): string {
  const signerById = new Map(signers.map((s) => [s.id, s]));
  const lines = [
    `CONTRACT (signed rendering — not a formatted PDF; see Phase 13 docs)`,
    `Title: ${version.title}`,
    `Effective Date: ${version.effective_date ?? "N/A"}`,
    "",
    version.body,
    "",
    "--- Commercial Terms (snapshotted at contract creation) ---",
    version.commercial_snapshot,
    "",
    "--- Signatures ---",
  ];
  for (const req of requests) {
    const signer = signerById.get(req.signer_id);
    lines.push(`${signer?.name ?? "Unknown"} <${signer?.email ?? ""}> (${signer?.role ?? ""}) — signed ${req.signed_at} via ${req.signature_method}, consent v${req.consent_text_version} at ${req.consent_at}, IP ${req.signer_ip}`);
  }
  return lines.join("\n");
}

/** Section 30/42 — writes the final, immutable signed artifact to R2
 *  (server-side only, tenant-safe key, never overwritten — a fresh UUID
 *  every time this function runs, which happens at most once per version
 *  since it's only invoked from the signed-derivation above) and records
 *  its hash on the version row. NOT a real PDF — a plain-text rendering of
 *  the legal body + commercial terms + every signer's evidence, honestly
 *  disclosed as such (Section 31: "do not add a heavy PDF dependency
 *  without review" — none was added this phase). */
async function finalizeSignedDocument(env: StorageEnv, organizationId: number, contractId: number, versionId: number): Promise<void> {
  const version = (await get<ContractVersion>(`SELECT ${CONTRACT_VERSION_COLUMNS} FROM contract_versions WHERE id = ?`, [versionId]))!;
  const requests = await query<SignatureRequest>(`SELECT ${SIGNATURE_REQUEST_COLUMNS} FROM contract_signature_requests WHERE contract_version_id = ?`, [versionId]);
  const signers = await listContractSigners(contractId);

  const documentText = renderSignedDocumentText(version, requests, signers);
  const documentHash = await sha256Hex(documentText);
  const key = `contracts/${organizationId}/${contractId}/${versionId}/signed-${crypto.randomUUID()}.txt`;

  await putObject(env, key, new TextEncoder().encode(documentText).buffer as ArrayBuffer, "text/plain");
  await run("UPDATE contract_versions SET signed_document_key = ?, signed_document_hash = ?, signed_at = datetime('now') WHERE id = ?", [key, documentHash, versionId]);
}

export { sha256Hex };

// ── Evidence (Section 41/42) ─────────────────────────────────────────

export async function getSignatureEvents(requestId: number): Promise<SignatureEvent[]> {
  return query<SignatureEvent>("SELECT * FROM contract_signature_events WHERE signature_request_id = ? ORDER BY created_at ASC, id ASC", [requestId]);
}

export interface EvidencePackage {
  contract_identifier: string;
  version_number: number;
  document_hash: string | null;
  signed_document_hash: string | null;
  requests: (SignatureRequest & { signer: ContractSigner | undefined; events: SignatureEvent[] })[];
}

export async function getEvidencePackage(organizationId: number, contractId: number): Promise<EvidencePackage | null> {
  const contract = await getContract(organizationId, contractId);
  if (!contract || contract.current_version_id === null) return null;
  const version = await getContractVersion(contractId, contract.current_version_id);
  if (!version) return null;
  const requests = await listSignatureRequests(contractId);
  const signers = await listContractSigners(contractId);
  const signerById = new Map(signers.map((s) => [s.id, s]));
  const requestsWithEvents = await Promise.all(requests.map(async (r) => ({ ...r, signer: signerById.get(r.signer_id), events: await getSignatureEvents(r.id) })));
  return {
    contract_identifier: contract.identifier,
    version_number: version.version_number,
    document_hash: version.document_hash,
    signed_document_hash: version.signed_document_hash,
    requests: requestsWithEvents,
  };
}

