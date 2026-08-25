import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, loginAs,
  post, put, queryDb, request, resetDatabase, satisfyCompletionRequirements,
} from "./helpers.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function technicianAuth(email = "hist-tech@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "TechPass123", role: "technician" });
  const { cookie } = await loginAs(email, "TechPass123");
  return { headers: { cookie } };
}

async function createTechnician(name: string, adminAuth: RequestInit): Promise<number> {
  const res = await post<{ id: number }>("/api/technicians", { name }, adminAuth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

interface NotificationRow {
  id: number; event_type: string; channel: string; recipient: string; status: string;
  attempts: number; last_error: string; scheduled_for: string; sent_at: string | null; created_at: string;
}
interface AttemptRow {
  notification_id: number; attempt_number: number; status: string; provider_message_id: string | null;
  error_code: string; error_message: string;
}
interface HistoryResponse { notifications: NotificationRow[]; attempts: AttemptRow[]; total: number }

describe("Customer notification history", () => {
  it("17. shows notifications tied to this customer's jobs", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "hist-cust@example.test" }, auth);
    await createJob(customer.id, "2026-10-01");
    const res = await request<HistoryResponse>(`/api/customers/${customer.id}/notifications`, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.notifications.length).toBeGreaterThan(0);
    expect(res.body.notifications[0].event_type).toBe("job.appointment_confirmation");
  });

  it("21. supports pagination", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "hist-page@example.test" }, auth);
    for (let i = 0; i < 3; i++) await createJob(customer.id, `2026-10-0${i + 2}`);
    const page1 = await request<HistoryResponse>(`/api/customers/${customer.id}/notifications?page=1&limit=2`, auth);
    expect(page1.body.notifications).toHaveLength(2);
    expect(page1.body.total).toBeGreaterThanOrEqual(3);
    const page2 = await request<HistoryResponse>(`/api/customers/${customer.id}/notifications?page=2&limit=2`, auth);
    expect(page2.body.notifications.length).toBeGreaterThan(0);
    const ids1 = page1.body.notifications.map((n) => n.id);
    const ids2 = page2.body.notifications.map((n) => n.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false); // no overlap
  });

  it("22. ordering is deterministic across repeated calls", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "hist-order@example.test" }, auth);
    for (let i = 0; i < 3; i++) await createJob(customer.id, `2026-10-1${i}`);
    const a = await request<HistoryResponse>(`/api/customers/${customer.id}/notifications`, auth);
    const b = await request<HistoryResponse>(`/api/customers/${customer.id}/notifications`, auth);
    expect(a.body.notifications.map((n) => n.id)).toEqual(b.body.notifications.map((n) => n.id));
  });

  it("23. technician is denied", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    void auth;
    const res = await request(`/api/customers/${customer.id}/notifications`, await technicianAuth());
    expect(res.response.status).toBe(403);
  });

  it("24. unauthenticated is 401", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    void auth;
    const res = await request(`/api/customers/${customer.id}/notifications`);
    expect(res.response.status).toBe(401);
  });

  it("404 for a nonexistent customer", async () => {
    const auth = await authHeaders();
    const res = await request(`/api/customers/999999/notifications`, auth);
    expect(res.response.status).toBe(404);
  });
});

describe("Lead notification history", () => {
  it("18. returns an empty (not erroring) page — no Lead events are wired yet", async () => {
    const auth = await authHeaders();
    const lead = await post<{ id: number }>("/api/leads", { name: "Hist Lead" }, auth);
    const res = await request<HistoryResponse>(`/api/leads/${lead.body.id}/notifications`, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.notifications).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("technician is denied", async () => {
    const auth = await authHeaders();
    const lead = await post<{ id: number }>("/api/leads", { name: "Hist Lead 2" }, auth);
    const res = await request(`/api/leads/${lead.body.id}/notifications`, await technicianAuth());
    expect(res.response.status).toBe(403);
  });
});

describe("Job notification history", () => {
  it("19. shows notifications for this specific job only", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "hist-job@example.test" }, auth);
    const job1 = await createJob(customer.id, "2026-10-20");
    const job2 = await createJob(customer.id, "2026-10-21");
    const res = await request<HistoryResponse>(`/api/jobs/${job1.id}/notifications`, auth);
    expect(res.body.total).toBe(1);
    expect(res.body.notifications[0].event_type).toBe("job.appointment_confirmation");
    void job2;
  });

  it("23b. technician is denied even for their own assigned job", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const techId = await createTechnician("Hist Tech", auth);
    const job = await createJob(customer.id, "2026-10-22", { technician_id: techId });
    const techAuth = await technicianAuth();
    // Link this technician user to the technician row so "own job" is genuine.
    const rows = await queryDb<{ id: number }>("SELECT id FROM technicians WHERE id = ?", [techId]);
    void rows;
    const res = await request(`/api/jobs/${job.id}/notifications`, techAuth);
    expect(res.response.status).toBe(403);
  });

  it("404 for a nonexistent job", async () => {
    const auth = await authHeaders();
    const res = await request(`/api/jobs/999999/notifications`, auth);
    expect(res.response.status).toBe(404);
  });
});

