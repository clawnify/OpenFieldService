import { get, query, run } from "./db.js";
import { createFollowUpForJob, sendFollowUp } from "./retention-followup.js";
import { scanReferralQualifications } from "./retention-referral.js";
import { listCampaigns, runCampaign } from "./retention-campaigns.js";

/**
 * Phase 19D — background retention automation. Reuses the ONE existing
 * Cloudflare cron trigger (Phase 9/19C precedent) — index.ts's
 * scheduled() handler calls runRetentionAutomationCycle() in its own
 * best-effort try/catch after Phase 19C's own cycle, never a second
 * scheduler. Also the single entry point the admin-only manual runner
 * calls (same "one production function, cron and manual both call it"
 * discipline as maintenance-automation.ts).
 */

async function activeOrganizations(organizationIdFilter: number | null): Promise<{ id: number }[]> {
  if (organizationIdFilter !== null) return [{ id: organizationIdFilter }];
  return query<{ id: number }>("SELECT id FROM organizations WHERE status = 'active'");
}

// A follow-up only makes sense for a RECENT experience — without a bound
// here, the very first cron tick after this feature ships would retroactively
// create (and, since due_date would already be in the past, immediately
// SEND) a follow-up for every completed Job in the organization's entire
// history, a mass unsolicited blast to the whole historical customer base
// (Code Review finding, Phase 19D). 60 days is a generous grace window
// beyond the default 7-day delay — long enough to catch up after the cron
// was down for a few weeks, short enough that a job from years ago never
// qualifies.
const MAX_FOLLOWUP_LOOKBACK_DAYS = 60;

/** Scans every organization's recently-completed Jobs for follow-up
 *  eligibility, creates due rows (idempotent — UNIQUE(job_id)), and sends
 *  every follow-up whose due_date has arrived. */
async function scanFollowUps(organizationIdFilter: number | null): Promise<{ created: number; sent: number }> {
  const orgs = await activeOrganizations(organizationIdFilter);
  let created = 0, sent = 0;
  const today = new Date().toISOString().slice(0, 10);
  // Plain YYYY-MM-DD, not a full ISO timestamp — job_status_history.created_at
  // is stored as SQLite's own space-separated datetime('now') format, and a
  // YYYY-MM-DD prefix compares correctly against it lexicographically
  // (shorter prefix sorts before any same-day timestamp extending it).
  const lookbackCutoff = new Date(Date.now() - MAX_FOLLOWUP_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);

  for (const org of orgs) {
    // Any completed Job with no follow-up row yet, completed within the
    // lookback window, is a candidate — creation itself is a no-op for a
    // Job that isn't actually eligible yet (too recent to be past the
    // org's configured delay is handled by due_date computed at creation
    // time; a Job completed TODAY still gets a row immediately, just with
    // a future due_date — it simply won't be sent until that date
    // arrives, matching the pending/send split below).
    const candidates = await query<{ id: number }>(
      `SELECT j.id FROM jobs j
       JOIN job_status_history jsh ON jsh.job_id = j.id AND jsh.to_status = 'completed'
       LEFT JOIN customer_follow_ups cf ON cf.job_id = j.id
       WHERE j.organization_id = ? AND j.status = 'completed' AND cf.id IS NULL
         AND jsh.created_at >= ?
         AND jsh.created_at = (SELECT MAX(jsh2.created_at) FROM job_status_history jsh2 WHERE jsh2.job_id = j.id AND jsh2.to_status = 'completed')`,
      [org.id, lookbackCutoff]
    );
    for (const job of candidates) {
      const row = await createFollowUpForJob(org.id, job.id);
      if (row) created++;
    }

    const due = await query<{ id: number }>(
      "SELECT id FROM customer_follow_ups WHERE organization_id = ? AND status = 'pending' AND due_date <= ?",
      [org.id, today]
    );
    for (const followUp of due) {
      const didSend = await sendFollowUp(org.id, followUp.id);
      if (didSend) sent++;
    }
  }
  return { created, sent };
}

async function scanReferrals(organizationIdFilter: number | null): Promise<{ qualified: number; rewarded: number }> {
  const orgs = await activeOrganizations(organizationIdFilter);
  let qualified = 0, rewarded = 0;
  for (const org of orgs) {
    const result = await scanReferralQualifications(org.id);
    qualified += result.qualified;
    rewarded += result.rewarded;
  }
  return { qualified, rewarded };
}

