import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createSecondOrganization,
  createUser, loginAs, post, put, request, queryDb, resetDatabase,
} from "./helpers.js";

// Phase 19C — Recurring Maintenance / Renewal / Reminder automation.
// Mirrors maintenance-plans.test.ts's real-API-fixture-through-real-session
// discipline: tenant isolation via createSecondOrganization(), RBAC via
// createUser()+loginAs(), idempotency/concurrency proven via real
// Promise.all against the manual-runner route (the exact same production
// function the Cloudflare cron tick calls — Section 33's own requirement).

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

/** "YYYY-MM-DD" `daysFromToday` days from the real current date — used
 *  instead of hardcoded fixed dates so due/overdue/renewal-window fixtures
 *  stay correct no matter when this suite actually runs. */
function dateOffset(daysFromToday: number): string {
  const dt = new Date();
  dt.setUTCDate(dt.getUTCDate() + daysFromToday);
  return dt.toISOString().slice(0, 10);
}

async function dispatcherAuth(email = "auto-dispatch@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
  const userRes = await post<{ user: { id: number } }>("/api/users", { name: email, email, password: "TechPass123", role: "technician" }, adminAuth);
  const techRes = await post<{ id: number }>("/api/technicians", { name: email, user_id: userRes.body.user.id }, adminAuth);
  const { cookie } = await loginAs(email, "TechPass123");
  return { auth: { headers: { cookie } } as RequestInit, technicianId: techRes.body.id };
}

async function makeCustomer(auth: RequestInit, name = "Automation Test Customer") {
  const res = await post<{ id: number }>("/api/customers", { name, email: "auto-cust@example.test", phone: "555-0177" }, auth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

async function makePlan(auth: RequestInit, overrides: Record<string, unknown> = {}) {
  const res = await post<{ plan: { id: number } }>("/api/maintenance/plans", {
    code: `AUTO-${Math.random().toString(36).slice(2, 8)}`, name: "Auto Test Plan", tier: "STANDARD",
    price_cents: 15000, taxable: false, visit_entitlement_count: 4, ...overrides,
  }, auth);
  expect(res.response.status).toBe(201);
  return res.body.plan;
}

/** Creates and fully signs an Agreement (real e-sign ceremony via the
 *  public token flow, never a typed password) — returns the now-active
 *  agreement id and its membership id. */
async function makeActiveAgreementWithMembership(auth: RequestInit, customerId: number, planId: number) {
  const created = await post<{ agreement: { id: number } }>("/api/maintenance/agreements", { customer_id: customerId, plan_id: planId }, auth);
  expect(created.response.status).toBe(201);
  const agreementId = created.body.agreement.id;

  await post(`/api/maintenance/agreements/${agreementId}/signers`, { name: "Auto Signer", email: "auto-signer@example.test" }, auth);
  const sent = await post<{ signingLinks: { token: string }[] }>(`/api/maintenance/agreements/${agreementId}/send`, { consent_text_version: "v1" }, auth);
  const token = sent.body.signingLinks[0].token;
  await post(`/api/public/maintenance-agreements/sign/${token}/consent`, { consent_text_version: "v1" });
  const signRes = await post(`/api/public/maintenance-agreements/sign/${token}/sign`, {
    signer_name: "Auto Signer", signature_method: "typed", auto_renew_enabled: true, auto_renew_consent_text_version: "ar-v1",
  });
  expect(signRes.response.status).toBe(200);

  const membershipRes = await request<{ membership: { id: number } | null }>(`/api/maintenance/agreements/${agreementId}/membership`, auth);
  expect(membershipRes.body.membership).toBeTruthy();
  return { agreementId, membershipId: membershipRes.body.membership!.id };
}

// ── Schedules ────────────────────────────────────────────────────────

describe("Maintenance Schedules", () => {
  it("creates a schedule for an active membership, RBAC-gated, one per membership", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { membershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    const { auth: techAuth } = await createLinkedTechnician("sched-tech@example.test", auth);

    expect((await post(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "ANNUAL" }, techAuth)).response.status).toBe(403);

    const created = await post<{ schedule: { id: number; recurrence_type: string; status: string; next_due_date: string } }>(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "ANNUAL" }, auth);
    expect(created.response.status).toBe(201);
    expect(created.body.schedule.status).toBe("active");
    // Regression: activateMembership falls back to a full ISO timestamp for
    // effective_start when the agreement version has no explicit
    // effective_date (the real path exercised here — no start_date given) —
    // next_due_date must still be normalized to plain YYYY-MM-DD, not the
    // raw timestamp, or nextIntervalDate/daysBetween's date-only parsing
    // silently breaks on the next automation cycle.
    expect(created.body.schedule.next_due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const dupe = await post(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "QUARTERLY" }, auth);
    expect(dupe.response.status).toBe(409);
  });

  it("rejects CUSTOM_DAYS without a positive custom_interval_days", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { membershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    const bad = await post(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "CUSTOM_DAYS" }, auth);
    expect(bad.response.status).toBe(400);
  });

  it("pause/resume/cancel lifecycle, reason-gated, dispatcher has parity", async () => {
    const auth = await authHeaders();
    const dispatch = await dispatcherAuth();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { membershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    const created = await post<{ schedule: { id: number } }>(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "ANNUAL" }, auth);
    const scheduleId = created.body.schedule.id;

    const noReason = await post(`/api/maintenance/schedules/${scheduleId}/pause`, {}, auth);
    expect(noReason.response.status).toBe(400);

    const paused = await post<{ schedule: { status: string } }>(`/api/maintenance/schedules/${scheduleId}/pause`, { reason: "Customer requested a hold" }, dispatch);
    expect(paused.response.status).toBe(200);
    expect(paused.body.schedule.status).toBe("paused");

    const resumed = await post<{ schedule: { status: string } }>(`/api/maintenance/schedules/${scheduleId}/resume`, {}, dispatch);
    expect(resumed.response.status).toBe(200);
    expect(resumed.body.schedule.status).toBe("active");

    const cancelled = await post<{ schedule: { status: string } }>(`/api/maintenance/schedules/${scheduleId}/cancel`, { reason: "No longer needed" }, auth);
    expect(cancelled.response.status).toBe(200);
    expect(cancelled.body.schedule.status).toBe("cancelled");
  });

  it("does not leak a schedule across organizations", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { membershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    const created = await post<{ schedule: { id: number } }>(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "ANNUAL" }, auth);

    const orgB = await createSecondOrganization("Org B Automation");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    expect((await request(`/api/maintenance/schedules/${created.body.schedule.id}`, orgBAuth)).response.status).toBe(404);
  });
});

