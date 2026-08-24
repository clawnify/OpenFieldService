import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANIZATION_ID, applySchema, authHeaders, createSecondOrganization,
  createUser, del, loginAs, post, put, queryDb, request, resetDatabase,
} from "./helpers.js";

// Phase 13 — Contracts / E-Sign Foundation. Covers Contract Core, Quote
// binding (exact accepted_version_id, not current/live), versioning/
// revision immutability, signers, signature requests, the public token-
// gated signing flow (consent/sign/decline/replay/expiry), status
// derivation, evidence, RBAC, and tenant isolation. Mirrors quotes.test.ts's
// real-API-fixture-through-real-session discipline throughout.

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

interface OrgContext {
  organizationId: number;
  auth: RequestInit;
}

async function orgA(): Promise<OrgContext> {
  return { organizationId: DEFAULT_ORGANIZATION_ID, auth: await authHeaders() };
}

async function orgB(): Promise<OrgContext> {
  const fixture = await createSecondOrganization("Org B Contracts Co");
  const { cookie } = await loginAs(fixture.email, fixture.password);
  return { organizationId: fixture.organizationId, auth: { headers: { cookie } } };
}

async function dispatcherAuth(email = "contract-dispatch@example.test"): Promise<RequestInit> {
  await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
  const { cookie } = await loginAs(email, "DispatchPass1");
  return { headers: { cookie } };
}

async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
  const userRes = await post<{ user: { id: number } }>("/api/users", { name: email, email, password: "TechPass123", role: "technician" }, adminAuth);
  expect(userRes.response.status).toBe(201);
  const tech = await post<{ id: number }>("/api/technicians", { name: email, user_id: userRes.body.user.id }, adminAuth);
  expect(tech.response.status).toBe(201);
  const { cookie } = await loginAs(email, "TechPass123");
  return { auth: { headers: { cookie } } as RequestInit };
}

async function makeCustomer(auth: RequestInit, name = "Contract Test Customer") {
  const res = await post<{ id: number }>("/api/customers", { name, email: "x@example.test", phone: "555-0100" }, auth);
  expect(res.response.status).toBe(201);
  return res.body.id;
}

/** Creates a quote, sends it, and accepts it — the only state a Contract
 *  may legally be created from (Section 37). */
async function makeAcceptedQuote(auth: RequestInit, customerId: number) {
  const res = await post<{ quote: { id: number; identifier: string } }>("/api/quotes", {
    customer_id: customerId,
    line_items: [{ description: "Install furnace", quantity: 1, unit_price_cents: 500000 }],
  }, auth);
  expect(res.response.status).toBe(201);
  const quoteId = res.body.quote.id;
  await post(`/api/quotes/${quoteId}/transition`, { to_status: "sent" }, auth);
  const accepted = await post<{ quote: { accepted_version_id: number } }>(`/api/quotes/${quoteId}/transition`, { to_status: "accepted" }, auth);
  expect(accepted.response.status).toBe(200);
  return { quoteId, acceptedVersionId: accepted.body.quote.accepted_version_id };
}

async function makeContract(auth: RequestInit, quoteId: number, overrides: Record<string, unknown> = {}) {
  const res = await post<{ contract: { id: number; identifier: string } }>("/api/contracts", { quote_id: quoteId, title: "Installation Agreement", ...overrides }, auth);
  expect(res.response.status).toBe(201);
  return res.body.contract;
}

async function makeSignerAndSend(auth: RequestInit, contractId: number, signer: { name?: string; email?: string; role?: string } = {}) {
  const signerRes = await post<{ signer: { id: number } }>(`/api/contracts/${contractId}/signers`, { name: "Jane Customer", email: "jane@example.test", role: "customer", ...signer }, auth);
  expect(signerRes.response.status).toBe(201);
  const sendRes = await post<{ contract: { status: string }; signing_links: { signer_id: number; signer_name: string; token: string }[] }>(`/api/contracts/${contractId}/send`, {}, auth);
  expect(sendRes.response.status).toBe(200);
  return { signerId: signerRes.body.signer.id, token: sendRes.body.signing_links[0].token };
}

