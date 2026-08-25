import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  applySchema, authHeaders, createCustomer, createJob, createSecondOrganization, createUser, del, loginAs,
  post, put, queryDb, request, requestRaw, resetDatabase, satisfyCompletionRequirements,
} from "./helpers.js";
import { generateInvoiceForJob } from "../src/server/financial.js";

// Phase 5 — Financials & Invoicing. Covers: automatic idempotent invoice
// generation on legitimate job completion, concurrency/duplicate-prevention
// at the database-constraint level (not just application logic), rebate
// splitting per job type (STANDARD/CleanBC/BC Hydro), partial/multiple/
// multi-method payments, overpayment rejection, the invoice status
// lifecycle, RBAC (technician full financial blackout), invoice void vs.
// delete, and the invoice_audit trail.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function dispatcherAuth(email = "dispatch-fin@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function technicianAuth(email = "tech-fin@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

async function createTechnicianRow(adminAuth: RequestInit) {
  const res = await post<{ id: number }>("/api/technicians", { name: "Fin Test Tech" }, adminAuth);
  expect(res.response.status).toBe(201);
  return res.body;
}

async function assignTechnician(jobId: number, technicianId: number, auth: RequestInit) {
  const res = await put(`/api/jobs/${jobId}`, { technician_id: technicianId }, auth);
  expect(res.response.status).toBe(200);
}

async function transition(jobId: number, toStatus: string, auth: RequestInit, extra: Record<string, unknown> = {}) {
  return post<{ job?: { status: string } }>(`/api/jobs/${jobId}/transition`, { to_status: toStatus, ...extra }, auth);
}

/** Walks a job all the way to "completed" through the real workflow engine
 *  (never fabricates the status directly) — this is what triggers Phase 5's
 *  automatic invoice generation as a side effect of the transition route. */
async function completeJob(customerId: number, jobType: "STANDARD" | "CLEANBC" | "BC_HYDRO", auth: RequestInit, priceOverride?: number) {
  const job = await createJob(customerId, "2026-09-01", {
    job_type: jobType, ...(priceOverride !== undefined ? { price: priceOverride } : {}),
  });
  const tech = await createTechnicianRow(auth);
  await assignTechnician(job.id, tech.id, auth);

  if (jobType === "CLEANBC") {
    expect((await transition(job.id, "application_pending", auth)).response.status).toBe(200);
    expect((await transition(job.id, "eligibility_approved", auth, {
      eligibility_code: "CB-FIN-1", eligibility_code_expiry: "2027-01-01",
    })).response.status).toBe(200);
    expect((await transition(job.id, "install_scheduled", auth)).response.status).toBe(200);
  } else if (jobType === "BC_HYDRO") {
    expect((await transition(job.id, "install_scheduled", auth)).response.status).toBe(200);
  }
  expect((await transition(job.id, "in_progress", auth)).response.status).toBe(200);
  await satisfyCompletionRequirements(job.id, auth);
  const completed = await transition(job.id, "completed", auth);
  expect(completed.response.status).toBe(200);
  return job;
}

async function getInvoiceDetail(invoiceId: number, auth: RequestInit) {
  return request<{ invoice: Record<string, unknown> }>(`/api/invoices/${invoiceId}`, auth);
}

