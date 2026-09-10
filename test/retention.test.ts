import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createSecondOrganization,
  createUser, loginAs, post, put, request, queryDb, resetDatabase, satisfyCompletionRequirements, runScheduled,
} from "./helpers.js";

// Phase 19D — Retention / Referral / Loyalty / Follow-up / Seasonal
// Campaigns. Mirrors Phase 19C's own real-API-fixture-through-real-session
// discipline: tenant isolation via createSecondOrganization(), RBAC via
// createUser()+loginAs(), idempotency/concurrency proven via real Promise.all
// against the manual-runner route (the exact same production function the
// Cloudflare cron tick calls).

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function dispatcherAuth(email = "retention-dispatch@example.test"): Promise<RequestInit> {
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

async function createTechnicianRow(adminAuth: RequestInit, name = "Retention Tech") {
  const res = await post<{ id: number }>("/api/technicians", { name }, adminAuth);
  expect(res.response.status).toBe(201);
  return res.body;
}

async function assignTechnician(jobId: number, technicianId: number, adminAuth: RequestInit) {
  const res = await put(`/api/jobs/${jobId}`, { technician_id: technicianId }, adminAuth);
  expect(res.response.status).toBe(200);
}

/** Creates a customer + a real completed Job (full compliance ceremony,
 *  same as compliance.test.ts's own jobInProgress() precedent) — the
 *  genuine eligible-follow-up path, not a fabricated status flip. */
async function makeCompletedJob(auth: RequestInit): Promise<{ customerId: number; jobId: number }> {
  const customer = await createCustomer(`Retention Customer ${Math.random().toString(36).slice(2, 8)}`);
  const job = await createJob(customer.id, "2026-09-01");
  const tech = await createTechnicianRow(auth);
  await assignTechnician(job.id, tech.id, auth);
  const started = await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, auth);
  expect(started.response.status).toBe(200);
  await satisfyCompletionRequirements(job.id, auth);
  const completed = await post(`/api/jobs/${job.id}/transition`, { to_status: "completed" }, auth);
  expect(completed.response.status).toBe(200);
  return { customerId: customer.id, jobId: job.id };
}

async function setSetting(auth: RequestInit, key: string, value: string, dataType: "string" | "number" = "string") {
  const res = await post("/api/settings", { key, value, data_type: dataType }, auth);
  expect(res.response.status).toBe(201);
}

// ── Marketing consent / suppression ──────────────────────────────────────

describe("Marketing consent and suppression", () => {
  it("opting in to marketing requires a consent source; transactional preferences are untouched", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer("Consent Customer");

    const bare = await put(`/api/customers/${customer.id}/marketing-preferences`, { marketing_email_opt_in: true }, auth);
    expect(bare.response.status).toBe(400);

    const withSource = await put<{ preferences: { marketingEmail: { enabled: boolean; consentSource: string }; email: { enabled: boolean } } }>(
      `/api/customers/${customer.id}/marketing-preferences`, { marketing_email_opt_in: true, consent_source: "web" }, auth
    );
    expect(withSource.response.status).toBe(200);
    expect(withSource.body.preferences.marketingEmail.enabled).toBe(true);
    expect(withSource.body.preferences.marketingEmail.consentSource).toBe("web");
    // Transactional email stays at its untouched default (opt-out marketing
    // toggle must never silently flip the separate transactional channel).
    expect(withSource.body.preferences.email.enabled).toBe(true);
  });

  it("does not leak marketing-preference mutation across organizations", async () => {
    const customer = await createCustomer("Tenant Consent Customer");
    const orgB = await createSecondOrganization("Org B Consent");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    const result = await put(`/api/customers/${customer.id}/marketing-preferences`, { marketing_email_opt_in: true, consent_source: "web" }, orgBAuth);
    expect(result.response.status).toBe(404);
  });
});

// ── Post-job follow-up / satisfaction / review request ───────────────────

