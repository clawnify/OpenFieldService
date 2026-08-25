import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createSecondOrganization, createUser,
  loginAs, post, put, queryDb, request, resetDatabase, satisfyCompletionRequirements,
} from "./helpers.js";
import { signMockWebhookPayload } from "../src/server/payment-provider.js";

async function createTechnician(name: string, adminAuth: RequestInit): Promise<number> {
  const res = await post<{ id: number }>("/api/technicians", { name }, adminAuth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

// Phase 13B — Online Payment: PaymentProvider abstraction (via the Mock
// implementation), public payment-link view/confirm/cancel, and the
// provider webhook endpoint. The "test-mock-payment-webhook-secret" value
// below matches vitest.config.ts's fixed test-only MOCK_PAYMENT_WEBHOOK_SECRET
// binding — same convention as RESEND_API_KEY/TWILIO_* elsewhere in this
// test suite.
const TEST_SECRET = "test-mock-payment-webhook-secret";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function technicianAuth(email = "tech-pay@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

async function issuedInvoiceWithContact(auth: RequestInit) {
  const customer = await createCustomer();
  await put(`/api/customers/${customer.id}`, { email: "pay@example.test" }, auth);
  const techId = await createTechnician("Pay Test Tech", auth);
  const job = await createJob(customer.id, "2026-10-05", { technician_id: techId });
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

async function createPaymentLink(auth: RequestInit, invoiceId: number) {
  const res = await post<{ url: string; expires_at: string }>(`/api/invoices/${invoiceId}/payment-link`, {}, auth);
  expect(res.response.status).toBe(201);
  const token = res.body.url.split("/pay/")[1];
  return { token, ...res.body };
}

describe("Provider config", () => {
  it("GET /api/config/payments reports enabled: true when the secret is configured (test env default)", async () => {
    const auth = await authHeaders();
    const res = await request<{ enabled: boolean }>("/api/config/payments", auth);
    expect(res.body.enabled).toBe(true);
  });

  it("requires authentication, same as every other /api/* route", async () => {
    const res = await request("/api/config/payments");
    expect(res.response.status).toBe(401);
  });
});

describe("Payment sessions — Section 9-13", () => {
  it("creates a session bound to the server-authoritative balance, never a client-supplied amount", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const invoice = await request<{ invoice: { balance_cents: number } }>(`/api/invoices/${invoiceId}`, auth);
    const { token } = await createPaymentLink(auth, invoiceId);
    const view = await request<{ view: { balance_due_cents: number } }>(`/api/public/invoices/pay/${token}`);
    expect(view.body.view.balance_due_cents).toBe(invoice.body.invoice.balance_cents);
  });

  it("rejects a payment link for a draft invoice", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const techId = await createTechnician("Draft Pay Tech", auth);
    const job = await createJob(customer.id, "2026-10-06", { technician_id: techId });
    await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, auth);
    await satisfyCompletionRequirements(job.id, auth);
    await post(`/api/jobs/${job.id}/transition`, { to_status: "completed" }, auth);
    const rows = await queryDb<{ id: number; status: string }>("SELECT id, status FROM invoices WHERE job_id = ?", [job.id]);
    expect(rows[0].status).toBe("draft");
    const res = await post(`/api/invoices/${rows[0].id}/payment-link`, {}, auth);
    expect(res.response.status).toBe(400);
  });

  it("rejects a payment link for a $0-balance (fully paid) invoice", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const invoice = await request<{ invoice: { total_cents: number } }>(`/api/invoices/${invoiceId}`, auth);
    await post(`/api/invoices/${invoiceId}/payments`, { amount_cents: invoice.body.invoice.total_cents, payer_type: "customer", method: "cash" }, auth);
    const res = await post(`/api/invoices/${invoiceId}/payment-link`, {}, auth);
    expect(res.response.status).toBe(400);
  });

  it("repeated payment-link generation reuses the same session row (no duplicate pending sessions)", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    await createPaymentLink(auth, invoiceId);
    await createPaymentLink(auth, invoiceId);
    const rows = await queryDb("SELECT id FROM payment_sessions WHERE invoice_id = ? AND status = 'pending'", [invoiceId]);
    expect(rows).toHaveLength(1);
  });

  it("technician is denied on payment-link creation", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const res = await post(`/api/invoices/${invoiceId}/payment-link`, {}, await technicianAuth());
    expect(res.response.status).toBe(403);
  });

  it("Org A cannot create a payment link for Org B's invoice", async () => {
    const authA = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(authA);
    const orgB = await createSecondOrganization("Pay Org B");
    const { cookie } = await loginAs(orgB.email, orgB.password);
    const authB = { headers: { cookie } };
    const res = await post(`/api/invoices/${invoiceId}/payment-link`, {}, authB);
    expect(res.response.status).toBe(404);
  });
});

