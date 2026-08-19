import { get, query, run } from "./db.js";
import { resolveReferralAttribution } from "./customers.js";
import { LeadWorkflowError, transitionLead } from "./lead-workflow.js";

/**
 * Lead -> Customer conversion (Phase 8.3). A converted Lead is never
 * "deleted" or replaced — it remains the historical source record,
 * pointing at the resulting Customer via `converted_customer_id`/
 * `converted_at`/`converted_by`. This module does NOT create a Job (see
 * the module-level note below) and does NOT touch the Lead transition
 * matrix — `transitionLead()` (Phase 8.1, unmodified) remains the sole
 * authority for the `estimate -> won` move this module may trigger.
 *
 * Job creation: deliberately NOT implemented. The approved Phase 8.0
 * decision ("Conversion is Lead -> (Existing or New) Customer -> Job")
 * describes the eventual relationship topology (a Customer's Jobs must
 * always go through Customer, never a direct Lead -> Job link) — it does
 * not mandate that converting a Lead automatically creates a Job. No
 * approved decision specifies Job field mapping, scheduling defaults, or
 * technician assignment for an auto-created Job, and inventing those here
 * would mean guessing an entire second business flow. A Customer created by
 * this module can have Jobs created against it afterward through the
 * existing, unmodified `POST /api/jobs` path, same as any other Customer.
 *
 * Lead.name -> Customer.name: Lead has a single `name` field (migration
 * 0010) and Customer *also* has a single `name` field (migration 0001) —
 * there is no first/last/company split on either side, so this mapping is
 * direct and unambiguous. This resolves the "name/company" question the
 * Phase 8.1/8.2 tasks each flagged as an open discrepancy: it turns out not
 * to matter for conversion specifically, because both schemas already agree
 * on a single plain `name` column.
 *
 * Duplicate Customer policy: no duplicate-detection mechanism exists
 * anywhere in this codebase today (grepped — confirmed) despite the
 * approved decision explicitly anticipating "(Existing or New) Customer" as
 * a valid conversion outcome, and despite the original pre-implementation
 * investigation naming the mechanism ("dedupe by phone/email... conversion
 * is create OR link") without ever building it. This module implements
 * exactly that: a full-table scan over `customers` (this project's existing
 * scale-appropriate precedent — see `listAllCustomers` — not a new
 * performance concern) matching on normalized email (trim+lowercase) or
 * normalized phone (digits only), each signal only applied when the Lead
 * actually has a non-empty value for it (a blank Lead phone/email never
 * matches a blank Customer phone/email). Zero matches -> create a new
 * Customer. Exactly one match -> reuse it, and do NOT overwrite any of its
 * existing fields (an existing Customer's own accumulated data must never
 * be silently clobbered by a new Lead's intake data — same "loose
 * attribution, preserve historical truth" philosophy already used
 * throughout this schema). More than one match -> reject with a
 * deterministic conflict rather than guessing; there is no
 * duplicate-resolution UI/field in this v1 (documented as a known
 * limitation, not silently handled).
 */

export type LeadConversionErrorCode = "not_found" | "invalid_state" | "ambiguous_match" | "conflict";

export class LeadConversionError extends Error {
  code: LeadConversionErrorCode;
  constructor(code: LeadConversionErrorCode, message: string) {
    super(message);
    this.name = "LeadConversionError";
    this.code = code;
  }
}