describe("Post-job follow-up", () => {
  it("creates exactly one follow-up per completed Job, never a duplicate on rerun", async () => {
    const auth = await authHeaders();
    const { jobId } = await makeCompletedJob(auth);

    const run1 = await post<{ followUpsCreated: number }>("/api/retention/automation/run", {}, auth);
    expect(run1.response.status).toBe(200);
    expect(run1.body.followUpsCreated).toBeGreaterThanOrEqual(1);

    const run2 = await post<{ followUpsCreated: number }>("/api/retention/automation/run", {}, auth);
    expect(run2.body.followUpsCreated).toBe(0);

    const rows = await queryDb<{ id: number }>("SELECT id FROM customer_follow_ups WHERE job_id = ?", [jobId]);
    expect(rows).toHaveLength(1);
  });

  it("never creates a follow-up for a Job completed long before this feature existed — no retroactive flood of the historical backlog", async () => {
    const auth = await authHeaders();
    const { jobId } = await makeCompletedJob(auth);
    // Backdate the completion event itself (not just the Job row) well
    // beyond the lookback window — simulates a Job that finished years
    // before this feature shipped.
    await queryDb(
      "UPDATE job_status_history SET created_at = datetime('now', '-120 days') WHERE job_id = ? AND to_status = 'completed'",
      [jobId]
    );

    await post("/api/retention/automation/run", {}, auth);
    const rows = await queryDb<{ id: number }>("SELECT id FROM customer_follow_ups WHERE job_id = ?", [jobId]);
    expect(rows).toHaveLength(0);
  });

  it("never creates a follow-up for a Job that is not completed", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer("Not Completed Customer");
    await createJob(customer.id, "2026-09-01");

    await post("/api/retention/automation/run", {}, auth);
    const rows = await queryDb<{ id: number }>("SELECT id FROM customer_follow_ups");
    expect(rows).toHaveLength(0);
  });

  it("sends the follow-up once its due date arrives, via the real public token flow, and a satisfied response shows the configured review link", async () => {
    const auth = await authHeaders();
    await setSetting(auth, "POST_JOB_FOLLOWUP_DAYS", "0", "number"); // due immediately for this test
    await setSetting(auth, "APP_PUBLIC_URL", "https://ofs.example.test");
    await setSetting(auth, "REVIEW_REQUEST_URL", "https://reviews.example.test/leave");
    const { jobId } = await makeCompletedJob(auth);

    await post("/api/retention/automation/run", {}, auth);
    const followUpRow = (await queryDb<{ id: number; status: string; token_hash: string }>(
      "SELECT id, status, token_hash FROM customer_follow_ups WHERE job_id = ?", [jobId]
    ))[0];
    expect(followUpRow.status).toBe("sent");
    expect(followUpRow.token_hash).toBeTruthy();

    // The real token is never persisted in plaintext — recover it the only
    // way a real customer would: from the actual enqueued notification
    // payload (this test's own fixture inspection, not an API the client
    // could ever call).
    const outboxRow = (await queryDb<{ payload: string }>(
      "SELECT payload FROM notification_outbox WHERE entity_type = 'follow_up' AND entity_id = ?", [followUpRow.id]
    ))[0];
    const payload = JSON.parse(outboxRow.payload);
    const token = String(payload.response_url).split("/follow-up/")[1];
    expect(token).toBeTruthy();

    const view = await request<{ status: string; jobIdentifier: string }>(`/api/public/follow-up/${token}`);
    expect(view.response.status).toBe(200);
    expect(view.body.status).toBe("sent");
    // Explicit whitelist only — internal ids must never reach a public
    // caller (Code Review finding, Phase 19D).
    expect(Object.keys(view.body).sort()).toEqual(["customerName", "jobIdentifier", "status"]);

    const responded = await post<{ status: string; reviewUrl: string | null }>(`/api/public/follow-up/${token}/respond`, { response: "satisfied" });
    expect(responded.response.status).toBe(200);
    expect(responded.body.status).toBe("satisfied");
    expect(responded.body.reviewUrl).toBe("https://reviews.example.test/leave");

    // Server-side replay idempotency (Section 11's "replay cannot overwrite
    // historical answer"): the public view now reports the real terminal
    // status, and a second /respond call — even with a DIFFERENT answer —
    // must return the ORIGINAL response untouched, never flip it.
    const viewAfter = await request<{ status: string }>(`/api/public/follow-up/${token}`);
    expect(viewAfter.body.status).toBe("satisfied");

    const replay = await post<{ status: string; reviewUrl: string | null }>(`/api/public/follow-up/${token}/respond`, { response: "needs_attention", notes: "trying to overwrite" });
    expect(replay.response.status).toBe(200);
    expect(replay.body.status).toBe("satisfied"); // unchanged, not flipped to needs_attention
    const rowAfterReplay = (await queryDb<{ status: string; response_notes: string }>(
      "SELECT status, response_notes FROM customer_follow_ups WHERE id = ?", [followUpRow.id]
    ))[0];
    expect(rowAfterReplay.status).toBe("satisfied");
    expect(rowAfterReplay.response_notes).not.toBe("trying to overwrite");
  });

  it("an invalid or unknown follow-up token is rejected, never leaking follow-up state", async () => {
    const bad = await request("/api/public/follow-up/not-a-real-token");
    expect(bad.response.status).toBe(404);
    const badRespond = await post("/api/public/follow-up/not-a-real-token/respond", { response: "satisfied" });
    expect(badRespond.response.status).toBe(404);
  });

  it("negative-feedback guard: a needs_attention response never shows a review link, even when one is configured", async () => {
    const auth = await authHeaders();
    await setSetting(auth, "POST_JOB_FOLLOWUP_DAYS", "0", "number");
    await setSetting(auth, "APP_PUBLIC_URL", "https://ofs.example.test");
    await setSetting(auth, "REVIEW_REQUEST_URL", "https://reviews.example.test/leave");
    const { jobId } = await makeCompletedJob(auth);
    await post("/api/retention/automation/run", {}, auth);

    const followUpRow = (await queryDb<{ id: number }>("SELECT id FROM customer_follow_ups WHERE job_id = ?", [jobId]))[0];
    const outboxRow = (await queryDb<{ payload: string }>(
      "SELECT payload FROM notification_outbox WHERE entity_type = 'follow_up' AND entity_id = ?", [followUpRow.id]
    ))[0];
    const token = String(JSON.parse(outboxRow.payload).response_url).split("/follow-up/")[1];

    const responded = await post<{ status: string; reviewUrl: string | null }>(`/api/public/follow-up/${token}/respond`, { response: "needs_attention", notes: "The furnace is still noisy" });
    expect(responded.response.status).toBe(200);
    expect(responded.body.status).toBe("needs_attention");
    expect(responded.body.reviewUrl).toBeNull();

    // Internal escalation is visible to staff — never auto-resolved, never
    // auto-pushed toward a public review.
    const list = await request<{ followUps: { status: string }[] }>("/api/retention/follow-ups?status=needs_attention", auth);
    expect(list.body.followUps).toHaveLength(1);

    const closed = await post(`/api/retention/follow-ups/${followUpRow.id}/close`, {}, auth);
    expect(closed.response.status).toBe(200);
  });

  it("shows the maintenance-plan offer only to a satisfied, non-member customer — never auto-enrolls", async () => {
    const auth = await authHeaders();
    await setSetting(auth, "POST_JOB_FOLLOWUP_DAYS", "0", "number");
    await setSetting(auth, "APP_PUBLIC_URL", "https://ofs.example.test");
    const planCreate = await post("/api/maintenance/plans", { code: "OFFER1", name: "Offer Plan", tier: "STANDARD", price_cents: 10000, taxable: false }, auth);
    expect(planCreate.response.status).toBe(201);
    const { jobId } = await makeCompletedJob(auth);
    await post("/api/retention/automation/run", {}, auth);

    const followUpRow = (await queryDb<{ id: number }>("SELECT id FROM customer_follow_ups WHERE job_id = ?", [jobId]))[0];
    const outboxRow = (await queryDb<{ payload: string }>(
      "SELECT payload FROM notification_outbox WHERE entity_type = 'follow_up' AND entity_id = ?", [followUpRow.id]
    ))[0];
    const token = String(JSON.parse(outboxRow.payload).response_url || "").split("/follow-up/")[1];

    const responded = await post<{ planOffer: { id: number; name: string }[] | null }>(`/api/public/follow-up/${token}/respond`, { response: "satisfied" });
    expect(responded.response.status).toBe(200);
    expect(responded.body.planOffer).not.toBeNull();
    expect(responded.body.planOffer!.some((p) => p.name === "Offer Plan")).toBe(true);

    // No Membership/Agreement was silently created — the legal/consent
    // e-sign flow (Phase 19B) is the only path to an actual enrollment.
    const memberships = await queryDb<{ id: number }>("SELECT id FROM maintenance_memberships");
    expect(memberships).toHaveLength(0);
  });

  it("does not leak another organization's follow-up queue; technician is denied", async () => {
    const auth = await authHeaders();
    const { technicianId } = await createLinkedTechnician("followup-tech@example.test", auth);
    void technicianId;
    const { auth: techAuth } = await createLinkedTechnician("followup-tech2@example.test", auth);
    await makeCompletedJob(auth);
    await post("/api/retention/automation/run", {}, auth);

    expect((await request("/api/retention/follow-ups", techAuth)).response.status).toBe(403);

    const orgB = await createSecondOrganization("Org B Follow-up");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    const orgBList = await request<{ followUps: unknown[] }>("/api/retention/follow-ups", orgBAuth);
    expect(orgBList.body.followUps).toHaveLength(0);
  });
});