describe("Public payment view / confirm / cancel — Section 11-13", () => {
  it("a garbage/wrong token gets the same generic 404 as an expired one — no enumeration", async () => {
    const res = await request("/api/public/invoices/pay/not-a-real-token");
    expect(res.response.status).toBe(404);
  });

  it("an expired session is treated identically to a nonexistent one", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const { token } = await createPaymentLink(auth, invoiceId);
    await queryDb("UPDATE payment_sessions SET expires_at = datetime('now', '-1 minute') WHERE invoice_id = ?", [invoiceId]);
    const res = await request(`/api/public/invoices/pay/${token}`);
    expect(res.response.status).toBe(404);
  });

  it("confirm records a real payment, updates the invoice balance/status, and auto-emails a receipt", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const invoice = await request<{ invoice: { total_cents: number } }>(`/api/invoices/${invoiceId}`, auth);
    const { token } = await createPaymentLink(auth, invoiceId);

    const confirm = await post<{ outcome: string }>(`/api/public/invoices/pay/${token}/confirm`, {});
    expect(confirm.response.status).toBe(200);
    expect(confirm.body.outcome).toBe("payment_recorded");

    const after = await request<{ invoice: { status: string; balance_cents: number; amount_paid_cents: number } }>(`/api/invoices/${invoiceId}`, auth);
    expect(after.body.invoice.balance_cents).toBe(0);
    expect(after.body.invoice.status).toBe("paid");
    expect(after.body.invoice.amount_paid_cents).toBe(invoice.body.invoice.total_cents);

    const payments = await queryDb<{ source: string; payment_session_id: number | null }>("SELECT source, payment_session_id FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(payments).toHaveLength(1);
    expect(payments[0].source).toBe("online_provider");
    expect(payments[0].payment_session_id).not.toBeNull();

    const receiptRows = await queryDb("SELECT * FROM notification_outbox WHERE entity_type = 'payment' AND event_type = 'payment.receipt'");
    expect(receiptRows).toHaveLength(1); // automatic for online payments, unlike manual (Section 24)
  });

  it("confirming an already-succeeded session is idempotent — exactly one payment row", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const { token } = await createPaymentLink(auth, invoiceId);
    const first = await post<{ outcome: string }>(`/api/public/invoices/pay/${token}/confirm`, {});
    expect(first.body.outcome).toBe("payment_recorded");
    // The token itself no longer resolves (session left 'pending' state), so
    // a literal second client call to the same URL hits the generic 404 —
    // true webhook replay (same provider event delivered twice) is covered
    // in the "Webhook processing" describe block below, which bypasses the
    // token and targets provider_session_id directly, the real replay
    // vector Section 29 is about.
    const second = await post(`/api/public/invoices/pay/${token}/confirm`, {});
    expect(second.response.status).toBe(404);
    const payments = await queryDb("SELECT id FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(payments).toHaveLength(1);
  });

  it("cancel marks the session cancelled; the link then behaves like any other dead link", async () => {
    const auth = await authHeaders();
    const invoiceId = await issuedInvoiceWithContact(auth);
    const { token } = await createPaymentLink(auth, invoiceId);
    const cancel = await post(`/api/public/invoices/pay/${token}/cancel`, {});
    expect(cancel.response.status).toBe(200);
    const viewAfter = await request(`/api/public/invoices/pay/${token}`);
    expect(viewAfter.response.status).toBe(404);
    const confirmAfter = await post(`/api/public/invoices/pay/${token}/confirm`, {});
    expect(confirmAfter.response.status).toBe(404);
    const payments = await queryDb("SELECT id FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(payments).toHaveLength(0);
  });
});

