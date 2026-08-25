import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createSecondOrganization, createUser,
  extractPdfText, loginAs, pdfBytesToText, post, put, queryDb, request, requestRaw, resetDatabase, satisfyCompletionRequirements,
} from "./helpers.js";

async function createTechnician(name: string, adminAuth: RequestInit): Promise<number> {
  const res = await post<{ id: number }>("/api/technicians", { name }, adminAuth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

// Phase 13B — Invoice Delivery (Section 6-8), Manual Payment enhancements
// (Section 14-20), and Payment Receipts (Section 21-24). Online
// Payment/webhook coverage lives in test/online-payment.test.ts.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function technicianAuth(email = "tech-delivery@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

/** An issued (not draft, not void) invoice with a real customer contact —
 *  Send/payment-link/manual-payment all require this baseline state. */
async function issuedInvoiceWithContact(auth: RequestInit) {
  const customer = await createCustomer();
  await put(`/api/customers/${customer.id}`, { email: "delivery@example.test" }, auth);
  const techId = await createTechnician("Delivery Test Tech", auth);
  const job = await createJob(customer.id, "2026-10-01", { technician_id: techId });
  await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, auth);
  await satisfyCompletionRequirements(job.id, auth);
  await post(`/api/jobs/${job.id}/transition`, { to_status: "completed" }, auth);
  const rows = await queryDb<{ id: number; status: string }>("SELECT id, status FROM invoices WHERE job_id = ?", [job.id]);
  const invoiceId = rows[0].id;
  if (rows[0].status === "draft") {
    const issued = await post(`/api/invoices/${invoiceId}/issue`, {}, auth);
    expect(issued.response.status).toBe(200);
  }
  return invoiceId;
}

describe("Invoice Delivery — Section 6-8", () => {
  it("sends an invoice and records a real outbox row with the expected payload fields", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const res = await post(`/api/invoices/${invoiceId}/send`, {}, auth);
    expect(res.response.status).toBe(200);
    const rows = await queryDb<{ payload: string; recipient: string }>(
      "SELECT payload, recipient FROM notification_outbox WHERE entity_type = 'invoice' AND entity_id = ? AND event_type = 'invoice.sent'",
      [invoiceId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe("delivery@example.test");
    const payload = JSON.parse(rows[0].payload);
    expect(payload.invoice_identifier).toBeTruthy();
    expect(typeof payload.total_cents).toBe("number");
  });

  it("cannot send a draft invoice", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const techId = await createTechnician("Draft Send Tech", auth);
    const job = await createJob(customer.id, "2026-10-02", { technician_id: techId });
    await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, auth);
    await satisfyCompletionRequirements(job.id, auth);
    await post(`/api/jobs/${job.id}/transition`, { to_status: "completed" }, auth);
    const rows = await queryDb<{ id: number; status: string }>("SELECT id, status FROM invoices WHERE job_id = ?", [job.id]);
    // Only proceed if genuinely still draft (auto-generation always creates draft).
    expect(rows[0].status).toBe("draft");
    const res = await post(`/api/invoices/${rows[0].id}/send`, {}, auth);
    expect(res.response.status).toBe(400);
  });

  it("cannot send a void invoice", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    await post(`/api/invoices/${invoiceId}/void`, { reason: "test" }, auth);
    const res = await post(`/api/invoices/${invoiceId}/send`, {}, auth);
    expect(res.response.status).toBe(400);
  });

  it("technician is denied (canManageFinancials blackout)", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const res = await post(`/api/invoices/${invoiceId}/send`, {}, await technicianAuth());
    expect(res.response.status).toBe(403);
    const statusRes = await request(`/api/invoices/${invoiceId}/delivery-status`, await technicianAuth("tech-delivery-2@example.test"));
    expect(statusRes.response.status).toBe(403);
  });

  it("Org A cannot send Org B's invoice, and cannot read its delivery status", async () => {
    const authA = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(authA);
    const orgB = await createSecondOrganization("Delivery Org B");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const authB = { headers: { cookie } };
    const sendRes = await post(`/api/invoices/${invoiceId}/send`, {}, authB);
    expect(sendRes.response.status).toBe(404); // tenant isolation, not 403 — no cross-org existence leak
    const statusRes = await request(`/api/invoices/${invoiceId}/delivery-status`, authB);
    expect(statusRes.response.status).toBe(404);
  });

  it("delivery-status reflects a real failure and Retry resets the same row to pending (no duplicate)", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    await post(`/api/invoices/${invoiceId}/send`, {}, auth);
    // Simulate a delivery failure the same way the rest of this codebase's
    // test suite does — direct D1 mutation of the outbox row (matching
    // Phase 13A's established technique for this exact scenario).
    await queryDb("UPDATE notification_outbox SET status = 'failed', last_error = 'simulated failure' WHERE entity_type = 'invoice' AND entity_id = ? AND event_type = 'invoice.sent'", [invoiceId]);

    const failedStatus = await request<{ delivery: { failed: number; last_error: string | null } }>(`/api/invoices/${invoiceId}/delivery-status`, auth);
    expect(failedStatus.body.delivery.failed).toBe(1);
    expect(failedStatus.body.delivery.last_error).toBe("simulated failure");

    const retry = await post(`/api/invoices/${invoiceId}/send`, {}, auth);
    expect(retry.response.status).toBe(200);
    const rows = await queryDb<{ status: string }>(
      "SELECT status FROM notification_outbox WHERE entity_type = 'invoice' AND entity_id = ? AND event_type = 'invoice.sent'", [invoiceId]
    );
    expect(rows).toHaveLength(1); // reused, never duplicated
    expect(rows[0].status).toBe("pending");
  });
});