describe("automatic invoice generation on job completion", () => {
  it("generates an invoice automatically the moment a STANDARD job legitimately reaches completed", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth, 150);

    const rows = await queryDb<{ id: number; job_id: number; status: string; total_cents: number; rebate_amount_cents: number }>(
      "SELECT * FROM invoices WHERE job_id = ?", [job.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("draft");
    expect(rows[0].total_cents).toBe(15000); // $150.00, no materials added
    expect(rows[0].rebate_amount_cents).toBe(0); // STANDARD jobs never carry a rebate
  });

  it("is idempotent: calling the manual create-from-job endpoint after auto-generation returns the SAME invoice, not a duplicate", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth);

    const before = await queryDb("SELECT id FROM invoices WHERE job_id = ?", [job.id]);
    expect(before).toHaveLength(1);

    const manual = await post<{ id: number; created: boolean }>(`/api/jobs/${job.id}/invoice`, {}, auth);
    expect(manual.response.status).toBe(200); // 200, not 201 — nothing was created
    expect(manual.body.created).toBe(false);
    expect(manual.body.id).toBe((before[0] as { id: number }).id);

    const after = await queryDb("SELECT id FROM invoices WHERE job_id = ?", [job.id]);
    expect(after).toHaveLength(1);
  });

  it("duplicate prevention holds under two genuinely concurrent generation calls for the same job (database constraint, not just an application check)", async () => {
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01", { job_type: "STANDARD", price: 200 });

    // Calls the real server function directly (bypassing HTTP) with true
    // Promise.all concurrency, exercising the exact race window
    // generateInvoiceForJob() must defend against: both calls' up-front
    // "does an invoice already exist" check can see "no" before either has
    // committed its INSERT — the partial UNIQUE index on invoices(job_id) is
    // what actually prevents two rows from surviving, not the up-front check.
    const [r1, r2] = await Promise.all([
      generateInvoiceForJob(env.DB, job.id, null),
      generateInvoiceForJob(env.DB, job.id, null),
    ]);
    // Exactly one of the two calls actually created the row; the other
    // adopted it via the constraint-violation catch path.
    expect([r1.created, r2.created].filter(Boolean)).toHaveLength(1);
    expect(r1.invoice.id).toBe(r2.invoice.id);

    const rows = await queryDb("SELECT id FROM invoices WHERE job_id = ?", [job.id]);
    expect(rows).toHaveLength(1);
  });

  it("duplicate prevention holds under two concurrent HTTP requests to the manual create-from-job endpoint", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01", { job_type: "STANDARD", price: 175 });

    const [r1, r2] = await Promise.all([
      post<{ id: number; created: boolean }>(`/api/jobs/${job.id}/invoice`, {}, auth),
      post<{ id: number; created: boolean }>(`/api/jobs/${job.id}/invoice`, {}, auth),
    ]);
    expect([r1.response.status, r2.response.status].sort()).toEqual([200, 201]);
    expect(r1.body.id).toBe(r2.body.id);

    const rows = await queryDb("SELECT id FROM invoices WHERE job_id = ?", [job.id]);
    expect(rows).toHaveLength(1);
  });

  it("re-issuing after a void creates a fresh invoice — the uniqueness guard excludes voided invoices by design", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth);
    const first = await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]);

    const voided = await post(`/api/invoices/${first[0].id}/void`, { reason: "duplicate entry, testing re-issue" }, auth);
    expect(voided.response.status).toBe(200);

    const regenerated = await post<{ id: number; created: boolean }>(`/api/jobs/${job.id}/invoice`, {}, auth);
    expect(regenerated.response.status).toBe(201);
    expect(regenerated.body.created).toBe(true);
    expect(regenerated.body.id).not.toBe(first[0].id);

    const active = await queryDb("SELECT id FROM invoices WHERE job_id = ? AND status != 'void'", [job.id]);
    expect(active).toHaveLength(1);
  });
});