describe("Webhook processing — Section 29-30, 40", () => {
  async function pendingSession(auth: RequestInit) {
    const invoiceId = await issuedInvoiceWithContact(auth);
    await createPaymentLink(auth, invoiceId);
    const session = await queryDb<{ id: number; provider_session_id: string; amount_cents: number }>(
      "SELECT id, provider_session_id, amount_cents FROM payment_sessions WHERE invoice_id = ?", [invoiceId]
    );
    return { invoiceId, session: session[0] };
  }

  it("a validly signed succeeded event records exactly one payment", async () => {
    const auth = await authHeaders();
    const { invoiceId, session } = await pendingSession(auth);
    const { rawBody, signature } = await signMockWebhookPayload(TEST_SECRET, {
      providerSessionId: session.provider_session_id, status: "succeeded",
      providerTransactionId: "mock_txn_test1", amountCents: session.amount_cents,
    });
    const res = await request<{ outcome: string }>("/api/webhooks/payments/mock", {
      method: "POST", headers: { "X-Mock-Signature": signature }, body: rawBody,
    });
    expect(res.response.status).toBe(200);
    expect(res.body.outcome).toBe("payment_recorded");
    const payments = await queryDb("SELECT id FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(payments).toHaveLength(1);
  });

  it("rejects a request with an invalid/missing signature — no payment recorded", async () => {
    const auth = await authHeaders();
    const { invoiceId, session } = await pendingSession(auth);
    const rawBody = JSON.stringify({
      providerSessionId: session.provider_session_id, status: "succeeded",
      providerTransactionId: "mock_txn_bad", amountCents: session.amount_cents,
    });
    const res = await request("/api/webhooks/payments/mock", {
      method: "POST", headers: { "X-Mock-Signature": "0000not-a-real-signature" }, body: rawBody,
    });
    expect(res.response.status).toBe(401);
    const payments = await queryDb("SELECT id FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(payments).toHaveLength(0);
  });

  it("rejects a tampered amount even with a validly signed OTHER payload — amount/session binding", async () => {
    const auth = await authHeaders();
    const { invoiceId, session } = await pendingSession(auth);
    // Sign a DIFFERENT (tampered) amount — the signature is valid for what
    // was actually signed, but that amount doesn't match the session's own
    // server-recorded amount, so it must still be rejected.
    const { rawBody, signature } = await signMockWebhookPayload(TEST_SECRET, {
      providerSessionId: session.provider_session_id, status: "succeeded",
      providerTransactionId: "mock_txn_tampered", amountCents: session.amount_cents + 100000,
    });
    const res = await request<{ outcome: string }>("/api/webhooks/payments/mock", {
      method: "POST", headers: { "X-Mock-Signature": signature }, body: rawBody,
    });
    expect(res.response.status).toBe(200);
    expect(res.body.outcome).toBe("session_terminal");
    const payments = await queryDb("SELECT id FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(payments).toHaveLength(0);
  });

  it("a replayed (duplicate) succeeded event never creates a second payment", async () => {
    const auth = await authHeaders();
    const { invoiceId, session } = await pendingSession(auth);
    const event = {
      providerSessionId: session.provider_session_id, status: "succeeded" as const,
      providerTransactionId: "mock_txn_replay", amountCents: session.amount_cents,
    };
    const { rawBody, signature } = await signMockWebhookPayload(TEST_SECRET, event);
    const first = await request<{ outcome: string }>("/api/webhooks/payments/mock", {
      method: "POST", headers: { "X-Mock-Signature": signature }, body: rawBody,
    });
    expect(first.body.outcome).toBe("payment_recorded");
    const second = await request<{ outcome: string }>("/api/webhooks/payments/mock", {
      method: "POST", headers: { "X-Mock-Signature": signature }, body: rawBody,
    });
    expect(second.body.outcome).toBe("already_processed");
    const payments = await queryDb("SELECT id FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(payments).toHaveLength(1);
  });

  it("an unknown provider_session_id is rejected without touching any real invoice", async () => {
    const { rawBody, signature } = await signMockWebhookPayload(TEST_SECRET, {
      providerSessionId: "mock_sess_does_not_exist", status: "succeeded",
      providerTransactionId: "mock_txn_unknown", amountCents: 100,
    });
    const res = await request<{ error: string }>("/api/webhooks/payments/mock", {
      method: "POST", headers: { "X-Mock-Signature": signature }, body: rawBody,
    });
    expect(res.response.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it("a failed/cancelled provider event marks the session terminal without recording a payment", async () => {
    const auth = await authHeaders();
    const { invoiceId, session } = await pendingSession(auth);
    const { rawBody, signature } = await signMockWebhookPayload(TEST_SECRET, {
      providerSessionId: session.provider_session_id, status: "failed",
      providerTransactionId: null, amountCents: session.amount_cents,
    });
    const res = await request<{ outcome: string }>("/api/webhooks/payments/mock", {
      method: "POST", headers: { "X-Mock-Signature": signature }, body: rawBody,
    });
    expect(res.response.status).toBe(200);
    expect(res.body.outcome).toBe("session_terminal");
    const payments = await queryDb("SELECT id FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(payments).toHaveLength(0);
    const sessionRow = await queryDb<{ status: string }>("SELECT status FROM payment_sessions WHERE id = ?", [session.id]);
    expect(sessionRow[0].status).toBe("failed");
  });

  // Security review fix regression: a session's amount_cents is pinned at
  // creation time and can go stale if the invoice's real balance shrinks
  // before the provider confirms (e.g. a manual payment lands on the same
  // invoice in the meantime — a normal, explicitly-supported workflow,
  // not an attack). The webhook must NEVER leave the session stuck at
  // 'succeeded' with zero payments recorded — see
  // financial.ts#processPaymentWebhookEvent's own doc comment for the fix.
  it("a webhook confirming a session whose amount no longer fits the invoice's real balance never leaves it falsely 'succeeded'", async () => {
    const auth = await authHeaders();
    const { invoiceId, session } = await pendingSession(auth);

    // A manual payment lands on the SAME invoice after the session was
    // created, consuming the balance the session's amount_cents assumed
    // was still available.
    const manual = await post(`/api/invoices/${invoiceId}/payments`, {
      amount_cents: session.amount_cents, payer_type: "customer", method: "cash",
    }, auth);
    expect(manual.response.status).toBe(201);

    const { rawBody, signature } = await signMockWebhookPayload(TEST_SECRET, {
      providerSessionId: session.provider_session_id, status: "succeeded",
      providerTransactionId: "mock_txn_race", amountCents: session.amount_cents,
    });
    const res = await request<{ outcome: string }>("/api/webhooks/payments/mock", {
      method: "POST", headers: { "X-Mock-Signature": signature }, body: rawBody,
    });
    expect(res.response.status).toBe(200);
    expect(res.body.outcome).toBe("session_terminal"); // rejected, not falsely recorded

    // Exactly the one manual payment exists — the webhook never created a
    // second (overpaying) payment row.
    const payments = await queryDb("SELECT id FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(payments).toHaveLength(1);

    // The session is NOT left at 'succeeded' with no payment — it's a
    // real terminal 'failed' state, not a fabricated success.
    const sessionRow = await queryDb<{ status: string }>("SELECT status FROM payment_sessions WHERE id = ?", [session.id]);
    expect(sessionRow[0].status).toBe("failed");

    // A replay of the exact same (now-stale) event is still safely
    // rejected, never retroactively recorded.
    const replay = await request<{ outcome: string }>("/api/webhooks/payments/mock", {
      method: "POST", headers: { "X-Mock-Signature": signature }, body: rawBody,
    });
    expect(replay.body.outcome).toBe("session_terminal");
    const paymentsAfterReplay = await queryDb("SELECT id FROM payments WHERE invoice_id = ?", [invoiceId]);
    expect(paymentsAfterReplay).toHaveLength(1);
  });
});