/** Processes every 'scheduled' campaign whose scheduled_for has arrived
 *  (and resumes any still 'running' from an interrupted prior tick —
 *  campaign_recipients' own UNIQUE guard makes re-running safe). Never
 *  touches a 'paused' campaign — Section 35's explicit pause-aware
 *  requirement. */
async function scanCampaigns(organizationIdFilter: number | null): Promise<{ queued: number; sent: number }> {
  const orgs = await activeOrganizations(organizationIdFilter);
  let queued = 0, sent = 0;
  const now = new Date().toISOString();

  for (const org of orgs) {
    const scheduled = await listCampaigns(org.id, { status: "scheduled" });
    const running = await listCampaigns(org.id, { status: "running" });
    const due = [...scheduled.filter((c) => !c.scheduled_for || c.scheduled_for <= now), ...running];
    for (const campaign of due) {
      const result = await runCampaign(org.id, campaign.id);
      queued += result.queued;
      sent += result.sent;
    }
  }
  return { queued, sent };
}

export interface RetentionRunSummary {
  organizationsScanned: number;
  followUpsCreated: number;
  followUpsSent: number;
  referralsQualified: number;
  rewardsIssued: number;
  campaignRecipientsQueued: number;
  campaignSends: number;
  erroredCount: number;
  errorSummary: string;
}

interface AutomationRunRow {
  id: number;
  organization_id: number | null;
  run_type: string;
  triggered_by: string;
  actor_user_id: number | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  organizations_scanned: number;
  follow_ups_created: number;
  review_requests_sent: number;
  referrals_qualified: number;
  rewards_issued: number;
  campaign_recipients_queued: number;
  campaign_sends: number;
  errored_count: number;
  error_summary: string;
  created_at: string;
}