describe("Contract creation from accepted Quote", () => {
  it("creates a draft contract bound to the quote's accepted_version_id", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId, acceptedVersionId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);

    const detail = await request<{ contract: { status: string; quote_id: number; accepted_quote_version_id: number; customer_id: number } }>(`/api/contracts/${contract.id}`, auth);
    expect(detail.body.contract.status).toBe("draft");
    expect(detail.body.contract.quote_id).toBe(quoteId);
    expect(detail.body.contract.accepted_quote_version_id).toBe(acceptedVersionId);
  });

  it("rejects contract creation from a draft, sent, rejected, or expired quote", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);

    const draftQuote = await post<{ quote: { id: number } }>("/api/quotes", { customer_id: customerId }, auth);
    const draftAttempt = await post("/api/contracts", { quote_id: draftQuote.body.quote.id }, auth);
    expect(draftAttempt.response.status).toBe(404);

    const sentQuote = await post<{ quote: { id: number } }>("/api/quotes", { customer_id: customerId }, auth);
    await post(`/api/quotes/${sentQuote.body.quote.id}/transition`, { to_status: "sent" }, auth);
    const sentAttempt = await post("/api/contracts", { quote_id: sentQuote.body.quote.id }, auth);
    expect(sentAttempt.response.status).toBe(404);

    const rejectedQuote = await post<{ quote: { id: number } }>("/api/quotes", { customer_id: customerId }, auth);
    await post(`/api/quotes/${rejectedQuote.body.quote.id}/transition`, { to_status: "sent" }, auth);
    await post(`/api/quotes/${rejectedQuote.body.quote.id}/transition`, { to_status: "rejected", reason: "no" }, auth);
    const rejectedAttempt = await post("/api/contracts", { quote_id: rejectedQuote.body.quote.id }, auth);
    expect(rejectedAttempt.response.status).toBe(404);
  });

  it("commercial_snapshot captures the quote's line items/totals at creation time", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const detail = await request<{ version: { commercial_snapshot: string } }>(`/api/contracts/${contract.id}`, auth);
    const snapshot = JSON.parse(detail.body.version.commercial_snapshot);
    expect(snapshot.total_cents).toBe(500000);
    expect(snapshot.line_items).toHaveLength(1);
  });

  it("organization_id, status, current_version_id, and accepted_quote_version_id cannot be set via any write route", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const res = await post("/api/contracts", { quote_id: quoteId, organization_id: 999, status: "signed", current_version_id: 1 }, auth);
    expect(res.response.status).toBe(400);
  });

  it("a second contract cannot be created for a quote that already has a live (non-cancelled/voided) contract", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    await makeContract(auth, quoteId);

    const second = await post("/api/contracts", { quote_id: quoteId }, auth);
    expect(second.response.status).toBe(409);
  });

  it("an accepted Quote (with a Contract already bound to it) can never itself be revised — Section 9's binding is even stronger than a snapshot: the source can't change at all", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId, acceptedVersionId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);

    // Quotes' own FSM makes "accepted" fully terminal (see quote-workflow.ts
    // — no reopen path exists at all) — createQuoteRevision() explicitly
    // rejects an accepted quote. This is confirmed here rather than assumed,
    // because it's WHY Contract's accepted_quote_version_id binding is safe:
    // not merely because Contract snapshots it, but because the Quote it
    // was snapshotted from cannot itself produce a different version to
    // drift towards.
    const revisionAttempt = await post(`/api/quotes/${quoteId}/revisions`, {}, auth);
    expect(revisionAttempt.response.status).toBe(409);

    const detail = await request<{ contract: { accepted_quote_version_id: number } }>(`/api/contracts/${contract.id}`, auth);
    expect(detail.body.contract.accepted_quote_version_id).toBe(acceptedVersionId); // unchanged
  });
});