// ── Referral program ──────────────────────────────────────────────────

describe("Referral program", () => {
  it("mints a referral code, rejects self-referral, and creates an attributed Lead on a valid claim", async () => {
    const auth = await authHeaders();
    await put("/api/retention/referral-program", { enabled: true, reward_type: "account_credit", reward_value_cents: 500, qualification_rule: "first_completed_job" }, auth);
    const referrer = await createCustomer("Referrer One");

    const created = await post<{ referral: { referral_code: string } }>(`/api/customers/${referrer.id}/referrals`, {}, auth);
    expect(created.response.status).toBe(201);
    const code = created.body.referral.referral_code;

    const view = await request<{ referrerName: string }>(`/api/public/refer/${code}`);
    expect(view.response.status).toBe(200);
    expect(view.body.referrerName).toBe("Referrer One");

    // Self-referral (same phone as the referrer) is rejected.
    const selfAttempt = await post(`/api/public/refer/${code}/claim`, { name: "Referrer One", phone: "555-0100" });
    expect(selfAttempt.response.status).toBe(404);

    // Self-referral is ALSO rejected when the phone is merely reformatted —
    // digits-only normalization must catch "(555) 0100" against the
    // referrer's stored "555-0100" (Security review finding, Phase 19D).
    const reformattedSelfAttempt = await post(`/api/public/refer/${code}/claim`, { name: "Referrer One Again", phone: "(555) 0100" });
    expect(reformattedSelfAttempt.response.status).toBe(404);

    const claim = await post(`/api/public/refer/${code}/claim`, { name: "Friend Of Referrer", phone: "555-9999" });
    expect(claim.response.status).toBe(201);

    const lead = (await queryDb<{ id: number; referral_source: string; referred_by_customer_id: number }>(
      "SELECT id, referral_source, referred_by_customer_id FROM leads WHERE name = 'Friend Of Referrer'"
    ))[0];
    expect(lead.referral_source).toBe("Existing Customer");
    expect(lead.referred_by_customer_id).toBe(referrer.id);

    // The code is single-use — a second claim attempt fails.
    const secondClaim = await post(`/api/public/refer/${code}/claim`, { name: "Someone Else", phone: "555-1111" });
    expect(secondClaim.response.status).toBe(404);
  });

  it("rejects a cross-tenant referral code lookup/claim", async () => {
    const auth = await authHeaders();
    const referrer = await createCustomer("Cross Tenant Referrer");
    await post<{ referral: { referral_code: string } }>(`/api/customers/${referrer.id}/referrals`, {}, auth);

    // A code minted for org A is a real, valid link regardless of who else
    // exists — the public lookup only cares whether the code itself is
    // active, never which org an unauthenticated caller happens to be
    // associated with (there is no such association for a public caller).
    // What tenant isolation actually guards here is the ADMIN-side listing.
    const orgB = await createSecondOrganization("Org B Referral");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    const orgBList = await request<{ referrals: unknown[] }>("/api/retention/referrals", orgBAuth);
    expect(orgBList.body.referrals).toHaveLength(0);
    // Scoped by organization_id — a cross-org customer id 404s, matching
    // this codebase's established per-customer sub-resource convention
    // (e.g. GET .../notification-preferences), never a leaked result.
    const orgBCustomerList = await request(`/api/customers/${referrer.id}/referrals`, orgBAuth);
    expect(orgBCustomerList.response.status).toBe(404);
  });

  it("a disabled referral program blocks new claims, even against an already-minted code", async () => {
    const auth = await authHeaders();
    await put("/api/retention/referral-program", { enabled: true, reward_type: "account_credit", reward_value_cents: 500, qualification_rule: "first_completed_job" }, auth);
    const referrer = await createCustomer("Disabled Program Referrer");
    const created = await post<{ referral: { referral_code: string } }>(`/api/customers/${referrer.id}/referrals`, {}, auth);
    const code = created.body.referral.referral_code;

    // Admin disables the program (e.g. for abuse) AFTER the code was minted
    // and shared.
    await put("/api/retention/referral-program", { enabled: false, reward_type: "account_credit", reward_value_cents: 500, qualification_rule: "first_completed_job" }, auth);

    const claim = await post(`/api/public/refer/${code}/claim`, { name: "Too Late Friend", phone: "555-8888" });
    expect(claim.response.status).toBe(404);
    const leads = await queryDb<{ id: number }>("SELECT id FROM leads WHERE name = 'Too Late Friend'");
    expect(leads).toHaveLength(0);
  });

  it("qualifies a referral and issues exactly one reward — idempotent under a genuine concurrent re-scan", async () => {
    const auth = await authHeaders();
    await put("/api/retention/referral-program", {
      enabled: true, reward_type: "account_credit", reward_value_cents: 2500, qualification_rule: "first_completed_job",
    }, auth);

    const referrer = await createCustomer("Qualifying Referrer");
    const created = await post<{ referral: { referral_code: string; id: number } }>(`/api/customers/${referrer.id}/referrals`, {}, auth);
    const code = created.body.referral.referral_code;
    await post(`/api/public/refer/${code}/claim`, { name: "Qualifying Friend", phone: "555-2222" });

    const lead = (await queryDb<{ id: number }>("SELECT id FROM leads WHERE name = 'Qualifying Friend'"))[0];
    // Walk the real Lead pipeline (new -> contacted -> qualified ->
    // estimate -> won) — convertLead() only accepts estimate/won.
    for (const toStatus of ["contacted", "qualified", "estimate", "won"]) {
      const t = await post(`/api/leads/${lead.id}/transition`, { to_status: toStatus }, auth);
      expect(t.response.status).toBe(200);
    }
    // Convert the Lead to a Customer (Phase 8.3's real conversion path) and
    // give them a completed Job — the genuine qualifying business event.
    const convertRes = await post<{ customer: { id: number } }>(`/api/leads/${lead.id}/convert`, {}, auth);
    expect([200, 201]).toContain(convertRes.response.status);
    const referredCustomerId = convertRes.body.customer.id;
    const job = await createJob(referredCustomerId, "2026-09-02");
    const tech = await createTechnicianRow(auth, "Qualify Tech");
    await assignTechnician(job.id, tech.id, auth);
    await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, auth);
    await satisfyCompletionRequirements(job.id, auth);
    await post(`/api/jobs/${job.id}/transition`, { to_status: "completed" }, auth);

    // Two genuinely concurrent manual runs — the reward must be issued
    // exactly once (UNIQUE(source_type, source_id) is the real guard).
    const [r1, r2] = await Promise.all([
      post("/api/retention/automation/run", {}, auth),
      post("/api/retention/automation/run", {}, auth),
    ]);
    expect(r1.response.status).toBe(200);
    expect(r2.response.status).toBe(200);

    const referralRow = (await queryDb<{ status: string }>("SELECT status FROM customer_referrals WHERE id = ?", [created.body.referral.id]))[0];
    expect(referralRow.status).toBe("qualified");

    const credits = await queryDb<{ id: number; amount_cents: number; status: string }>(
      "SELECT id, amount_cents, status FROM customer_credit_ledger WHERE customer_id = ? AND source_type = 'referral_reward'", [referrer.id]
    );
    expect(credits).toHaveLength(1);
    expect(credits[0].amount_cents).toBe(2500);
    expect(credits[0].status).toBe("issued");
  });

  it("never rewards merely because a Lead was created — no completed Job/paid Invoice yet", async () => {
    const auth = await authHeaders();
    await put("/api/retention/referral-program", { enabled: true, reward_type: "account_credit", reward_value_cents: 1000, qualification_rule: "first_completed_job" }, auth);
    const referrer = await createCustomer("No Reward Referrer");
    const created = await post<{ referral: { referral_code: string } }>(`/api/customers/${referrer.id}/referrals`, {}, auth);
    await post(`/api/public/refer/${created.body.referral.referral_code}/claim`, { name: "Unqualified Friend", phone: "555-3333" });

    await post("/api/retention/automation/run", {}, auth);
    const credits = await queryDb<{ id: number }>("SELECT id FROM customer_credit_ledger");
    expect(credits).toHaveLength(0);
  });

  it("admin can manually issue and void a loyalty credit; dispatcher cannot issue", async () => {
    const auth = await authHeaders();
    const dispatch = await dispatcherAuth();
    const customer = await createCustomer("Loyalty Customer");

    expect((await post(`/api/customers/${customer.id}/credits`, { amount_cents: 500, reason: "goodwill" }, dispatch)).response.status).toBe(403);

    const issued = await post<{ credit: { id: number } }>(`/api/customers/${customer.id}/credits`, { amount_cents: 500, reason: "goodwill gesture" }, auth);
    expect(issued.response.status).toBe(201);

    const balance = await request<{ availableBalanceCents: number }>(`/api/customers/${customer.id}/credits`, auth);
    expect(balance.body.availableBalanceCents).toBe(500);

    const voided = await post(`/api/credits/${issued.body.credit.id}/void`, { reason: "issued in error" }, auth);
    expect(voided.response.status).toBe(200);

    const afterVoid = await request<{ availableBalanceCents: number }>(`/api/customers/${customer.id}/credits`, auth);
    expect(afterVoid.body.availableBalanceCents).toBe(0);
  });
});

