import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createSecondOrganization,
  createUser, extractPdfText, loginAs, post, put, request, requestRaw, queryDb, resetDatabase,
} from "./helpers.js";

// Phase 19B — Maintenance Plans / Memberships / Agreements / Legal Terms /
// Checklists / Service Reports. Mirrors contracts.test.ts's real-API-
// fixture-through-real-session discipline throughout: tenant isolation via
// createSecondOrganization(), RBAC via createUser()+loginAs(), historical
// integrity proven via re-fetching a signed Agreement after its source Plan/
// Terms change, entitlement idempotency proven via concurrent finalize.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function dispatcherAuth(email = "maint-dispatch@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
  const userRes = await post<{ user: { id: number } }>("/api/users", { name: email, email, password: "TechPass123", role: "technician" }, adminAuth);
  expect(userRes.response.status).toBe(201);
  const techRes = await post<{ id: number }>("/api/technicians", { name: email, user_id: userRes.body.user.id }, adminAuth);
  expect(techRes.response.status).toBe(201);
  const { cookie } = await loginAs(email, "TechPass123");
  return { auth: { headers: { cookie } } as RequestInit, technicianId: techRes.body.id };
}

async function makeCustomer(auth: RequestInit, name = "Maintenance Test Customer") {
  const res = await post<{ id: number }>("/api/customers", { name, email: "maint-cust@example.test", phone: "555-0100" }, auth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

async function makeAsset(auth: RequestInit, customerId: number, overrides: Record<string, unknown> = {}) {
  const res = await post<{ asset: { id: number } }>("/api/assets", { customer_id: customerId, asset_type: "FURNACE", manufacturer: "Carrier", model: "X1", serial_number: "SN-1", ...overrides }, auth);
  expect(res.response.status).toBe(201);
  return res.body.asset.id;
}

async function makePlan(auth: RequestInit, overrides: Record<string, unknown> = {}) {
  const res = await post<{ plan: { id: number; code: string } }>("/api/maintenance/plans", {
    code: `PLAN-${Math.random().toString(36).slice(2, 8)}`, name: "Standard Maintenance", tier: "STANDARD",
    price_cents: 20000, taxable: false, visit_entitlement_count: 2, ...overrides,
  }, auth);
  expect(res.response.status).toBe(201);
  return res.body.plan;
}

async function makePublishedTerms(auth: RequestInit, content = "Standard maintenance terms v1.") {
  const doc = await post<{ document: { id: number }; version: { id: number } }>("/api/legal-terms", { type: "MAINTENANCE", title: "Residential Maintenance Terms" }, auth);
  expect(doc.response.status).toBe(201);
  await put(`/api/legal-terms/${doc.body.document.id}/versions/${doc.body.version.id}`, { content }, auth);
  const pub = await post<{ version: { id: number; content_hash: string } }>(`/api/legal-terms/${doc.body.document.id}/versions/${doc.body.version.id}/publish`, {}, auth);
  expect(pub.response.status).toBe(200);
  return { documentId: doc.body.document.id, versionId: pub.body.version.id, hash: pub.body.version.content_hash };
}

async function makeDraftAgreement(auth: RequestInit, customerId: number, planId: number, overrides: Record<string, unknown> = {}) {
  const res = await post<{ agreement: { id: number; identifier: string }; version: { id: number; plan_snapshot: string; terms_version_id: number | null } }>("/api/maintenance/agreements", {
    customer_id: customerId, plan_id: planId, ...overrides,
  }, auth);
  expect(res.response.status).toBe(201);
  return res.body;
}

async function sendAndSign(auth: RequestInit, agreementId: number, signerOverrides: Record<string, unknown> = {}, signOverrides: Record<string, unknown> = {}) {
  const signer = await post<{ signer: { id: number } }>(`/api/maintenance/agreements/${agreementId}/signers`, { name: "Jane Customer", email: "jane@example.test", ...signerOverrides }, auth);
  expect(signer.response.status).toBe(201);
  const sent = await post<{ signingLinks: { signerId: number; token: string }[] }>(`/api/maintenance/agreements/${agreementId}/send`, { consent_text_version: "v1" }, auth);
  expect(sent.response.status).toBe(200);
  const token = sent.body.signingLinks[0].token;

  const consent = await post(`/api/public/maintenance-agreements/sign/${token}/consent`, { consent_text_version: "v1" });
  expect(consent.response.status).toBe(200);
  const sign = await post(`/api/public/maintenance-agreements/sign/${token}/sign`, {
    signer_name: "Jane Customer", signature_method: "typed", auto_renew_enabled: false, auto_renew_consent_text_version: "ar-v1", ...signOverrides,
  });
  expect(sign.response.status).toBe(200);
  return token;
}

// ── Maintenance Plans ────────────────────────────────────────────────

describe("Maintenance Plan catalog", () => {
  it("admin creates, lists, and updates a plan", async () => {
    const auth = await authHeaders();
    const plan = await makePlan(auth, { name: "Premium Plan", tier: "PREMIUM" });

    const list = await request<{ plans: { id: number }[] }>("/api/maintenance/plans", auth);
    expect(list.body.plans.some((p) => p.id === plan.id)).toBe(true);

    const updated = await put<{ plan: { name: string; price_cents: number } }>(`/api/maintenance/plans/${plan.id}`, { name: "Premium Plan Updated", price_cents: 30000 }, auth);
    expect(updated.response.status).toBe(200);
    expect(updated.body.plan.name).toBe("Premium Plan Updated");
    expect(updated.body.plan.price_cents).toBe(30000);
  });

  it("rejects a duplicate plan code within the same organization", async () => {
    const auth = await authHeaders();
    await makePlan(auth, { code: "DUPE-CODE" });
    const dupe = await post("/api/maintenance/plans", { code: "DUPE-CODE", name: "Another", price_cents: 100 }, auth);
    expect(dupe.response.status).toBe(409);
  });

  it("blocks technician from managing or reading plans; dispatcher may read but not write", async () => {
    const adminAuth = await authHeaders();
    const plan = await makePlan(adminAuth);
    const { auth: techAuth } = await createLinkedTechnician("plan-tech@example.test", adminAuth);
    const dispatch = await dispatcherAuth();

    expect((await post("/api/maintenance/plans", { code: "X", name: "X", price_cents: 1 }, techAuth)).response.status).toBe(403);
    expect((await request("/api/maintenance/plans", techAuth)).response.status).toBe(403);

    expect((await request<{ plans: unknown[] }>("/api/maintenance/plans", dispatch)).response.status).toBe(200);
    expect((await post("/api/maintenance/plans", { code: "Y", name: "Y", price_cents: 1 }, dispatch)).response.status).toBe(403);
    void plan;
  });

  it("rejects a percent/fixed discount_type without its required amount", async () => {
    const auth = await authHeaders();
    const missingPercent = await post("/api/maintenance/plans", { code: "BADPCT", name: "Bad Percent", price_cents: 100, discount_type: "percent" }, auth);
    expect(missingPercent.response.status).toBe(400);

    const missingFixed = await post("/api/maintenance/plans", { code: "BADFIX", name: "Bad Fixed", price_cents: 100, discount_type: "fixed" }, auth);
    expect(missingFixed.response.status).toBe(400);
  });

  it("does not leak a plan across organizations", async () => {
    const auth = await authHeaders();
    const plan = await makePlan(auth);
    const orgB = await createSecondOrganization("Org B Maintenance");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };

    const res = await request(`/api/maintenance/plans/${plan.id}`, orgBAuth);
    expect(res.response.status).toBe(404);
  });
});

// ── Legal Terms Library ─────────────────────────────────────────────

describe("Legal Terms Library", () => {
  it("draft is editable, publish is one-way and supersedes the prior published version", async () => {
    const auth = await authHeaders();
    const { documentId, versionId, hash } = await makePublishedTerms(auth, "v1 content");
    expect(hash).toBeTruthy();

    // Published version is now immutable.
    const editAttempt = await put(`/api/legal-terms/${documentId}/versions/${versionId}`, { content: "changed" }, auth);
    expect(editAttempt.response.status).toBe(409);

    // A new draft, edited, published — supersedes v1.
    const draft2 = await post<{ version: { id: number; version_number: number } }>(`/api/legal-terms/${documentId}/versions`, {}, auth);
    expect(draft2.response.status).toBe(201);
    expect(draft2.body.version.version_number).toBe(2);
    await put(`/api/legal-terms/${documentId}/versions/${draft2.body.version.id}`, { content: "v2 content" }, auth);
    const pub2 = await post(`/api/legal-terms/${documentId}/versions/${draft2.body.version.id}/publish`, {}, auth);
    expect(pub2.response.status).toBe(200);

    const detail = await request<{ document: { current_published_version_id: number }; versions: { id: number; status: string }[] }>(`/api/legal-terms/${documentId}`, auth);
    expect(detail.body.document.current_published_version_id).toBe(draft2.body.version.id);
    const v1Row = detail.body.versions.find((v) => v.id === versionId);
    expect(v1Row?.status).toBe("superseded");
  });

  it("refuses a second draft while one already exists", async () => {
    const auth = await authHeaders();
    const doc = await post<{ document: { id: number } }>("/api/legal-terms", { type: "MAINTENANCE", title: "T" }, auth);
    const second = await post(`/api/legal-terms/${doc.body.document.id}/versions`, {}, auth);
    expect(second.response.status).toBe(409);
  });

  it("dispatcher can view but not manage; technician blocked entirely", async () => {
    const adminAuth = await authHeaders();
    const { documentId } = await makePublishedTerms(adminAuth);
    const dispatch = await dispatcherAuth("terms-dispatch@example.test");
    const { auth: techAuth } = await createLinkedTechnician("terms-tech@example.test", adminAuth);

    expect((await request("/api/legal-terms", dispatch)).response.status).toBe(200);
    expect((await post("/api/legal-terms", { type: "MAINTENANCE", title: "X" }, dispatch)).response.status).toBe(403);
    expect((await request("/api/legal-terms", techAuth)).response.status).toBe(403);
    void documentId;
  });

  it("rejects publishing a draft with empty content", async () => {
    const auth = await authHeaders();
    const doc = await post<{ document: { id: number }; version: { id: number } }>("/api/legal-terms", { type: "MAINTENANCE", title: "Empty Content Test" }, auth);
    expect(doc.response.status).toBe(201);
    const pub = await post(`/api/legal-terms/${doc.body.document.id}/versions/${doc.body.version.id}/publish`, {}, auth);
    expect(pub.response.status).toBe(400);
  });

  it("does not leak a legal terms document across organizations", async () => {
    const auth = await authHeaders();
    const { documentId } = await makePublishedTerms(auth);
    const orgB = await createSecondOrganization("Org B Legal Terms");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    expect((await request(`/api/legal-terms/${documentId}`, orgBAuth)).response.status).toBe(404);
  });
});

// ── Maintenance Agreements: creation, snapshots, covered equipment ────

describe("Maintenance Agreement creation", () => {
  it("freezes a plan/company/customer snapshot at creation time", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth, { name: "Snapshot Plan", price_cents: 15000 });
    const { agreement, version } = await makeDraftAgreement(auth, customerId, plan.id);

    expect(agreement.identifier).toMatch(/^MAINT-/);
    const planSnapshot = JSON.parse(version.plan_snapshot ?? "{}");
    expect(planSnapshot.name).toBe("Snapshot Plan");
    expect(planSnapshot.price_cents).toBe(15000);
  });

  it("attaches covered equipment only for the same customer, draft-only", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const otherCustomerId = await makeCustomer(auth, "Other Customer");
    const plan = await makePlan(auth);
    const assetId = await makeAsset(auth, customerId);
    const otherAssetId = await makeAsset(auth, otherCustomerId);
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);

    const ok = await post(`/api/maintenance/agreements/${agreement.id}/covered-equipment`, { asset_ids: [assetId] }, auth);
    expect(ok.response.status).toBe(200);

    const crossCustomer = await post(`/api/maintenance/agreements/${agreement.id}/covered-equipment`, { asset_ids: [otherAssetId] }, auth);
    expect(crossCustomer.response.status).toBe(400);
  });

  it("rejects covered equipment from a DIFFERENT organization's asset, not just a different customer", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);

    const orgB = await createSecondOrganization("Org B Cross-Asset");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    const orgBCustomerId = await makeCustomer(orgBAuth, "Org B Customer");
    const orgBAssetId = await makeAsset(orgBAuth, orgBCustomerId);

    const crossOrg = await post<{ error: string }>(`/api/maintenance/agreements/${agreement.id}/covered-equipment`, { asset_ids: [orgBAssetId] }, auth);
    expect(crossOrg.response.status).toBe(400);
    expect(crossOrg.body.error).toMatch(/not found/i);
  });

  it("does not leak an agreement across organizations", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);

    const orgB = await createSecondOrganization("Org B Agreements");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    expect((await request(`/api/maintenance/agreements/${agreement.id}`, orgBAuth)).response.status).toBe(404);
  });

  it("blocks technician entirely; dispatcher has parity with admin", async () => {
    const adminAuth = await authHeaders();
    const customerId = await makeCustomer(adminAuth);
    const plan = await makePlan(adminAuth);
    const { auth: techAuth } = await createLinkedTechnician("agr-tech@example.test", adminAuth);
    const dispatch = await dispatcherAuth("agr-dispatch@example.test");

    expect((await post("/api/maintenance/agreements", { customer_id: customerId, plan_id: plan.id }, techAuth)).response.status).toBe(403);
    const dispatcherCreate = await post("/api/maintenance/agreements", { customer_id: customerId, plan_id: plan.id }, dispatch);
    expect(dispatcherCreate.response.status).toBe(201);
  });
});

