import { get, query, run } from "./db.js";
import { getSettingValue } from "./settings.js";
import { checkServiceEligibility } from "./retention-consent.js";
import { getCustomerContact, safeEnqueue, enqueueEvent } from "./notifications.js";
import { listMaintenancePlans } from "./maintenance-plans.js";

/**
 * Phase 19D — post-job satisfaction follow-up, review request, and
 * maintenance-plan offer. One row per qualifying Job (customer_follow_ups,
 * migration 0029) — service-adjacent, gated by the EXISTING transactional
 * notification_preferences toggle (checkServiceEligibility), never the new
 * marketing consent tier. Reuses Phase 9's notification_outbox for the
 * actual send (no parallel delivery system) and a bearer public token
 * (same primitive shape as Phase 19B's e-sign tokens) for the one
 * customer-facing action this flow needs: responding.
 */

export interface Actor { id: number; role: "admin" | "dispatcher" | "technician" }

export function canManageRetention(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "dispatcher";
}

export class FollowUpError extends Error {
  code: "not_found" | "invalid_input" | "invalid_state" | "token_invalid";
  constructor(code: FollowUpError["code"], message: string) {
    super(message);
    this.name = "FollowUpError";
    this.code = code;
  }
}

const DEFAULT_FOLLOWUP_DELAY_DAYS = 7;

export async function getFollowUpDelayDays(organizationId: number): Promise<number> {
  const value = await getSettingValue<number>(organizationId, "POST_JOB_FOLLOWUP_DAYS");
  // 0 is a genuine, deliberate admin choice ("follow up the same day") —
  // only a missing/negative/non-finite value falls back to the default.
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_FOLLOWUP_DELAY_DAYS;
}

/** Unconfigured (null) means review requests stay disabled entirely — never
 *  a hardcoded/fabricated destination (Section 12/43's explicit rule). */
export async function getReviewRequestUrl(organizationId: number): Promise<string | null> {
  const value = await getSettingValue<string>(organizationId, "REVIEW_REQUEST_URL");
  return value && value.trim() ? value.trim() : null;
}

/** No server module before Phase 19D ever needed to embed a public link
 *  in an email body (Phase 19B's signing links are always shared manually
 *  by staff, never auto-emailed) — and a Cloudflare `scheduled()` cron
 *  tick has no incoming HTTP request to derive an origin from at all. A
 *  new, organization-configurable Global Setting is the minimal honest
 *  fix, reusing settings.ts rather than inventing a wrangler.toml/env var.
 *  Unconfigured (null) means the follow-up email/SMS falls back to a
 *  contact-us message with no broken link — never a fabricated URL. */
export async function getAppPublicUrl(organizationId: number): Promise<string | null> {
  const value = await getSettingValue<string>(organizationId, "APP_PUBLIC_URL");
  return value && value.trim() ? value.trim().replace(/\/+$/, "") : null;
}

// ── Token primitives — same tiny Web-Crypto shape already duplicated in
// contracts.ts/maintenance-agreements.ts rather than shared, per this
// codebase's own established convention for this exact primitive. ────────

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateFollowUpToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashFollowUpToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

async function recordAudit(organizationId: number, entityId: number, eventType: string, actorUserId: number | null, details: Record<string, unknown>): Promise<void> {
  await run(
    "INSERT INTO retention_audit (organization_id, entity_type, entity_id, event_type, actor_user_id, details) VALUES (?, 'follow_up', ?, ?, ?, ?)",
    [organizationId, entityId, eventType, actorUserId, JSON.stringify(details)]
  );
}