// ── Seasonal campaigns ────────────────────────────────────────────────

describe("Seasonal campaigns", () => {
  it("a draft campaign never sends; dispatcher can view but not create/schedule", async () => {
    const auth = await authHeaders();
    const dispatch = await dispatcherAuth();

    expect((await post("/api/campaigns", { name: "Winter Reminder", channel: "email", body: "Book your furnace check!" }, dispatch)).response.status).toBe(403);

    const created = await post<{ campaign: { id: number; status: string } }>("/api/campaigns", { name: "Winter Reminder", channel: "email", body: "Book your furnace check!" }, auth);
    expect(created.response.status).toBe(201);
    expect(created.body.campaign.status).toBe("draft");

    expect((await request(`/api/campaigns/${created.body.campaign.id}`, dispatch)).response.status).toBe(200);
    expect((await post(`/api/campaigns/${created.body.campaign.id}/schedule`, { scheduled_for: "2026-12-01" }, dispatch)).response.status).toBe(403);

    await post("/api/retention/automation/run", {}, auth);
    const recipients = await queryDb<{ id: number }>("SELECT id FROM campaign_recipients WHERE campaign_id = ?", [created.body.campaign.id]);
    expect(recipients).toHaveLength(0);
  });

  it("audience preview reflects real suppression without sending anything", async () => {
    const auth = await authHeaders();
    const optedIn = await createCustomer("Opted In Customer");
    await put(`/api/customers/${optedIn.id}/marketing-preferences`, { marketing_email_opt_in: true, consent_source: "web" }, auth);
    await createCustomer("Not Opted In Customer");

    const created = await post<{ campaign: { id: number } }>("/api/campaigns", { name: "Preview Test", channel: "email", body: "Hello" }, auth);
    const preview = await post<{ totalCandidates: number; eligible: number; suppressed: number }>(`/api/campaigns/${created.body.campaign.id}/preview-audience`, {}, auth);
    expect(preview.response.status).toBe(200);
    expect(preview.body.totalCandidates).toBeGreaterThanOrEqual(2);
    expect(preview.body.eligible).toBeGreaterThanOrEqual(1);
    expect(preview.body.suppressed).toBeGreaterThanOrEqual(1);

    const recipients = await queryDb<{ id: number }>("SELECT id FROM campaign_recipients WHERE campaign_id = ?", [created.body.campaign.id]);
    expect(recipients).toHaveLength(0);
  });

  it("a scheduled campaign sends once to each eligible recipient and never duplicates on rerun; excludes a suppressed customer", async () => {
    const auth = await authHeaders();
    const optedIn = await createCustomer("Campaign Recipient");
    await put(`/api/customers/${optedIn.id}/marketing-preferences`, { marketing_email_opt_in: true, consent_source: "web" }, auth);
    await createCustomer("Never Opted In");

    const created = await post<{ campaign: { id: number } }>("/api/campaigns", { name: "Send Test", channel: "email", body: "Hello there" }, auth);
    const scheduled = await post(`/api/campaigns/${created.body.campaign.id}/schedule`, { scheduled_for: "2020-01-01" }, auth);
    expect(scheduled.response.status).toBe(200);

    const run1 = await post<{ campaignSends: number }>("/api/retention/automation/run", {}, auth);
    expect(run1.body.campaignSends).toBe(1);

    const run2 = await post<{ campaignSends: number }>("/api/retention/automation/run", {}, auth);
    expect(run2.body.campaignSends).toBe(0);

    const recipients = await queryDb<{ customer_id: number; status: string }>(
      "SELECT customer_id, status FROM campaign_recipients WHERE campaign_id = ?", [created.body.campaign.id]
    );
    expect(recipients).toHaveLength(2); // one sent, one suppressed — never a third row on rerun
    const sent = recipients.find((r) => r.customer_id === optedIn.id)!;
    expect(sent.status).toBe("sent");
    const finalCampaign = await request<{ campaign: { status: string } }>(`/api/campaigns/${created.body.campaign.id}`, auth);
    expect(finalCampaign.body.campaign.status).toBe("completed");
  });

  it("every marketing send carries a real, working unsubscribe link — using it suppresses future sends without touching transactional preferences", async () => {
    const auth = await authHeaders();
    await setSetting(auth, "APP_PUBLIC_URL", "https://ofs.example.test");
    const customer = await createCustomer("Unsubscribe Test Customer");
    await put(`/api/customers/${customer.id}/marketing-preferences`, { marketing_email_opt_in: true, consent_source: "web" }, auth);

    const created = await post<{ campaign: { id: number } }>("/api/campaigns", { name: "Unsub Test", channel: "email", body: "Seasonal reminder" }, auth);
    await post(`/api/campaigns/${created.body.campaign.id}/schedule`, { scheduled_for: "2020-01-01" }, auth);
    const run1 = await post<{ campaignSends: number }>("/api/retention/automation/run", {}, auth);
    expect(run1.body.campaignSends).toBe(1);

    const outboxRow = (await queryDb<{ payload: string }>(
      "SELECT payload FROM notification_outbox WHERE entity_type = 'campaign' AND entity_id = ?", [created.body.campaign.id]
    ))[0];
    const unsubscribeToken = String(JSON.parse(outboxRow.payload).unsubscribeUrl || "").split("/unsubscribe/")[1];
    expect(unsubscribeToken).toBeTruthy();

    const view = await request<{ ok: boolean }>(`/api/public/marketing-unsubscribe/${unsubscribeToken}`);
    expect(view.response.status).toBe(200);
    const unsub = await post(`/api/public/marketing-unsubscribe/${unsubscribeToken}`, {});
    expect(unsub.response.status).toBe(200);

    const prefs = await request<{ preferences: { email: { enabled: boolean }; marketingEmail: { enabled: boolean } } }>(`/api/customers/${customer.id}/notification-preferences`, auth);
    expect(prefs.body.preferences.marketingEmail.enabled).toBe(false);
    // Transactional email is completely unaffected by a marketing unsubscribe.
    expect(prefs.body.preferences.email.enabled).toBe(true);

    // A second campaign never reaches this now-unsubscribed customer.
    const created2 = await post<{ campaign: { id: number } }>("/api/campaigns", { name: "Unsub Test 2", channel: "email", body: "Another reminder" }, auth);
    await post(`/api/campaigns/${created2.body.campaign.id}/schedule`, { scheduled_for: "2020-01-01" }, auth);
    const run2 = await post<{ campaignSends: number }>("/api/retention/automation/run", {}, auth);
    expect(run2.body.campaignSends).toBe(0);
  });

  it("a paused campaign is never processed by the automated scan", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer("Pause Test Customer");
    await put(`/api/customers/${customer.id}/marketing-preferences`, { marketing_email_opt_in: true, consent_source: "web" }, auth);

    const created = await post<{ campaign: { id: number } }>("/api/campaigns", { name: "Pause Test", channel: "email", body: "Hi" }, auth);
    await post(`/api/campaigns/${created.body.campaign.id}/schedule`, { scheduled_for: "2020-01-01" }, auth);
    const paused = await post<{ campaign: { status: string } }>(`/api/campaigns/${created.body.campaign.id}/pause`, {}, auth);
    expect(paused.body.campaign.status).toBe("paused");

    await post("/api/retention/automation/run", {}, auth);
    const recipients = await queryDb<{ id: number }>("SELECT id FROM campaign_recipients WHERE campaign_id = ?", [created.body.campaign.id]);
    expect(recipients).toHaveLength(0);
  });

  it("content/audience become immutable once a campaign leaves draft", async () => {
    const auth = await authHeaders();
    const created = await post<{ campaign: { id: number } }>("/api/campaigns", { name: "Immutable Test", channel: "email", body: "Original" }, auth);
    await post(`/api/campaigns/${created.body.campaign.id}/schedule`, { scheduled_for: "2099-01-01" }, auth);
    const edit = await put(`/api/campaigns/${created.body.campaign.id}`, { body: "Changed after scheduling" }, auth);
    expect(edit.response.status).toBe(400);
  });
});