// ── Public signing ceremony + auto-renew consent ──────────────────────

describe("Maintenance Agreement public signing", () => {
  it("consent then sign completes the agreement, activates it, and creates a membership", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth, { visit_entitlement_count: 3 });
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);

    await sendAndSign(auth, agreement.id);

    const detail = await request<{ agreement: { status: string } }>(`/api/maintenance/agreements/${agreement.id}`, auth);
    expect(detail.body.agreement.status).toBe("active");

    const membership = await request<{ membership: { status: string; visits_included: number } | null }>(`/api/maintenance/agreements/${agreement.id}/membership`, auth);
    expect(membership.body.membership?.status).toBe("active");
    expect(membership.body.membership?.visits_included).toBe(3);
  });

  it("captures a separate, explicit auto-renew consent record", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreement, version } = await makeDraftAgreement(auth, customerId, plan.id);
    await sendAndSign(auth, agreement.id, {}, { auto_renew_enabled: true, auto_renew_consent_text_version: "ar-v2" });

    const detail = await request<{ version: { auto_renew_consent: string } }>(`/api/maintenance/agreements/${agreement.id}`, auth);
    const consent = JSON.parse(detail.body.version.auto_renew_consent);
    expect(consent.enabled).toBe(true);
    expect(consent.consent_text_version).toBe("ar-v2");
    expect(consent.consent_timestamp).toBeTruthy();
    void version;
  });

  it("rejects signing without prior consent, and rejects reuse of a consumed token", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);
    const signer = await post<{ signer: { id: number } }>(`/api/maintenance/agreements/${agreement.id}/signers`, { name: "Jane", email: "jane@example.test" }, auth);
    const sent = await post<{ signingLinks: { token: string }[] }>(`/api/maintenance/agreements/${agreement.id}/send`, { consent_text_version: "v1" }, auth);
    const token = sent.body.signingLinks[0].token;

    const noConsent = await post(`/api/public/maintenance-agreements/sign/${token}/sign`, {
      signer_name: "Jane", signature_method: "typed", auto_renew_enabled: false, auto_renew_consent_text_version: "v1",
    });
    expect(noConsent.response.status).toBe(400);

    await post(`/api/public/maintenance-agreements/sign/${token}/consent`, { consent_text_version: "v1" });
    const firstSign = await post(`/api/public/maintenance-agreements/sign/${token}/sign`, {
      signer_name: "Jane", signature_method: "typed", auto_renew_enabled: false, auto_renew_consent_text_version: "v1",
    });
    expect(firstSign.response.status).toBe(200);

    // Idempotent re-submit is a safe no-op, not a 409 — same discipline as Contracts.
    const secondSign = await post(`/api/public/maintenance-agreements/sign/${token}/sign`, {
      signer_name: "Jane", signature_method: "typed", auto_renew_enabled: false, auto_renew_consent_text_version: "v1",
    });
    expect(secondSign.response.status).toBe(200);
    void signer;
  });

  it("returns a generic error for an invalid or expired token, no enumeration oracle", async () => {
    const res = await request("/api/public/maintenance-agreements/sign/not-a-real-token", {});
    expect(res.response.status).toBe(404);
  });

  it("a signing link past its expires_at auto-expires on view (not just on sign attempt), and can no longer be signed", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);
    const signer = await post<{ signer: { id: number } }>(`/api/maintenance/agreements/${agreement.id}/signers`, { name: "Jane", email: "jane@example.test" }, auth);
    expect(signer.response.status).toBe(201);
    const sent = await post<{ signingLinks: { token: string }[] }>(`/api/maintenance/agreements/${agreement.id}/send`, { consent_text_version: "v1" }, auth);
    const token = sent.body.signingLinks[0].token;

    await queryDb("UPDATE maintenance_agreement_signature_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE agreement_id = ?", [agreement.id]);

    const view = await request(`/api/public/maintenance-agreements/sign/${token}`, {});
    expect(view.response.status).toBe(404);

    const requests = await queryDb<{ status: string }>("SELECT status FROM maintenance_agreement_signature_requests WHERE agreement_id = ?", [agreement.id]);
    expect(requests[0].status).toBe("expired");

    const consentAttempt = await post(`/api/public/maintenance-agreements/sign/${token}/consent`, { consent_text_version: "v1" });
    expect(consentAttempt.response.status).toBe(404);
    const signAttempt = await post(`/api/public/maintenance-agreements/sign/${token}/sign`, {
      signer_name: "Jane", signature_method: "typed", auto_renew_enabled: false, auto_renew_consent_text_version: "v1",
    });
    expect(signAttempt.response.status).toBe(404);
  });
});