// ── Occurrence generation: idempotency + concurrency + entitlement gating ──

describe("Recurring occurrence generation", () => {
  it("the manual runner generates exactly one Job+Report for a due schedule, and a rerun never duplicates it", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth, { visit_entitlement_count: 5 });
    const { membershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    const created = await post<{ schedule: { id: number } }>(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "ANNUAL", start_date: dateOffset(-1) }, auth);
    const scheduleId = created.body.schedule.id;

    const run1 = await post<{ occurrencesProcessed: number; jobsGenerated: number }>("/api/maintenance/automation/run", {}, auth);
    expect(run1.response.status).toBe(200);
    expect(run1.body.jobsGenerated).toBeGreaterThanOrEqual(1);

    const run2 = await post<{ occurrencesProcessed: number; jobsGenerated: number }>("/api/maintenance/automation/run", {}, auth);
    expect(run2.response.status).toBe(200);
    // The schedule's next_due_date has already advanced past today after
    // run1, so a rerun the same instant finds nothing newly due — proving
    // no duplicate for the SAME cycle.
    expect(run2.body.jobsGenerated).toBe(0);

    const occurrences = await queryDb<{ cycle_number: number; status: string }>("SELECT cycle_number, status FROM maintenance_occurrences WHERE schedule_id = ?", [scheduleId]);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].status).toBe("job_generated");
  });

  it("two genuinely concurrent manual runs never double-generate the same occurrence", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth, { visit_entitlement_count: 5 });
    const { membershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    const created = await post<{ schedule: { id: number } }>(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "ANNUAL", start_date: dateOffset(-1) }, auth);
    const scheduleId = created.body.schedule.id;

    const [r1, r2] = await Promise.all([
      post("/api/maintenance/automation/run", {}, auth),
      post("/api/maintenance/automation/run", {}, auth),
    ]);
    expect(r1.response.status).toBe(200);
    expect(r2.response.status).toBe(200);

    const occurrences = await queryDb<{ id: number }>("SELECT id FROM maintenance_occurrences WHERE schedule_id = ?", [scheduleId]);
    expect(occurrences).toHaveLength(1);
    const jobs = await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM jobs WHERE customer_id = ?", [customerId]);
    expect(jobs[0].count).toBe(1);
  });

  it("skips generation (never creates a Job) when the membership has zero remaining visit entitlement", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth, { visit_entitlement_count: 0 });
    const { membershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    const created = await post<{ schedule: { id: number } }>(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "ANNUAL", start_date: dateOffset(-1) }, auth);

    const run = await post<{ occurrencesProcessed: number; jobsGenerated: number }>("/api/maintenance/automation/run", {}, auth);
    expect(run.response.status).toBe(200);
    expect(run.body.jobsGenerated).toBe(0);

    const occurrences = await queryDb<{ status: string; skip_reason: string }>("SELECT status, skip_reason FROM maintenance_occurrences WHERE schedule_id = ?", [created.body.schedule.id]);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].status).toBe("skipped");
    expect(occurrences[0].skip_reason).toContain("entitlement");
  });

  it("a generated occurrence carries the schedule's checklist template into the new Service Report's checklist_snapshot", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { membershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    const sections = [{ title: "Furnace", items: [{ id: "filter", label: "Filter", input_type: "PASS_FAIL", required: true }] }];
    const template = await post<{ template: { id: number } }>("/api/maintenance/checklist-templates", { name: "Auto Checklist", sections }, auth);
    const created = await post<{ schedule: { id: number } }>(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "ANNUAL", start_date: dateOffset(-1), checklist_template_id: template.body.template.id }, auth);

    await post("/api/maintenance/automation/run", {}, auth);
    const occurrence = (await queryDb<{ job_id: number }>("SELECT job_id FROM maintenance_occurrences WHERE schedule_id = ?", [created.body.schedule.id]))[0];
    const report = await request<{ report: { checklist_snapshot: string } }>(`/api/jobs/${occurrence.job_id}/maintenance-report`, auth);
    expect(JSON.parse(report.body.report!.checklist_snapshot)).toEqual(sections);
  });

  it("cancelling a schedule stops future generation but preserves already-generated occurrences", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { membershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    const created = await post<{ schedule: { id: number } }>(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "ANNUAL", start_date: dateOffset(-1) }, auth);
    await post("/api/maintenance/automation/run", {}, auth);

    const cancelled = await post(`/api/maintenance/schedules/${created.body.schedule.id}/cancel`, { reason: "test" }, auth);
    expect(cancelled.response.status).toBe(200);

    // Force next_due_date back into the past to prove a cancelled schedule
    // is never picked up again even though it would otherwise be "due".
    await queryDb("UPDATE maintenance_schedules SET next_due_date = ? WHERE id = ?", [dateOffset(-1), created.body.schedule.id]);
    const run = await post<{ jobsGenerated: number }>("/api/maintenance/automation/run", {}, auth);
    expect(run.body.jobsGenerated).toBe(0);

    const occurrences = await queryDb<{ status: string }>("SELECT status FROM maintenance_occurrences WHERE schedule_id = ?", [created.body.schedule.id]);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].status).toBe("job_generated"); // the earlier real occurrence untouched
  });
});