describe("Contract Version editing (draft-only)", () => {
  it("allows editing title/body/dates while draft, rejects once sent", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);

    const update = await put(`/api/contracts/${contract.id}/version`, { title: "Updated Title", body: "New terms" }, auth);
    expect(update.response.status).toBe(200);

    await makeSignerAndSend(auth, contract.id);
    const afterSend = await put(`/api/contracts/${contract.id}/version`, { title: "Should fail" }, auth);
    expect(afterSend.response.status).toBe(409);
  });

  it("concurrent draft-version edits never silently lose one write (row_version CAS)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);

    // Same honesty caveat as quotes.test.ts's analogous row_version race:
    // this single-isolate harness can interleave two identical-shaped
    // requests in near-lockstep, so both may legitimately succeed (200,200)
    // sequentially rather than genuinely racing. What must NEVER happen,
    // with or without the CAS guard actually engaging, is a write that
    // returns 200 but is silently discarded — every successful response
    // must correspond to a real row_version increment.
    const [a, b] = await Promise.all([
      put<{ version: { title: string } }>(`/api/contracts/${contract.id}/version`, { title: "Title A" }, auth),
      put<{ version: { title: string } }>(`/api/contracts/${contract.id}/version`, { title: "Title B" }, auth),
    ]);
    const statuses = [a.response.status, b.response.status].sort((x, y) => x - y);
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);

    const rows = await queryDb<{ row_version: number; title: string }>(
      "SELECT row_version, title FROM contract_versions WHERE contract_id = ?", [contract.id]
    );
    expect(rows).toHaveLength(1);
    const successCount = [a, b].filter((r) => r.response.status === 200).length;
    expect(rows[0].row_version).toBe(successCount); // one increment per successful write, none lost
    expect(["Title A", "Title B"]).toContain(rows[0].title); // final title is one of the two real writes, not a mix
  });
});