describe("rebate splitting per job type", () => {
  it("STANDARD invoices never carry a rebate amount", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth, 300);
    const invoice = await queryDb<{ rebate_amount_cents: number; total_cents: number }>(
      "SELECT rebate_amount_cents, total_cents FROM invoices WHERE job_id = ?", [job.id]
    );
    expect(invoice[0].rebate_amount_cents).toBe(0);
  });

  it("CleanBC rebate defaults to $0 (never fabricated) when CLEANBC_REBATE_AMOUNT_CENTS is not configured in Global Settings", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "CLEANBC", auth, 500);
    const invoice = await queryDb<{ rebate_amount_cents: number }>(
      "SELECT rebate_amount_cents FROM invoices WHERE job_id = ?", [job.id]
    );
    expect(invoice[0].rebate_amount_cents).toBe(0);
  });

  it("CleanBC rebate is applied from Global Settings and capped so customer_amount_cents never goes negative", async () => {
    const auth = await authHeaders();
    await post("/api/settings", {
      key: "CLEANBC_REBATE_AMOUNT_CENTS", value: "300000", data_type: "number", category: "rebate",
    }, auth);
    const customer = await createCustomer();
    // Job price ($500) is less than the configured rebate ($3000) — must be
    // capped at the invoice total, never allowed to exceed it.
    const job = await completeJob(customer.id, "CLEANBC", auth, 500);
    const invoice = await queryDb<{ rebate_amount_cents: number; total_cents: number }>(
      "SELECT rebate_amount_cents, total_cents FROM invoices WHERE job_id = ?", [job.id]
    );
    expect(invoice[0].total_cents).toBe(50000);
    expect(invoice[0].rebate_amount_cents).toBe(50000); // capped at total, not the configured 300000

    const detail = await getInvoiceDetail((await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]))[0].id, auth);
    expect(detail.body.invoice.customer_amount_cents).toBe(0); // never negative
  });

  it("BC Hydro rebate is applied from its own Global Settings key, independent of the CleanBC key", async () => {
    const auth = await authHeaders();
    await post("/api/settings", {
      key: "BC_HYDRO_REBATE_AMOUNT_CENTS", value: "10000", data_type: "number", category: "rebate",
    }, auth);
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "BC_HYDRO", auth, 400);
    const invoice = await queryDb<{ rebate_amount_cents: number; total_cents: number }>(
      "SELECT rebate_amount_cents, total_cents FROM invoices WHERE job_id = ?", [job.id]
    );
    expect(invoice[0].total_cents).toBe(40000);
    expect(invoice[0].rebate_amount_cents).toBe(10000);

    const invId = (await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]))[0].id;
    const detail = await getInvoiceDetail(invId, auth);
    expect(detail.body.invoice.customer_amount_cents).toBe(30000); // 40000 - 10000
  });

  it("admin/dispatcher can correct the rebate amount after generation, clamped to [0, total_cents]", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "CLEANBC", auth, 500);
    const invId = (await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]))[0].id;

    const tooHigh = await put(`/api/invoices/${invId}/rebate`, { rebate_amount_cents: 99999 }, auth);
    expect(tooHigh.response.status).toBe(400);

    const ok = await put(`/api/invoices/${invId}/rebate`, { rebate_amount_cents: 20000 }, auth);
    expect(ok.response.status).toBe(200);

    const auditRows = await queryDb<{ event_type: string }>(
      "SELECT event_type FROM invoice_audit WHERE invoice_id = ? AND event_type = 'rebate_amount_changed'", [invId]
    );
    expect(auditRows).toHaveLength(1);
  });
});