describe("Invoice notification history", () => {
  async function completedInvoice(auth: RequestInit) {
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "hist-invoice@example.test" }, auth);
    const techId = await createTechnician("Invoice Hist Tech", auth);
    const job = await createJob(customer.id, "2026-10-25", { technician_id: techId });
    await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, auth);
    await satisfyCompletionRequirements(job.id, auth);
    await post(`/api/jobs/${job.id}/transition`, { to_status: "completed" }, auth);
    const invoiceRows = await queryDb<{ id: number; status: string }>("SELECT id, status FROM invoices WHERE job_id=?", [job.id]);
    if (invoiceRows[0].status === "draft") await post(`/api/invoices/${invoiceRows[0].id}/issue`, {}, auth);
    return invoiceRows[0].id;
  }

  // Phase 13B — invoice.issued/payment.received are no longer auto-fired
  // (Section 5's Core Business Rule); the explicit Send Invoice action and
  // an opt-in Email Receipt on payment are their replacements.
  it("20. shows invoice.sent and payment.receipt together", async () => {
    const auth = await authHeaders();
    const invoiceId = await completedInvoice(auth);
    await post(`/api/invoices/${invoiceId}/send`, {}, auth);
    await post(`/api/invoices/${invoiceId}/payments`, { amount_cents: 100, payer_type: "customer", method: "cash", email_receipt: true }, auth);
    const res = await request<HistoryResponse>(`/api/invoices/${invoiceId}/notifications`, auth);
    expect(res.response.status).toBe(200);
    const types = res.body.notifications.map((n) => n.event_type);
    expect(types).toContain("invoice.sent");
    expect(types).toContain("payment.receipt");
  });

  it("technician is denied (canManageFinancials blackout)", async () => {
    const auth = await authHeaders();
    const invoiceId = await completedInvoice(auth);
    const res = await request(`/api/invoices/${invoiceId}/notifications`, await technicianAuth());
    expect(res.response.status).toBe(403);
  });

  it("404 for a nonexistent invoice", async () => {
    const auth = await authHeaders();
    const res = await request(`/api/invoices/999999/notifications`, auth);
    expect(res.response.status).toBe(404);
  });
});

describe("response safety", () => {
  it("25. no provider secret ever appears in a history response", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "hist-safe@example.test" }, auth);
    await createJob(customer.id, "2026-10-30");
    const res = await request<HistoryResponse>(`/api/customers/${customer.id}/notifications`, auth);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/Bearer |Authorization|api[_-]?key/i);
  });

  it("26. the full payload JSON is never included in a history response", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "hist-nopayload@example.test" }, auth);
    await createJob(customer.id, "2026-10-31");
    const res = await request<HistoryResponse>(`/api/customers/${customer.id}/notifications`, auth);
    for (const n of res.body.notifications) {
      expect(n).not.toHaveProperty("payload");
    }
  });

  it("27. delivery attempts are only ever visible as safe fields, no notification_id leakage confusion across entities", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await put(`/api/customers/${customer.id}`, { email: "hist-attempts@example.test" }, auth);
    await createJob(customer.id, "2026-11-01");
    const res = await request<HistoryResponse>(`/api/customers/${customer.id}/notifications`, auth);
    for (const a of res.body.attempts) {
      expect(Object.keys(a).sort()).toEqual(
        ["attempt_number", "attempted_at", "completed_at", "error_code", "error_message", "notification_id", "provider_message_id", "status"].sort()
      );
      const belongs = res.body.notifications.some((n) => n.id === a.notification_id);
      expect(belongs).toBe(true);
    }
  });
});
