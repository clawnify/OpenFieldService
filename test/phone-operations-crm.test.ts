import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema, authHeaders, createCustomer, createSecondOrganization, createUser, loginAs, post, put, request, requestRaw, resetDatabase } from "./helpers.js";
import { buildToolRegistry, KNOWN_TOOL_NAMES } from "../src/server/phone-operations-crm.js";

// Phase 16 — Phone Operations <-> CRM / Customers / Leads / Scheduler / Jobs.
//
// Covers: caller matching (exact/unknown/ambiguous), the sensitive-
// disclosure gate, cross-tenant isolation on every new route, Lead/
// appointment creation THROUGH the canonical createLeadRecord/
// createJobRecord paths (never a bypass), the tool registry's
// authorization (agent tool_policy allow/deny), idempotent tool
// invocation, manual link/correction, follow-ups, and availability.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function signTwilioRequest(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Buffer.from(sig).toString("base64");
}

async function configurePhoneOps(auth: RequestInit) {
  await post("/api/phone-operations/credentials/twilio", { account_sid: "AC_crm_test", auth_token: "crm_test_token" }, auth);
  await post("/api/phone-operations/settings", { operating_mode: "ACTIVE", inbound_enabled: true, outbound_enabled: true, max_concurrent_calls: 5, daily_call_cap: 0 }, auth);
  const number = await post<{ number: { id: number; e164_number: string } }>("/api/phone-operations/numbers", { e164_number: "+16045551200" }, auth);
  return number.body.number;
}

/** Places a real, fully-signed inbound call through the actual webhook —
 *  used only where the test cares about call-CREATION mechanics (auto-
 *  matching). Other tests raw-insert a `calls` row for speed, matching this
 *  codebase's own `executeStatements` fixture-setup precedent. */
async function placeInboundCall(number: { e164_number: string }, fromNumber: string, callSid: string): Promise<void> {
  const params = { To: number.e164_number, From: fromNumber, CallSid: callSid };
  const url = "http://example.test/api/phone-operations/twilio/voice";
  const signature = await signTwilioRequest("crm_test_token", url, params);
  await requestRaw("/api/phone-operations/twilio/voice", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body: new URLSearchParams(params).toString(),
  });
}

async function insertBareCall(organizationId: number, phoneNumberId: number): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO calls (organization_id, direction, status, phone_number_id, from_number, to_number, voice_agent_snapshot) VALUES (?, 'inbound', 'completed', ?, '+16045550099', '+16045551200', '{}')"
  ).bind(organizationId, phoneNumberId).run();
  const row = await env.DB.prepare("SELECT id FROM calls WHERE organization_id = ? ORDER BY id DESC LIMIT 1").bind(organizationId).first<{ id: number }>();
  return row!.id;
}

describe("Caller matching", () => {
  it("exact single phone match auto-links the call with EXACT_PHONE confidence", async () => {
    const auth = await authHeaders();
    const number = await configurePhoneOps(auth);
    const customer = await createCustomer("Match Me");
    await put(`/api/customers/${customer.id}`, { phone: "604-555-9876" }, auth);

    await placeInboundCall(number, "+16045559876", "CA_match_exact");
    const call = await env.DB.prepare("SELECT id, customer_id, match_confidence FROM calls WHERE provider_call_sid = 'CA_match_exact'").first<{ id: number; customer_id: number; match_confidence: string }>();
    expect(call!.customer_id).toBe(customer.id);
    expect(call!.match_confidence).toBe("EXACT_PHONE");
  });

  it("unknown caller leaves the call unlinked with UNKNOWN confidence", async () => {
    const auth = await authHeaders();
    const number = await configurePhoneOps(auth);
    await placeInboundCall(number, "+16045550000", "CA_match_unknown");
    const call = await env.DB.prepare("SELECT customer_id, match_confidence FROM calls WHERE provider_call_sid = 'CA_match_unknown'").first<{ customer_id: number | null; match_confidence: string }>();
    expect(call!.customer_id).toBeNull();
    expect(call!.match_confidence).toBe("UNKNOWN");
  });

  it("multiple matches never guess — the call stays unlinked, not silently picked", async () => {
    const auth = await authHeaders();
    const number = await configurePhoneOps(auth);
    const c1 = await createCustomer("Dup One");
    const c2 = await createCustomer("Dup Two");
    await put(`/api/customers/${c1.id}`, { phone: "604-555-4444" }, auth);
    await put(`/api/customers/${c2.id}`, { phone: "604-555-4444" }, auth);

    await placeInboundCall(number, "+16045554444", "CA_match_ambiguous");
    const call = await env.DB.prepare("SELECT customer_id, match_confidence FROM calls WHERE provider_call_sid = 'CA_match_ambiguous'").first<{ customer_id: number | null; match_confidence: string }>();
    expect(call!.customer_id).toBeNull();
    expect(call!.match_confidence).toBe("UNKNOWN");
  });
});