export interface FollowUpRow {
  id: number;
  organization_id: number;
  job_id: number;
  customer_id: number;
  status: string;
  due_date: string;
  sent_at: string | null;
  response: string;
  response_notes: string;
  responded_at: string | null;
  review_status: string;
  review_sent_at: string | null;
  review_clicked_at: string | null;
  maintenance_offer_shown: number;
  closed_at: string | null;
  token_hash: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listFollowUps(organizationId: number, filters: { status?: string } = {}): Promise<FollowUpRow[]> {
  if (filters.status) {
    return query<FollowUpRow>(
      "SELECT * FROM customer_follow_ups WHERE organization_id = ? AND status = ? ORDER BY due_date ASC",
      [organizationId, filters.status]
    );
  }
  return query<FollowUpRow>("SELECT * FROM customer_follow_ups WHERE organization_id = ? ORDER BY due_date ASC", [organizationId]);
}

export async function getFollowUp(organizationId: number, id: number): Promise<FollowUpRow> {
  const row = await get<FollowUpRow>("SELECT * FROM customer_follow_ups WHERE id = ? AND organization_id = ?", [id, organizationId]);
  if (!row) throw new FollowUpError("not_found", "Follow-up not found");
  return row;
}

/** Server-authoritative eligibility for a single Job — never trusts a
 *  client-supplied eligibility claim (Section 9). Returns null when NOT
 *  eligible, with the reason implicit in which check failed (never
 *  throws for an ordinary ineligibility — mirrors enqueueChannel()'s own
 *  "ordinary skip is a value, not an exception" convention). */
async function isJobEligibleForFollowUp(organizationId: number, jobId: number): Promise<{ customerId: number; completedAt: string } | null> {
  const job = await get<{ id: number; customer_id: number; status: string }>(
    "SELECT id, customer_id, status FROM jobs WHERE id = ? AND organization_id = ?", [jobId, organizationId]
  );
  if (!job || job.status !== "completed") return null;
  const completion = await get<{ created_at: string }>(
    "SELECT created_at FROM job_status_history WHERE job_id = ? AND to_status = 'completed' ORDER BY id DESC LIMIT 1",
    [jobId]
  );
  if (!completion) return null;
  const existing = await get<{ id: number }>("SELECT id FROM customer_follow_ups WHERE job_id = ?", [jobId]);
  if (existing) return null; // already has a follow-up — UNIQUE(job_id) is the real guard, this is just a fast-path skip
  return { customerId: job.customer_id, completedAt: completion.created_at };
}

function isoDate(dt: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return isoDate(dt);
}

/** Creates one follow-up row for a newly-eligible Job — claim-first INSERT
 *  under UNIQUE(job_id), catch-and-adopt on conflict, same idempotency
 *  idiom as every other occurrence/entitlement guard in this codebase.
 *  Never sends anything itself — scanning/sending is
 *  retention-automation.ts's job, this is pure row creation. */
export async function createFollowUpForJob(organizationId: number, jobId: number): Promise<FollowUpRow | null> {
  const eligible = await isJobEligibleForFollowUp(organizationId, jobId);
  if (!eligible) return null;
  const delayDays = await getFollowUpDelayDays(organizationId);
  const dueDate = addDays(eligible.completedAt, delayDays);
  try {
    const result = await run(
      "INSERT INTO customer_follow_ups (organization_id, job_id, customer_id, due_date) VALUES (?, ?, ?, ?)",
      [organizationId, jobId, eligible.customerId, dueDate]
    );
    const id = Number(result.lastInsertRowid);
    await recordAudit(organizationId, id, "follow_up_created", null, { job_id: jobId, due_date: dueDate });
    return getFollowUp(organizationId, id);
  } catch {
    return null; // lost the UNIQUE(job_id) race — another call already created it
  }
}

/** Sends the follow-up (email/SMS via the existing notification pipeline,
 *  service-adjacent consent tier) once its due_date has arrived. Never
 *  sends twice — status must be exactly 'pending'. */
export async function sendFollowUp(organizationId: number, followUpId: number): Promise<boolean> {
  const followUp = await getFollowUp(organizationId, followUpId);
  if (followUp.status !== "pending") return false;

  const contact = await getCustomerContact(followUp.customer_id);
  if (!contact) {
    await run("UPDATE customer_follow_ups SET status = 'failed', updated_at = datetime('now') WHERE id = ?", [followUpId]);
    return false;
  }

  const emailEligible = await checkServiceEligibility(followUp.customer_id, "email");
  const smsEligible = await checkServiceEligibility(followUp.customer_id, "sms");
  if (!emailEligible.eligible && !smsEligible.eligible) {
    await run("UPDATE customer_follow_ups SET status = 'suppressed', updated_at = datetime('now') WHERE id = ?", [followUpId]);
    await recordAudit(organizationId, followUpId, "follow_up_suppressed", null, { emailReason: emailEligible.reason, smsReason: smsEligible.reason });
    return false;
  }

  const token = generateFollowUpToken();
  const tokenHash = await hashFollowUpToken(token);
  const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  await run(
    "UPDATE customer_follow_ups SET token_hash = ?, token_expires_at = ? WHERE id = ?",
    [tokenHash, tokenExpiresAt, followUpId]
  );

  const baseUrl = await getAppPublicUrl(organizationId);
  const responseUrl = baseUrl ? `${baseUrl}/follow-up/${token}` : "";

  let didSend = false;
  await safeEnqueue(async () => {
    const results = await enqueueEvent({
      eventType: "retention.followup_request", entityType: "follow_up", entityId: followUpId,
      recipientType: "customer", recipientId: followUp.customer_id,
      email: contact.email, phone: contact.phone,
      templateKey: "follow_up_request_v1",
      payload: { customer_name: contact.name, response_url: responseUrl },
      discriminator: followUpId,
    });
    didSend = results.email.enqueued || results.sms.enqueued;
  });

  if (!didSend) {
    await run("UPDATE customer_follow_ups SET status = 'failed', updated_at = datetime('now') WHERE id = ?", [followUpId]);
    return false;
  }

  await run("UPDATE customer_follow_ups SET status = 'sent', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [followUpId]);
  await recordAudit(organizationId, followUpId, "follow_up_sent", null, {});
  return true;
}

// ── Public, token-scoped response flow ──────────────────────────────────

interface PublicFollowUpView {
  followUpId: number;
  organizationId: number;
  status: string;
  jobIdentifier: string;
  customerName: string;
}

/** The public entry point for the token flow — resolves and returns the
 *  follow-up's own organization_id directly, since a public caller never
 *  knows (or can be trusted to supply) it. Every other function in this
 *  module's public flow (respondToFollowUp/markReviewClicked) takes that
 *  resolved id as an explicit parameter rather than re-deriving it. */
export async function getFollowUpByToken(token: string): Promise<PublicFollowUpView> {
  const tokenHash = await hashFollowUpToken(token);
  const row = await get<FollowUpRow & { job_identifier: string; customer_name: string }>(
    `SELECT cf.*, j.identifier as job_identifier, c.name as customer_name
     FROM customer_follow_ups cf JOIN jobs j ON j.id = cf.job_id JOIN customers c ON c.id = cf.customer_id
     WHERE cf.token_hash = ?`,
    [tokenHash]
  );
  if (!row) throw new FollowUpError("token_invalid", "This link is invalid or has expired");
  if (row.token_expires_at && new Date(row.token_expires_at) < new Date()) {
    throw new FollowUpError("token_invalid", "This link is invalid or has expired");
  }
  return { followUpId: row.id, organizationId: row.organization_id, status: row.status, jobIdentifier: row.job_identifier, customerName: row.customer_name };
}

export interface RespondResult {
  status: string;
  reviewUrl: string | null;
  planOffer: { id: number; name: string; description: string; tier: string; priceCents: number }[] | null;
}

/** The customer's response — 'satisfied' or 'needs_attention'. A negative
 *  response NEVER routes into the review-request path (Section 11's
 *  explicit negative-feedback guard) — it only ever creates an internal
 *  escalation for staff to follow up on. Idempotent: responding twice
 *  through the same token just returns the current state, never
 *  double-processes (no duplicate review-eligible transition, no second
 *  audit spam beyond the one genuine transition). */
export async function respondToFollowUp(
  organizationId: number, token: string, response: "satisfied" | "needs_attention", notes: string
): Promise<RespondResult> {
  const view = await getFollowUpByToken(token);
  const followUp = await getFollowUp(organizationId, view.followUpId);

  if (followUp.response) {
    // Already responded — idempotent re-read, not a re-process.
    const reviewUrl = followUp.review_status !== "not_eligible" ? await getReviewRequestUrl(organizationId) : null;
    return { status: followUp.status, reviewUrl, planOffer: null };
  }

  const isSatisfied = response === "satisfied";
  const newStatus = isSatisfied ? "satisfied" : "needs_attention";
  await run(
    "UPDATE customer_follow_ups SET response = ?, response_notes = ?, responded_at = datetime('now'), status = ?, updated_at = datetime('now') WHERE id = ?",
    [response, notes.slice(0, 2000), newStatus, followUp.id]
  );
  await recordAudit(organizationId, followUp.id, "follow_up_responded", null, { response });

  let reviewUrl: string | null = null;
  if (isSatisfied) {
    const url = await getReviewRequestUrl(organizationId);
    if (url) {
      await run(
        "UPDATE customer_follow_ups SET review_status = 'sent', review_sent_at = datetime('now') WHERE id = ?",
        [followUp.id]
      );
      await recordAudit(organizationId, followUp.id, "review_request_sent", null, {});
      reviewUrl = url;
    } else {
      await run("UPDATE customer_follow_ups SET review_status = 'not_eligible' WHERE id = ?", [followUp.id]);
    }
  } else {
    await recordAudit(organizationId, followUp.id, "follow_up_escalated", null, { notes: notes.slice(0, 500) });
  }

  // Maintenance-plan offer: only for a satisfied response, only when the
  // customer is not already an active Member (Section 13 — never a second
  // Plan catalog, reuses Phase 19B's listPlans() as-is; never auto-enrolls).
  let planOffer: RespondResult["planOffer"] = null;
  if (isSatisfied) {
    const activeMembership = await get<{ id: number }>(
      "SELECT id FROM maintenance_memberships WHERE customer_id = ? AND status = 'active'", [followUp.customer_id]
    );
    if (!activeMembership) {
      const plans = await listMaintenancePlans(organizationId, false);
      if (plans.length > 0) {
        planOffer = plans.map((p) => ({ id: p.id, name: p.name, description: p.description, tier: p.tier, priceCents: p.price_cents }));
        await run("UPDATE customer_follow_ups SET maintenance_offer_shown = 1 WHERE id = ?", [followUp.id]);
      }
    }
  }

  return { status: newStatus, reviewUrl, planOffer };
}

/** Fires when the customer actually clicks the shown review link — a tiny
 *  public tracking endpoint, never claims a review was actually posted
 *  (Section 12's explicit "completed only if genuinely knowable" — this
 *  system has no way to know that, so it never claims it). */
export async function markReviewClicked(organizationId: number, token: string): Promise<void> {
  const view = await getFollowUpByToken(token);
  const followUp = await getFollowUp(organizationId, view.followUpId);
  if (followUp.review_status === "sent") {
    await run("UPDATE customer_follow_ups SET review_status = 'clicked', review_clicked_at = datetime('now') WHERE id = ?", [followUp.id]);
    await recordAudit(organizationId, followUp.id, "review_link_clicked", null, {});
  }
}

/** Admin/dispatcher closes a follow-up once handled (whether satisfied or
 *  a resolved escalation) — the explicit terminal state. */
export async function closeFollowUp(organizationId: number, id: number, actorUserId: number): Promise<FollowUpRow> {
  const followUp = await getFollowUp(organizationId, id);
  if (followUp.status === "closed") return followUp;
  await run("UPDATE customer_follow_ups SET status = 'closed', closed_at = datetime('now'), closed_by = ?, updated_at = datetime('now') WHERE id = ?", [actorUserId, id]);
  await recordAudit(organizationId, id, "follow_up_closed", actorUserId, {});
  return getFollowUp(organizationId, id);
}
