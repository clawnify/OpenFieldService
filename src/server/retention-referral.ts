import { get, query, run } from "./db.js";

/**
 * Phase 19D — referral program config, attribution, deterministic
 * qualification, and the unified reward/loyalty credit ledger.
 *
 * Referral code lifecycle: a referrer's link is minted on demand
 * (`createReferralCode`) as an 'active' row with no referred party yet.
 * Using the public link claims it exactly once (atomic
 * `WHERE referred_* IS NULL` UPDATE — a code can never be claimed twice,
 * no separate uniqueness table needed) -> 'pending'. A deterministic scan
 * (`scanReferralQualifications`, called from retention-automation.ts)
 * promotes 'pending' -> 'qualified' the moment the organization's
 * configured qualification event genuinely occurs, and atomically issues
 * exactly one reward via customer_credit_ledger's
 * UNIQUE(source_type, source_id) guard.
 */

export class ReferralError extends Error {
  code: "not_found" | "invalid_input" | "invalid_state" | "self_referral" | "conflict";
  constructor(code: ReferralError["code"], message: string) {
    super(message);
    this.name = "ReferralError";
    this.code = code;
  }
}

export const REWARD_TYPES = ["account_credit", "fixed_reward", "service_credit", "future_discount", "non_cash"] as const;
export type RewardType = typeof REWARD_TYPES[number];
export const QUALIFICATION_RULES = ["first_completed_job", "first_paid_invoice"] as const;
export type QualificationRule = typeof QUALIFICATION_RULES[number];

export interface ReferralProgramRow {
  id: number;
  organization_id: number;
  enabled: number;
  reward_type: RewardType;
  reward_value_cents: number | null;
  reward_description: string;
  qualification_rule: QualificationRule;
  created_at: string;
  updated_at: string;
}

export async function getReferralProgram(organizationId: number): Promise<ReferralProgramRow> {
  const row = await get<ReferralProgramRow>("SELECT * FROM referral_programs WHERE organization_id = ?", [organizationId]);
  if (row) return row;
  // Default, unconfigured state — disabled, never fabricated reward terms.
  return {
    id: 0, organization_id: organizationId, enabled: 0, reward_type: "account_credit",
    reward_value_cents: null, reward_description: "", qualification_rule: "first_completed_job",
    created_at: "", updated_at: "",
  };
}

export interface ReferralProgramInput {
  enabled: boolean;
  rewardType: RewardType;
  rewardValueCents?: number | null;
  rewardDescription?: string;
  qualificationRule: QualificationRule;
}