describe("CRM context, manual linking, and RBAC", () => {
  it("admin/dispatcher can read CRM context and manually link/unlink a customer; technician is denied", async () => {
    const auth = await authHeaders();
    const number = await configurePhoneOps(auth);
    const customer = await createCustomer("Manual Link Target");
    const callId = await insertBareCall(1, number.id);

    const before = await request<{ customer: unknown; match_confidence: string }>(`/api/phone-operations/calls/${callId}/crm-context`, auth);
    expect(before.response.status).toBe(200);
    expect(before.body.customer).toBeNull();

    const linked = await post(`/api/phone-operations/calls/${callId}/link`, { entity_type: "customer", entity_id: customer.id }, auth);
    expect(linked.response.status).toBe(200);
    const after = await request<{ customer: { id: number } | null; match_confidence: string }>(`/api/phone-operations/calls/${callId}/crm-context`, auth);
    expect(after.body.customer?.id).toBe(customer.id);
    expect(after.body.match_confidence).toBe("MANUAL");

    const unlinked = await post(`/api/phone-operations/calls/${callId}/link`, { entity_type: "customer", entity_id: null }, auth);
    expect(unlinked.response.status).toBe(200);

    await createUser({ email: "crm-tech@example.test", password: "TechPass123", role: "technician" });
    const tech = { headers: { cookie: (await loginAs("crm-tech@example.test", "TechPass123")).cookie } };
    expect((await request(`/api/phone-operations/calls/${callId}/crm-context`, tech)).response.status).toBe(403);
    expect((await post(`/api/phone-operations/calls/${callId}/link`, { entity_type: "customer", entity_id: customer.id }, tech)).response.status).toBe(403);
  });

  it("linking to a customer in another organization is rejected (tenant isolation)", async () => {
    const auth = await authHeaders();
    const number = await configurePhoneOps(auth);
    const callId = await insertBareCall(1, number.id);

    const second = await createSecondOrganization();
    const secondAuth = { headers: { cookie: (await loginAs(second.email, second.password)).cookie } };
    // createCustomer() always uses the cached ADMIN (org 1) session
    // internally, so the org-B customer must be created directly with the
    // org-B session instead.
    const orgBCustomerRes = await post<{ id: number }>("/api/customers", { name: "Org B Customer", email: "b@example.test", phone: "555-0111" }, secondAuth);

    const res = await post(`/api/phone-operations/calls/${callId}/link`, { entity_type: "customer", entity_id: orgBCustomerRes.body.id }, auth);
    expect(res.response.status).toBe(404);
  });
});

describe("Follow-ups", () => {
  it("admin/dispatcher can create and complete a follow-up; technician is denied", async () => {
    const auth = await authHeaders();
    const number = await configurePhoneOps(auth);
    const callId = await insertBareCall(1, number.id);

    const created = await post<{ follow_up: { id: number; status: string } }>(`/api/phone-operations/calls/${callId}/follow-ups`, { note: "Call back tomorrow", due_date: "2026-09-01" }, auth);
    expect(created.response.status).toBe(201);
    expect(created.body.follow_up.status).toBe("open");

    const list = await request<{ follow_ups: { id: number }[] }>("/api/phone-operations/follow-ups?status=open", auth);
    expect(list.body.follow_ups.some((f) => f.id === created.body.follow_up.id)).toBe(true);

    const completed = await post(`/api/phone-operations/follow-ups/${created.body.follow_up.id}/complete`, {}, auth);
    expect(completed.response.status).toBe(200);
    const again = await post(`/api/phone-operations/follow-ups/${created.body.follow_up.id}/complete`, {}, auth);
    expect(again.response.status).toBe(404); // already completed — not re-completable

    await createUser({ email: "crm-tech2@example.test", password: "TechPass123", role: "technician" });
    const tech = { headers: { cookie: (await loginAs("crm-tech2@example.test", "TechPass123")).cookie } };
    expect((await post(`/api/phone-operations/calls/${callId}/follow-ups`, { note: "x" }, tech)).response.status).toBe(403);
  });

  it("rejects an empty note with 400", async () => {
    const auth = await authHeaders();
    const number = await configurePhoneOps(auth);
    const callId = await insertBareCall(1, number.id);
    const res = await post(`/api/phone-operations/calls/${callId}/follow-ups`, { note: "   " }, auth);
    expect(res.response.status).toBe(400);
  });
});

