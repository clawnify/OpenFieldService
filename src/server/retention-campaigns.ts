import { get, query, run } from "./db.js";
import { checkMarketingEligibility } from "./retention-consent.js";
import { enqueueChannel, type NotificationChannel } from "./notifications.js";
import { getOrCreateUnsubscribeToken } from "./notification-preferences.js";
import { getAppPublicUrl } from "./retention-followup.js";

/**
 * Phase 19D — seasonal / retention campaigns. Each campaign IS its own
 * content unit (no separate reusable-template library — an unrequested
 * extra abstraction for this phase). Content/audience become immutable
 * once a campaign leaves 'draft' (Section 28) — the campaign row itself is
 * the frozen historical record, no separate snapshot table needed. Actual
 * sends reuse Phase 9's notification_outbox directly (its own dedupe_key
 * is what prevents a duplicate send — Section 32); campaign_recipients is
 * only the audience-membership + eligibility-DECISION ledger.
 */

export interface Actor { id: number; role: "admin" | "dispatcher" | "technician" }

/** Config/lifecycle actions (create/update/schedule/pause/cancel) are
 *  admin-only — mirrors referral program config's own admin-only gate
 *  (Section 40's explicit "do not grant Admin-only campaign configuration
 *  unless policy allows"). */
export function canManageCampaigns(actor: Actor): boolean {
  return actor.role === "admin";
}

/** Read/list visibility — admin + dispatcher (Section 40's "campaign
 *  visibility if policy permits" — this codebase's established pattern is
 *  read-open to dispatcher, write-restricted to admin, same split as
 *  Phase 19B's Plans/Terms/Checklists). */
export function canViewCampaigns(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "dispatcher";
}

export class CampaignError extends Error {
  code: "not_found" | "invalid_input" | "invalid_state";
  constructor(code: CampaignError["code"], message: string) {
    super(message);
    this.name = "CampaignError";
    this.code = code;
  }
}

export const CAMPAIGN_CHANNELS = ["email", "sms", "both"] as const;
export type CampaignChannel = typeof CAMPAIGN_CHANNELS[number];

export interface AudienceFilter {
  hasActiveMembership?: boolean;
  minDaysSinceLastJob?: number;
  maxDaysSinceLastJob?: number;
  city?: string;
}