async function recordAutomationRun(organizationIdFilter: number | null, triggeredBy: string, actorUserId: number | null, summary: RetentionRunSummary): Promise<void> {
  await run(
    `INSERT INTO retention_automation_runs
      (organization_id, run_type, triggered_by, actor_user_id, finished_at, status, organizations_scanned,
       follow_ups_created, review_requests_sent, referrals_qualified, rewards_issued, campaign_recipients_queued, campaign_sends, errored_count, error_summary)
     VALUES (?, 'cycle', ?, ?, datetime('now'), 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationIdFilter, triggeredBy, actorUserId, summary.organizationsScanned,
      summary.followUpsCreated, summary.followUpsSent, summary.referralsQualified, summary.rewardsIssued,
      summary.campaignRecipientsQueued, summary.campaignSends, summary.erroredCount, summary.errorSummary,
    ]
  );
}

/** THE single entry point — both the Cloudflare cron tick and the
 *  admin-only manual runner call this exact function (same production
 *  logic either way, matching maintenance-automation.ts's own discipline). */
export async function runRetentionAutomationCycle(organizationIdFilter: number | null, triggeredBy: "cron" | "manual", actorUserId: number | null): Promise<RetentionRunSummary> {
  const orgs = await activeOrganizations(organizationIdFilter);
  const errors: string[] = [];
  let followUpsCreated = 0, followUpsSent = 0, referralsQualified = 0, rewardsIssued = 0, campaignQueued = 0, campaignSent = 0;

  try {
    const result = await scanFollowUps(organizationIdFilter);
    followUpsCreated = result.created; followUpsSent = result.sent;
  } catch (err) { errors.push(`follow-ups: ${(err as Error).message}`); }

  try {
    const result = await scanReferrals(organizationIdFilter);
    referralsQualified = result.qualified; rewardsIssued = result.rewarded;
  } catch (err) { errors.push(`referrals: ${(err as Error).message}`); }

  try {
    const result = await scanCampaigns(organizationIdFilter);
    campaignQueued = result.queued; campaignSent = result.sent;
  } catch (err) { errors.push(`campaigns: ${(err as Error).message}`); }

  const summary: RetentionRunSummary = {
    organizationsScanned: orgs.length, followUpsCreated, followUpsSent: followUpsSent,
    referralsQualified, rewardsIssued, campaignRecipientsQueued: campaignQueued, campaignSends: campaignSent,
    erroredCount: errors.length, errorSummary: errors.slice(0, 20).join("; "),
  };

  const didSomething = followUpsCreated > 0 || followUpsSent > 0 || referralsQualified > 0 || rewardsIssued > 0 || campaignQueued > 0 || errors.length > 0;
  if (didSomething) await recordAutomationRun(organizationIdFilter, triggeredBy, actorUserId, summary);
  return summary;
}

/** Deliberately scoped to organization_id = ? only — a global cron row
 *  (organization_id IS NULL) must never be returned through a tenant-
 *  scoped admin's view, same tenant-isolation discipline Phase 19C's
 *  security review already established for its own automation-run
 *  history (mem:phase19c/recurring-maintenance-renewal-automation). */
export async function listRetentionRuns(organizationId: number, limit = 50): Promise<AutomationRunRow[]> {
  return query<AutomationRunRow>(
    "SELECT * FROM retention_automation_runs WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?",
    [organizationId, limit]
  );
}

// ── Retention signals — pure, deterministic, computed on read, never
// stored/cached (same "derived, not stored" discipline as Phase 19B's
// entitlement/renewal-status projections) ─────────────────────────────

export interface RetentionSignals {
  activeCustomer: boolean;
  activeMember: boolean;
  repeatCustomer: boolean;
  atRisk: boolean;
  followUpDue: boolean;
  renewalDue: boolean;
  inactive: boolean;
  referralAdvocate: boolean;
}

const AT_RISK_INACTIVITY_DAYS = 365;
const INACTIVE_DAYS = 730;

export async function computeRetentionSignals(organizationId: number, customerId: number): Promise<RetentionSignals> {
  const completedJobs = await query<{ id: number; completed_at: string }>(
    `SELECT j.id, MAX(jsh.created_at) as completed_at FROM jobs j
     JOIN job_status_history jsh ON jsh.job_id = j.id AND jsh.to_status = 'completed'
     WHERE j.customer_id = ? AND j.organization_id = ? AND j.status = 'completed'
     GROUP BY j.id ORDER BY completed_at DESC`,
    [customerId, organizationId]
  );
  const activeMembership = await get<{ id: number }>("SELECT id FROM maintenance_memberships WHERE customer_id = ? AND status = 'active'", [customerId]);
  const cancelledOrExpiredMembership = await get<{ id: number }>(
    "SELECT id FROM maintenance_memberships WHERE customer_id = ? AND status IN ('cancelled', 'expired') ORDER BY id DESC LIMIT 1", [customerId]
  );
  const openFollowUp = await get<{ id: number }>(
    "SELECT id FROM customer_follow_ups WHERE customer_id = ? AND status IN ('needs_attention')", [customerId]
  );
  const dueFollowUp = await get<{ id: number }>(
    "SELECT id FROM customer_follow_ups WHERE customer_id = ? AND status = 'pending' AND due_date <= date('now')", [customerId]
  );
  const referralCount = await get<{ count: number }>(
    "SELECT COUNT(*) as count FROM customer_referrals WHERE referrer_customer_id = ? AND status IN ('qualified')", [customerId]
  );

  const lastCompletedAt = completedJobs[0]?.completed_at ?? null;
  const daysSinceLastJob = lastCompletedAt ? Math.floor((Date.now() - new Date(lastCompletedAt).getTime()) / 86_400_000) : null;

  const activeMember = !!activeMembership;
  const failedRenewal = !!cancelledOrExpiredMembership;
  const hasUnresolvedIssue = !!openFollowUp;

  return {
    activeCustomer: completedJobs.length > 0 || activeMember,
    activeMember,
    repeatCustomer: completedJobs.length >= 2,
    atRisk: (daysSinceLastJob !== null && daysSinceLastJob >= AT_RISK_INACTIVITY_DAYS && daysSinceLastJob < INACTIVE_DAYS) || failedRenewal || hasUnresolvedIssue,
    followUpDue: !!dueFollowUp,
    renewalDue: false, // derived directly from Phase 19C's own getRenewalStatus() at the call site — not duplicated here
    inactive: daysSinceLastJob !== null && daysSinceLastJob >= INACTIVE_DAYS,
    referralAdvocate: (referralCount?.count ?? 0) > 0,
  };
}