interface LeadConversionRow {
  id: number;
  status: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  notes: string;
  referral_source: string;
  referral_name: string;
  referred_by_customer_id: number | null;
  converted_customer_id: number | null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

async function findMatchingCustomerIds(lead: { phone: string; email: string }): Promise<number[]> {
  const email = normalizeEmail(lead.email || "");
  const phone = normalizePhone(lead.phone || "");
  if (!email && !phone) return [];
  const rows = await query<{ id: number; email: string; phone: string }>("SELECT id, email, phone FROM customers");
  const matched = new Set<number>();
  for (const c of rows) {
    if (email && normalizeEmail(c.email) === email) matched.add(c.id);
    if (phone && normalizePhone(c.phone) === phone) matched.add(c.id);
  }
  return [...matched];
}

export interface ConvertLeadInput {
  /** Real, server-resolved actor id — never a value trusted from a request body. */
  actorUserId: number;
}

export interface ConvertLeadOutcome {
  leadId: number;
  customerId: number;
  /** true if a brand-new Customer row was created; false if an existing
   *  Customer was matched and reused. */
  created: boolean;
}

/**
 * THE authoritative way to convert a Lead into a Customer. Validates
 * current state, resolves an existing-or-new Customer, and atomically
 * records the conversion on the Lead. Throws LeadConversionError for every
 * rejection case; CustomerValidationError (from customers.ts, re-thrown
 * unchanged) for invalid referral attribution.
 *
 * Two-phase atomicity, not one: if the Lead is still in "estimate", this
 * calls transitionLead() first — which is its OWN complete, atomic,
 * concurrency-guarded unit (Phase 8.1, unmodified; this module must not
 * duplicate or weaken it). Only after that succeeds (or is skipped because
 * the Lead is already "won") does the Customer-resolution +
 * conversion-metadata write run as a SECOND atomic unit. This is a
 * deliberate architectural boundary, not a compromise: `transitionLead()`
 * cannot be handed extra statements to fold into its internal db.batch()
 * without changing its signature (forbidden by this phase's own rules), so
 * the true atomic unit here is smaller than "the whole conversion." This is
 * safe, not merely convenient, because the intermediate state
 * (status="won", converted_customer_id=NULL) is itself a well-defined,
 * already-tested, retriable state — Phase 8.1 explicitly proved a normal
 * estimate->won transition never touches the conversion columns, and this
 * function accepts a Lead that is ALREADY "won" and unconverted as a valid
 * starting point (see below), which is exactly what makes retrying a
 * failed second phase safe: calling convertLead() again on that same Lead
 * just skips phase one and re-attempts phase two.
 *
 * Phase two's own atomicity: a genuinely new Customer is created and the
 * Lead's conversion columns are written in ONE db.batch() (INSERT customer,
 * then UPDATE leads ... SET converted_customer_id = last_insert_rowid()
 * WHERE id = ? AND converted_customer_id IS NULL — the guard is what makes
 * this concurrency-safe). Because a 0-row UPDATE is a successful statement,
 * not a SQL error, D1 does not roll back the sibling INSERT just because
 * the guard didn't match — so a stale/duplicate racer's Customer INSERT
 * would otherwise survive orphaned. This function detects that (the
 * UPDATE's own reported change count) and compensates by deleting exactly
 * the just-inserted Customer row before reporting the conflict — the same
 * detect-and-compensate pattern `transitionLead()` established in Phase
 * 8.1, reused here rather than reinvented, for the same underlying D1
 * batch-semantics reason. The "reuse an existing Customer" branch never
 * creates anything to compensate for; its guarded UPDATE alone is the
 * entire atomic unit.
 */
export async function convertLead(db: D1Database, leadId: number, input: ConvertLeadInput): Promise<ConvertLeadOutcome> {
  const lead = await get<LeadConversionRow>(
    `SELECT id, status, name, phone, email, address, city, state, zip, notes,
            referral_source, referral_name, referred_by_customer_id, converted_customer_id
     FROM leads WHERE id = ?`,
    [leadId]
  );
  if (!lead) throw new LeadConversionError("not_found", "Lead not found");

  if (lead.converted_customer_id !== null) {
    throw new LeadConversionError("conflict", "This lead has already been converted");
  }

  if (lead.status !== "estimate" && lead.status !== "won") {
    throw new LeadConversionError(
      "invalid_state",
      `Cannot convert a lead in "${lead.status}" status — it must be in "estimate" or "won" status`
    );
  }

  if (lead.status === "estimate") {
    try {
      await transitionLead(db, leadId, { toStatus: "won", actorUserId: input.actorUserId, reason: "Converted to customer" });
    } catch (err) {
      if (err instanceof LeadWorkflowError) {
        if (err.code === "conflict") {
          throw new LeadConversionError("conflict", "This lead was changed by another request — reload and try again");
        }
        // not_found/invalid_transition/missing_data here would mean the Lead
        // changed state between the read above and this call (e.g. a
        // concurrent transition moved it somewhere transitionLead() no
        // longer accepts "won" from) — surface as a state conflict rather
        // than losing the original error's meaning.
        throw new LeadConversionError("conflict", err.message);
      }
      throw err;
    }
  }

  const matches = await findMatchingCustomerIds({ phone: lead.phone, email: lead.email });
  if (matches.length > 1) {
    throw new LeadConversionError(
      "ambiguous_match",
      "Multiple existing customers match this lead's phone or email — resolve the duplicate manually before converting"
    );
  }

  if (matches.length === 1) {
    const customerId = matches[0];
    const result = await run(
      "UPDATE leads SET converted_customer_id = ?, converted_at = datetime('now'), converted_by = ? WHERE id = ? AND converted_customer_id IS NULL",
      [customerId, input.actorUserId, leadId]
    );
    if (result.changes === 0) {
      throw new LeadConversionError("conflict", "This lead was already converted by another request");
    }
    return { leadId, customerId, created: false };
  }

  // Propagates CustomerValidationError unchanged on failure — the route
  // layer already knows how to map that to a 400, same as createCustomer.
  const referral = await resolveReferralAttribution(
    { referral_source: lead.referral_source, referral_name: lead.referral_name, referred_by_customer_id: lead.referred_by_customer_id },
    null, null
  );

  const results = await db.batch([
    db.prepare(
      `INSERT INTO customers (name, email, phone, address, city, state, zip, notes,
         referral_source, referral_name, referred_by_customer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      lead.name, lead.email, lead.phone, lead.address, lead.city, lead.state, lead.zip, lead.notes,
      referral.referral_source, referral.referral_name, referral.referred_by_customer_id
    ),
    db.prepare(
      "UPDATE leads SET converted_customer_id = last_insert_rowid(), converted_at = datetime('now'), converted_by = ? WHERE id = ? AND converted_customer_id IS NULL"
    ).bind(input.actorUserId, leadId),
  ]);

  const updateChanges = results[1]?.meta?.changes ?? 0;
  if (updateChanges === 0) {
    const newCustomerId = results[0]?.meta?.last_row_id;
    if (newCustomerId) await run("DELETE FROM customers WHERE id = ?", [newCustomerId]);
    throw new LeadConversionError("conflict", "This lead was already converted by another request");
  }

  const newCustomerId = results[0]?.meta?.last_row_id;
  return { leadId, customerId: Number(newCustomerId), created: true };
}