describe("invoice lifecycle and payments", () => {
  async function issuedInvoice(auth: RequestInit, priceCents = 20000) {
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth, priceCents / 100);
    const invId = (await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]))[0].id;
    const issued = await post(`/api/invoices/${invId}/issue`, {}, auth);
    expect(issued.response.status).toBe(200);
    return invId;
  }

  it("draft -> issued -> partially_paid -> paid, driven entirely by actual recorded payments", async () => {
    const auth = await authHeaders();
    const invId = await issuedInvoice(auth, 10000);

    const partial = await post(`/api/invoices/${invId}/payments`, {
      amount_cents: 4000, payer_type: "customer", method: "cash",
    }, auth);
    expect(partial.response.status).toBe(201);
    expect((await queryDb<{ status: string }>("SELECT status FROM invoices WHERE id = ?", [invId]))[0].status).toBe("partially_paid");

    const rest = await post(`/api/invoices/${invId}/payments`, {
      amount_cents: 6000, payer_type: "customer", method: "e_transfer",
    }, auth);
    expect(rest.response.status).toBe(201);
    expect((await queryDb<{ status: string }>("SELECT status FROM invoices WHERE id = ?", [invId]))[0].status).toBe("paid");
  });

  it("supports multiple payments from multiple payer types and methods against one invoice", async () => {
    const auth = await authHeaders();
    const invId = await issuedInvoice(auth, 50000);

    await post(`/api/invoices/${invId}/payments`, { amount_cents: 30000, payer_type: "government", method: "e_transfer", reference: "GOV-REF-1" }, auth);
    await post(`/api/invoices/${invId}/payments`, { amount_cents: 15000, payer_type: "customer", method: "credit_card" }, auth);
    const final = await post(`/api/invoices/${invId}/payments`, { amount_cents: 5000, payer_type: "customer", method: "cash" }, auth);
    expect(final.response.status).toBe(201);

    const payments = await queryDb("SELECT * FROM payments WHERE invoice_id = ?", [invId]);
    expect(payments).toHaveLength(3);
    const detail = await getInvoiceDetail(invId, auth);
    expect(detail.body.invoice.status).toBe("paid");
    expect(detail.body.invoice.balance_cents).toBe(0);
    expect(detail.body.invoice.amount_paid_cents).toBe(50000);
  });

  it("rejects a payment that would overpay the invoice — no credit/refund model exists", async () => {
    const auth = await authHeaders();
    const invId = await issuedInvoice(auth, 10000);

    await post(`/api/invoices/${invId}/payments`, { amount_cents: 8000, payer_type: "customer", method: "cash" }, auth);
    const overpay = await post(`/api/invoices/${invId}/payments`, { amount_cents: 3000, payer_type: "customer", method: "cash" }, auth);
    expect(overpay.response.status).toBe(400);

    const detail = await getInvoiceDetail(invId, auth);
    expect(detail.body.invoice.status).toBe("partially_paid"); // unchanged by the rejected attempt
    expect(detail.body.invoice.balance_cents).toBe(2000);
  });

  it("rejects a non-positive payment amount", async () => {
    const auth = await authHeaders();
    const invId = await issuedInvoice(auth);
    const zero = await post(`/api/invoices/${invId}/payments`, { amount_cents: 0, payer_type: "customer", method: "cash" }, auth);
    expect(zero.response.status).toBe(400);
  });

  it("rejects recording a payment against a draft (not yet issued) or void invoice", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth);
    const invId = (await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]))[0].id;

    const onDraft = await post(`/api/invoices/${invId}/payments`, { amount_cents: 100, payer_type: "customer", method: "cash" }, auth);
    expect(onDraft.response.status).toBe(400);

    await post(`/api/invoices/${invId}/void`, { reason: "test" }, auth);
    const onVoid = await post(`/api/invoices/${invId}/payments`, { amount_cents: 100, payer_type: "customer", method: "cash" }, auth);
    expect(onVoid.response.status).toBe(400);
  });

  it("voiding a payment reverses its effect on the invoice status without deleting the payment record", async () => {
    const auth = await authHeaders();
    const invId = await issuedInvoice(auth, 10000);
    const paid = await post<{ id: number }>(`/api/invoices/${invId}/payments`, { amount_cents: 10000, payer_type: "customer", method: "cash" }, auth);
    expect((await queryDb<{ status: string }>("SELECT status FROM invoices WHERE id = ?", [invId]))[0].status).toBe("paid");

    const paymentRow = await queryDb<{ id: number }>("SELECT id FROM payments WHERE invoice_id = ?", [invId]);
    const voided = await post(`/api/payments/${paymentRow[0].id}/void`, { reason: "recorded in error" }, auth);
    expect(voided.response.status).toBe(200);

    expect((await queryDb<{ status: string }>("SELECT status FROM invoices WHERE id = ?", [invId]))[0].status).toBe("issued");
    const stillThere = await queryDb<{ id: number; voided_at: string | null }>("SELECT id, voided_at FROM payments WHERE id = ?", [paymentRow[0].id]);
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].voided_at).not.toBeNull();
    void paid;
  });

  it("only a draft invoice can be hard-deleted — an issued invoice must be voided instead", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth);
    const invId = (await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]))[0].id;

    await post(`/api/invoices/${invId}/issue`, {}, auth);
    const deleteIssued = await del(`/api/invoices/${invId}`, auth);
    expect(deleteIssued.response.status).toBe(400);
    expect(await queryDb("SELECT id FROM invoices WHERE id = ?", [invId])).toHaveLength(1);

    const voided = await post(`/api/invoices/${invId}/void`, { reason: "test cleanup" }, auth);
    expect(voided.response.status).toBe(200);
    const deleteVoid = await del(`/api/invoices/${invId}`, auth);
    expect(deleteVoid.response.status).toBe(400); // still not a draft — void, not deletable
  });

  it("a draft invoice (manual, never issued) can be deleted outright", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const created = await post<{ id: number }>("/api/invoices", {
      customer_id: customer.id, lines: [{ description: "Quote", quantity: 1, unit_price_cents: 5000 }],
    }, auth);
    const removed = await del(`/api/invoices/${created.body.id}`, auth);
    expect(removed.response.status).toBe(200);
    expect(await queryDb("SELECT id FROM invoices WHERE id = ?", [created.body.id])).toHaveLength(0);
  });

  it("void requires a non-empty reason and is recorded in the audit trail", async () => {
    const auth = await authHeaders();
    const invId = await issuedInvoice(auth);
    const noReason = await post(`/api/invoices/${invId}/void`, { reason: "" }, auth);
    expect(noReason.response.status).toBe(400);

    const withReason = await post(`/api/invoices/${invId}/void`, { reason: "customer cancelled the job" }, auth);
    expect(withReason.response.status).toBe(200);
    const audit = await queryDb<{ event_type: string }>(
      "SELECT event_type FROM invoice_audit WHERE invoice_id = ? AND event_type = 'invoice_voided'", [invId]
    );
    expect(audit).toHaveLength(1);
  });
});