describe("Manual Payment — Section 14-20", () => {
  it("Section 25 CRITICAL: on-site cash payment against a never-sent invoice succeeds, updates the balance, and sends zero customer email", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    // Deliberately never call POST .../send.
    const invBefore = await request<{ invoice: { total_cents: number; balance_cents: number; status: string } }>(`/api/invoices/${invoiceId}`, auth);
    const total = invBefore.body.invoice.total_cents;

    const res = await post(`/api/invoices/${invoiceId}/payments`, {
      amount_cents: total, payer_type: "customer", method: "cash", received_by: "Front desk",
    }, auth);
    expect(res.response.status).toBe(201);

    const invAfter = await request<{ invoice: { balance_cents: number; status: string } }>(`/api/invoices/${invoiceId}`, auth);
    expect(invAfter.body.invoice.balance_cents).toBe(0);
    expect(invAfter.body.invoice.status).toBe("paid");

    const outboxRows = await queryDb("SELECT * FROM notification_outbox WHERE entity_type IN ('invoice','payment') AND entity_id IN (?, ?)", [invoiceId, invoiceId]);
    expect(outboxRows).toHaveLength(0);
  });

  it("persists received_by and defaults source to manual", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    await post(`/api/invoices/${invoiceId}/payments`, {
      amount_cents: 500, payer_type: "customer", method: "cash", received_by: "Jane the Tech",
    }, auth);
    const rows = await queryDb<{ received_by: string; source: string }>("SELECT received_by, source FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(rows[0].received_by).toBe("Jane the Tech");
    expect(rows[0].source).toBe("manual");
  });

  it("client cannot set source directly — mass-assignment guard", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    await post(`/api/invoices/${invoiceId}/payments`, {
      amount_cents: 500, payer_type: "customer", method: "cash", source: "online_provider",
    } as unknown as Record<string, unknown>, auth);
    const rows = await queryDb<{ source: string }>("SELECT source FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(rows[0].source).toBe("manual"); // the injected field is silently ignored by the strict-ish schema/handler
  });

  it("supports the bank_transfer method", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const res = await post(`/api/invoices/${invoiceId}/payments`, {
      amount_cents: 500, payer_type: "customer", method: "bank_transfer",
    }, auth);
    expect(res.response.status).toBe(201);
    const rows = await queryDb<{ method: string }>("SELECT method FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(rows[0].method).toBe("bank_transfer");
  });

  it("received_by is never required (empty string is valid)", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const res = await post(`/api/invoices/${invoiceId}/payments`, { amount_cents: 500, payer_type: "customer", method: "cash" }, auth);
    expect(res.response.status).toBe(201);
    const rows = await queryDb<{ received_by: string }>("SELECT received_by FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(rows[0].received_by).toBe("");
  });

  // Security/Testing review fix regression (Section 40): two genuinely
  // concurrent payments that would TOGETHER overpay the invoice must never
  // both succeed — recordPayment()'s overpayment guard used to be a plain
  // SELECT-the-sum-then-INSERT, a classic read-then-write race. Fixed by
  // folding the guard into the INSERT itself (see financial.ts#recordPayment's
  // own doc comment). This exercises the exact race window via real
  // Promise.all-concurrent HTTP requests, not sequential calls.
  it("two concurrent payments that would together overpay the invoice never both succeed — genuine race, not sequential", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const invoice = await request<{ invoice: { total_cents: number } }>(`/api/invoices/${invoiceId}`, auth);
    const total = invoice.body.invoice.total_cents;
    // Each payment alone is valid; both together would exceed total_cents.
    const each = Math.ceil(total * 0.6);

    const [r1, r2] = await Promise.all([
      post(`/api/invoices/${invoiceId}/payments`, { amount_cents: each, payer_type: "customer", method: "cash" }, auth),
      post(`/api/invoices/${invoiceId}/payments`, { amount_cents: each, payer_type: "customer", method: "cash" }, auth),
    ]);
    const statuses = [r1.response.status, r2.response.status].sort();
    expect(statuses).toEqual([201, 400]); // exactly one succeeded, one was correctly rejected

    const payments = await queryDb<{ amount_cents: number }>("SELECT amount_cents FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(payments).toHaveLength(1);
    const sum = payments.reduce((s, p) => s + p.amount_cents, 0);
    expect(sum).toBeLessThanOrEqual(total); // the invariant this whole test exists to prove
  });
});