// ── Renewal ──────────────────────────────────────────────────────────

describe("Renewal", () => {
  it("auto-renews under valid standing consent with no material change — no fresh signature, old superseded, new active", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreementId, membershipId: oldMembershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);

    // Force the agreement's expiry into the auto-renew evaluation window.
    const version = (await queryDb<{ id: number }>("SELECT current_version_id as id FROM maintenance_agreements WHERE id = ?", [agreementId]))[0];
    await queryDb("UPDATE maintenance_agreement_versions SET expires_at = ? WHERE id = ?", [dateOffset(10), version.id]);

    const run = await post<{ renewalsProcessed: number }>("/api/maintenance/automation/run", {}, auth);
    expect(run.response.status).toBe(200);
    expect(run.body.renewalsProcessed).toBeGreaterThanOrEqual(1);

    const oldStatus = await request<{ agreement: { status: string; superseded_by_agreement_id: number | null } }>(`/api/maintenance/agreements/${agreementId}`, auth);
    expect(oldStatus.body.agreement.status).toBe("superseded");
    expect(oldStatus.body.agreement.superseded_by_agreement_id).toBeTruthy();

    const newAgreementId = oldStatus.body.agreement.superseded_by_agreement_id!;
    const newDetail = await request<{ agreement: { status: string }; version: { signed_at: string | null; auto_renew_consent: string; expires_at: string | null } }>(`/api/maintenance/agreements/${newAgreementId}`, auth);
    expect(newDetail.body.agreement.status).toBe("active");
    expect(newDetail.body.version.signed_at).toBeNull(); // never a fabricated signature
    const carried = JSON.parse(newDetail.body.version.auto_renew_consent);
    expect(carried.carried_forward_from_agreement).toBeTruthy();
    // Regression: the renewed version must carry forward its own
    // expires_at, or every renewal-candidate scan (which all filter
    // expires_at IS NOT NULL) would silently stop finding this agreement
    // after exactly one renewal cycle (Code Review finding, Phase 19C).
    expect(newDetail.body.version.expires_at).toBeTruthy();

    const oldMembership = await request<{ membership: { status: string } }>(`/api/maintenance/memberships/${oldMembershipId}`, auth);
    // getEntitlement route returns membership nested — verify via direct query instead for the status field.
    const oldMembershipRow = (await queryDb<{ status: string }>("SELECT status FROM maintenance_memberships WHERE id = ?", [oldMembershipId]))[0];
    expect(oldMembershipRow.status).toBe("superseded");
    void oldMembership;

    const newMembership = await request<{ membership: { id: number } | null }>(`/api/maintenance/agreements/${newAgreementId}/membership`, auth);
    expect(newMembership.body.membership).toBeTruthy();
  });

  it("blocks auto-renew and falls back to fresh-acceptance when the plan price has materially changed — never fabricates a signature", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth, { price_cents: 10000 });
    const { agreementId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    const version = (await queryDb<{ id: number }>("SELECT current_version_id as id FROM maintenance_agreements WHERE id = ?", [agreementId]))[0];
    await queryDb("UPDATE maintenance_agreement_versions SET expires_at = ? WHERE id = ?", [dateOffset(10), version.id]);

    // Material change: raise the plan's price after the agreement was signed.
    await put(`/api/maintenance/plans/${plan.id}`, { price_cents: 20000 }, auth);

    const run = await post("/api/maintenance/automation/run", {}, auth);
    expect(run.response.status).toBe(200);

    const oldStatus = await request<{ agreement: { status: string; superseded_by_agreement_id: number | null } }>(`/api/maintenance/agreements/${agreementId}`, auth);
    // Old agreement is NOT yet superseded — it stays active, preserving
    // coverage, until the customer actually accepts the new terms.
    expect(oldStatus.body.agreement.status).toBe("active");
    expect(oldStatus.body.agreement.superseded_by_agreement_id).toBeTruthy();

    const newAgreementId = oldStatus.body.agreement.superseded_by_agreement_id!;
    const newDetail = await request<{ agreement: { status: string } }>(`/api/maintenance/agreements/${newAgreementId}`, auth);
    expect(newDetail.body.agreement.status).toBe("draft");

    const renewalStatus = await request<{ status: string; pending_agreement_id: number }>(`/api/maintenance/agreements/${agreementId}/renewal-status`, auth);
    expect(renewalStatus.body.status).toBe("awaiting_customer");
  });

  it("manual initiateRenewal + real signing completes the handover only at the moment of signature, never before", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreementId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);

    const initiated = await post<{ newAgreement: { id: number; status: string } }>(`/api/maintenance/agreements/${agreementId}/renewal/initiate`, {}, auth);
    expect(initiated.response.status).toBe(201);
    const newAgreementId = initiated.body.newAgreement.id;

    // Old agreement still fully active — customer has coverage throughout.
    const midway = await request<{ agreement: { status: string } }>(`/api/maintenance/agreements/${agreementId}`, auth);
    expect(midway.body.agreement.status).toBe("active");

    // A second initiate attempt is rejected — one renewal in flight at a time.
    const dupeInitiate = await post(`/api/maintenance/agreements/${agreementId}/renewal/initiate`, {}, auth);
    expect(dupeInitiate.response.status).toBe(409);

    await post(`/api/maintenance/agreements/${newAgreementId}/signers`, { name: "Renewal Signer", email: "renewal@example.test" }, auth);
    const sent = await post<{ signingLinks: { token: string }[] }>(`/api/maintenance/agreements/${newAgreementId}/send`, { consent_text_version: "v1" }, auth);
    const token = sent.body.signingLinks[0].token;
    await post(`/api/public/maintenance-agreements/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/maintenance-agreements/sign/${token}/sign`, {
      signer_name: "Renewal Signer", signature_method: "typed", auto_renew_enabled: false, auto_renew_consent_text_version: "ar-v1",
    });

    const finalOld = await request<{ agreement: { status: string } }>(`/api/maintenance/agreements/${agreementId}`, auth);
    expect(finalOld.body.agreement.status).toBe("superseded");
    const finalNew = await request<{ agreement: { status: string } }>(`/api/maintenance/agreements/${newAgreementId}`, auth);
    expect(finalNew.body.agreement.status).toBe("active");
  });

  it("two genuinely concurrent initiateRenewal calls for the same agreement never both win — the loser's draft is cancelled, not orphaned", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreementId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);

    const [r1, r2] = await Promise.all([
      post<{ newAgreement: { id: number } }>(`/api/maintenance/agreements/${agreementId}/renewal/initiate`, {}, auth),
      post<{ newAgreement: { id: number } }>(`/api/maintenance/agreements/${agreementId}/renewal/initiate`, {}, auth),
    ]);
    const statuses = [r1.response.status, r2.response.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winner = r1.response.status === 201 ? r1 : r2;
    const oldStatus = await request<{ agreement: { superseded_by_agreement_id: number | null } }>(`/api/maintenance/agreements/${agreementId}`, auth);
    expect(oldStatus.body.agreement.superseded_by_agreement_id).toBe(winner.body.newAgreement.id);

    // Whether the underlying test/D1 execution model actually interleaves
    // these two requests (producing a second, losing draft agreement that
    // must be cancelled — never left as an orphaned, unreachable draft) or
    // effectively serializes them (the loser's own read already sees the
    // winner's completed write and never creates a draft at all), there
    // must be exactly one LIVE (non-cancelled) draft superseding the old
    // agreement — no dangling live duplicate either way.
    const allNew = await queryDb<{ id: number; status: string }>(
      "SELECT id, status FROM maintenance_agreements WHERE supersedes_agreement_id = ?", [agreementId]
    );
    const live = allNew.filter((a) => a.status !== "cancelled");
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(winner.body.newAgreement.id);
    for (const row of allNew) {
      if (row.id !== winner.body.newAgreement.id) expect(row.status).toBe("cancelled");
    }
  });

  it("does not leak a renewal-status lookup across organizations", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreementId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);

    const orgB = await createSecondOrganization("Org B Renewal");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    expect((await request(`/api/maintenance/agreements/${agreementId}/renewal-status`, orgBAuth)).response.status).toBe(404);
    expect((await post(`/api/maintenance/agreements/${agreementId}/renewal/initiate`, {}, orgBAuth)).response.status).toBe(404);
  });
});