export async function upsertReferralProgram(organizationId: number, actorUserId: number, input: ReferralProgramInput): Promise<ReferralProgramRow> {
  if (!REWARD_TYPES.includes(input.rewardType)) throw new ReferralError("invalid_input", "Invalid reward_type");
  if (!QUALIFICATION_RULES.includes(input.qualificationRule)) throw new ReferralError("invalid_input", "Invalid qualification_rule");
  if (input.rewardValueCents != null && input.rewardValueCents < 0) throw new ReferralError("invalid_input", "reward_value_cents cannot be negative");

  const existing = await get<{ id: number }>("SELECT id FROM referral_programs WHERE organization_id = ?", [organizationId]);
  if (existing) {
    await run(
      `UPDATE referral_programs SET enabled = ?, reward_type = ?, reward_value_cents = ?, reward_description = ?, qualification_rule = ?, updated_by = ?, updated_at = datetime('now') WHERE organization_id = ?`,
      [input.enabled ? 1 : 0, input.rewardType, input.rewardValueCents ?? null, input.rewardDescription ?? "", input.qualificationRule, actorUserId, organizationId]
    );
  } else {
    await run(
      `INSERT INTO referral_programs (organization_id, enabled, reward_type, reward_value_cents, reward_description, qualification_rule, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [organizationId, input.enabled ? 1 : 0, input.rewardType, input.rewardValueCents ?? null, input.rewardDescription ?? "", input.qualificationRule, actorUserId]
    );
  }
  return getReferralProgram(organizationId);
}

// ── Attribution ──────────────────────────────────────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Opaque, non-enumerable, tenant-bound by construction (looked up by
 *  code alone, never combined with a client-supplied org id — Section 36).
 *  16 random bytes is ample for a link nobody can guess/brute-force. */
function generateReferralCode(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export interface ReferralRow {
  id: number;
  organization_id: number;
  referrer_customer_id: number;
  referred_customer_id: number | null;
  referred_lead_id: number | null;
  referral_code: string;
  status: string;
  qualifying_job_id: number | null;
  qualifying_invoice_id: number | null;
  qualified_at: string | null;
  rejected_reason: string;
  created_at: string;
  updated_at: string;
}

async function recordAudit(organizationId: number, entityType: string, entityId: number, eventType: string, actorUserId: number | null, details: Record<string, unknown>): Promise<void> {
  await run(
    "INSERT INTO retention_audit (organization_id, entity_type, entity_id, event_type, actor_user_id, details) VALUES (?, ?, ?, ?, ?, ?)",
    [organizationId, entityType, entityId, eventType, actorUserId, JSON.stringify(details)]
  );
}

/** Mints a fresh, single-use referral link for `referrerCustomerId`. Does
 *  NOT require the program to be enabled to mint (an admin may prepare
 *  links ahead of enabling), but the public claim route below refuses to
 *  attribute against a disabled program. */
export async function createReferralCode(organizationId: number, actorUserId: number, referrerCustomerId: number): Promise<ReferralRow> {
  const referrer = await get<{ id: number }>("SELECT id FROM customers WHERE id = ? AND organization_id = ?", [referrerCustomerId, organizationId]);
  if (!referrer) throw new ReferralError("not_found", "Referrer customer not found");

  const code = generateReferralCode();
  const result = await run(
    "INSERT INTO customer_referrals (organization_id, referrer_customer_id, referral_code, status) VALUES (?, ?, ?, 'active')",
    [organizationId, referrerCustomerId, code]
  );
  const id = Number(result.lastInsertRowid);
  await recordAudit(organizationId, "referral", id, "referral_code_created", actorUserId, { referrer_customer_id: referrerCustomerId });
  return getReferral(organizationId, id);
}

export async function getReferral(organizationId: number, id: number): Promise<ReferralRow> {
  const row = await get<ReferralRow>("SELECT * FROM customer_referrals WHERE id = ? AND organization_id = ?", [id, organizationId]);
  if (!row) throw new ReferralError("not_found", "Referral not found");
  return row;
}

export async function listReferrals(organizationId: number, filters: { referrerCustomerId?: number; status?: string } = {}): Promise<ReferralRow[]> {
  const conditions = ["organization_id = ?"];
  const params: unknown[] = [organizationId];
  if (filters.referrerCustomerId) { conditions.push("referrer_customer_id = ?"); params.push(filters.referrerCustomerId); }
  if (filters.status) { conditions.push("status = ?"); params.push(filters.status); }
  return query<ReferralRow>(`SELECT * FROM customer_referrals WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`, params);
}

/** Public: looks up an 'active', unclaimed code — never reveals anything
 *  about the referrer beyond what's needed for a friendly landing page. */
export async function getReferralByCode(code: string): Promise<{ organizationId: number; referrerName: string } | null> {
  const row = await get<{ organization_id: number; referrer_customer_id: number; status: string }>(
    "SELECT organization_id, referrer_customer_id, status FROM customer_referrals WHERE referral_code = ?", [code]
  );
  if (!row || row.status !== "active") return null;
  const referrer = await get<{ name: string }>("SELECT name FROM customers WHERE id = ?", [row.referrer_customer_id]);
  return { organizationId: row.organization_id, referrerName: referrer?.name ?? "a customer" };
}

const DEFAULT_LEAD_PREFIX = "LEAD";

async function nextLeadIdentifier(): Promise<string> {
  const prefix = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'lead_prefix'");
  const counter = await get<{ value: string }>(
    "UPDATE _meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'lead_counter' RETURNING value"
  );
  return `${prefix?.value || DEFAULT_LEAD_PREFIX}-${counter!.value}`;
}

export interface ClaimReferralInput { name: string; phone?: string; email?: string }

/** Public referral-landing submission — creates a new Lead attributed to
 *  the referrer (reusing leads' EXISTING referral_source/referral_name/
 *  referred_by_customer_id columns from Phase 3/8.0, never a duplicate
 *  attribution field) and atomically claims the code (`WHERE
 *  referred_lead_id IS NULL AND referred_customer_id IS NULL` — a code can
 *  only ever be claimed once; a race loses cleanly with `changes === 0`).
 *  Self-referral (the referrer submitting their own code) is rejected —
 *  matched by phone/email against the referrer's own contact info. */
/** Digits-only comparison — a referrer submitting their own link with the
 *  phone reformatted ("(604) 555-1234" vs. the stored "6045551234") must
 *  not defeat the self-referral guard (Security review finding, Phase
 *  19D). Email already normalizes via .toLowerCase(); phone had no
 *  normalization at all before this fix. */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export async function claimReferralCode(code: string, input: ClaimReferralInput): Promise<{ leadId: number } | null> {
  const referral = await get<{ id: number; organization_id: number; referrer_customer_id: number; status: string }>(
    "SELECT id, organization_id, referrer_customer_id, status FROM customer_referrals WHERE referral_code = ?", [code]
  );
  if (!referral || referral.status !== "active") return null;

  // A disabled program must stop new attribution outright — a previously
  // minted code (e.g. shared before an admin disabled the program for
  // abuse) must not keep creating Leads/eventually issuing rewards (Code
  // Review finding, Phase 19D — this was previously only true in a doc
  // comment, never actually enforced in code).
  const program = await getReferralProgram(referral.organization_id);
  if (!program.enabled) return null;

  const referrer = await get<{ name: string; phone: string; email: string }>(
    "SELECT name, phone, email FROM customers WHERE id = ?", [referral.referrer_customer_id]
  );
  if (!referrer) return null;
  const referredPhone = (input.phone ?? "").trim();
  const referredEmail = (input.email ?? "").trim().toLowerCase();
  const referredPhoneDigits = normalizePhone(referredPhone);
  const referrerPhoneDigits = normalizePhone(referrer.phone);
  if ((referredPhoneDigits && referredPhoneDigits === referrerPhoneDigits) || (referredEmail && referredEmail === referrer.email.toLowerCase())) {
    await recordAudit(referral.organization_id, "referral", referral.id, "referral_self_referral_rejected", null, {});
    return null;
  }

  const identifier = await nextLeadIdentifier();
  const leadResult = await run(
    `INSERT INTO leads (identifier, name, phone, email, referral_source, referral_name, referred_by_customer_id, organization_id)
     VALUES (?, ?, ?, ?, 'Existing Customer', ?, ?, ?)`,
    [identifier, input.name.trim().slice(0, 200), referredPhone, referredEmail, referrer.name, referral.referrer_customer_id, referral.organization_id]
  );
  const leadId = Number(leadResult.lastInsertRowid);

  const claim = await run(
    "UPDATE customer_referrals SET referred_lead_id = ?, status = 'pending', updated_at = datetime('now') WHERE id = ? AND referred_lead_id IS NULL AND referred_customer_id IS NULL",
    [leadId, referral.id]
  );
  if (claim.changes === 0) {
    // Lost the claim race — leave the Lead record (harmless, real intake
    // data) but do not report a successful referral attribution.
    return null;
  }
  await recordAudit(referral.organization_id, "referral", referral.id, "referral_claimed", null, { lead_id: leadId });
  return { leadId };
}

/** Deterministic qualification scan — server-authoritative, per the
 *  organization's own configured rule. Never rewards merely because a
 *  Lead was created (Section 16's explicit rule) — only a genuine
 *  business event on the CONVERTED customer counts. */
export async function scanReferralQualifications(organizationId: number): Promise<{ qualified: number; rewarded: number }> {
  const program = await getReferralProgram(organizationId);
  if (!program.enabled) return { qualified: 0, rewarded: 0 };

  const pending = await query<ReferralRow>("SELECT * FROM customer_referrals WHERE organization_id = ? AND status = 'pending'", [organizationId]);
  let qualified = 0, rewarded = 0;

  for (const referral of pending) {
    let referredCustomerId = referral.referred_customer_id;
    if (!referredCustomerId && referral.referred_lead_id) {
      const lead = await get<{ converted_customer_id: number | null }>(
        "SELECT converted_customer_id FROM leads WHERE id = ?", [referral.referred_lead_id]
      );
      referredCustomerId = lead?.converted_customer_id ?? null;
      if (referredCustomerId) {
        await run("UPDATE customer_referrals SET referred_customer_id = ? WHERE id = ?", [referredCustomerId, referral.id]);
      }
    }
    if (!referredCustomerId) continue; // referred Lead hasn't converted yet — nothing to qualify

    let qualifyingJobId: number | null = null;
    let qualifyingInvoiceId: number | null = null;
    if (program.qualification_rule === "first_completed_job") {
      const job = await get<{ id: number }>(
        "SELECT id FROM jobs WHERE customer_id = ? AND status = 'completed' ORDER BY id ASC LIMIT 1", [referredCustomerId]
      );
      if (!job) continue;
      qualifyingJobId = job.id;
    } else {
      const invoice = await get<{ id: number }>(
        "SELECT id FROM invoices WHERE customer_id = ? AND status = 'paid' ORDER BY id ASC LIMIT 1", [referredCustomerId]
      );
      if (!invoice) continue;
      qualifyingInvoiceId = invoice.id;
    }

    const claim = await run(
      "UPDATE customer_referrals SET status = 'qualified', qualified_at = datetime('now'), qualifying_job_id = ?, qualifying_invoice_id = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
      [qualifyingJobId, qualifyingInvoiceId, referral.id]
    );
    if (claim.changes === 0) continue; // lost a concurrent qualification race
    qualified++;
    await recordAudit(organizationId, "referral", referral.id, "referral_qualified", null, { qualifying_job_id: qualifyingJobId, qualifying_invoice_id: qualifyingInvoiceId });

    const issued = await issueReward(organizationId, {
      customerId: referral.referrer_customer_id, sourceType: "referral_reward", sourceId: referral.id,
      amountCents: program.reward_value_cents, valueDescription: program.reward_description,
      reason: `Referral reward for referring ${referredCustomerId ? "a new customer" : ""}`.trim(), actorUserId: null,
    });
    if (issued) rewarded++;
  }
  return { qualified, rewarded };
}

// ── Unified reward / loyalty credit ledger ──────────────────────────────

export interface CreditLedgerRow {
  id: number;
  organization_id: number;
  customer_id: number;
  source_type: string;
  source_id: number | null;
  amount_cents: number | null;
  value_description: string;
  status: string;
  reason: string;
  issued_at: string;
  voided_at: string | null;
  void_reason: string;
  redeemed_at: string | null;
  redeemed_reason: string;
  actor_user_id: number | null;
  created_at: string;
}

export interface IssueRewardInput {
  customerId: number;
  sourceType: "referral_reward" | "loyalty_grant";
  sourceId: number | null;
  amountCents: number | null;
  valueDescription: string;
  reason: string;
  actorUserId: number | null;
}

/** UNIQUE(source_type, source_id) WHERE source_id IS NOT NULL is the real
 *  idempotency guard (Section 17) — a claim-first INSERT, catch-and-return-
 *  null on conflict, same idiom as every other duplicate-prevention guard
 *  in this codebase. A manual loyalty_grant (sourceId=null) has no such
 *  constraint by design — an admin can genuinely issue multiple separate
 *  grants to the same customer. */
export async function issueReward(organizationId: number, input: IssueRewardInput): Promise<CreditLedgerRow | null> {
  if (input.amountCents != null && input.amountCents < 0) throw new ReferralError("invalid_input", "amount_cents cannot be negative");
  try {
    const result = await run(
      `INSERT INTO customer_credit_ledger (organization_id, customer_id, source_type, source_id, amount_cents, value_description, reason, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [organizationId, input.customerId, input.sourceType, input.sourceId, input.amountCents, input.valueDescription, input.reason, input.actorUserId]
    );
    const id = Number(result.lastInsertRowid);
    await recordAudit(organizationId, "loyalty_credit", id, "credit_issued", input.actorUserId, { source_type: input.sourceType, source_id: input.sourceId, amount_cents: input.amountCents });
    return get<CreditLedgerRow>("SELECT * FROM customer_credit_ledger WHERE id = ?", [id]) as Promise<CreditLedgerRow>;
  } catch {
    return null; // lost the UNIQUE(source_type, source_id) race — reward already issued for this referral
  }
}

export async function listCreditLedger(organizationId: number, customerId?: number): Promise<CreditLedgerRow[]> {
  if (customerId) {
    return query<CreditLedgerRow>("SELECT * FROM customer_credit_ledger WHERE organization_id = ? AND customer_id = ? ORDER BY issued_at DESC", [organizationId, customerId]);
  }
  return query<CreditLedgerRow>("SELECT * FROM customer_credit_ledger WHERE organization_id = ? ORDER BY issued_at DESC", [organizationId]);
}

/** Manual admin-issued loyalty grant — always sourceId=null (no
 *  referral-style idempotency needed; every explicit admin action is
 *  independently intentional). */
export async function issueLoyaltyGrant(
  organizationId: number, actorUserId: number, customerId: number, amountCents: number | null, valueDescription: string, reason: string
): Promise<CreditLedgerRow> {
  const customer = await get<{ id: number }>("SELECT id FROM customers WHERE id = ? AND organization_id = ?", [customerId, organizationId]);
  if (!customer) throw new ReferralError("not_found", "Customer not found");
  if (amountCents != null && amountCents < 0) throw new ReferralError("invalid_input", "amount_cents cannot be negative");
  const result = await run(
    `INSERT INTO customer_credit_ledger (organization_id, customer_id, source_type, source_id, amount_cents, value_description, reason, actor_user_id)
     VALUES (?, ?, 'loyalty_grant', NULL, ?, ?, ?, ?)`,
    [organizationId, customerId, amountCents, valueDescription, reason, actorUserId]
  );
  const id = Number(result.lastInsertRowid);
  await recordAudit(organizationId, "loyalty_credit", id, "credit_issued", actorUserId, { source_type: "loyalty_grant", amount_cents: amountCents });
  return (await get<CreditLedgerRow>("SELECT * FROM customer_credit_ledger WHERE id = ?", [id]))!;
}

/** Voiding is the only reversal this phase implements — real invoice
 *  redemption is explicitly deferred to Phase 21 (Section 19). "Mark
 *  redeemed" below is a manual bookkeeping state only, never wired into
 *  the invoice/payment engine. */
export async function voidCredit(organizationId: number, id: number, actorUserId: number, reason: string): Promise<CreditLedgerRow> {
  const credit = await get<CreditLedgerRow>("SELECT * FROM customer_credit_ledger WHERE id = ? AND organization_id = ?", [id, organizationId]);
  if (!credit) throw new ReferralError("not_found", "Credit not found");
  if (credit.status !== "issued") throw new ReferralError("invalid_state", "Only an issued credit can be voided");
  await run("UPDATE customer_credit_ledger SET status = 'voided', voided_at = datetime('now'), void_reason = ? WHERE id = ?", [reason, id]);
  await recordAudit(organizationId, "loyalty_credit", id, "credit_voided", actorUserId, { reason });
  return (await get<CreditLedgerRow>("SELECT * FROM customer_credit_ledger WHERE id = ?", [id]))!;
}

export async function markCreditRedeemed(organizationId: number, id: number, actorUserId: number, reason: string): Promise<CreditLedgerRow> {
  const credit = await get<CreditLedgerRow>("SELECT * FROM customer_credit_ledger WHERE id = ? AND organization_id = ?", [id, organizationId]);
  if (!credit) throw new ReferralError("not_found", "Credit not found");
  if (credit.status !== "issued") throw new ReferralError("invalid_state", "Only an issued credit can be marked redeemed");
  await run("UPDATE customer_credit_ledger SET status = 'redeemed', redeemed_at = datetime('now'), redeemed_reason = ? WHERE id = ?", [reason, id]);
  await recordAudit(organizationId, "loyalty_credit", id, "credit_redeemed", actorUserId, { reason });
  return (await get<CreditLedgerRow>("SELECT * FROM customer_credit_ledger WHERE id = ?", [id]))!;
}

/** Available (issued, not voided/redeemed) balance for a customer — a pure
 *  read, never a stored/mutable balance column (same "never store a
 *  derived money value" discipline as Phase 5's invoice financials). */
export async function getAvailableCreditBalance(organizationId: number, customerId: number): Promise<number> {
  const row = await get<{ total: number }>(
    "SELECT COALESCE(SUM(amount_cents), 0) as total FROM customer_credit_ledger WHERE organization_id = ? AND customer_id = ? AND status = 'issued' AND amount_cents IS NOT NULL",
    [organizationId, customerId]
  );
  return row?.total ?? 0;
}