describe("Payment Receipts — Section 21-24", () => {
  async function paidInvoiceAndPayment(auth: RequestInit) {
    const invoiceId = await issuedInvoiceWithContact(auth);
    const res = await post(`/api/invoices/${invoiceId}/payments`, { amount_cents: 500, payer_type: "customer", method: "cash" }, auth);
    expect(res.response.status).toBe(201);
    const rows = await queryDb<{ id: number }>("SELECT id FROM payments WHERE invoice_id = ?", [invoiceId]);
    return { invoiceId, paymentId: rows[0].id };
  }

  it("renders a real application/pdf receipt whose content matches this specific payment, not just a generic PDF", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const invoiceRow = await queryDb<{ identifier: string }>("SELECT identifier FROM invoices WHERE id = ?", [invoiceId]);
    const paid = await post(`/api/invoices/${invoiceId}/payments`, {
      amount_cents: 12345, payer_type: "customer", method: "check", reference: "RECEIPT-CONTENT-CHECK-9182",
    }, auth);
    expect(paid.response.status).toBe(201);
    const paymentRows = await queryDb<{ id: number }>("SELECT id FROM payments WHERE invoice_id = ?", [invoiceId]);
    const paymentId = paymentRows[0].id;

    const res = await requestRaw(`/api/payments/${paymentId}/receipt-pdf`, auth);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(100);
    expect(pdfBytesToText(bytes.slice(0, 5))).toBe("%PDF-");
    const text = await extractPdfText(bytes);
    expect(text).toContain(invoiceRow[0].identifier);
    expect(text).toContain("$123.45"); // this payment's own amount, not just any dollar figure
    expect(text).toContain("RECEIPT-CONTENT-CHECK-9182"); // this payment's own reference

    // A second, unrelated payment on the same invoice must render its own
    // receipt with its own numbers, not silently reuse the first one's.
    const paid2 = await post(`/api/invoices/${invoiceId}/payments`, {
      amount_cents: 654, payer_type: "customer", method: "cash", reference: "RECEIPT-CONTENT-CHECK-OTHER",
    }, auth);
    expect(paid2.response.status).toBe(201);
    const paymentRows2 = await queryDb<{ id: number }>("SELECT id FROM payments WHERE invoice_id = ? ORDER BY id", [invoiceId]);
    const paymentId2 = paymentRows2[1].id;
    const res2 = await requestRaw(`/api/payments/${paymentId2}/receipt-pdf`, auth);
    const text2 = await extractPdfText(new Uint8Array(await res2.arrayBuffer()));
    expect(text2).toContain("$6.54");
    expect(text2).toContain("RECEIPT-CONTENT-CHECK-OTHER");
    expect(text2).not.toContain("RECEIPT-CONTENT-CHECK-9182");
  });

  it("404 for a nonexistent payment", async () => {
    const auth = await authHeaders();
    const res = await requestRaw("/api/payments/999999/receipt-pdf", auth);
    expect(res.status).toBe(404);
  });

  it("email-receipt is a genuinely explicit, separate action that queues payment.receipt", async () => {
    const auth = await authHeaders();
    const { paymentId } = await paidInvoiceAndPayment(auth);
    const before = await queryDb("SELECT * FROM notification_outbox WHERE entity_type = 'payment' AND entity_id = ? AND event_type = 'payment.receipt'", [paymentId]);
    expect(before).toHaveLength(0);
    const res = await post(`/api/payments/${paymentId}/email-receipt`, {}, auth);
    expect(res.response.status).toBe(200);
    const after = await queryDb("SELECT * FROM notification_outbox WHERE entity_type = 'payment' AND entity_id = ? AND event_type = 'payment.receipt'", [paymentId]);
    expect(after).toHaveLength(1);
  });

  it("a failed receipt-email delivery never invalidates the underlying payment", async () => {
    const auth = await authHeaders();
    const { invoiceId, paymentId } = await paidInvoiceAndPayment(auth);
    await post(`/api/payments/${paymentId}/email-receipt`, {}, auth);
    await queryDb("UPDATE notification_outbox SET status = 'failed', last_error = 'simulated' WHERE entity_type = 'payment' AND entity_id = ? AND event_type = 'payment.receipt'", [paymentId]);

    const invoice = await request<{ invoice: { status: string; balance_cents: number } }>(`/api/invoices/${invoiceId}`, auth);
    expect(invoice.body.invoice.status).toBe("partially_paid"); // still a valid, unaffected financial state
    const payments = await queryDb<{ voided_at: string | null }>("SELECT voided_at FROM payments WHERE id = ?", [paymentId]);
    expect(payments[0].voided_at).toBeNull();

    const status = await request<{ delivery: { failed: number } }>(`/api/payments/${paymentId}/receipt-status`, auth);
    expect(status.body.delivery.failed).toBe(1);

    // Retry reuses the same row.
    const retry = await post(`/api/payments/${paymentId}/email-receipt`, {}, auth);
    expect(retry.response.status).toBe(200);
    const rows = await queryDb("SELECT * FROM notification_outbox WHERE entity_type = 'payment' AND entity_id = ? AND event_type = 'payment.receipt'", [paymentId]);
    expect(rows).toHaveLength(1);
  });

  it("technician is denied on receipt-pdf, receipt-status, and email-receipt", async () => {
    const auth = await authHeaders();
    const { paymentId } = await paidInvoiceAndPayment(auth);
    const techAuth = await technicianAuth();
    const pdfRes = await requestRaw(`/api/payments/${paymentId}/receipt-pdf`, techAuth);
    expect(pdfRes.status).toBe(403);
    expect((await request(`/api/payments/${paymentId}/receipt-status`, techAuth)).response.status).toBe(403);
    expect((await post(`/api/payments/${paymentId}/email-receipt`, {}, techAuth)).response.status).toBe(403);
  });

  it("Org A cannot access Org B's payment receipt in any form", async () => {
    const authA = await authHeaders();
    const { paymentId } = await paidInvoiceAndPayment(authA);
    const orgB = await createSecondOrganization("Receipt Org B");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const authB = { headers: { cookie } };
    const pdfRes = await requestRaw(`/api/payments/${paymentId}/receipt-pdf`, authB);
    expect(pdfRes.status).toBe(404);
    expect((await request(`/api/payments/${paymentId}/receipt-status`, authB)).response.status).toBe(404);
    expect((await post(`/api/payments/${paymentId}/email-receipt`, {}, authB)).response.status).toBe(404);
  });
});