// ── 60/30/14-day reminders ───────────────────────────────────────────

describe("Renewal reminders", () => {
  it("sends exactly one reminder per milestone, never duplicated across repeated runs", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreementId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    const version = (await queryDb<{ id: number }>("SELECT current_version_id as id FROM maintenance_agreements WHERE id = ?", [agreementId]))[0];

    // Force expires_at so "today" is exactly 30 days out.
    const today = new Date();
    const expires = new Date(today.getTime() + 30 * 86_400_000);
    const expiresStr = expires.toISOString().slice(0, 10);
    await queryDb("UPDATE maintenance_agreement_versions SET expires_at = ? WHERE id = ?", [expiresStr, version.id]);

    await post("/api/maintenance/automation/run", {}, auth);
    await post("/api/maintenance/automation/run", {}, auth);
    await post("/api/maintenance/automation/run", {}, auth);

    const outbox = await queryDb<{ dedupe_key: string }>(
      "SELECT dedupe_key FROM notification_outbox WHERE entity_type = 'maintenance_agreement' AND entity_id = ? AND event_type = 'maintenance.renewal_reminder'",
      [agreementId]
    );
    // Exactly one row per (milestone, channel) — email is enabled by
    // default for a fresh customer, sms is not (no consent captured) —
    // so exactly one email row for the "30" milestone, never duplicated
    // by three repeated runs.
    const milestone30 = outbox.filter((o) => o.dedupe_key.includes(":30:"));
    expect(milestone30.length).toBe(1);
  });
});