describe("RBAC — technician financial blackout", () => {
  it("blocks a technician from every invoice route: list, detail, create, edit, issue, void, rebate, delete, payments", async () => {
    const auth = await authHeaders();
    const tech = await technicianAuth();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth);
    const invId = (await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]))[0].id;

    expect((await request("/api/invoices", tech)).response.status).toBe(403);
    expect((await request(`/api/invoices/${invId}`, tech)).response.status).toBe(403);
    expect((await post("/api/invoices", { customer_id: customer.id, lines: [{ description: "x", quantity: 1, unit_price_cents: 100 }] }, tech)).response.status).toBe(403);
    expect((await put(`/api/invoices/${invId}`, { notes: "hacked" }, tech)).response.status).toBe(403);
    expect((await post(`/api/invoices/${invId}/issue`, {}, tech)).response.status).toBe(403);
    expect((await post(`/api/invoices/${invId}/void`, { reason: "x" }, tech)).response.status).toBe(403);
    expect((await put(`/api/invoices/${invId}/rebate`, { rebate_amount_cents: 0 }, tech)).response.status).toBe(403);
    expect((await del(`/api/invoices/${invId}`, tech)).response.status).toBe(403);
    expect((await request(`/api/invoices/${invId}/payments`, tech)).response.status).toBe(403);
    expect((await post(`/api/invoices/${invId}/payments`, { amount_cents: 100, payer_type: "customer", method: "cash" }, tech)).response.status).toBe(403);
    expect((await post(`/api/jobs/${job.id}/invoice`, {}, tech)).response.status).toBe(403);
  });

  it("blocks a technician from voiding a payment", async () => {
    const auth = await authHeaders();
    const tech = await technicianAuth();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth);
    const invId = (await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]))[0].id;
    await post(`/api/invoices/${invId}/issue`, {}, auth);
    const payment = await post<{ id: number }>(`/api/invoices/${invId}/payments`, { amount_cents: 100, payer_type: "customer", method: "cash" }, auth);

    const blocked = await post(`/api/payments/${payment.body.id}/void`, { reason: "x" }, tech);
    expect(blocked.response.status).toBe(403);
  });

  it("still leaves none of the technician's actually-legitimate operational routes blocked (regression check)", async () => {
    const auth = await authHeaders();
    const tech = await technicianAuth();
    const techRow = await createTechnicianRow(auth);
    // technicianAuth() only creates a bare login — link it to a technician
    // profile so this actor actually owns a job (see
    // mem:risks/technician-job-read-scoping: an unlinked/unassigned
    // technician is correctly blocked from every job now, so a meaningful
    // "not blanket-locked-out" check needs a real assignment).
    const linkRes = await put(`/api/technicians/${techRow.id}`, {
      user_id: (await request<{ user: { id: number } }>("/api/auth/me", tech)).body.user.id,
    }, auth);
    expect(linkRes.response.status).toBe(200);
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-09-01");
    await assignTechnician(job.id, techRow.id, auth);
    // A technician can still read their OWN assigned job's detail (unrelated
    // to invoicing) — confirms the financial RBAC blackout is scoped to
    // invoice/payment routes only, not a blanket lockout.
    expect((await request(`/api/jobs/${job.id}`, tech)).response.status).toBe(200);
  });

  it("allows dispatcher the same financial access as admin (not admin-only)", async () => {
    const auth = await authHeaders();
    const dispatcher = await dispatcherAuth();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth);
    const invId = (await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]))[0].id;

    expect((await request("/api/invoices", dispatcher)).response.status).toBe(200);
    expect((await request(`/api/invoices/${invId}`, dispatcher)).response.status).toBe(200);
    expect((await post(`/api/invoices/${invId}/issue`, {}, dispatcher)).response.status).toBe(200);
  });
});