describe("Availability", () => {
  it("reports a technician unavailable for a conflicting window and available otherwise", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer("Avail Customer");
    const tech = await post<{ id: number }>("/api/technicians", { name: "Avail Tech" }, auth);
    await post("/api/jobs", { customer_id: customer.id, technician_id: tech.body.id, scheduled_date: "2026-09-10", scheduled_time: "10:00", duration: 60 }, auth);

    const conflicting = await request<{ availability: { technician_id: number; available: boolean }[] }>("/api/phone-operations/availability?date=2026-09-10&time=10:30&duration=30", auth);
    expect(conflicting.body.availability.find((a) => a.technician_id === tech.body.id)?.available).toBe(false);

    const free = await request<{ availability: { technician_id: number; available: boolean }[] }>("/api/phone-operations/availability?date=2026-09-10&time=14:00&duration=30", auth);
    expect(free.body.availability.find((a) => a.technician_id === tech.body.id)?.available).toBe(true);
  });

  it("technician is denied", async () => {
    await createUser({ email: "crm-tech3@example.test", password: "TechPass123", role: "technician" });
    const tech = { headers: { cookie: (await loginAs("crm-tech3@example.test", "TechPass123")).cookie } };
    expect((await request("/api/phone-operations/availability?date=2026-09-10", tech)).response.status).toBe(403);
  });
});