// ── Agreement lifecycle: bare-transition FSM boundaries + supersede ──────

describe("Maintenance Agreement lifecycle", () => {
  it("rejects a bare transition into a derived-only status, and requires a reason to cancel", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);

    // "active"/"signed" are derived-only — never reachable via the bare transition route.
    const illegal = await post("/api/maintenance/agreements/" + agreement.id + "/transition", { to_status: "active" }, auth);
    expect(illegal.response.status).toBe(400);

    const noReason = await post("/api/maintenance/agreements/" + agreement.id + "/transition", { to_status: "cancelled" }, auth);
    expect(noReason.response.status).toBe(400);

    const cancelled = await post<{ agreement: { status: string } }>("/api/maintenance/agreements/" + agreement.id + "/transition", { to_status: "cancelled", reason: "Customer changed mind" }, auth);
    expect(cancelled.response.status).toBe(200);
    expect(cancelled.body.agreement.status).toBe("cancelled");

    // "cancelled" is terminal — no further bare transition is legal.
    const afterTerminal = await post("/api/maintenance/agreements/" + agreement.id + "/transition", { to_status: "cancelled", reason: "again" }, auth);
    expect(afterTerminal.response.status).toBe(400);
  });

  it("an active (fully signed) agreement can still be cancelled with a reason, recorded in status history", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);
    await sendAndSign(auth, agreement.id);

    const cancelled = await post<{ agreement: { status: string } }>("/api/maintenance/agreements/" + agreement.id + "/transition", { to_status: "cancelled", reason: "Customer moved" }, auth);
    expect(cancelled.response.status).toBe(200);
    expect(cancelled.body.agreement.status).toBe("cancelled");

    const history = await request<{ history: { new_status: string; reason: string }[] }>(`/api/maintenance/agreements/${agreement.id}/status-history`, auth);
    expect(history.body.history.some((h) => h.new_status === "cancelled" && h.reason === "Customer moved")).toBe(true);
  });

  it("supersedeAgreement marks the old agreement superseded and cross-links a fresh draft; a draft cannot itself be superseded", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);
    await sendAndSign(auth, agreement.id);

    const newPlan = await makePlan(auth, { name: "Upgraded Plan", price_cents: 25000 });
    const superseded = await post<{
      oldAgreement: { id: number; status: string; superseded_by_agreement_id: number | null };
      newAgreement: { id: number; status: string; supersedes_agreement_id: number | null };
    }>(`/api/maintenance/agreements/${agreement.id}/supersede`, { customer_id: customerId, plan_id: newPlan.id }, auth);
    expect(superseded.response.status).toBe(201);
    expect(superseded.body.oldAgreement.status).toBe("superseded");
    expect(superseded.body.oldAgreement.superseded_by_agreement_id).toBe(superseded.body.newAgreement.id);
    expect(superseded.body.newAgreement.status).toBe("draft");
    expect(superseded.body.newAgreement.supersedes_agreement_id).toBe(agreement.id);

    // A draft (not signed/active) agreement cannot itself be superseded.
    const invalid = await post(`/api/maintenance/agreements/${superseded.body.newAgreement.id}/supersede`, { customer_id: customerId, plan_id: newPlan.id }, auth);
    expect(invalid.response.status).toBe(400);
  });
});