// ── RBAC / tenant isolation on automation runs + preview ─────────────

describe("Automation runs + preview", () => {
  it("manual runner and run history are admin-only; dispatcher and technician are denied", async () => {
    const auth = await authHeaders();
    const dispatch = await dispatcherAuth("runs-dispatch@example.test");
    const { auth: techAuth } = await createLinkedTechnician("runs-tech@example.test", auth);

    expect((await post("/api/maintenance/automation/run", {}, dispatch)).response.status).toBe(403);
    expect((await post("/api/maintenance/automation/run", {}, techAuth)).response.status).toBe(403);
    expect((await request("/api/maintenance/automation/runs", dispatch)).response.status).toBe(403);
    expect((await request("/api/maintenance/automation/preview", dispatch)).response.status).toBe(403);

    const adminRun = await post("/api/maintenance/automation/run", {}, auth);
    expect(adminRun.response.status).toBe(200);
    const history = await request<{ runs: unknown[] }>("/api/maintenance/automation/runs", auth);
    expect(history.response.status).toBe(200);
  });

  it("does not leak another organization's automation run history, including a global cron-triggered (organization_id NULL) row", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth, { visit_entitlement_count: 5 });
    const { membershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    await post(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "ANNUAL", start_date: dateOffset(-1) }, auth);
    const orgARun = await post<{ jobsGenerated: number }>("/api/maintenance/automation/run", {}, auth);
    expect(orgARun.response.status).toBe(200);
    expect(orgARun.body.jobsGenerated).toBeGreaterThanOrEqual(1);

    // Simulate a global cron-triggered run row (organization_id NULL) the
    // way runMaintenanceAutomationCycle(db, deps, null, "cron", null) would
    // write it — this is the row that must never leak into a tenant-scoped
    // admin's view (Security review finding, Phase 19C).
    await queryDb(
      "INSERT INTO maintenance_automation_runs (organization_id, run_type, triggered_by, actor_user_id, finished_at, status, organizations_scanned, occurrences_processed, jobs_generated, renewals_processed, reminders_sent, errored_count, error_summary) VALUES (NULL, 'cycle', 'cron', NULL, datetime('now'), 'completed', 3, 5, 5, 0, 0, 0, 'schedule 999: some other org detail')",
      []
    );

    const orgB = await createSecondOrganization("Org B Automation Runs");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    const orgBHistory = await request<{ runs: { organization_id: number | null; error_summary: string }[] }>("/api/maintenance/automation/runs", orgBAuth);
    expect(orgBHistory.response.status).toBe(200);
    expect(orgBHistory.body.runs).toHaveLength(0);
  });

  it("preview reflects real due/renewal state without creating any side effects", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { membershipId } = await makeActiveAgreementWithMembership(auth, customerId, plan.id);
    await post(`/api/maintenance/memberships/${membershipId}/schedule`, { recurrence_type: "ANNUAL", start_date: "2020-01-01" }, auth);

    const preview = await request<{ occurrences: { dueState: string }[] }>("/api/maintenance/automation/preview", auth);
    expect(preview.response.status).toBe(200);
    expect(preview.body.occurrences.some((o) => o.dueState === "overdue")).toBe(true);

    // Preview must be side-effect-free — no occurrence/Job actually created.
    const occurrences = await queryDb<{ count: number }>("SELECT COUNT(*) as count FROM maintenance_occurrences", []);
    expect(occurrences[0].count).toBe(0);
  });
});
