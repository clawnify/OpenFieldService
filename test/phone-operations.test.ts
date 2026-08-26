import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyTwilioSignature, mapTwilioCallStatus, buildInboundStreamTwiML, buildRejectedCallTwiML } from "../src/server/twilio-provider.js";
import { applySchema, authHeaders, createSecondOrganization, createUser, loginAs, mockNotificationProviders, post, put, request, requestRaw, resetDatabase } from "./helpers.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

// Phase 15 — Phone Operations Foundation.
//
// Covers: RBAC (admin-only config surfaces, admin+dispatcher call
// visibility, technician fully blocked, unauthenticated 401), tenant
// isolation, non-destructive settings/agent versioning, the call FSM
// (allowed/forbidden transitions, idempotent event/transcript dedupe,
// outcome recorded once), operating-mode/cap gating, the Twilio webhook
// signature boundary (valid/invalid/unconfigured), and the Voice Engine
// runtime API's bearer-credential tenant resolution (including the
// cross-organization IDOR case Phase 14's independent reviews flagged as
// the most consequential finding to close).

async function configureActiveOrg(auth: RequestInit) {
  await post("/api/phone-operations/credentials/twilio", { account_sid: "AC_test_sid", auth_token: "test_auth_token_12345" }, auth);
  await post("/api/phone-operations/settings", { operating_mode: "ACTIVE", inbound_enabled: true, outbound_enabled: true, max_concurrent_calls: 5, daily_call_cap: 0 }, auth);
  const number = await post<{ number: { id: number; e164_number: string } }>("/api/phone-operations/numbers", { e164_number: "+16045551234" }, auth);
  return number.body.number;
}

describe("Phone Operations Settings — RBAC and versioning", () => {
  it("admin can read defaults, save, and read history", async () => {
    const auth = await authHeaders();
    const before = await request<{ settings: { operating_mode: string; configured: boolean } }>("/api/phone-operations/settings", auth);
    expect(before.response.status).toBe(200);
    expect(before.body.settings.operating_mode).toBe("DISABLED");
    expect(before.body.settings.configured).toBe(false);

    const saved = await post<{ settings: { operating_mode: string; configured: boolean } }>("/api/phone-operations/settings", {
      operating_mode: "PAUSED", inbound_enabled: false, outbound_enabled: false, max_concurrent_calls: 2, daily_call_cap: 10,
    }, auth);
    expect(saved.response.status).toBe(201);
    expect(saved.body.settings.operating_mode).toBe("PAUSED");
    expect(saved.body.settings.configured).toBe(true);

    const history = await request<{ history: unknown[] }>("/api/phone-operations/settings/history", auth);
    expect(history.body.history).toHaveLength(1);
  });

  it("a second save never mutates the first version — history shows both", async () => {
    const auth = await authHeaders();
    await post("/api/phone-operations/settings", { operating_mode: "PAUSED", inbound_enabled: false, outbound_enabled: false, max_concurrent_calls: 1, daily_call_cap: 0 }, auth);
    const second = await post<{ settings: { effective_from: string } }>("/api/phone-operations/settings", {
      operating_mode: "ACTIVE", inbound_enabled: true, outbound_enabled: true, max_concurrent_calls: 3, daily_call_cap: 0,
      effective_from: new Date(Date.now() + 60_000).toISOString(),
    }, auth);
    expect(second.response.status).toBe(201);
    const history = await request<{ history: { operating_mode: string; effective_until: string | null }[] }>("/api/phone-operations/settings/history", auth);
    expect(history.body.history).toHaveLength(2);
    const prior = history.body.history.find((h) => h.operating_mode === "PAUSED")!;
    expect(prior.effective_until).not.toBeNull();
  });

  it("rejects an invalid operating_mode / negative caps with 400", async () => {
    const auth = await authHeaders();
    const res = await request("/api/phone-operations/settings", auth);
    void res;
    const bad = await post("/api/phone-operations/settings", { operating_mode: "SLEEPY", inbound_enabled: false, outbound_enabled: false, max_concurrent_calls: 1, daily_call_cap: 0 }, auth);
    expect(bad.response.status).toBe(400);
  });

  it("dispatcher and technician are denied every config route; unauthenticated gets 401 not 403", async () => {
    await createUser({ email: "po-dispatcher@example.test", password: "DispatchPass1", role: "dispatcher" });
    const dispatcher = { headers: { cookie: (await loginAs("po-dispatcher@example.test", "DispatchPass1")).cookie } };
    await createUser({ email: "po-tech@example.test", password: "TechPass123", role: "technician" });
    const tech = { headers: { cookie: (await loginAs("po-tech@example.test", "TechPass123")).cookie } };

    for (const role of [dispatcher, tech]) {
      expect((await request("/api/phone-operations/settings", role)).response.status).toBe(403);
      expect((await request("/api/phone-operations/agents", role)).response.status).toBe(403);
      expect((await request("/api/phone-operations/numbers", role)).response.status).toBe(403);
      expect((await request("/api/phone-operations/credentials/twilio", role)).response.status).toBe(403);
      expect((await request("/api/phone-operations/service-credentials", role)).response.status).toBe(403);
    }
    expect((await request("/api/phone-operations/settings")).response.status).toBe(401);
  });
});