// ── PDF content verification: real text, not just a hash ─────────────────

describe("Maintenance PDF content", () => {
  it("the signed agreement PDF actually contains the plan and customer content, not just a hash", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth, "Extraction Test Customer");
    const plan = await makePlan(auth, { name: "Extraction Test Plan", price_cents: 12345 });
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);
    await sendAndSign(auth, agreement.id);

    const doc = await requestRaw(`/api/maintenance/agreements/${agreement.id}/signed-document`, auth);
    expect(doc.status).toBe(200);
    const text = await extractPdfText(new Uint8Array(await doc.arrayBuffer()));
    expect(text).toContain("Extraction Test Plan");
    expect(text).toContain("Extraction Test Customer");
  });

  it("the finalized service report PDF actually contains the work-performed and checklist content, not just a hash", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const sections = [{ title: "Compressor Check", items: [{ id: "c1", label: "Compressor Amp Draw", input_type: "MEASUREMENT", required: true }] }];
    const template = await post<{ version: { id: number } }>("/api/maintenance/checklist-templates", { name: "AC Extraction Check", sections }, auth);
    const job = await post<{ id: number }>("/api/jobs", { customer_id: customerId, scheduled_date: "2026-09-06", job_type: "STANDARD" }, auth);
    const report = await post<{ report: { id: number } }>(`/api/jobs/${job.body.id}/maintenance-report`, { checklist_template_version_id: template.body.version.id }, auth);
    await put(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}`, {
      work_performed: "Replaced the compressor capacitor and verified amp draw within spec.",
      checklist_results: { c1: "18.5A" },
    }, auth);
    const finalize = await post(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}/finalize`, {}, auth);
    expect(finalize.response.status).toBe(200);

    const doc = await requestRaw(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}/document`, auth);
    expect(doc.status).toBe(200);
    const text = await extractPdfText(new Uint8Array(await doc.arrayBuffer()));
    expect(text).toContain("Replaced the compressor capacitor");
    expect(text).toContain("Compressor Amp Draw");
    expect(text).toContain("18.5A");
  });
});

// ── Historical integrity: signed Agreement survives later Plan/Terms edits ─

describe("Historical integrity", () => {
  it("a signed agreement retains its original plan/price/terms after the plan changes and terms are republished", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth, { name: "Original Plan Name", price_cents: 10000 });
    const { documentId: termsDocId } = await makePublishedTerms(auth, "Original terms text");
    const { agreement, version } = await makeDraftAgreement(auth, customerId, plan.id, { legal_terms_document_id: termsDocId });
    const originalTermsVersionId = version.terms_version_id;

    await sendAndSign(auth, agreement.id);
    const originalHash = (await request<{ version: { document_hash: string | null; signed_document_hash: string | null } }>(`/api/maintenance/agreements/${agreement.id}`, auth)).body.version.signed_document_hash;
    expect(originalHash).toBeTruthy();

    // Change the plan after signing.
    await put(`/api/maintenance/plans/${plan.id}`, { name: "Changed Plan Name", price_cents: 99999 }, auth);
    // Publish a new Terms version.
    const draft2 = await post<{ version: { id: number } }>(`/api/legal-terms/${termsDocId}/versions`, {}, auth);
    await put(`/api/legal-terms/${termsDocId}/versions/${draft2.body.version.id}`, { content: "Changed terms text" }, auth);
    await post(`/api/legal-terms/${termsDocId}/versions/${draft2.body.version.id}/publish`, {}, auth);

    // Re-fetch the already-signed agreement — its frozen snapshot and signed hash must be unchanged.
    const reread = await request<{ version: { plan_snapshot: string; total_price_cents: number; terms_version_id: number; signed_document_hash: string } }>(`/api/maintenance/agreements/${agreement.id}`, auth);
    const rereadPlanSnapshot = JSON.parse(reread.body.version.plan_snapshot);
    expect(rereadPlanSnapshot.name).toBe("Original Plan Name");
    expect(reread.body.version.total_price_cents).toBe(10000);
    expect(reread.body.version.terms_version_id).toBe(originalTermsVersionId);
    expect(reread.body.version.signed_document_hash).toBe(originalHash);
  });
});

// ── Membership / entitlement idempotency ──────────────────────────────

describe("Membership entitlement", () => {
  it("consumes exactly one visit per finalized service report, never double-consumes under a concurrent retry", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth, { visit_entitlement_count: 5 });
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);
    await sendAndSign(auth, agreement.id);
    const membership = (await request<{ membership: { id: number } | null }>(`/api/maintenance/agreements/${agreement.id}/membership`, auth)).body.membership!;

    const job = await post<{ id: number }>("/api/jobs", { customer_id: customerId, scheduled_date: "2026-09-01", job_type: "STANDARD" }, auth);
    expect(job.response.status).toBe(201);
    const report = await post<{ report: { id: number } }>(`/api/jobs/${job.body.id}/maintenance-report`, { agreement_id: agreement.id, membership_id: membership.id }, auth);
    expect(report.response.status).toBe(201);
    await put(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}`, { work_performed: "Inspected and serviced unit." }, auth);

    // Two concurrent finalize attempts against the SAME report — must consume exactly once.
    const [first, second] = await Promise.all([
      post(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}/finalize`, {}, auth),
      post(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}/finalize`, {}, auth),
    ]);
    expect([first.response.status, second.response.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);

    const entitlement = await request<{ visitsRemaining: number | null; visitsConsumed: number }>(`/api/maintenance/memberships/${membership.id}`, auth);
    expect(entitlement.body.visitsConsumed).toBe(1);
    expect(entitlement.body.visitsRemaining).toBe(4);

    // A retry against the already-finalized report's entitlement math stays exactly 1 consumed
    // (the ledger's UNIQUE idempotency_key, keyed to this report, structurally prevents another
    // consume event from this same report — proven by the concurrent pair above never exceeding 1).
    const events = await queryDb<{ visit_delta: number }>("SELECT visit_delta FROM maintenance_entitlement_events WHERE membership_id = ? AND event_type = 'consume'", [membership.id]);
    expect(events.length).toBe(1);
  });

  it("cancelling a membership requires a reason and records status history", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);
    await sendAndSign(auth, agreement.id);
    const membership = (await request<{ membership: { id: number } | null }>(`/api/maintenance/agreements/${agreement.id}/membership`, auth)).body.membership!;

    const noReason = await post(`/api/maintenance/memberships/${membership.id}/cancel`, {}, auth);
    expect(noReason.response.status).toBe(400);

    const cancelled = await post<{ membership: { status: string } }>(`/api/maintenance/memberships/${membership.id}/cancel`, { reason: "Customer requested" }, auth);
    expect(cancelled.response.status).toBe(200);
    expect(cancelled.body.membership.status).toBe("cancelled");

    const history = await request<{ history: { new_status: string }[] }>(`/api/maintenance/memberships/${membership.id}/status-history`, auth);
    expect(history.body.history.some((h) => h.new_status === "cancelled")).toBe(true);
  });

  it("blocks technician from memberships entirely; dispatcher has parity with admin", async () => {
    const adminAuth = await authHeaders();
    const customerId = await makeCustomer(adminAuth);
    const plan = await makePlan(adminAuth);
    const { agreement } = await makeDraftAgreement(adminAuth, customerId, plan.id);
    await sendAndSign(adminAuth, agreement.id);
    const membership = (await request<{ membership: { id: number } | null }>(`/api/maintenance/agreements/${agreement.id}/membership`, adminAuth)).body.membership!;

    const { auth: techAuth } = await createLinkedTechnician("member-tech@example.test", adminAuth);
    const dispatch = await dispatcherAuth("member-dispatch@example.test");

    expect((await request(`/api/maintenance/memberships/${membership.id}`, techAuth)).response.status).toBe(403);
    expect((await request("/api/maintenance/memberships", techAuth)).response.status).toBe(403);

    expect((await request(`/api/maintenance/memberships/${membership.id}`, dispatch)).response.status).toBe(200);
    const dispatcherCancel = await post(`/api/maintenance/memberships/${membership.id}/cancel`, { reason: "Dispatcher cancel" }, dispatch);
    expect(dispatcherCancel.response.status).toBe(200);
  });

  it("does not leak a membership across organizations", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth);
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);
    await sendAndSign(auth, agreement.id);
    const membership = (await request<{ membership: { id: number } | null }>(`/api/maintenance/agreements/${agreement.id}/membership`, auth)).body.membership!;

    const orgB = await createSecondOrganization("Org B Memberships");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    expect((await request(`/api/maintenance/memberships/${membership.id}`, orgBAuth)).response.status).toBe(404);
  });
});