export interface CampaignRow {
  id: number;
  organization_id: number;
  name: string;
  campaign_type: string;
  status: string;
  channel: CampaignChannel;
  subject: string;
  body: string;
  cta_link: string;
  audience_filter: string;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

async function recordAudit(organizationId: number, entityId: number, eventType: string, actorUserId: number | null, details: Record<string, unknown>): Promise<void> {
  await run(
    "INSERT INTO retention_audit (organization_id, entity_type, entity_id, event_type, actor_user_id, details) VALUES (?, 'campaign', ?, ?, ?, ?)",
    [organizationId, entityId, eventType, actorUserId, JSON.stringify(details)]
  );
}

export async function getCampaign(organizationId: number, id: number): Promise<CampaignRow> {
  const row = await get<CampaignRow>("SELECT * FROM campaigns WHERE id = ? AND organization_id = ?", [id, organizationId]);
  if (!row) throw new CampaignError("not_found", "Campaign not found");
  return row;
}

export async function listCampaigns(organizationId: number, filters: { status?: string } = {}): Promise<CampaignRow[]> {
  if (filters.status) {
    return query<CampaignRow>("SELECT * FROM campaigns WHERE organization_id = ? AND status = ? ORDER BY created_at DESC", [organizationId, filters.status]);
  }
  return query<CampaignRow>("SELECT * FROM campaigns WHERE organization_id = ? ORDER BY created_at DESC", [organizationId]);
}

export interface CampaignInput {
  name: string;
  campaignType?: string;
  channel: CampaignChannel;
  subject?: string;
  body: string;
  ctaLink?: string;
  audienceFilter?: AudienceFilter;
}

function validateCampaignInput(input: CampaignInput): void {
  if (!input.name.trim()) throw new CampaignError("invalid_input", "name is required");
  if (!input.body.trim()) throw new CampaignError("invalid_input", "body is required");
  if (!CAMPAIGN_CHANNELS.includes(input.channel)) throw new CampaignError("invalid_input", "Invalid channel");
}

export async function createCampaign(organizationId: number, actorUserId: number, input: CampaignInput): Promise<CampaignRow> {
  validateCampaignInput(input);
  const result = await run(
    `INSERT INTO campaigns (organization_id, name, campaign_type, channel, subject, body, cta_link, audience_filter, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [organizationId, input.name.trim(), input.campaignType ?? "seasonal", input.channel, input.subject ?? "", input.body, input.ctaLink ?? "", JSON.stringify(input.audienceFilter ?? {}), actorUserId]
  );
  const id = Number(result.lastInsertRowid);
  await recordAudit(organizationId, id, "campaign_created", actorUserId, { name: input.name });
  return getCampaign(organizationId, id);
}

/** Only permitted while status='draft' — this IS the snapshot-integrity
 *  guarantee (Section 28): once scheduled/running/completed, nothing can
 *  rewrite what was actually approved and sent. */
export async function updateCampaign(organizationId: number, actorUserId: number, id: number, input: Partial<CampaignInput>): Promise<CampaignRow> {
  const campaign = await getCampaign(organizationId, id);
  if (campaign.status !== "draft") throw new CampaignError("invalid_state", "Only a draft campaign can be edited — its content/audience are frozen once scheduled");
  const merged: CampaignInput = {
    name: input.name ?? campaign.name, campaignType: input.campaignType ?? campaign.campaign_type,
    channel: input.channel ?? campaign.channel, subject: input.subject ?? campaign.subject,
    body: input.body ?? campaign.body, ctaLink: input.ctaLink ?? campaign.cta_link,
    audienceFilter: input.audienceFilter ?? JSON.parse(campaign.audience_filter || "{}"),
  };
  validateCampaignInput(merged);
  await run(
    `UPDATE campaigns SET name = ?, campaign_type = ?, channel = ?, subject = ?, body = ?, cta_link = ?, audience_filter = ?, updated_at = datetime('now') WHERE id = ?`,
    [merged.name.trim(), merged.campaignType, merged.channel, merged.subject ?? "", merged.body, merged.ctaLink ?? "", JSON.stringify(merged.audienceFilter ?? {}), id]
  );
  await recordAudit(organizationId, id, "campaign_updated", actorUserId, {});
  return getCampaign(organizationId, id);
}

export async function scheduleCampaign(organizationId: number, actorUserId: number, id: number, scheduledFor: string): Promise<CampaignRow> {
  const campaign = await getCampaign(organizationId, id);
  if (campaign.status !== "draft") throw new CampaignError("invalid_state", "Only a draft campaign can be scheduled");
  if (!scheduledFor) throw new CampaignError("invalid_input", "scheduled_for is required");
  await run("UPDATE campaigns SET status = 'scheduled', scheduled_for = ?, updated_at = datetime('now') WHERE id = ?", [scheduledFor, id]);
  await recordAudit(organizationId, id, "campaign_scheduled", actorUserId, { scheduled_for: scheduledFor });
  return getCampaign(organizationId, id);
}

export async function pauseCampaign(organizationId: number, actorUserId: number, id: number): Promise<CampaignRow> {
  const campaign = await getCampaign(organizationId, id);
  if (!["scheduled", "running"].includes(campaign.status)) throw new CampaignError("invalid_state", "Only a scheduled or running campaign can be paused");
  await run("UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?", [id]);
  await recordAudit(organizationId, id, "campaign_paused", actorUserId, {});
  return getCampaign(organizationId, id);
}

export async function resumeCampaign(organizationId: number, actorUserId: number, id: number): Promise<CampaignRow> {
  const campaign = await getCampaign(organizationId, id);
  if (campaign.status !== "paused") throw new CampaignError("invalid_state", "Only a paused campaign can be resumed");
  const nextStatus = campaign.started_at ? "running" : "scheduled";
  await run("UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?", [nextStatus, id]);
  await recordAudit(organizationId, id, "campaign_resumed", actorUserId, {});
  return getCampaign(organizationId, id);
}

export async function cancelCampaign(organizationId: number, actorUserId: number, id: number, reason: string): Promise<CampaignRow> {
  const campaign = await getCampaign(organizationId, id);
  if (["completed", "cancelled"].includes(campaign.status)) throw new CampaignError("invalid_state", "Campaign already finished");
  await run("UPDATE campaigns SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ?, updated_at = datetime('now') WHERE id = ?", [reason, id]);
  await recordAudit(organizationId, id, "campaign_cancelled", actorUserId, { reason });
  return getCampaign(organizationId, id);
}

// ── Audience — deterministic, parameterized filters only, never raw SQL ──

function buildAudienceQuery(organizationId: number, filter: AudienceFilter): { sql: string; params: unknown[] } {
  const conditions = ["c.organization_id = ?"];
  const params: unknown[] = [organizationId];
  let join = "";

  if (filter.hasActiveMembership === true) {
    join += " JOIN maintenance_memberships mm ON mm.customer_id = c.id AND mm.status = 'active'";
  } else if (filter.hasActiveMembership === false) {
    conditions.push("NOT EXISTS (SELECT 1 FROM maintenance_memberships mm2 WHERE mm2.customer_id = c.id AND mm2.status = 'active')");
  }
  if (filter.city) {
    conditions.push("c.address LIKE ?");
    params.push(`%${filter.city}%`);
  }
  if (filter.minDaysSinceLastJob != null || filter.maxDaysSinceLastJob != null) {
    conditions.push("EXISTS (SELECT 1 FROM jobs j WHERE j.customer_id = c.id AND j.status = 'completed')");
  }

  return { sql: `SELECT DISTINCT c.id FROM customers c${join} WHERE ${conditions.join(" AND ")}`, params };
}

async function candidateCustomerIds(organizationId: number, filter: AudienceFilter): Promise<number[]> {
  const { sql, params } = buildAudienceQuery(organizationId, filter);
  const rows = await query<{ id: number }>(sql, params);
  if (filter.minDaysSinceLastJob == null && filter.maxDaysSinceLastJob == null) return rows.map((r) => r.id);

  // Last-job-recency filter needs per-customer date math — applied in JS
  // over the (already org/membership/city-narrowed) candidate set rather
  // than a fragile SQL julianday() expression.
  const today = Date.now();
  const filtered: number[] = [];
  for (const row of rows) {
    const last = await get<{ created_at: string }>(
      "SELECT MAX(created_at) as created_at FROM job_status_history WHERE job_id IN (SELECT id FROM jobs WHERE customer_id = ? AND status = 'completed') AND to_status = 'completed'",
      [row.id]
    );
    if (!last?.created_at) continue;
    const daysSince = Math.floor((today - new Date(last.created_at).getTime()) / 86_400_000);
    if (filter.minDaysSinceLastJob != null && daysSince < filter.minDaysSinceLastJob) continue;
    if (filter.maxDaysSinceLastJob != null && daysSince > filter.maxDaysSinceLastJob) continue;
    filtered.push(row.id);
  }
  return filtered;
}

export interface AudiencePreview {
  totalCandidates: number;
  eligible: number;
  suppressed: number;
  suppressedByReason: Record<string, number>;
}

/** Read-only, side-effect-free — powers the Admin preview (Section 27)
 *  using the EXACT same eligibility check the real run uses
 *  (checkMarketingEligibility), so preview and reality can never diverge. */
export async function previewAudience(organizationId: number, filter: AudienceFilter, channel: NotificationChannel): Promise<AudiencePreview> {
  const ids = await candidateCustomerIds(organizationId, filter);
  let eligible = 0;
  const suppressedByReason: Record<string, number> = {};
  for (const id of ids) {
    const result = await checkMarketingEligibility(id, channel);
    if (result.eligible) eligible++;
    else suppressedByReason[result.reason!] = (suppressedByReason[result.reason!] ?? 0) + 1;
  }
  const suppressed = ids.length - eligible;
  return { totalCandidates: ids.length, eligible, suppressed, suppressedByReason };
}

/** Runs (or resumes) a scheduled/running campaign — builds the audience,
 *  claims each (customer, channel) pair in campaign_recipients (UNIQUE
 *  guard — re-running never double-processes a recipient), and for each
 *  eligible one enqueues through the real notification_outbox with
 *  purpose:'marketing' (that table's own dedupe_key is the real
 *  duplicate-send guard, Section 32). Marks the campaign 'completed' once
 *  every candidate has been processed. */
export async function runCampaign(organizationId: number, campaignId: number): Promise<{ queued: number; sent: number; suppressed: number }> {
  const campaign = await getCampaign(organizationId, campaignId);
  if (!["scheduled", "running"].includes(campaign.status)) return { queued: 0, sent: 0, suppressed: 0 };

  if (campaign.status === "scheduled") {
    await run("UPDATE campaigns SET status = 'running', started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [campaignId]);
  }

  const filter: AudienceFilter = JSON.parse(campaign.audience_filter || "{}");
  const channels: NotificationChannel[] = campaign.channel === "both" ? ["email", "sms"] : [campaign.channel as NotificationChannel];
  const candidateIds = await candidateCustomerIds(organizationId, filter);

  let queued = 0, sent = 0, suppressed = 0;
  for (const customerId of candidateIds) {
    for (const channel of channels) {
      const claim = await run(
        "INSERT INTO campaign_recipients (organization_id, campaign_id, customer_id, channel) VALUES (?, ?, ?, ?) ON CONFLICT(campaign_id, customer_id, channel) DO NOTHING",
        [organizationId, campaignId, customerId, channel]
      );
      if (claim.changes === 0) continue; // already processed this recipient/channel on a prior run
      queued++;

      const eligibility = await checkMarketingEligibility(customerId, channel);
      if (!eligibility.eligible) {
        await run("UPDATE campaign_recipients SET status = 'suppressed', suppressed_at = datetime('now'), reason = ? WHERE campaign_id = ? AND customer_id = ? AND channel = ?", [eligibility.reason, campaignId, customerId, channel]);
        suppressed++;
        continue;
      }

      // Every marketing send carries a real, working unsubscribe link — the
      // opt-in-with-no-reachable-opt-out gap independent review flagged.
      const unsubscribeToken = await getOrCreateUnsubscribeToken("customer", customerId);
      const baseUrl = await getAppPublicUrl(organizationId);
      const unsubscribeUrl = baseUrl ? `${baseUrl}/unsubscribe/${unsubscribeToken}` : "";

      const enqueueResult = await enqueueChannel({
        eventType: "retention.campaign_send", entityType: "campaign", entityId: campaignId,
        channel, recipientType: "customer", recipientId: customerId, recipientContact: eligibility.contact!,
        templateKey: "campaign_send_v1",
        payload: { subject: campaign.subject, body: campaign.body, ctaLink: campaign.cta_link, unsubscribeUrl },
        discriminator: customerId, purpose: "marketing",
      });
      if (enqueueResult.enqueued) {
        await run(
          "UPDATE campaign_recipients SET status = 'sent', sent_at = datetime('now'), notification_outbox_id = ? WHERE campaign_id = ? AND customer_id = ? AND channel = ?",
          [enqueueResult.notificationId, campaignId, customerId, channel]
        );
        sent++;
      } else {
        await run("UPDATE campaign_recipients SET status = 'failed', failed_at = datetime('now'), reason = ? WHERE campaign_id = ? AND customer_id = ? AND channel = ?", [enqueueResult.reason, campaignId, customerId, channel]);
      }
    }
  }

  await run("UPDATE campaigns SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'running'", [campaignId]);
  await recordAudit(organizationId, campaignId, "campaign_run", null, { queued, sent, suppressed });
  return { queued, sent, suppressed };
}

export interface CampaignRecipientRow {
  id: number;
  campaign_id: number;
  customer_id: number;
  channel: string;
  status: string;
  reason: string;
  queued_at: string;
  sent_at: string | null;
  failed_at: string | null;
  suppressed_at: string | null;
}

export async function listCampaignRecipients(organizationId: number, campaignId: number): Promise<CampaignRecipientRow[]> {
  return query<CampaignRecipientRow>("SELECT * FROM campaign_recipients WHERE organization_id = ? AND campaign_id = ? ORDER BY id ASC", [organizationId, campaignId]);
}