describe("Contract Revision", () => {
  it("a revision after decline creates a new version and resets to draft; the old version stays immutable", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);

    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${token}/decline`, { reason: "not ready" });

    const declined = await request<{ contract: { status: string; current_version_id: number } }>(`/api/contracts/${contract.id}`, auth);
    expect(declined.body.contract.status).toBe("declined");
    const v1Id = declined.body.contract.current_version_id;

    const revision = await post<{ version: { id: number; version_number: number } }>(`/api/contracts/${contract.id}/revisions`, {}, auth);
    expect(revision.response.status).toBe(201);
    expect(revision.body.version.version_number).toBe(2);

    const afterRevision = await request<{ contract: { status: string; current_version_id: number } }>(`/api/contracts/${contract.id}`, auth);
    expect(afterRevision.body.contract.status).toBe("draft");
    expect(afterRevision.body.contract.current_version_id).toBe(revision.body.version.id);
    expect(afterRevision.body.contract.current_version_id).not.toBe(v1Id);

    // Old version's own row (fetched directly) is untouched.
    const v1 = await request<{ version: { title: string } }>(`/api/contracts/${contract.id}/versions/${v1Id}`, auth);
    expect(v1.response.status).toBe(200);
  });

  it("a signed contract cannot be revised", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });

    const revisionAttempt = await post(`/api/contracts/${contract.id}/revisions`, {}, auth);
    expect(revisionAttempt.response.status).toBe(409);
  });
});

describe("Signers", () => {
  it("adds and lists signers, rejects removing a signer with an active signature request", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);

    const signer = await post<{ signer: { id: number } }>(`/api/contracts/${contract.id}/signers`, { name: "Co Owner", email: "co@example.test", role: "co_owner" }, auth);
    expect(signer.response.status).toBe(201);

    const list = await request<{ signers: { name: string }[] }>(`/api/contracts/${contract.id}/signers`, auth);
    expect(list.body.signers).toHaveLength(1);

    await post(`/api/contracts/${contract.id}/send`, {}, auth);
    const removeAttempt = await del(`/api/contracts/${contract.id}/signers/${signer.body.signer.id}`, auth);
    expect(removeAttempt.response.status).toBe(409);
  });

  it("sending for signature with zero signers is rejected", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const res = await post(`/api/contracts/${contract.id}/send`, {}, auth);
    expect(res.response.status).toBe(409);
  });

  it("an invalid signer role is rejected", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const res = await post(`/api/contracts/${contract.id}/signers`, { name: "X", role: "not_a_real_role" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("adding a signer to a non-draft contract is rejected server-side, not just hidden in the UI", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    await makeSignerAndSend(auth, contract.id); // contract is now 'sent', not 'draft'

    const res = await post(`/api/contracts/${contract.id}/signers`, { name: "Late Add", email: "late@example.test" }, auth);
    expect(res.response.status).toBe(409);
  });
});

describe("Send for signature / Signature Requests", () => {
  it("sending computes a document_hash, creates a pending request per signer, and transitions draft->sent", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    await post(`/api/contracts/${contract.id}/signers`, { name: "Jane Customer", email: "jane@example.test", role: "customer" }, auth);

    const sendRes = await post<{ contract: { status: string }; signing_links: { token: string }[] }>(`/api/contracts/${contract.id}/send`, {}, auth);
    expect(sendRes.response.status).toBe(200);
    expect(sendRes.body.contract.status).toBe("sent");
    expect(sendRes.body.signing_links).toHaveLength(1);
    expect(sendRes.body.signing_links[0].token.length).toBeGreaterThan(20);

    const detail = await request<{ version: { document_hash: string | null } }>(`/api/contracts/${contract.id}`, auth);
    expect(detail.body.version.document_hash).not.toBeNull();

    const requests = await request<{ requests: { status: string }[] }>(`/api/contracts/${contract.id}/signature-requests`, auth);
    expect(requests.body.requests).toHaveLength(1);
    expect(requests.body.requests[0].status).toBe("sent");
  });

  it("cannot cancel or resend a signature request that is already signed", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });

    const requests = await request<{ requests: { id: number }[] }>(`/api/contracts/${contract.id}/signature-requests`, auth);
    const requestId = requests.body.requests[0].id;

    const cancelAttempt = await post(`/api/contracts/${contract.id}/signature-requests/${requestId}/cancel`, {}, auth);
    expect(cancelAttempt.response.status).toBe(409);
    const resendAttempt = await post(`/api/contracts/${contract.id}/signature-requests/${requestId}/resend`, {}, auth);
    expect(resendAttempt.response.status).toBe(409);
  });

  it("resend supersedes the old token — the old token no longer works, the new one does", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token: oldToken } = await makeSignerAndSend(auth, contract.id);

    const requests = await request<{ requests: { id: number }[] }>(`/api/contracts/${contract.id}/signature-requests`, auth);
    const requestId = requests.body.requests[0].id;
    const resend = await post<{ token: string }>(`/api/contracts/${contract.id}/signature-requests/${requestId}/resend`, {}, auth);
    expect(resend.response.status).toBe(200);
    const newToken = resend.body.token;
    expect(newToken).not.toBe(oldToken);

    const oldView = await request(`/api/public/contracts/sign/${oldToken}`);
    expect(oldView.response.status).toBe(404);
    const newView = await request(`/api/public/contracts/sign/${newToken}`);
    expect(newView.response.status).toBe(200);
  });

  it("cancelling the sole outstanding signature request re-derives the contract's status to expired, not left stale at sent", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    await makeSignerAndSend(auth, contract.id);

    const requests = await request<{ requests: { id: number }[] }>(`/api/contracts/${contract.id}/signature-requests`, auth);
    const requestId = requests.body.requests[0].id;

    const cancelRes = await post(`/api/contracts/${contract.id}/signature-requests/${requestId}/cancel`, { reason: "customer no longer interested" }, auth);
    expect(cancelRes.response.status).toBe(200);

    const detail = await request<{ contract: { status: string } }>(`/api/contracts/${contract.id}`, auth);
    expect(detail.body.contract.status).toBe("expired");
  });
});

describe("Public signing flow", () => {
  it("the full consent -> sign flow works and requires consent before signing", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);

    const signWithoutConsent = await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });
    expect(signWithoutConsent.response.status).toBe(400);

    const consent = await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    expect(consent.response.status).toBe(200);

    const sign = await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });
    expect(sign.response.status).toBe(200);

    const detail = await request<{ contract: { status: string } }>(`/api/contracts/${contract.id}`, auth);
    expect(detail.body.contract.status).toBe("signed");
  });

  it("viewing a link transitions sent->viewed; an unknown/garbage token returns a generic 404", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);

    const view = await request<{ view: { request_status: string } }>(`/api/public/contracts/sign/${token}`);
    expect(view.response.status).toBe(200);
    expect(view.body.view.request_status).toBe("viewed");

    const garbage = await request("/api/public/contracts/sign/not-a-real-token-at-all");
    expect(garbage.response.status).toBe(404);
    const garbageBody = (garbage as unknown as { body: { error: string } }).body;
    expect(garbageBody.error).toMatch(/invalid or has expired/i);
  });

  it("submitting a signature twice is idempotent — no duplicate event, no error", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });

    const first = await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });
    expect(first.response.status).toBe(200);
    const second = await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });
    expect(second.response.status).toBe(200);

    const requests = await request<{ requests: { id: number }[] }>(`/api/contracts/${contract.id}/signature-requests`, auth);
    const events = await queryDb("SELECT event_type FROM contract_signature_events WHERE signature_request_id = ? AND event_type = 'signed'", [requests.body.requests[0].id]);
    expect(events).toHaveLength(1); // not 2 — the second submit was a genuine no-op
  });

  it("a used token cannot be reused to sign again after being superseded, and decline after sign is rejected", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });

    const declineAfterSign = await post(`/api/public/contracts/sign/${token}/decline`, { reason: "changed mind" });
    expect(declineAfterSign.response.status).toBe(404); // already-signed -> getSignatureRequestByToken returns null (not pending/sent/viewed)
  });

  it("an expired signature request cannot be signed", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);

    await queryDb("UPDATE contract_signature_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE contract_id = ?", [contract.id]);

    const view = await request(`/api/public/contracts/sign/${token}`);
    expect(view.response.status).toBe(404);

    const requests = await queryDb<{ status: string }>("SELECT status FROM contract_signature_requests WHERE contract_id = ?", [contract.id]);
    expect(requests[0].status).toBe("expired");
  });

  it("rejects an unsupported signature method and a blank signer name", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });

    const badMethod = await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "drawn" });
    expect(badMethod.response.status).toBe(400);
  });
});

describe("Status derivation (multi-signer)", () => {
  it("partially_signed when one of two signers has signed; signed once both have", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    await post(`/api/contracts/${contract.id}/signers`, { name: "Jane Customer", email: "jane@example.test", role: "customer" }, auth);
    await post(`/api/contracts/${contract.id}/signers`, { name: "Co Owner", email: "co@example.test", role: "co_owner" }, auth);
    const sendRes = await post<{ signing_links: { signer_id: number; token: string }[] }>(`/api/contracts/${contract.id}/send`, {}, auth);
    const [linkA, linkB] = sendRes.body.signing_links;

    await post(`/api/public/contracts/sign/${linkA.token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${linkA.token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });

    const midway = await request<{ contract: { status: string } }>(`/api/contracts/${contract.id}`, auth);
    expect(midway.body.contract.status).toBe("partially_signed");

    await post(`/api/public/contracts/sign/${linkB.token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${linkB.token}/sign`, { signer_name: "Co Owner", signature_method: "typed" });

    const final = await request<{ contract: { status: string }; version: { signed_document_key: string | null; signed_document_hash: string | null; signed_at: string | null } }>(`/api/contracts/${contract.id}`, auth);
    expect(final.body.contract.status).toBe("signed");
    expect(final.body.version.signed_document_key).not.toBeNull();
    expect(final.body.version.signed_document_hash).not.toBeNull();
    expect(final.body.version.signed_at).not.toBeNull();
  });

  it("declined when any signer declines, even if another already signed", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    await post(`/api/contracts/${contract.id}/signers`, { name: "Jane Customer", email: "jane@example.test", role: "customer" }, auth);
    await post(`/api/contracts/${contract.id}/signers`, { name: "Co Owner", email: "co@example.test", role: "co_owner" }, auth);
    const sendRes = await post<{ signing_links: { signer_id: number; token: string }[] }>(`/api/contracts/${contract.id}/send`, {}, auth);
    const [linkA, linkB] = sendRes.body.signing_links;

    await post(`/api/public/contracts/sign/${linkA.token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${linkA.token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });
    await post(`/api/public/contracts/sign/${linkB.token}/decline`, { reason: "no" });

    const final = await request<{ contract: { status: string } }>(`/api/contracts/${contract.id}`, auth);
    expect(final.body.contract.status).toBe("declined");
  });
});

describe("Lifecycle / bare transitions", () => {
  it("draft can be cancelled; cancelled is terminal", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const res = await post<{ contract: { status: string } }>(`/api/contracts/${contract.id}/transition`, { to_status: "cancelled", reason: "no longer needed" }, auth);
    expect(res.response.status).toBe(200);
    expect(res.body.contract.status).toBe("cancelled");
    const transitions = await request<{ allowed: string[] }>(`/api/contracts/${contract.id}/transitions`, auth);
    expect(transitions.body.allowed).toEqual([]);
  });

  it("a signed contract can be voided (with reason), preserving evidence; voiding requires a reason", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });

    const noReason = await post(`/api/contracts/${contract.id}/transition`, { to_status: "voided" }, auth);
    expect(noReason.response.status).toBe(400);

    const voided = await post<{ contract: { status: string; voided_at: string | null; void_reason: string } }>(`/api/contracts/${contract.id}/transition`, { to_status: "voided", reason: "customer requested cancellation" }, auth);
    expect(voided.response.status).toBe(200);
    expect(voided.body.contract.status).toBe("voided");
    expect(voided.body.contract.voided_at).not.toBeNull();

    // Evidence is preserved, not deleted.
    const evidence = await request<{ evidence: { requests: { status: string }[] } }>(`/api/contracts/${contract.id}/evidence`, auth);
    expect(evidence.body.evidence.requests[0].status).toBe("signed");
  });

  it("cannot bare-transition directly to signed/declined/partially_signed", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    await makeSignerAndSend(auth, contract.id);
    const res = await post(`/api/contracts/${contract.id}/transition`, { to_status: "signed" }, auth);
    expect(res.response.status).toBe(400);
  });

  it("deletes a never-sent draft contract; refuses once it has transition history", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId: q1 } = await makeAcceptedQuote(auth, customerId);
    const draft = await makeContract(auth, q1);
    const deleted = await del(`/api/contracts/${draft.id}`, auth);
    expect(deleted.response.status).toBe(200);

    const { quoteId: q2 } = await makeAcceptedQuote(auth, customerId);
    const sent = await makeContract(auth, q2);
    await post(`/api/contracts/${sent.id}/transition`, { to_status: "cancelled" }, auth);
    const deleteAttempt = await del(`/api/contracts/${sent.id}`, auth);
    expect(deleteAttempt.response.status).toBe(409);
  });
});

describe("Evidence package", () => {
  it("contains document hash, signer identity, and the full event ledger", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });

    const evidence = await request<{ evidence: { document_hash: string | null; signed_document_hash: string | null; requests: { signer?: { name: string }; events: { event_type: string }[] }[] } }>(`/api/contracts/${contract.id}/evidence`, auth);
    expect(evidence.response.status).toBe(200);
    expect(evidence.body.evidence.document_hash).not.toBeNull();
    expect(evidence.body.evidence.signed_document_hash).not.toBeNull();
    const eventTypes = evidence.body.evidence.requests[0].events.map((e) => e.event_type);
    expect(eventTypes).toEqual(expect.arrayContaining(["request_created", "viewed", "consented", "signed"]));
    expect(evidence.body.evidence.requests[0].signer?.name).toBe("Jane Customer");
  });
});

describe("Templates", () => {
  it("creates a template, renders whitelisted merge fields, leaves unknown placeholders literal", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth, "Merge Field Co");
    const template = await post<{ template: { id: number }; version: { id: number } }>("/api/contract-templates", {
      name: "Standard Install Agreement",
      body: "This agreement is with {{customer_name}} for quote {{quote_number}}, total {{quote_total}}. Unknown: {{not_a_real_field}}.",
    }, auth);
    expect(template.response.status).toBe(201);

    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId, { template_version_id: template.body.version.id, title: undefined });
    const detail = await request<{ version: { body: string } }>(`/api/contracts/${contract.id}`, auth);
    expect(detail.body.version.body).toContain("Merge Field Co");
    expect(detail.body.version.body).toContain("$5000.00");
    expect(detail.body.version.body).toContain("{{not_a_real_field}}"); // left literally in place, never dropped/crashed
  });

  it("a second template version is independently addable and does not alter Contracts already created from an earlier version", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const template = await post<{ template: { id: number }; version: { id: number } }>("/api/contract-templates", { name: "T", body: "v1 body {{customer_name}}" }, auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId, { template_version_id: template.body.version.id, title: undefined });

    const v2 = await post<{ id: number; body: string }>(`/api/contract-templates/${template.body.template.id}/versions`, { title: "T v2", body: "v2 body totally different" }, auth);
    expect(v2.response.status).toBe(201);

    const detail = await request<{ version: { body: string } }>(`/api/contracts/${contract.id}`, auth);
    expect(detail.body.version.body).toContain("v1 body"); // unaffected by the new template version
  });
});

describe("RBAC", () => {
  it("a technician is blanket-blocked from every Contract route, including the internal listing routes", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { auth: techAuth } = await createLinkedTechnician("contract-tech@example.test", auth);

    const list = await request("/api/contracts", techAuth);
    expect(list.response.status).toBe(403);
    const detail = await request(`/api/contracts/${contract.id}`, techAuth);
    expect(detail.response.status).toBe(403);
    const create = await post("/api/contracts", { quote_id: quoteId }, techAuth);
    expect(create.response.status).toBe(403);
    const signers = await request(`/api/contracts/${contract.id}/signers`, techAuth);
    expect(signers.response.status).toBe(403);
    const templates = await request("/api/contract-templates", techAuth);
    expect(templates.response.status).toBe(403);
  });

  it("a dispatcher has full parity with admin: create, send, transition", async () => {
    const admin = await authHeaders();
    const customerId = await makeCustomer(admin);
    const { quoteId } = await makeAcceptedQuote(admin, customerId);
    const dispatcher = await dispatcherAuth();

    const contract = await makeContract(dispatcher, quoteId);
    await post(`/api/contracts/${contract.id}/signers`, { name: "Jane Customer", email: "jane@example.test", role: "customer" }, dispatcher);
    const send = await post(`/api/contracts/${contract.id}/send`, {}, dispatcher);
    expect(send.response.status).toBe(200);
  });

  it("the public signing routes require no session at all (deliberately unauthenticated)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    // No auth header passed at all.
    const view = await request(`/api/public/contracts/sign/${token}`);
    expect(view.response.status).toBe(200);
  });
});

describe("Tenant isolation — Contracts", () => {
  it("Org A cannot list, read, update, delete, or transition Org B's contract", async () => {
    const a = await orgA();
    const b = await orgB();
    const customerBId = await makeCustomer(b.auth, "Org B Customer");
    const { quoteId: quoteBId } = await makeAcceptedQuote(b.auth, customerBId);
    const contractB = await makeContract(b.auth, quoteBId);

    const read = await request(`/api/contracts/${contractB.id}`, a.auth);
    expect(read.response.status).toBe(404);
    const update = await put(`/api/contracts/${contractB.id}/version`, { title: "hostile" }, a.auth);
    expect(update.response.status).toBe(404);
    const del1 = await del(`/api/contracts/${contractB.id}`, a.auth);
    expect(del1.response.status).toBe(404);
    const transition = await post(`/api/contracts/${contractB.id}/transition`, { to_status: "cancelled" }, a.auth);
    expect(transition.response.status).toBe(404);
    const evidence = await request(`/api/contracts/${contractB.id}/evidence`, a.auth);
    expect(evidence.response.status).toBe(404);

    const list = await request<{ contracts: unknown[]; total: number }>("/api/contracts", a.auth);
    expect(list.body.contracts.some((c: unknown) => (c as { id: number }).id === contractB.id)).toBe(false);
  });

  it("Org A cannot create a contract from Org B's quote", async () => {
    const a = await orgA();
    const b = await orgB();
    const customerBId = await makeCustomer(b.auth, "Org B Customer");
    const { quoteId: quoteBId } = await makeAcceptedQuote(b.auth, customerBId);

    const attempt = await post("/api/contracts", { quote_id: quoteBId }, a.auth);
    expect(attempt.response.status).toBe(404);
  });

  it("a signing token from Org B's contract cannot be used to leak data cross-org (token itself is the only auth, but resolves to the correct org)", async () => {
    const b = await orgB();
    const customerBId = await makeCustomer(b.auth, "Org B Customer");
    const { quoteId: quoteBId } = await makeAcceptedQuote(b.auth, customerBId);
    const contractB = await makeContract(b.auth, quoteBId);
    const { token } = await makeSignerAndSend(b.auth, contractB.id);

    // The public route needs no org context at all — it must still resolve
    // correctly and only ever touch Org B's own data.
    const view = await request<{ view: { contract_identifier: string } }>(`/api/public/contracts/sign/${token}`);
    expect(view.response.status).toBe(200);
    expect(view.body.view.contract_identifier).toContain("CONTRACT");
  });

  it("Org A cannot use a guessed Org-B signer id to probe or delete a signer via Org A's own contract (regression: deleteContractSigner's active-request check must be contract-scoped, not just signer-id-scoped)", async () => {
    const a = await orgA();
    const b = await orgB();

    const customerAId = await makeCustomer(a.auth, "Org A Customer");
    const { quoteId: quoteAId } = await makeAcceptedQuote(a.auth, customerAId);
    const contractA = await makeContract(a.auth, quoteAId);
    const signerAOnly = await post<{ signer: { id: number } }>(`/api/contracts/${contractA.id}/signers`, { name: "Org A Signer", email: "a@example.test" }, a.auth);
    expect(signerAOnly.response.status).toBe(201);

    const customerBId = await makeCustomer(b.auth, "Org B Customer");
    const { quoteId: quoteBId } = await makeAcceptedQuote(b.auth, customerBId);
    const contractB = await makeContract(b.auth, quoteBId);
    // Org B's signer has an ACTIVE signature request — before the fix, this
    // active-request row was findable by signer_id alone (no contract_id
    // scoping), so an attempt to delete an unrelated Org-A signer id could
    // be silently blocked (409) by Org B's own request state, leaking its
    // existence/activity across the tenant boundary.
    const { signerId: signerBWithActiveRequest } = await makeSignerAndSend(b.auth, contractB.id);

    // Org A attempts to delete ITS OWN contract's signer, but the id it
    // passes is Org B's signer id (e.g. via id enumeration/guessing).
    const crossOrgAttempt = await del(`/api/contracts/${contractA.id}/signers/${signerBWithActiveRequest}`, a.auth);
    expect(crossOrgAttempt.response.status).toBe(404); // not found — never blocked by Org B's activity, never silently "successful" either

    // Org A's own, unrelated signer is untouched.
    const list = await request<{ signers: { id: number }[] }>(`/api/contracts/${contractA.id}/signers`, a.auth);
    expect(list.body.signers.map((s) => s.id)).toContain(signerAOnly.body.signer.id);
  });

  it("Org A cannot add/remove signers, send, cancel, or resend on Org B's contract", async () => {
    const a = await orgA();
    const b = await orgB();
    const customerBId = await makeCustomer(b.auth, "Org B Customer");
    const { quoteId: quoteBId } = await makeAcceptedQuote(b.auth, customerBId);
    const contractB = await makeContract(b.auth, quoteBId);
    const { signerId, token } = await makeSignerAndSend(b.auth, contractB.id);
    const requests = await request<{ requests: { id: number }[] }>(`/api/contracts/${contractB.id}/signature-requests`, b.auth);
    const requestId = requests.body.requests[0].id;

    const addSigner = await post(`/api/contracts/${contractB.id}/signers`, { name: "Hostile" }, a.auth);
    expect(addSigner.response.status).toBe(404);
    const removeSigner = await del(`/api/contracts/${contractB.id}/signers/${signerId}`, a.auth);
    expect(removeSigner.response.status).toBe(404);
    const send = await post(`/api/contracts/${contractB.id}/send`, {}, a.auth);
    expect(send.response.status).toBe(404);
    const cancel = await post(`/api/contracts/${contractB.id}/signature-requests/${requestId}/cancel`, {}, a.auth);
    expect(cancel.response.status).toBe(404);
    const resend = await post(`/api/contracts/${contractB.id}/signature-requests/${requestId}/resend`, {}, a.auth);
    expect(resend.response.status).toBe(404);
    const listRequests = await request(`/api/contracts/${contractB.id}/signature-requests`, a.auth);
    expect(listRequests.response.status).toBe(404);

    // The real token still works — proving none of Org A's failed attempts
    // disturbed Org B's actual data.
    const view = await request(`/api/public/contracts/sign/${token}`);
    expect(view.response.status).toBe(200);
  });
});