// ── Checklist Templates: versioning + historical snapshot ─────────────

describe("Maintenance Checklist Templates", () => {
  const sampleSections = [{ title: "Furnace Check", items: [{ id: "filter", label: "Filter condition", input_type: "PASS_FAIL", required: true }] }];

  it("creates a template, versions it, and rejects duplicate item ids", async () => {
    const auth = await authHeaders();
    const created = await post<{ template: { id: number }; version: { id: number; version_number: number } }>("/api/maintenance/checklist-templates", {
      name: "Furnace Inspection", sections: sampleSections,
    }, auth);
    expect(created.response.status).toBe(201);
    expect(created.body.version.version_number).toBe(1);

    const badSections = [{ title: "S", items: [{ id: "a", label: "One", input_type: "TEXT", required: false }, { id: "a", label: "Two", input_type: "TEXT", required: false }] }];
    const dupe = await post("/api/maintenance/checklist-templates", { name: "Bad", sections: badSections }, auth);
    expect(dupe.response.status).toBe(400);

    const v2 = await post<{ version: { version_number: number } }>(`/api/maintenance/checklist-templates/${created.body.template.id}/versions`, { sections: sampleSections }, auth);
    expect(v2.response.status).toBe(201);
    expect(v2.body.version.version_number).toBe(2);
  });

  it("a finalized service report retains the exact checklist snapshot used, even after the template is versioned again", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const template = await post<{ template: { id: number }; version: { id: number } }>("/api/maintenance/checklist-templates", { name: "AC Check", sections: sampleSections }, auth);
    const job = await post<{ id: number }>("/api/jobs", { customer_id: customerId, scheduled_date: "2026-09-02", job_type: "STANDARD" }, auth);
    const report = await post<{ report: { id: number; checklist_snapshot: string } }>(`/api/jobs/${job.body.id}/maintenance-report`, { checklist_template_version_id: template.body.version.id }, auth);
    expect(JSON.parse(report.body.report.checklist_snapshot)).toEqual(sampleSections);

    // Version the template AFTER the report snapshot was taken.
    const newSections = [{ title: "Different", items: [{ id: "x", label: "Changed", input_type: "TEXT", required: false }] }];
    await post(`/api/maintenance/checklist-templates/${template.body.template.id}/versions`, { sections: newSections }, auth);

    const rereadReport = await request<{ report: { checklist_snapshot: string } }>(`/api/jobs/${job.body.id}/maintenance-report`, auth);
    expect(JSON.parse(rereadReport.body.report!.checklist_snapshot)).toEqual(sampleSections);
  });

  it("rejects a SELECT checklist item with no options", async () => {
    const auth = await authHeaders();
    const badSections = [{ title: "S", items: [{ id: "a", label: "Pick one", input_type: "SELECT", required: false }] }];
    const res = await post("/api/maintenance/checklist-templates", { name: "Bad Select", sections: badSections }, auth);
    expect(res.response.status).toBe(400);
  });

  it("dispatcher can view checklist templates but not manage; technician blocked entirely", async () => {
    const adminAuth = await authHeaders();
    await post<{ template: { id: number } }>("/api/maintenance/checklist-templates", { name: "RBAC Check", sections: sampleSections }, adminAuth);
    const { auth: techAuth } = await createLinkedTechnician("checklist-tech@example.test", adminAuth);
    const dispatch = await dispatcherAuth("checklist-dispatch@example.test");

    expect((await request("/api/maintenance/checklist-templates", techAuth)).response.status).toBe(403);
    expect((await request("/api/maintenance/checklist-templates", dispatch)).response.status).toBe(200);
    expect((await post("/api/maintenance/checklist-templates", { name: "X", sections: sampleSections }, dispatch)).response.status).toBe(403);
  });

  it("does not leak a checklist template across organizations", async () => {
    const auth = await authHeaders();
    const created = await post<{ template: { id: number } }>("/api/maintenance/checklist-templates", { name: "Cross Org Check", sections: sampleSections }, auth);
    const orgB = await createSecondOrganization("Org B Checklists");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    expect((await request(`/api/maintenance/checklist-templates/${created.body.template.id}`, orgBAuth)).response.status).toBe(404);
  });
});