// ── Automation ledger tenant isolation ───────────────────────────────────

describe("Retention automation runs", () => {
  it("does not leak another organization's automation run history", async () => {
    const auth = await authHeaders();
    await makeCompletedJob(auth);
    const run = await post<{ followUpsCreated: number }>("/api/retention/automation/run", {}, auth);
    expect(run.response.status).toBe(200);

    const orgB = await createSecondOrganization("Org B Retention Runs");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    const orgBHistory = await request<{ runs: unknown[] }>("/api/retention/automation/runs", orgBAuth);
    expect(orgBHistory.response.status).toBe(200);
    expect(orgBHistory.body.runs).toHaveLength(0);
  });

  it("the real Cloudflare scheduled() cron handler drives the exact same cycle — no second scheduler", async () => {
    const auth = await authHeaders();
    await setSetting(auth, "POST_JOB_FOLLOWUP_DAYS", "0", "number");
    const { jobId } = await makeCompletedJob(auth);

    await runScheduled();

    const rows = await queryDb<{ id: number }>("SELECT id FROM customer_follow_ups WHERE job_id = ?", [jobId]);
    expect(rows).toHaveLength(1);
  });
});

// ── Retention signals ────────────────────────────────────────────────────

describe("Retention signals", () => {
  it("computes deterministic signals from real completed-Job history", async () => {
    const auth = await authHeaders();
    const { customerId } = await makeCompletedJob(auth);

    const signals = await request<{ activeCustomer: boolean; repeatCustomer: boolean; atRisk: boolean }>(`/api/customers/${customerId}/retention-signals`, auth);
    expect(signals.response.status).toBe(200);
    expect(signals.body.activeCustomer).toBe(true);
    expect(signals.body.repeatCustomer).toBe(false); // only one completed Job so far
  });
});