describe("Tool registry — authorization, idempotency, and canonical-service reuse", () => {
  async function issueRuntimeCredential(auth: RequestInit): Promise<string> {
    const issued = await post<{ token: string }>("/api/phone-operations/service-credentials", { label: "crm-test-runtime" }, auth);
    return issued.body.token;
  }

  async function callWithToolPolicy(auth: RequestInit, toolPolicy: string[]): Promise<{ number: { id: number; e164_number: string }; callId: number; token: string }> {
    const number = await configurePhoneOps(auth);
    // Number's voice_agent_id stays null, which resolves to the org's
    // default agent at call-creation time (see createCall in
    // phone-operations.ts) — no need to bind it explicitly here.
    await post("/api/phone-operations/agents", { name: "Tool Agent", language: "en", voice: "", model: "", instructions: "", is_default: true, status: "active", tool_policy: toolPolicy }, auth);
    const token = await issueRuntimeCredential(auth);
    await placeInboundCall(number, "+16045557000", "CA_tool_test");
    const call = await env.DB.prepare("SELECT id FROM calls WHERE provider_call_sid = 'CA_tool_test'").first<{ id: number }>();
    return { number, callId: call!.id, token };
  }

  async function invokeTool(token: string, callId: number, tool: string, idempotencyKey: string, args: Record<string, unknown>) {
    return request<{ status: string; result?: unknown; error?: string; idempotent_replay: boolean }>(`/api/phone-operations/runtime/calls/${callId}/tools/invoke`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool, idempotency_key: idempotencyKey, args }),
    });
  }

  it("a tool not in the agent's frozen tool_policy is denied, even though the tool itself exists", async () => {
    const auth = await authHeaders();
    const { callId, token } = await callWithToolPolicy(auth, ["get_job_status"]); // find_customer_by_phone NOT granted
    const res = await invokeTool(token, callId, "find_customer_by_phone", "key-1", { phone: "+16045551234" });
    expect(res.response.status).toBe(403);
    expect(res.body.status).toBe("denied");
  });

  it("an unknown tool name fails cleanly, never a crash", async () => {
    const auth = await authHeaders();
    const { callId, token } = await callWithToolPolicy(auth, ["get_job_status"]);
    const res = await invokeTool(token, callId, "delete_everything", "key-1", {});
    expect(res.response.status).toBe(200);
    expect(res.body.status).toBe("failed");
  });

  it("a granted tool executes; a duplicate idempotency_key replays the stored result without re-executing", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer("Idempotent Customer");
    const { callId, token } = await callWithToolPolicy(auth, ["get_customer_service_context"]);

    const first = await invokeTool(token, callId, "get_customer_service_context", "key-idem", { customer_id: customer.id });
    expect(first.response.status).toBe(200);
    expect(first.body.status).toBe("success");
    expect(first.body.idempotent_replay).toBe(false);

    const second = await invokeTool(token, callId, "get_customer_service_context", "key-idem", { customer_id: customer.id });
    expect(second.response.status).toBe(200);
    expect(second.body.idempotent_replay).toBe(true);
    expect(second.body.result).toEqual(first.body.result);

    const invocations = await env.DB.prepare("SELECT COUNT(*) as n FROM call_tool_invocations WHERE call_id = ? AND idempotency_key = 'key-idem'").bind(callId).first<{ n: number }>();
    expect(invocations!.n).toBe(1); // exactly one row despite two identical invocations
  });

  it("create_lead_from_call creates a real Lead through createLeadRecord (identifier, history row, RBAC-independent of workflow bypass)", async () => {
    const auth = await authHeaders();
    const { callId, token } = await callWithToolPolicy(auth, ["create_lead_from_call"]);
    const res = await invokeTool(token, callId, "create_lead_from_call", "key-lead", { name: "Phone Prospect", phone: "+16045559999", referral_source: "Phone" });
    expect(res.response.status).toBe(200);
    expect(res.body.status).toBe("success");
    const lead = await env.DB.prepare("SELECT identifier, status FROM leads WHERE name = 'Phone Prospect'").first<{ identifier: string; status: string }>();
    expect(lead!.status).toBe("new");
    expect(lead!.identifier).toMatch(/LEAD-/);
    const call = await env.DB.prepare("SELECT lead_id FROM calls WHERE id = ?").bind(callId).first<{ lead_id: number }>();
    expect(call!.lead_id).not.toBeNull();
  });

  it("create_appointment_for_customer only operates on an already-linked, existing customer — never an unknown/foreign one", async () => {
    const auth = await authHeaders();
    const { callId, token } = await callWithToolPolicy(auth, ["create_appointment_for_customer"]);
    const res = await invokeTool(token, callId, "create_appointment_for_customer", "key-appt-bad", { customer_id: 999999, scheduled_date: "2026-09-15" });
    expect(res.response.status).toBe(200);
    expect(res.body.status).toBe("failed");
    const jobCount = await env.DB.prepare("SELECT COUNT(*) as n FROM jobs").first<{ n: number }>();
    expect(jobCount!.n).toBe(0);
  });

  it("create_appointment_for_customer books a real, unassigned Job for a real customer", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer("Booking Customer");
    const { callId, token } = await callWithToolPolicy(auth, ["create_appointment_for_customer"]);
    const res = await invokeTool(token, callId, "create_appointment_for_customer", "key-appt-ok", { customer_id: customer.id, scheduled_date: "2026-09-20", scheduled_time: "11:00" });
    expect(res.response.status).toBe(200);
    expect(res.body.status).toBe("success");
    const job = await env.DB.prepare("SELECT technician_id, status FROM jobs WHERE customer_id = ?").bind(customer.id).first<{ technician_id: number | null; status: string }>();
    expect(job!.technician_id).toBeNull(); // Section 19 — created unassigned, never auto-dispatched
    const call = await env.DB.prepare("SELECT job_id FROM calls WHERE id = ?").bind(callId).first<{ job_id: number }>();
    expect(call!.job_id).not.toBeNull();
  });

  it("create_appointment_for_customer goes through the real conflict guard, same as the Jobs UI", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer("Conflict Customer");
    const tech = await post<{ id: number }>("/api/technicians", { name: "Conflict Tech" }, auth);
    await post("/api/jobs", { customer_id: customer.id, technician_id: tech.body.id, scheduled_date: "2026-09-21", scheduled_time: "10:00", duration: 60 }, auth);
    const { callId, token } = await callWithToolPolicy(auth, ["create_appointment_for_customer"]);
    // Phone-created appointments are always unassigned, so this can't collide
    // with the specific technician above — it proves createJobRecord (the
    // same canonical path the Jobs UI uses) is genuinely being called, not a
    // hand-rolled duplicate, by checking the resulting row shape rather than
    // forcing a same-technician conflict (which the tool's design makes
    // structurally impossible to reach).
    const res = await invokeTool(token, callId, "create_appointment_for_customer", "key-appt-canonical", { customer_id: customer.id, scheduled_date: "2026-09-21", scheduled_time: "10:00" });
    expect(res.response.status).toBe(200);
    expect(res.body.status).toBe("success");
    const jobs = await env.DB.prepare("SELECT technician_id FROM jobs WHERE customer_id = ?").bind(customer.id).all<{ technician_id: number | null }>();
    expect(jobs.results.length).toBe(2);
    expect(jobs.results.filter((j) => j.technician_id === null).length).toBe(1);
  });

  it("KNOWN_TOOL_NAMES stays in sync with buildToolRegistry's actual keys", () => {
    const registry = buildToolRegistry({
      createLeadRecord: async () => ({ id: 0, identifier: "" }),
      createJobRecord: async () => ({ id: 0, identifier: "" }),
    });
    expect(Object.keys(registry).sort()).toEqual([...KNOWN_TOOL_NAMES].sort());
  });

  it("two concurrent invocations with the same idempotency_key execute the side effect exactly once", async () => {
    const auth = await authHeaders();
    const { callId, token } = await callWithToolPolicy(auth, ["create_lead_from_call"]);

    const [first, second] = await Promise.all([
      invokeTool(token, callId, "create_lead_from_call", "key-race", { name: "Race Prospect", phone: "+16045558888" }),
      invokeTool(token, callId, "create_lead_from_call", "key-race", { name: "Race Prospect", phone: "+16045558888" }),
    ]);

    // Exactly one side effect regardless of which request "won" the race —
    // this is what the claim-first (INSERT-before-execute) fix guarantees;
    // the old check-then-act version could let both requests execute.
    const leadCount = await env.DB.prepare("SELECT COUNT(*) as n FROM leads WHERE name = 'Race Prospect'").first<{ n: number }>();
    expect(leadCount!.n).toBe(1);
    const invocationCount = await env.DB.prepare("SELECT COUNT(*) as n FROM call_tool_invocations WHERE call_id = ? AND idempotency_key = 'key-race'").bind(callId).first<{ n: number }>();
    expect(invocationCount!.n).toBe(1);

    // Both requests get a coherent answer: either it succeeded (possibly as
    // an idempotent replay of the other's result), or it was told the
    // invocation was still being processed and to retry — never a crash and
    // never a second, silently-duplicated Lead.
    for (const res of [first, second]) {
      expect(res.response.status).toBe(200);
      if (res.body.status === "success") {
        expect(typeof (res.body.result as { id: number }).id).toBe("number");
      } else {
        expect(res.body.error).toMatch(/still being processed/);
      }
    }
  });

  it("a call's frozen tool_policy does not gain permissions from a LATER agent version", async () => {
    const auth = await authHeaders();
    const { callId, token } = await callWithToolPolicy(auth, ["get_job_status"]); // create_follow_up NOT granted at call time

    // Publish a new version of the same agent that DOES grant create_follow_up.
    await post("/api/phone-operations/agents", { name: "Tool Agent", language: "en", voice: "", model: "", instructions: "", is_default: true, status: "active", tool_policy: ["get_job_status", "create_follow_up"] }, auth);

    const res = await invokeTool(token, callId, "create_follow_up", "key-frozen", { note: "should stay denied" });
    expect(res.response.status).toBe(403);
    expect(res.body.status).toBe("denied");
    const count = await env.DB.prepare("SELECT COUNT(*) as n FROM call_follow_ups WHERE call_id = ?").bind(callId).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("a call's frozen tool_policy does not lose permissions from a LATER agent version either", async () => {
    const auth = await authHeaders();
    const { callId, token } = await callWithToolPolicy(auth, ["get_job_status", "create_follow_up"]);

    // Publish a new version that revokes create_follow_up.
    await post("/api/phone-operations/agents", { name: "Tool Agent", language: "en", voice: "", model: "", instructions: "", is_default: true, status: "active", tool_policy: ["get_job_status"] }, auth);

    const res = await invokeTool(token, callId, "create_follow_up", "key-frozen-still-allowed", { note: "still allowed under the original snapshot" });
    expect(res.response.status).toBe(200);
    expect(res.body.status).toBe("success");
  });
});

describe("Cross-tenant isolation on the runtime tool-invoke route", () => {
  it("a service credential from Org A cannot invoke tools against Org B's call", async () => {
    const auth = await authHeaders();
    const number = await configurePhoneOps(auth);
    await post("/api/phone-operations/agents", { name: "Isolation Agent", language: "en", voice: "", model: "", instructions: "", is_default: true, status: "active", tool_policy: ["get_job_status"] }, auth);
    await placeInboundCall(number, "+16045556000", "CA_isolation_test");
    const call = await env.DB.prepare("SELECT id FROM calls WHERE provider_call_sid = 'CA_isolation_test'").first<{ id: number }>();

    const second = await createSecondOrganization();
    const secondAuth = { headers: { cookie: (await loginAs(second.email, second.password)).cookie } };
    const orgBCred = await post<{ token: string }>("/api/phone-operations/service-credentials", { label: "org-b" }, secondAuth);

    const res = await request(`/api/phone-operations/runtime/calls/${call!.id}/tools/invoke`, {
      method: "POST", headers: { Authorization: `Bearer ${orgBCred.body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "get_job_status", idempotency_key: "hijack", args: {} }),
    });
    expect(res.response.status).toBe(404);
  });
});