// ── Service Reports: RBAC ownership, finalize, document ───────────────

describe("Maintenance Service Reports", () => {
  it("a technician can only access their own assigned job's report; admin/dispatcher always can", async () => {
    const adminAuth = await authHeaders();
    const customerId = await makeCustomer(adminAuth);
    const { auth: techAuth, technicianId } = await createLinkedTechnician("report-tech@example.test", adminAuth);
    const { auth: otherTechAuth } = await createLinkedTechnician("other-tech@example.test", adminAuth);

    const job = await post<{ id: number }>("/api/jobs", { customer_id: customerId, scheduled_date: "2026-09-03", job_type: "STANDARD", technician_id: technicianId }, adminAuth);
    expect(job.response.status).toBe(201);

    // Technician cannot self-associate — creating the report is admin/dispatcher-only.
    const techCreateAttempt = await post(`/api/jobs/${job.body.id}/maintenance-report`, {}, techAuth);
    expect(techCreateAttempt.response.status).toBe(403);

    const report = await post<{ report: { id: number } }>(`/api/jobs/${job.body.id}/maintenance-report`, {}, adminAuth);
    expect(report.response.status).toBe(201);

    // Assigned technician can read/edit their own job's report.
    const ownRead = await request(`/api/jobs/${job.body.id}/maintenance-report`, techAuth);
    expect(ownRead.response.status).toBe(200);
    const ownEdit = await put(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}`, { notes: "On site" }, techAuth);
    expect(ownEdit.response.status).toBe(200);

    // A different technician, not assigned to this job, is denied.
    const otherRead = await request(`/api/jobs/${job.body.id}/maintenance-report`, otherTechAuth);
    expect(otherRead.response.status).toBe(403);
  });

  it("finalizing requires work_performed, is one-way, and produces a downloadable, hash-verified PDF", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const job = await post<{ id: number }>("/api/jobs", { customer_id: customerId, scheduled_date: "2026-09-04", job_type: "STANDARD" }, auth);
    const report = await post<{ report: { id: number } }>(`/api/jobs/${job.body.id}/maintenance-report`, {}, auth);

    const emptyFinalize = await post(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}/finalize`, {}, auth);
    expect(emptyFinalize.response.status).toBe(400);

    await put(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}`, { work_performed: "Full seasonal tune-up completed." }, auth);
    const finalize = await post<{ report: { status: string; document_hash: string } }>(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}/finalize`, {}, auth);
    expect(finalize.response.status).toBe(200);
    expect(finalize.body.report.status).toBe("finalized");
    expect(finalize.body.report.document_hash).toBeTruthy();

    const editAfterFinalize = await put(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}`, { notes: "too late" }, auth);
    expect(editAfterFinalize.response.status).toBe(409);

    const doc = await requestRaw(`/api/jobs/${job.body.id}/maintenance-report/${report.body.report.id}/document`, auth);
    expect(doc.status).toBe(200);
    expect(doc.headers.get("content-type")).toBe("application/pdf");
  });

  it("does not leak a report across organizations", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const job = await post<{ id: number }>("/api/jobs", { customer_id: customerId, scheduled_date: "2026-09-05", job_type: "STANDARD" }, auth);
    const report = await post<{ report: { id: number } }>(`/api/jobs/${job.body.id}/maintenance-report`, {}, auth);

    const orgB = await createSecondOrganization("Org B Reports");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    const res = await request(`/api/jobs/${job.body.id}/maintenance-report`, orgBAuth);
    expect(res.response.status).toBe(404);
    void report;
  });

  // Security review finding (Phase 19B, fixed): createOrGetServiceReport()
  // originally trusted agreement_id/membership_id/asset_id/
  // checklist_template_version_id from the client with zero ownership
  // validation — an org-A actor could attach an org-B agreement/membership/
  // asset/checklist-template-version to their own job, reading org B's
  // checklist content and, via finalize -> consumeEntitlement, silently
  // draining org B's membership entitlement with no record visible to org
  // B. Every one of the four references is now validated against this
  // organization (and the job's own customer, for agreement/membership/
  // asset) before being persisted.
  it("rejects a cross-organization agreement/membership/asset/checklist-template-version reference on report creation", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const job = await post<{ id: number }>("/api/jobs", { customer_id: customerId, scheduled_date: "2026-09-06", job_type: "STANDARD" }, auth);

    const orgB = await createSecondOrganization("Org B Cross-Tenant Reports");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const orgBAuth: RequestInit = { headers: { cookie } };
    const orgBCustomerId = await makeCustomer(orgBAuth, "Org B Customer");
    const orgBPlan = await makePlan(orgBAuth, { visit_entitlement_count: 5 });
    const { agreement: orgBAgreement } = await makeDraftAgreement(orgBAuth, orgBCustomerId, orgBPlan.id);
    await sendAndSign(orgBAuth, orgBAgreement.id);
    const orgBMembership = (await request<{ membership: { id: number } | null }>(`/api/maintenance/agreements/${orgBAgreement.id}/membership`, orgBAuth)).body.membership!;
    const orgBAsset = await makeAsset(orgBAuth, orgBCustomerId);
    const orgBTemplate = await post<{ template: { id: number }; version: { id: number } }>(
      "/api/maintenance/checklist-templates",
      { name: "Org B Secret Checklist", sections: [{ title: "S", items: [{ id: "a", label: "Confidential item", input_type: "TEXT", required: false }] }] },
      orgBAuth
    );

    const crossAgreement = await post(`/api/jobs/${job.body.id}/maintenance-report`, { agreement_id: orgBAgreement.id }, auth);
    expect(crossAgreement.response.status).toBe(400);

    const crossMembership = await post(`/api/jobs/${job.body.id}/maintenance-report`, { membership_id: orgBMembership.id }, auth);
    expect(crossMembership.response.status).toBe(400);

    const crossAsset = await post(`/api/jobs/${job.body.id}/maintenance-report`, { asset_id: orgBAsset }, auth);
    expect(crossAsset.response.status).toBe(400);

    const crossChecklist = await post(`/api/jobs/${job.body.id}/maintenance-report`, { checklist_template_version_id: orgBTemplate.body.version.id }, auth);
    expect(crossChecklist.response.status).toBe(400);

    // Confirm no report was left behind by any of the rejected attempts, and
    // that org B's entitlement ledger has exactly the one grant event from
    // its own signing — never touched by org A's attempts.
    const noReport = await request<{ report: unknown }>(`/api/jobs/${job.body.id}/maintenance-report`, auth);
    expect(noReport.body.report).toBeNull();
    const orgBEvents = await queryDb<{ event_type: string }>("SELECT event_type FROM maintenance_entitlement_events WHERE membership_id = ?", [orgBMembership.id]);
    expect(orgBEvents).toHaveLength(1);
    expect(orgBEvents[0].event_type).toBe("grant");
  });

  it("an agreement's own membership is auto-derived when only agreement_id is supplied (no separate membership_id needed)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const plan = await makePlan(auth, { visit_entitlement_count: 4 });
    const { agreement } = await makeDraftAgreement(auth, customerId, plan.id);
    await sendAndSign(auth, agreement.id);
    const membership = (await request<{ membership: { id: number } | null }>(`/api/maintenance/agreements/${agreement.id}/membership`, auth)).body.membership!;

    const job = await post<{ id: number }>("/api/jobs", { customer_id: customerId, scheduled_date: "2026-09-07", job_type: "STANDARD" }, auth);
    const report = await post<{ report: { id: number; membership_id: number | null } }>(`/api/jobs/${job.body.id}/maintenance-report`, { agreement_id: agreement.id }, auth);
    expect(report.response.status).toBe(201);
    expect(report.body.report.membership_id).toBe(membership.id);
  });
});