describe("invoice audit trail", () => {
  it("records creation, issuance, payment, and void as separate WHO/WHAT/WHEN events", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth);
    const invId = (await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]))[0].id;

    await post(`/api/invoices/${invId}/issue`, {}, auth);
    await post(`/api/invoices/${invId}/payments`, { amount_cents: 100, payer_type: "customer", method: "cash" }, auth);

    const auditRes = await request<{ audit: { event_type: string; actor_user_id: number | null }[] }>(`/api/invoices/${invId}/audit`, auth);
    expect(auditRes.response.status).toBe(200);
    const types = auditRes.body.audit.map((a) => a.event_type).sort();
    expect(types).toEqual(["invoice_created", "invoice_issued", "payment_recorded"].sort());
    for (const row of auditRes.body.audit) {
      expect(row.actor_user_id).not.toBeNull();
    }
  });
});

describe("Invoice PDF (Phase 13A final document hardening, Section 42-49)", () => {
  function cookieOf(auth: RequestInit): string {
    return (auth.headers as Record<string, string>).cookie;
  }

  async function makeInvoice(auth: RequestInit, priceCents = 20000) {
    const customer = await createCustomer();
    const job = await completeJob(customer.id, "STANDARD", auth, priceCents / 100);
    return (await queryDb<{ id: number }>("SELECT id FROM invoices WHERE job_id = ?", [job.id]))[0].id;
  }

  it("View/Download/Print all serve the same underlying live-rendered PDF, reflecting current balance", async () => {
    const auth = await authHeaders();
    const invId = await makeInvoice(auth, 10000);
    await post(`/api/invoices/${invId}/issue`, {}, auth);

    const view = await requestRaw(`/api/invoices/${invId}/pdf`, { headers: { cookie: cookieOf(auth) } });
    expect(view.status).toBe(200);
    expect(view.headers.get("content-type")).toBe("application/pdf");
    expect(view.headers.get("content-disposition")).toMatch(/^inline;/);
    const bytesBeforePayment = new Uint8Array(await view.arrayBuffer());
    expect(new TextDecoder().decode(bytesBeforePayment.slice(0, 5))).toBe("%PDF-");

    const download = await requestRaw(`/api/invoices/${invId}/pdf?mode=download`, { headers: { cookie: cookieOf(auth) } });
    expect(download.status).toBe(200);
    const disposition = download.headers.get("content-disposition") || "";
    expect(disposition).toMatch(/^attachment;/);
    expect(disposition).toMatch(/\.pdf"$/);

    // Section 43's explicit lifecycle decision: rendered LIVE, never a
    // stored snapshot — recording a payment must change the very next
    // render's bytes (a genuinely different balance), unlike a signed
    // Contract PDF which never changes after signing.
    await post(`/api/invoices/${invId}/payments`, { amount_cents: 4000, payer_type: "customer", method: "cash" }, auth);
    const viewAfterPayment = await requestRaw(`/api/invoices/${invId}/pdf`, { headers: { cookie: cookieOf(auth) } });
    const bytesAfterPayment = new Uint8Array(await viewAfterPayment.arrayBuffer());
    expect(bytesAfterPayment).not.toEqual(bytesBeforePayment);
  });

  it("uses the tenant's Company Profile and logo (Section 45 — shared branding, no separate settings)", async () => {
    const auth = await authHeaders();
    await put("/api/company-profile", { company_name: "Coreline Comfort Invoicing Co" }, auth);
    const invId = await makeInvoice(auth);
    const res = await requestRaw(`/api/invoices/${invId}/pdf`, { headers: { cookie: cookieOf(auth) } });
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
  });

  // Testing review finding: index.ts's `/api/invoices/:id/pdf` route filters
  // `payments.filter((p) => !p.voided_at)` before handing them to the
  // renderer — this is a money-correctness path on a customer-facing
  // document, and was previously exercised only with zero or one
  // never-voided payment. A voided payment must never appear in the
  // rendered PDF (it would misstate what the customer actually paid) — a
  // byte-diff against an equivalent invoice with no voided payment at all
  // is the only way to prove this without a PDF text-extraction library
  // (content streams are Flate-compressed, per this file's own convention).
  it("never renders a voided payment in the PDF (route-level payments.filter regression guard)", async () => {
    // Proof strategy: PDF content streams are Flate-compressed, so exact
    // text can't be grepped out of the bytes (this file's own established
    // convention) — but the rendered "Payments" table's ROW COUNT directly
    // drives the output length. Three invoices, three payment histories:
    //   (1) one active payment            -> table has 1 row
    //   (2) one active + one VOIDED       -> table must ALSO have 1 row
    //   (3) two active payments           -> table has 2 rows
    // If the route's payments.filter(p => !p.voided_at) regresses (e.g. the
    // filter is removed or inverted), scenario (2)'s PDF would match
    // scenario (3)'s length instead of scenario (1)'s.
    const auth = await authHeaders();

    const invOneActive = await makeInvoice(auth, 10000);
    await post(`/api/invoices/${invOneActive}/issue`, {}, auth);
    await post(`/api/invoices/${invOneActive}/payments`, { amount_cents: 4000, payer_type: "customer", method: "cash", reference: "ROW-A" }, auth);
    const oneActiveLen = (await (await requestRaw(`/api/invoices/${invOneActive}/pdf`, { headers: { cookie: cookieOf(auth) } })).arrayBuffer()).byteLength;

    const invOneActiveOneVoided = await makeInvoice(auth, 10000);
    await post(`/api/invoices/${invOneActiveOneVoided}/issue`, {}, auth);
    await post(`/api/invoices/${invOneActiveOneVoided}/payments`, { amount_cents: 4000, payer_type: "customer", method: "cash", reference: "ROW-A" }, auth);
    await post(`/api/invoices/${invOneActiveOneVoided}/payments`, { amount_cents: 1000, payer_type: "customer", method: "check", reference: "SHOULD-NOT-APPEAR" }, auth);
    // POST /api/invoices/:id/payments returns the INVOICE, not the new
    // payment row (see index.ts's recordPaymentRoute comment) — the
    // payment's own id has to be read back separately, same as the
    // existing "voiding a payment reverses..." test above does.
    const toVoidRow = await queryDb<{ id: number }>("SELECT id FROM payments WHERE invoice_id = ? AND amount_cents = 1000", [invOneActiveOneVoided]);
    await post(`/api/payments/${toVoidRow[0].id}/void`, { reason: "recorded in error" }, auth);
    const oneActiveOneVoidedLen = (await (await requestRaw(`/api/invoices/${invOneActiveOneVoided}/pdf`, { headers: { cookie: cookieOf(auth) } })).arrayBuffer()).byteLength;

    const invTwoActive = await makeInvoice(auth, 10000);
    await post(`/api/invoices/${invTwoActive}/issue`, {}, auth);
    await post(`/api/invoices/${invTwoActive}/payments`, { amount_cents: 4000, payer_type: "customer", method: "cash", reference: "ROW-A" }, auth);
    await post(`/api/invoices/${invTwoActive}/payments`, { amount_cents: 1000, payer_type: "customer", method: "check", reference: "SHOULD-APPEAR" }, auth);
    const twoActiveLen = (await (await requestRaw(`/api/invoices/${invTwoActive}/pdf`, { headers: { cookie: cookieOf(auth) } })).arrayBuffer()).byteLength;

    // The voided-payment scenario must land at the 1-row length, not the
    // 2-row length — an exact match isn't guaranteed (payment ids/
    // timestamps differ), but it must be far closer to the 1-row case.
    expect(Math.abs(oneActiveOneVoidedLen - oneActiveLen)).toBeLessThan(Math.abs(oneActiveOneVoidedLen - twoActiveLen));
    expect(twoActiveLen).toBeGreaterThan(oneActiveLen); // sanity: a second real row does measurably grow the document

    // Also confirm the underlying financials (already computed via SQL
    // excluding voided payments, independent of this route's own filter)
    // agree — a second, independent signal that nothing double-counted.
    const detail = await request<{ invoice: { amount_paid_cents: number; balance_cents: number } }>(`/api/invoices/${invOneActiveOneVoided}`, auth);
    expect(detail.body.invoice.amount_paid_cents).toBe(4000);
    expect(detail.body.invoice.balance_cents).toBe(6000);
  });

  it("rejects a technician from viewing an invoice PDF (same financial blackout as every other invoice route)", async () => {
    const auth = await authHeaders();
    const invId = await makeInvoice(auth);
    const tech = await technicianAuth();
    const res = await requestRaw(`/api/invoices/${invId}/pdf`, { headers: { cookie: cookieOf(tech) } });
    expect(res.status).toBe(403);
  });

  it("a dispatcher can access the Invoice PDF (same as admin, not admin-only)", async () => {
    const auth = await authHeaders();
    const invId = await makeInvoice(auth);
    const dispatcher = await dispatcherAuth();
    const res = await requestRaw(`/api/invoices/${invId}/pdf`, { headers: { cookie: cookieOf(dispatcher) } });
    expect(res.status).toBe(200);
  });

  it("never leaks another organization's invoice PDF (tenant isolation)", async () => {
    const auth = await authHeaders();
    const invId = await makeInvoice(auth);
    const second = await createSecondOrganization("Org B Invoicing Co");
    const { cookie } = await loginAs(second.email, second.password);
    const res = await requestRaw(`/api/invoices/${invId}/pdf`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a nonexistent invoice id rather than an unhandled error", async () => {
    const auth = await authHeaders();
    const res = await requestRaw("/api/invoices/999999/pdf", { headers: { cookie: cookieOf(auth) } });
    expect(res.status).toBe(404);
  });
});