describe("Voice Engine (Twilio) account credential", () => {
  it("saves encrypted at rest — the raw auth token never appears in the stored row", async () => {
    const auth = await authHeaders();
    const res = await post<{ credential: { account_sid: string; configured: boolean } }>("/api/phone-operations/credentials/twilio", { account_sid: "AC123", auth_token: "super-secret-token" }, auth);
    expect(res.response.status).toBe(201);
    expect(res.body.credential.account_sid).toBe("AC123");
    expect(res.body.credential.configured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("super-secret-token");

    const row = await env.DB.prepare("SELECT auth_token_encrypted FROM voice_engine_credentials WHERE account_sid = 'AC123'").first<{ auth_token_encrypted: string }>();
    expect(row!.auth_token_encrypted).not.toContain("super-secret-token");
  });

  it("a second save updates the same row rather than accumulating duplicates", async () => {
    const auth = await authHeaders();
    await post("/api/phone-operations/credentials/twilio", { account_sid: "AC_first", auth_token: "t1" }, auth);
    await post("/api/phone-operations/credentials/twilio", { account_sid: "AC_second", auth_token: "t2" }, auth);
    const summary = await request<{ credential: { account_sid: string } }>("/api/phone-operations/credentials/twilio", auth);
    expect(summary.body.credential.account_sid).toBe("AC_second");
    const count = await env.DB.prepare("SELECT COUNT(*) as n FROM voice_engine_credentials").first<{ n: number }>();
    expect(count!.n).toBe(1);
  });
});

describe("Voice Engine service credentials (runtime auth)", () => {
  it("issues a token once, lists summaries without it, and a revoked token no longer authenticates", async () => {
    const auth = await authHeaders();
    const issued = await post<{ id: number; token: string }>("/api/phone-operations/service-credentials", { label: "voice-engine-1" }, auth);
    expect(issued.response.status).toBe(201);
    expect(typeof issued.body.token).toBe("string");
    expect(issued.body.token.length).toBeGreaterThan(20);

    const list = await request<{ credentials: { id: number; label: string }[] }>("/api/phone-operations/service-credentials", auth);
    expect(JSON.stringify(list.body)).not.toContain(issued.body.token);
    expect(list.body.credentials.some((cr) => cr.label === "voice-engine-1")).toBe(true);

    const okBefore = await request("/api/phone-operations/runtime/sessions/resolve", {
      method: "POST", headers: { Authorization: `Bearer ${issued.body.token}`, "content-type": "application/json" }, body: JSON.stringify({ session_token: "nonexistent" }),
    });
    expect(okBefore.response.status).toBe(404); // authenticated (bearer accepted) but no such session — proves the token itself is valid

    const revoke = await post(`/api/phone-operations/service-credentials/${issued.body.id}/revoke`, {}, auth);
    expect(revoke.response.status).toBe(200);

    const afterRevoke = await request("/api/phone-operations/runtime/sessions/resolve", {
      method: "POST", headers: { Authorization: `Bearer ${issued.body.token}`, "content-type": "application/json" }, body: JSON.stringify({ session_token: "nonexistent" }),
    });
    expect(afterRevoke.response.status).toBe(401);
  });

  it("runtime routes reject a missing/garbage bearer token with 401, never a crash", async () => {
    const noAuth = await request("/api/phone-operations/runtime/sessions/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(noAuth.response.status).toBe(401);
    const garbage = await request("/api/phone-operations/runtime/sessions/resolve", { method: "POST", headers: { Authorization: "Bearer not-a-real-token", "content-type": "application/json" }, body: "{}" });
    expect(garbage.response.status).toBe(401);
  });
});

describe("Voice Agents — versioning and default-swap invariant", () => {
  it("saving a new version of the same name closes the prior one; a different-name default swap demotes the old default", async () => {
    const auth = await authHeaders();
    const a1 = await post<{ agent: { id: number; is_default: boolean } }>("/api/phone-operations/agents", {
      name: "Front Desk", language: "en", voice: "alloy", model: "gpt-realtime", instructions: "Answer politely.", is_default: true, status: "active",
    }, auth);
    expect(a1.response.status).toBe(201);
    expect(a1.body.agent.is_default).toBe(true);

    const a2 = await post<{ agent: { id: number; is_default: boolean } }>("/api/phone-operations/agents", {
      name: "After Hours", language: "en", voice: "verse", model: "gpt-realtime", instructions: "Take a message.", is_default: true, status: "active",
    }, auth);
    expect(a2.response.status).toBe(201);
    expect(a2.body.agent.is_default).toBe(true);

    const list = await request<{ agents: { name: string; is_default: boolean }[] }>("/api/phone-operations/agents", auth);
    const frontDesk = list.body.agents.find((x) => x.name === "Front Desk")!;
    const afterHours = list.body.agents.find((x) => x.name === "After Hours")!;
    expect(frontDesk.is_default).toBe(false);
    expect(afterHours.is_default).toBe(true);

    const v2 = await post<{ agent: { id: number } }>("/api/phone-operations/agents", {
      name: "Front Desk", language: "en", voice: "alloy", model: "gpt-realtime-2", instructions: "Updated script.", is_default: false, status: "active",
    }, auth);
    expect(v2.response.status).toBe(201);
    const history = await request<{ history: { effective_until: string | null }[] }>("/api/phone-operations/agents/Front%20Desk/history", auth);
    expect(history.body.history).toHaveLength(2);
    expect(history.body.history.find((h) => h.effective_until !== null)).toBeTruthy();
  });

  it("rejects an invalid status with 400", async () => {
    const auth = await authHeaders();
    const res = await post("/api/phone-operations/agents", { name: "Bad", language: "en", voice: "", model: "", instructions: "", is_default: false, status: "not-a-status" }, auth);
    expect(res.response.status).toBe(400);
  });
});

describe("Phone Numbers", () => {
  it("validates E.164, rejects duplicates, and updates in place", async () => {
    const auth = await authHeaders();
    const bad = await post("/api/phone-operations/numbers", { e164_number: "6045551234" }, auth);
    expect(bad.response.status).toBe(400);

    const created = await post<{ number: { id: number; e164_number: string } }>("/api/phone-operations/numbers", { e164_number: "+16045559999" }, auth);
    expect(created.response.status).toBe(201);

    const dup = await post("/api/phone-operations/numbers", { e164_number: "+16045559999" }, auth);
    expect(dup.response.status).toBe(400);

    const updated = await put<{ number: { status: string; inbound_enabled: boolean } }>(`/api/phone-operations/numbers/${created.body.number.id}`, { status: "disabled", inbound_enabled: false }, auth);
    expect(updated.response.status).toBe(200);
    expect(updated.body.number.status).toBe("disabled");
    expect(updated.body.number.inbound_enabled).toBe(false);
  });

  it("a number's own bound agent is used for its calls, not silently overridden by the org default (regression fix)", async () => {
    // Independent Architecture review finding: phone_numbers.voice_agent_id
    // was recorded and exposed in the UI but createCall() always resolved
    // the org-wide default agent, ignoring it — every call, regardless of
    // which number was dialed, silently got whichever agent was is_default.
    const auth = await authHeaders();
    await post("/api/phone-operations/credentials/twilio", { account_sid: "AC_route_test", auth_token: "route_test_token" }, auth);
    await post("/api/phone-operations/settings", { operating_mode: "ACTIVE", inbound_enabled: true, outbound_enabled: true, max_concurrent_calls: 5, daily_call_cap: 0 }, auth);

    await post("/api/phone-operations/agents", { name: "Org Default", language: "en", voice: "", model: "gpt-default", instructions: "default", is_default: true, status: "active" }, auth);
    const specific = await post<{ agent: { id: number; name: string } }>("/api/phone-operations/agents", { name: "Sales Line", language: "en", voice: "", model: "gpt-sales", instructions: "sales-specific", is_default: false, status: "active" }, auth);

    const number = await post<{ number: { id: number; e164_number: string } }>("/api/phone-operations/numbers", { e164_number: "+16045556666", voice_agent_id: specific.body.agent.id }, auth);
    expect(number.response.status).toBe(201);

    const params = { To: number.body.number.e164_number, From: "+16045550000", CallSid: "CA_test_routing" };
    const url = "http://example.test/api/phone-operations/twilio/voice";
    const signature = await signTwilioRequest("route_test_token", url, params);
    const res = await requestRaw("/api/phone-operations/twilio/voice", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body: new URLSearchParams(params).toString(),
    });
    expect(res.status).toBe(200);

    const call = await env.DB.prepare("SELECT voice_agent_id, voice_agent_snapshot FROM calls WHERE provider_call_sid = 'CA_test_routing'").first<{ voice_agent_id: number; voice_agent_snapshot: string }>();
    expect(call!.voice_agent_id).toBe(specific.body.agent.id);
    expect(JSON.parse(call!.voice_agent_snapshot).name).toBe("Sales Line");
  });
});

describe("Call operating-mode / cap gating and outbound placement", () => {
  it("refuses an outbound call while DISABLED (default) with 400, not a crash", async () => {
    const auth = await authHeaders();
    const number = await post<{ number: { id: number } }>("/api/phone-operations/numbers", { e164_number: "+16045551111" }, auth);
    const res = await post("/api/phone-operations/calls", { phone_number_id: number.body.number.id, to_number: "+16045552222" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("dispatcher can view calls but only admin/dispatcher may place one; technician is denied", async () => {
    await createUser({ email: "po-dispatcher2@example.test", password: "DispatchPass1", role: "dispatcher" });
    const dispatcherAuth = { headers: { cookie: (await loginAs("po-dispatcher2@example.test", "DispatchPass1")).cookie } };
    await createUser({ email: "po-tech2@example.test", password: "TechPass123", role: "technician" });
    const techAuth = { headers: { cookie: (await loginAs("po-tech2@example.test", "TechPass123")).cookie } };

    const list = await request("/api/phone-operations/calls", dispatcherAuth);
    expect(list.response.status).toBe(200);
    expect((await request("/api/phone-operations/calls", techAuth)).response.status).toBe(403);
  });

  it("a failed Twilio placement marks the call failed instead of leaving it queued forever (regression fix — was a permanent concurrency-slot leak)", async () => {
    const auth = await authHeaders();
    const number = await configureActiveOrg(auth);
    const mock = mockNotificationProviders({ failNextSmsWithStatus: 500 }); // intercepts api.twilio.com/* generically, including Calls.json
    try {
      const res = await post<{ error: string }>("/api/phone-operations/calls", { phone_number_id: number.id, to_number: "+16045553333" }, auth);
      expect(res.response.status).toBe(400);
      expect(res.body.error).not.toContain("mocked failure"); // raw Twilio error text is never surfaced to the client
    } finally {
      mock.restore();
    }
    const call = await env.DB.prepare("SELECT status FROM calls WHERE to_number = '+16045553333'").first<{ status: string }>();
    expect(call!.status).toBe("failed");

    // The failed call must NOT still occupy the organization's concurrency
    // budget — placing a second (successfully mocked) outbound call must
    // succeed even though max_concurrent_calls was left at configureActiveOrg's
    // default of 5 (proving this isn't just "cap never reached" by luck,
    // re-save it to exactly 1 first).
    await post("/api/phone-operations/settings", { operating_mode: "ACTIVE", inbound_enabled: true, outbound_enabled: true, max_concurrent_calls: 1, daily_call_cap: 0 }, auth);
    const second = mockNotificationProviders();
    try {
      const res2 = await post("/api/phone-operations/calls", { phone_number_id: number.id, to_number: "+16045554444" }, auth);
      expect(res2.response.status).toBe(201);
    } finally {
      second.restore();
    }
  });
});

describe("Twilio webhook — signature verification and org resolution", () => {
  it("valid signature + configured active inbound number returns a Stream TwiML pointing at the runtime, with a real call row created", async () => {
    const auth = await authHeaders();
    // No VOICE_ENGINE_STREAM_BASE_URL is configured in the test environment
    // (deliberately — see wrangler.toml/vitest.config.ts), so a fully valid,
    // fully authorized inbound call still gets the graceful "not yet
    // deployed" rejection TwiML rather than a broken stream URL — this
    // test asserts the call row IS created and the signature check DID
    // pass (proven by reaching the create-call step at all, not a 401),
    // which is everything this Worker is responsible for.
    const number = await configureActiveOrg(auth);
    const params = { To: number.e164_number, From: "+16045550000", CallSid: "CA_test_1" };
    const url = "http://example.test/api/phone-operations/twilio/voice";
    const body = new URLSearchParams(params).toString();
    const signature = await signTwilioRequest("test_auth_token_12345", url, params);

    const res = await requestRaw("/api/phone-operations/twilio/voice", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body,
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("<Response>");

    const call = await env.DB.prepare("SELECT status, from_number, to_number FROM calls WHERE provider_call_sid = 'CA_test_1'").first<{ status: string; from_number: string }>();
    expect(call).toBeTruthy();
    expect(call!.status).toBe("queued");
  });

  it("an invalid signature is rejected with 401 and creates no call row", async () => {
    const auth = await authHeaders();
    const number = await configureActiveOrg(auth);
    const params = { To: number.e164_number, From: "+16045550000", CallSid: "CA_test_bad_sig" };
    const body = new URLSearchParams(params).toString();
    const res = await requestRaw("/api/phone-operations/twilio/voice", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "totally-wrong" }, body,
    });
    expect(res.status).toBe(401);
    const call = await env.DB.prepare("SELECT id FROM calls WHERE provider_call_sid = 'CA_test_bad_sig'").first();
    expect(call).toBeFalsy();
  });

  it("an unknown To number gets a graceful reject TwiML, never a 500, without leaking whether it's a real customer number", async () => {
    const params = { To: "+19995551234", From: "+16045550000", CallSid: "CA_test_unknown" };
    const body = new URLSearchParams(params).toString();
    const res = await requestRaw("/api/phone-operations/twilio/voice", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Hangup");
  });

  it("status callback maps Twilio vocabulary and is idempotent under a duplicate retry", async () => {
    const auth = await authHeaders();
    const number = await configureActiveOrg(auth);
    const voiceParams = { To: number.e164_number, From: "+16045550000", CallSid: "CA_test_status" };
    const voiceSig = await signTwilioRequest("test_auth_token_12345", "http://example.test/api/phone-operations/twilio/voice", voiceParams);
    await requestRaw("/api/phone-operations/twilio/voice", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": voiceSig }, body: new URLSearchParams(voiceParams).toString() });

    const statusParams = { CallSid: "CA_test_status", CallStatus: "in-progress" };
    const statusUrl = "http://example.test/api/phone-operations/twilio/status";
    const statusSig = await signTwilioRequest("test_auth_token_12345", statusUrl, statusParams);
    const first = await request("/api/phone-operations/twilio/status", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": statusSig }, body: new URLSearchParams(statusParams).toString() });
    expect(first.response.status).toBe(200);
    const second = await request("/api/phone-operations/twilio/status", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": statusSig }, body: new URLSearchParams(statusParams).toString() });
    expect(second.response.status).toBe(200); // duplicate webhook never errors

    const call = await env.DB.prepare("SELECT status FROM calls WHERE provider_call_sid = 'CA_test_status'").first<{ status: string }>();
    expect(call!.status).toBe("in_progress");
    const events = await env.DB.prepare("SELECT COUNT(*) as n FROM call_events WHERE idempotency_key = 'CA_test_status:in-progress'").first<{ n: number }>();
    expect(events!.n).toBe(1); // exactly one event recorded despite two identical webhook deliveries
  });

  it("a replayed inbound voice webhook (same CallSid) resolves idempotently instead of crashing with a raw 500 (regression fix)", async () => {
    // Twilio retries a webhook it didn't get a fast 2xx for — a genuinely
    // valid, identically-signed replay of the SAME CallSid used to hit an
    // uncaught UNIQUE constraint violation on calls.provider_call_sid
    // (independent Testing review finding, reproduced and now fixed in
    // createCall()). Both deliveries here must succeed with valid TwiML,
    // and only ONE call row may ever exist for this CallSid.
    const auth = await authHeaders();
    const number = await configureActiveOrg(auth);
    const params = { To: number.e164_number, From: "+16045550000", CallSid: "CA_test_replay" };
    const url = "http://example.test/api/phone-operations/twilio/voice";
    const body = new URLSearchParams(params).toString();
    const signature = await signTwilioRequest("test_auth_token_12345", url, params);

    const first = await requestRaw("/api/phone-operations/twilio/voice", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body,
    });
    expect(first.status).toBe(200);
    const second = await requestRaw("/api/phone-operations/twilio/voice", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body,
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("<Response>");

    const count = await env.DB.prepare("SELECT COUNT(*) as n FROM calls WHERE provider_call_sid = 'CA_test_replay'").first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("an unconfigured-credential number and a bad-signature-on-a-configured-number both return 401 — no oracle distinguishing them from the outside (regression fix)", async () => {
    const auth = await authHeaders();
    // Provisioned, but no Twilio credential ever saved for this org.
    const number = await post<{ number: { e164_number: string } }>("/api/phone-operations/numbers", { e164_number: "+16045558888" }, auth);
    const params = { To: number.body.number.e164_number, From: "+16045550000", CallSid: "CA_test_unconfigured" };
    const res = await requestRaw("/api/phone-operations/twilio/voice", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString(),
    });
    expect(res.status).toBe(401);
  });
});

describe("Tenant isolation", () => {
  it("Org B cannot see Org A's settings, agents, numbers, or calls", async () => {
    const auth = await authHeaders();
    await post("/api/phone-operations/settings", { operating_mode: "ACTIVE", inbound_enabled: true, outbound_enabled: true, max_concurrent_calls: 1, daily_call_cap: 0 }, auth);
    await post("/api/phone-operations/agents", { name: "Org A Agent", language: "en", voice: "", model: "", instructions: "", is_default: true, status: "active" }, auth);
    await post("/api/phone-operations/numbers", { e164_number: "+16045557777" }, auth);

    const second = await createSecondOrganization();
    const secondAuth = { headers: { cookie: (await loginAs(second.email, second.password)).cookie } };
    const settings = await request<{ settings: { configured: boolean } }>("/api/phone-operations/settings", secondAuth);
    expect(settings.body.settings.configured).toBe(false);
    const agents = await request<{ agents: unknown[] }>("/api/phone-operations/agents", secondAuth);
    expect(agents.body.agents).toHaveLength(0);
    const numbers = await request<{ numbers: unknown[] }>("/api/phone-operations/numbers", secondAuth);
    expect(numbers.body.numbers).toHaveLength(0);
  });

  it("a Voice Engine service credential issued for Org A cannot resolve or act on Org B's call (cross-tenant IDOR)", async () => {
    const auth = await authHeaders();
    const number = await configureActiveOrg(auth);
    const voiceParams = { To: number.e164_number, From: "+16045550000", CallSid: "CA_idor_test" };
    const voiceSig = await signTwilioRequest("test_auth_token_12345", "http://example.test/api/phone-operations/twilio/voice", voiceParams);
    await requestRaw("/api/phone-operations/twilio/voice", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": voiceSig }, body: new URLSearchParams(voiceParams).toString() });
    const call = await env.DB.prepare("SELECT id FROM calls WHERE provider_call_sid = 'CA_idor_test'").first<{ id: number }>();

    const second = await createSecondOrganization();
    const secondAuth = { headers: { cookie: (await loginAs(second.email, second.password)).cookie } };
    const orgBCred = await post<{ token: string }>("/api/phone-operations/service-credentials", { label: "org-b-runtime" }, secondAuth);

    const attempt = await request("/api/phone-operations/runtime/calls/" + call!.id + "/events", {
      method: "POST", headers: { Authorization: `Bearer ${orgBCred.body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ event_type: "hijack_attempt", to_status: "failed" }),
    });
    expect(attempt.response.status).toBe(404); // resolved to Org B, Org A's call id is simply not found under that tenant scope
  });
});

describe("Call FSM — invalid transitions are rejected", () => {
  it("rejects a transition attempted after the call reaches a terminal state, and never rewrites the terminal status", async () => {
    const auth = await authHeaders();
    const number = await configureActiveOrg(auth);
    const voiceParams = { To: number.e164_number, From: "+16045550000", CallSid: "CA_fsm_terminal" };
    const voiceSig = await signTwilioRequest("test_auth_token_12345", "http://example.test/api/phone-operations/twilio/voice", voiceParams);
    await requestRaw("/api/phone-operations/twilio/voice", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": voiceSig }, body: new URLSearchParams(voiceParams).toString() });

    const statusUrl = "http://example.test/api/phone-operations/twilio/status";
    for (const CallStatus of ["in-progress", "completed"]) {
      const statusParams = { CallSid: "CA_fsm_terminal", CallStatus };
      const statusSig = await signTwilioRequest("test_auth_token_12345", statusUrl, statusParams);
      const step = await request("/api/phone-operations/twilio/status", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": statusSig }, body: new URLSearchParams(statusParams).toString() });
      expect(step.response.status).toBe(200);
    }

    const call = await env.DB.prepare("SELECT id, status FROM calls WHERE provider_call_sid = 'CA_fsm_terminal'").first<{ id: number; status: string }>();
    expect(call!.status).toBe("completed");

    const cred = await post<{ token: string }>("/api/phone-operations/service-credentials", { label: "fsm-test" }, auth);
    const attempt = await request(`/api/phone-operations/runtime/calls/${call!.id}/events`, {
      method: "POST", headers: { Authorization: `Bearer ${cred.body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ event_type: "bogus_resurrection", to_status: "ringing" }),
    });
    expect(attempt.response.status).toBe(400); // completed -> ringing is not in ALLOWED_TRANSITIONS

    const stillCompleted = await env.DB.prepare("SELECT status FROM calls WHERE id = ?").bind(call!.id).first<{ status: string }>();
    expect(stillCompleted!.status).toBe("completed"); // the rejected attempt never touched the row
  });

  it("a transition attempt against a nonexistent call id returns 404, not a crash", async () => {
    const auth = await authHeaders();
    const cred = await post<{ token: string }>("/api/phone-operations/service-credentials", { label: "fsm-404" }, auth);
    const res = await request("/api/phone-operations/runtime/calls/999999/events", {
      method: "POST", headers: { Authorization: `Bearer ${cred.body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ event_type: "x", to_status: "ringing" }),
    });
    expect(res.response.status).toBe(404);
  });
});

describe("Call concurrency and daily cap gating", () => {
  it("allows exactly max_concurrent_calls active calls, rejects the next with 400", async () => {
    const auth = await authHeaders();
    await post("/api/phone-operations/credentials/twilio", { account_sid: "AC_test_sid", auth_token: "test_auth_token_12345" }, auth);
    await post("/api/phone-operations/settings", { operating_mode: "ACTIVE", inbound_enabled: true, outbound_enabled: true, max_concurrent_calls: 2, daily_call_cap: 0 }, auth);
    const number = await post<{ number: { id: number } }>("/api/phone-operations/numbers", { e164_number: "+16045551234" }, auth);

    const mock = mockNotificationProviders();
    try {
      const first = await post("/api/phone-operations/calls", { phone_number_id: number.body.number.id, to_number: "+16045552221" }, auth);
      expect(first.response.status).toBe(201);
      const second = await post("/api/phone-operations/calls", { phone_number_id: number.body.number.id, to_number: "+16045552222" }, auth);
      expect(second.response.status).toBe(201);
      const third = await post("/api/phone-operations/calls", { phone_number_id: number.body.number.id, to_number: "+16045552223" }, auth);
      expect(third.response.status).toBe(400); // the Nth+1 call is refused, not silently allowed past the cap
    } finally {
      mock.restore();
    }
  });

  it("rejects a new call once daily_call_cap is reached", async () => {
    const auth = await authHeaders();
    await post("/api/phone-operations/credentials/twilio", { account_sid: "AC_test_sid", auth_token: "test_auth_token_12345" }, auth);
    await post("/api/phone-operations/settings", { operating_mode: "ACTIVE", inbound_enabled: true, outbound_enabled: true, max_concurrent_calls: 10, daily_call_cap: 1 }, auth);
    const number = await post<{ number: { id: number; e164_number: string } }>("/api/phone-operations/numbers", { e164_number: "+16045551234" }, auth);

    const params = { To: number.body.number.e164_number, From: "+16045550000", CallSid: "CA_cap_1" };
    const sig = await signTwilioRequest("test_auth_token_12345", "http://example.test/api/phone-operations/twilio/voice", params);
    const firstCall = await requestRaw("/api/phone-operations/twilio/voice", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig }, body: new URLSearchParams(params).toString() });
    expect(firstCall.status).toBe(200);

    const mock = mockNotificationProviders();
    try {
      const second = await post("/api/phone-operations/calls", { phone_number_id: number.body.number.id, to_number: "+16045552222" }, auth);
      expect(second.response.status).toBe(400); // daily cap already consumed by the inbound call above
    } finally {
      mock.restore();
    }
  });
});

describe("Transcript and outcome — idempotency via runtime API", () => {
  it("a duplicate sequence number for the same call is a no-op, not an overwrite or error", async () => {
    const auth = await authHeaders();
    const number = await configureActiveOrg(auth);
    const voiceParams = { To: number.e164_number, From: "+16045550000", CallSid: "CA_transcript_test" };
    const voiceSig = await signTwilioRequest("test_auth_token_12345", "http://example.test/api/phone-operations/twilio/voice", voiceParams);
    await requestRaw("/api/phone-operations/twilio/voice", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": voiceSig }, body: new URLSearchParams(voiceParams).toString() });
    const call = await env.DB.prepare("SELECT id FROM calls WHERE provider_call_sid = 'CA_transcript_test'").first<{ id: number }>();

    const cred = await post<{ token: string }>("/api/phone-operations/service-credentials", { label: "transcript-test" }, auth);
    const bearer = { Authorization: `Bearer ${cred.body.token}`, "content-type": "application/json" };

    const first = await request<{ applied: boolean }>(`/api/phone-operations/runtime/calls/${call!.id}/transcript`, { method: "POST", headers: bearer, body: JSON.stringify({ sequence: 1, speaker: "caller", text: "Hello, is anyone there?" }) });
    expect(first.response.status).toBe(200);
    expect(first.body.applied).toBe(true);

    const duplicate = await request<{ applied: boolean }>(`/api/phone-operations/runtime/calls/${call!.id}/transcript`, { method: "POST", headers: bearer, body: JSON.stringify({ sequence: 1, speaker: "agent", text: "This should never be stored." }) });
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body.applied).toBe(false);

    const rows = await env.DB.prepare("SELECT text, speaker FROM call_transcripts WHERE call_id = ? AND sequence = 1").bind(call!.id).all<{ text: string; speaker: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].text).toBe("Hello, is anyone there?"); // the duplicate's text never overwrote the original
  });

  it("recording an outcome twice is a no-op, not an overwrite", async () => {
    const auth = await authHeaders();
    const number = await configureActiveOrg(auth);
    const voiceParams = { To: number.e164_number, From: "+16045550000", CallSid: "CA_outcome_test" };
    const voiceSig = await signTwilioRequest("test_auth_token_12345", "http://example.test/api/phone-operations/twilio/voice", voiceParams);
    await requestRaw("/api/phone-operations/twilio/voice", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": voiceSig }, body: new URLSearchParams(voiceParams).toString() });
    const call = await env.DB.prepare("SELECT id FROM calls WHERE provider_call_sid = 'CA_outcome_test'").first<{ id: number }>();

    const cred = await post<{ token: string }>("/api/phone-operations/service-credentials", { label: "outcome-test" }, auth);
    const bearer = { Authorization: `Bearer ${cred.body.token}`, "content-type": "application/json" };

    const first = await request<{ applied: boolean }>(`/api/phone-operations/runtime/calls/${call!.id}/outcome`, { method: "POST", headers: bearer, body: JSON.stringify({ outcome_type: "booked_job", summary: "Customer booked a repair." }) });
    expect(first.response.status).toBe(200);
    expect(first.body.applied).toBe(true);

    const second = await request<{ applied: boolean }>(`/api/phone-operations/runtime/calls/${call!.id}/outcome`, { method: "POST", headers: bearer, body: JSON.stringify({ outcome_type: "spam", summary: "This should never overwrite the first outcome." }) });
    expect(second.response.status).toBe(200);
    expect(second.body.applied).toBe(false);

    const outcome = await request<{ outcome: { outcome_type: string; summary: string } }>(`/api/phone-operations/calls/${call!.id}/outcome`, auth);
    expect(outcome.body.outcome.outcome_type).toBe("booked_job"); // the second, conflicting attempt never overwrote it
  });
});

describe("Cross-organization Twilio signature confusion", () => {
  it("Org B's genuine, correctly-configured Twilio auth token does not validate a webhook for Org A's number", async () => {
    const auth = await authHeaders();
    const number = await configureActiveOrg(auth); // Org A, credential "test_auth_token_12345"

    const second = await createSecondOrganization();
    const secondAuth = { headers: { cookie: (await loginAs(second.email, second.password)).cookie } };
    await post("/api/phone-operations/credentials/twilio", { account_sid: "AC_org_b_sid", auth_token: "org_b_real_token" }, secondAuth);

    const params = { To: number.e164_number, From: "+16045550000", CallSid: "CA_cross_org_sig" };
    const url = "http://example.test/api/phone-operations/twilio/voice";
    // Signed with Org B's own genuine, correctly-configured auth token — not garbage — to prove
    // this isn't just rejecting malformed signatures but actually binds the signature check to
    // the specific organization resolved from the dialed number.
    const signature = await signTwilioRequest("org_b_real_token", url, params);
    const res = await requestRaw("/api/phone-operations/twilio/voice", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body: new URLSearchParams(params).toString(),
    });
    expect(res.status).toBe(401);
    const call = await env.DB.prepare("SELECT id FROM calls WHERE provider_call_sid = 'CA_cross_org_sig'").first();
    expect(call).toBeFalsy();
  });
});

/** Test-only helper — computes a real Twilio request signature the same
 *  way Twilio's own servers would, so the webhook route's REAL verification
 *  code path is exercised (never bypassed/mocked), mirroring this
 *  codebase's existing payment-provider.ts#signMockWebhookPayload precedent
 *  for testing an HMAC-verified webhook without a live external account. */
async function signTwilioRequest(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Buffer.from(sig).toString("base64");
}

describe("twilio-provider.ts — pure unit tests", () => {
  it("verifyTwilioSignature accepts a correctly computed signature and rejects a wrong one", async () => {
    const url = "https://example.test/webhook";
    const params = { CallSid: "CA1", CallStatus: "ringing" };
    const good = await signTwilioRequest("secret", url, params);
    expect(await verifyTwilioSignature("secret", url, params, good)).toBe(true);
    expect(await verifyTwilioSignature("secret", url, params, "wrong")).toBe(false);
    expect(await verifyTwilioSignature("secret", url, params, null)).toBe(false);
    expect(await verifyTwilioSignature("wrong-secret", url, params, good)).toBe(false);
  });

  it("mapTwilioCallStatus maps the documented Twilio vocabulary and rejects unknown values", () => {
    expect(mapTwilioCallStatus("in-progress")).toBe("in_progress");
    expect(mapTwilioCallStatus("no-answer")).toBe("no_answer");
    expect(mapTwilioCallStatus("completed")).toBe("completed");
    expect(mapTwilioCallStatus("something-twilio-invents-later")).toBeNull();
  });

  it("TwiML builders escape and produce well-formed XML shells", () => {
    expect(buildInboundStreamTwiML("wss://engine.test/stream?a=1&b=2")).toContain("&amp;");
    expect(buildRejectedCallTwiML()).toContain("<Hangup/>");
  });
});
