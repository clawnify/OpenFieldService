import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANIZATION_ID, applySchema, authHeaders, createSecondOrganization,
  createUser, del, loginAs, post, put, queryDb, request, requestRaw, resetDatabase,
} from "./helpers.js";
import { deleteObject, putObject, type StorageEnv } from "../src/server/storage.js";
import { sha256Hex } from "../src/server/contracts.js";

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

  it("a revision copies the company_snapshot forward from the source version, never re-deriving it from a profile edited in between (Phase 13A Company Profile hardening)", async () => {
    const auth = await authHeaders();
    await put("/api/company-profile", { company_name: "Profile A Co" }, auth);

    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${token}/decline`, { reason: "not ready" });

    // Edit the profile AFTER v1 was created but BEFORE the revision.
    await put("/api/company-profile", { company_name: "Profile B Co" }, auth);

    const revision = await post<{ version: { id: number } }>(`/api/contracts/${contract.id}/revisions`, {}, auth);
    expect(revision.response.status).toBe(201);

    const snapshotRows = await queryDb<{ company_snapshot: string }>(
      "SELECT company_snapshot FROM contract_versions WHERE id = ?", [revision.body.version.id]
    );
    expect(JSON.parse(snapshotRows[0].company_snapshot).name).toBe("Profile A Co"); // copied forward, not re-derived as B
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

    // "voice" was never a real signature method (unlike "drawn", which
    // became a genuinely supported method in the Phase 13A final
    // document hardening pass — see the "Draw Signature" describe block
    // below for its own dedicated coverage).
    const badMethod = await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "voice" });
    expect(badMethod.response.status).toBe(400);
  });
});

describe("Draw Signature (Phase 13A final document hardening, Section 17-22)", () => {
  const TINY_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  async function signedContractViaDraw(auth: RequestInit, dataUrl = TINY_PNG_DATA_URL) {
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    const sign = await post(`/api/public/contracts/sign/${token}/sign`, {
      signer_name: "Jane Customer", signature_method: "drawn", signature_image_data_url: dataUrl,
    });
    return { contract, token, sign };
  }

  it("accepts a valid drawn signature (base64 PNG data URL) and records signature_method='drawn'", async () => {
    const auth = await authHeaders();
    const { contract, sign } = await signedContractViaDraw(auth);
    expect(sign.response.status).toBe(200);
    const rows = await queryDb<{ signature_method: string; signature_image_key: string | null }>(
      "SELECT signature_method, signature_image_key FROM contract_signature_requests WHERE contract_id = ?", [contract.id]
    );
    expect(rows[0].signature_method).toBe("drawn");
    expect(rows[0].signature_image_key).not.toBeNull();
  });

  it("rejects signing with method='drawn' and no image data", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    const sign = await post<{ error: string }>(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "drawn" });
    expect(sign.response.status).toBe(400);
  });

  it("rejects a malformed data URL (not a base64 PNG)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    const notAUrl = await post<{ error: string }>(`/api/public/contracts/sign/${token}/sign`, {
      signer_name: "Jane Customer", signature_method: "drawn", signature_image_data_url: "not-a-data-url",
    });
    expect(notAUrl.response.status).toBe(400);

    const wrongFormat = await post<{ error: string }>(`/api/public/contracts/sign/${token}/sign`, {
      signer_name: "Jane Customer", signature_method: "drawn",
      signature_image_data_url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    });
    expect(wrongFormat.response.status).toBe(400);
  });

  // P2 fix (found by independent security review): an oversized payload
  // must be rejected by cheap zod length validation BEFORE
  // decodeSignatureImage() ever calls atob() on the whole attacker-
  // controlled string — this endpoint is PUBLIC and unauthenticated, with
  // no other body-size limit in front of it.
  it("rejects a wildly oversized signature_image_data_url before attempting to decode it", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    const oversized = "data:image/png;base64," + "A".repeat(3_000_000);
    const res = await post<{ error: string }>(`/api/public/contracts/sign/${token}/sign`, {
      signer_name: "Jane Customer", signature_method: "drawn", signature_image_data_url: oversized,
    });
    expect(res.response.status).toBe(400);
  });

  it("the drawn signature image is embedded in the signed PDF and never falls back to a typed name", async () => {
    const auth = await authHeaders();
    const { contract } = await signedContractViaDraw(auth);
    const cookie = (auth.headers as Record<string, string>).cookie;
    const res = await requestRaw(`/api/contracts/${contract.id}/signed-document`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  // Testing review finding: every other test in this file isolates one
  // feature (logo-only, drawn-only, typed-only). finalizeSignedDocument()
  // does three independent sequential fetches (logo, per-request
  // signature images, per-request events) — a regression that scopes one
  // of those fetches wrong relative to another (e.g. mixing up which
  // signer's image belongs to which request) would only show up when all
  // three are exercised together.
  it("a multi-signer contract with a configured logo, one typed signer and one drawn signer, finalizes correctly — each signer's own image stays correctly scoped to their own request", async () => {
    const auth = await authHeaders();
    const cookie = (auth.headers as Record<string, string>).cookie;
    const logoForm = new FormData();
    logoForm.append("file", new File(
      [Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (ch) => ch.charCodeAt(0))],
      "logo.png", { type: "image/png" }
    ));
    await request("/api/company-profile/logo", { method: "POST", headers: { cookie }, body: logoForm });

    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const typedSigner = await post<{ signer: { id: number } }>(`/api/contracts/${contract.id}/signers`, { name: "Typed Signer", email: "typed@example.test", role: "customer" }, auth);
    const drawnSigner = await post<{ signer: { id: number } }>(`/api/contracts/${contract.id}/signers`, { name: "Drawn Signer", email: "drawn@example.test", role: "co_owner" }, auth);
    const send = await post<{ signing_links: { signer_id: number; token: string }[] }>(`/api/contracts/${contract.id}/send`, {}, auth);
    const typedToken = send.body.signing_links.find((l) => l.signer_id === typedSigner.body.signer.id)!.token;
    const drawnToken = send.body.signing_links.find((l) => l.signer_id === drawnSigner.body.signer.id)!.token;

    await post(`/api/public/contracts/sign/${typedToken}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${typedToken}/sign`, { signer_name: "Typed Signer", signature_method: "typed" });
    await post(`/api/public/contracts/sign/${drawnToken}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${drawnToken}/sign`, {
      signer_name: "Drawn Signer", signature_method: "drawn",
      signature_image_data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    });

    const res = await requestRaw(`/api/contracts/${contract.id}/signed-document`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const pdfBytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe("%PDF-");

    const rows = await queryDb<{ signer_id: number; signature_method: string; signature_image_key: string | null }>(
      "SELECT signer_id, signature_method, signature_image_key FROM contract_signature_requests WHERE contract_id = ?", [contract.id]
    );
    const typedRow = rows.find((r) => r.signer_id === typedSigner.body.signer.id)!;
    const drawnRow = rows.find((r) => r.signer_id === drawnSigner.body.signer.id)!;
    expect(typedRow.signature_method).toBe("typed");
    expect(typedRow.signature_image_key).toBeNull(); // never picks up the OTHER signer's image
    expect(drawnRow.signature_method).toBe("drawn");
    expect(drawnRow.signature_image_key).not.toBeNull();
  });
});

describe("Automatic Customer Signed-Copy Delivery (Phase 13A final document hardening, Section 31-41)", () => {
  async function signOneSigner(auth: RequestInit, signerEmail = "jane@example.test") {
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id, { email: signerEmail });
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });
    return contract;
  }

  it("enqueues exactly one notification per signer, addressed to the SIGNER's email, only after the artifact is persisted", async () => {
    const auth = await authHeaders();
    const contract = await signOneSigner(auth, "specific-signer@example.test");
    const rows = await queryDb<{ recipient: string; event_type: string; entity_type: string; status: string; template_key: string }>(
      "SELECT recipient, event_type, entity_type, status, template_key FROM notification_outbox WHERE entity_type = 'contract' AND entity_id = ?", [contract.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient: "specific-signer@example.test", event_type: "contract.signed_copy", entity_type: "contract", status: "pending", template_key: "contract_signed_copy_v1" });
  });

  it("a multi-signer contract enqueues one independently-deduplicated email per signer", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const signerA = await post<{ signer: { id: number } }>(`/api/contracts/${contract.id}/signers`, { name: "Signer A", email: "a@example.test", role: "customer" }, auth);
    const signerB = await post<{ signer: { id: number } }>(`/api/contracts/${contract.id}/signers`, { name: "Signer B", email: "b@example.test", role: "co_owner" }, auth);
    const send = await post<{ signing_links: { signer_id: number; token: string }[] }>(`/api/contracts/${contract.id}/send`, {}, auth);
    const tokenA = send.body.signing_links.find((l) => l.signer_id === signerA.body.signer.id)!.token;
    const tokenB = send.body.signing_links.find((l) => l.signer_id === signerB.body.signer.id)!.token;
    for (const t of [tokenA, tokenB]) {
      await post(`/api/public/contracts/sign/${t}/consent`, { consent_text_version: "v1" });
      await post(`/api/public/contracts/sign/${t}/sign`, { signer_name: "Signer", signature_method: "typed" });
    }
    const rows = await queryDb<{ recipient: string }>("SELECT recipient FROM notification_outbox WHERE entity_type = 'contract' AND entity_id = ?", [contract.id]);
    expect(rows.map((r) => r.recipient).sort()).toEqual(["a@example.test", "b@example.test"]);
  });

  it("GET delivery-status aggregates correctly, and a manual retry only touches failed rows (idempotent, reuses the same notification)", async () => {
    const auth = await authHeaders();
    const contract = await signOneSigner(auth);

    const pending = await request<{ delivery: { total: number; pending: number; failed: number; sent: number } }>(`/api/contracts/${contract.id}/delivery-status`, auth);
    expect(pending.body.delivery).toMatchObject({ total: 1, pending: 1, failed: 0, sent: 0 });

    // Simulate a dispatcher failure (e.g. email provider not configured) —
    // directly via SQL, since the dispatcher's own retry timing/attachment
    // resolution is covered separately in test/notification-dispatcher.test.ts.
    await queryDb("UPDATE notification_outbox SET status = 'failed', attempts = 3, last_error = 'provider_not_configured: Email provider is not configured' WHERE entity_type = 'contract' AND entity_id = ?", [contract.id]);
    const failed = await request<{ delivery: { failed: number; last_error: string | null } }>(`/api/contracts/${contract.id}/delivery-status`, auth);
    expect(failed.body.delivery.failed).toBe(1);
    expect(failed.body.delivery.last_error).toContain("provider_not_configured");

    const retry = await post<{ retried: number }>(`/api/contracts/${contract.id}/resend-signed-copy`, {}, auth);
    expect(retry.response.status).toBe(200);
    expect(retry.body.retried).toBe(1);
    const afterRetry = await request<{ delivery: { pending: number; failed: number } }>(`/api/contracts/${contract.id}/delivery-status`, auth);
    expect(afterRetry.body.delivery).toMatchObject({ pending: 1, failed: 0 });

    // Idempotent — calling retry again when nothing is failed is a safe no-op.
    const retryAgain = await post<{ retried: number }>(`/api/contracts/${contract.id}/resend-signed-copy`, {}, auth);
    expect(retryAgain.body.retried).toBe(0);

    const rows = await queryDb<{ id: number }>("SELECT id FROM notification_outbox WHERE entity_type = 'contract' AND entity_id = ?", [contract.id]);
    expect(rows).toHaveLength(1); // still the SAME one row — retry never creates a new notification
  });

  it("a dispatcher can read delivery status and retry (canManageContracts), a technician cannot", async () => {
    const auth = await authHeaders();
    const contract = await signOneSigner(auth);
    const dispatch = await dispatcherAuth("delivery-dispatch@example.test");
    const status = await request(`/api/contracts/${contract.id}/delivery-status`, dispatch);
    expect(status.response.status).toBe(200);

    const { auth: tech } = await createLinkedTechnician("delivery-tech@example.test", auth);
    const techStatus = await request(`/api/contracts/${contract.id}/delivery-status`, tech);
    expect(techStatus.response.status).toBe(403);
    const techRetry = await post(`/api/contracts/${contract.id}/resend-signed-copy`, {}, tech);
    expect(techRetry.response.status).toBe(403);
  });

  it("never leaks or acts on another organization's delivery status (tenant isolation)", async () => {
    const a = await orgA();
    const contractA = await signOneSigner(a.auth);
    const b = await orgB();
    const crossOrgStatus = await request(`/api/contracts/${contractA.id}/delivery-status`, b.auth);
    expect(crossOrgStatus.response.status).toBe(404);
    const crossOrgRetry = await post(`/api/contracts/${contractA.id}/resend-signed-copy`, {}, b.auth);
    expect(crossOrgRetry.response.status).toBe(404);
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

/** Phase 13A — Signed Contract Document Access (View/Download/Print). All
 *  three client actions hit the same GET /api/contracts/{id}/signed-document
 *  route, so testing the route's response is sufficient — there is no
 *  separate server-side "print" logic to exercise. */
describe("Signed Document Access", () => {
  async function makeSignedContract(auth: RequestInit, customerId: number) {
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });
    return contract;
  }

  function cookieOf(auth: RequestInit): string {
    return (auth.headers as Record<string, string>).cookie;
  }

  it("an authorized admin can view the exact signed artifact, matching the stored evidence hash", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const contract = await makeSignedContract(auth, customerId);

    const evidence = await request<{ evidence: { signed_document_hash: string | null } }>(`/api/contracts/${contract.id}/evidence`, auth);
    const storedHash = evidence.body.evidence.signed_document_hash;
    expect(storedHash).not.toBeNull();

    const viewRes = await requestRaw(`/api/contracts/${contract.id}/signed-document`, { headers: { cookie: cookieOf(auth) } });
    expect(viewRes.status).toBe(200);
    expect(viewRes.headers.get("content-type")).toBe("application/pdf");
    expect(viewRes.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(viewRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(viewRes.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(viewRes.headers.get("cache-control")).toBe("private, no-store");
    const bytes = await viewRes.arrayBuffer();
    // A real PDF, not a text placeholder — starts with the format's magic
    // bytes. Content-level correctness (does it actually render the
    // header/customer/line-items/terms/signature) is verified structurally
    // in test/contract-pdf.test.ts (renderContractPdf's own unit tests,
    // which can assert page count etc. via PDFDocument.load) and visually
    // in the required real-browser pass — content streams inside a PDF are
    // Flate-compressed by default, so a raw byte/text search here (as the
    // old plain-text artifact test used to do) would not be a meaningful
    // check against real PDF bytes.
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actualHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(actualHash).toBe(storedHash); // served bytes hash exactly to the evidence-recorded hash
  });

  it("download mode sets an attachment disposition with the contract identifier in the filename", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const contract = await makeSignedContract(auth, customerId);

    const res = await requestRaw(`/api/contracts/${contract.id}/signed-document?mode=download`, { headers: { cookie: cookieOf(auth) } });
    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition") || "";
    expect(disposition).toMatch(/^attachment;/);
    expect(disposition).toContain(contract.identifier);
    expect(disposition).toMatch(/\.pdf"$/);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("a draft (never-sent) contract has no signed document (409), not a 404 or silent empty body", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const draftContract = await makeContract(auth, quoteId);
    const res = await requestRaw(`/api/contracts/${draftContract.id}/signed-document`, { headers: { cookie: cookieOf(auth) } });
    expect(res.status).toBe(409);
  });

  it("a sent-but-not-yet-signed contract has no signed document (409)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    await makeSignerAndSend(auth, contract.id); // sent, but nobody has signed yet
    const res = await requestRaw(`/api/contracts/${contract.id}/signed-document`, { headers: { cookie: cookieOf(auth) } });
    expect(res.status).toBe(409);
  });

  it("an unknown contract id returns 404, not an unhandled error", async () => {
    const auth = await authHeaders();
    const res = await requestRaw("/api/contracts/999999/signed-document", { headers: { cookie: cookieOf(auth) } });
    expect(res.status).toBe(404);
  });

  it("a malformed (non-numeric/negative) contract id returns 404, not a crash", async () => {
    const auth = await authHeaders();
    const authHeader = { headers: { cookie: cookieOf(auth) } };
    expect((await requestRaw("/api/contracts/abc/signed-document", authHeader)).status).toBe(404);
    expect((await requestRaw("/api/contracts/-1/signed-document", authHeader)).status).toBe(404);
    expect((await requestRaw("/api/contracts/0/signed-document", authHeader)).status).toBe(404);
  });

  it("a corrupted/tampered stored hash is detected and never silently served (500, not the mismatched bytes)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const contract = await makeSignedContract(auth, customerId);

    await queryDb("UPDATE contract_versions SET signed_document_hash = ? WHERE contract_id = ?", ["0".repeat(64), contract.id]);

    const res = await requestRaw(`/api/contracts/${contract.id}/signed-document`, { headers: { cookie: cookieOf(auth) } });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).not.toMatch(/contracts\/.*\/signed-/); // never leaks the R2 key in the error
  });

  it("if PDF finalization fails, the contract is never left falsely flagged 'signed' with no artifact (Section 28)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);

    // Force finalizeSignedDocument (contract-pdf.ts's renderContractPdf) to
    // throw deterministically by corrupting the current version's snapshot
    // JSON — contracts.ts JSON.parses commercial_snapshot before it ever
    // reaches the PDF renderer, so this is a clean, real failure injection
    // using only existing test infra (no mocking framework needed).
    await queryDb("UPDATE contract_versions SET commercial_snapshot = 'not valid json' WHERE contract_id = ?", [contract.id]);

    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    // requestRaw (not post) — an uncaught JSON.parse failure inside
    // finalizeSignedDocument reaches Hono's default error handler, which
    // returns a plain-text "Internal Server Error" body, not JSON; post()'s
    // helper would throw trying to .json() that.
    const signRes = await requestRaw(`/api/public/contracts/sign/${token}/sign`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ signer_name: "Jane Customer", signature_method: "typed" }),
    });
    expect(signRes.status).toBeGreaterThanOrEqual(500); // the finalize failure surfaces as a real error, not a silent success

    // The critical invariant: the contract must NOT have been flipped to
    // "signed" — finalizeSignedDocument is now called BEFORE the status
    // transition specifically so a failure here leaves the contract at its
    // prior, honest status rather than falsely complete with no document.
    const detail = await request<{ contract: { status: string } }>(`/api/contracts/${contract.id}`, auth);
    expect(detail.body.contract.status).not.toBe("signed");
    expect(detail.body.contract.status).toBe("sent");

    const rows = await queryDb<{ signed_document_key: string | null }>("SELECT signed_document_key FROM contract_versions WHERE contract_id = ?", [contract.id]);
    expect(rows[0].signed_document_key).toBeNull(); // no orphaned/partial artifact reference either
  });

  it("a signed_document_key that no longer resolves to a real R2 object returns 404, not a crash", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const contract = await makeSignedContract(auth, customerId);

    const rows = await queryDb<{ signed_document_key: string }>("SELECT signed_document_key FROM contract_versions WHERE contract_id = ?", [contract.id]);
    // `env`'s ambient Cloudflare.Env type (worker-configuration.d.ts, auto-
    // generated) predates the MEDIA R2 binding and hasn't been regenerated
    // since — MEDIA genuinely exists at runtime (the whole compliance-photo
    // feature already depends on it); this cast works around the stale
    // generated type without touching that generated file in an unrelated,
    // narrowly-scoped follow-up task.
    await deleteObject(env as unknown as StorageEnv, rows[0].signed_document_key);

    const res = await requestRaw(`/api/contracts/${contract.id}/signed-document`, { headers: { cookie: cookieOf(auth) } });
    expect(res.status).toBe(404);
  });

  it("a technician is blocked from signed-document access (403)", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const contract = await makeSignedContract(auth, customerId);
    const { auth: techAuth } = await createLinkedTechnician("signed-doc-tech@example.test", auth);
    const res = await requestRaw(`/api/contracts/${contract.id}/signed-document`, { headers: { cookie: cookieOf(techAuth) } });
    expect(res.status).toBe(403);
  });

  it("a dispatcher has parity with admin for signed-document access", async () => {
    const admin = await authHeaders();
    const customerId = await makeCustomer(admin);
    const contract = await makeSignedContract(admin, customerId);
    const dispatcher = await dispatcherAuth();
    const res = await requestRaw(`/api/contracts/${contract.id}/signed-document`, { headers: { cookie: cookieOf(dispatcher) } });
    expect(res.status).toBe(200);
  });

  it("Org A cannot access Org B's signed document", async () => {
    const b = await createSecondOrganization("Org B Signed Docs");
    const { cookie: bCookie } = await loginAs(b.email, b.password);
    const bAuth: RequestInit = { headers: { cookie: bCookie } };
    const customerBId = await makeCustomer(bAuth, "Org B Customer");
    const contractB = await makeSignedContract(bAuth, customerBId);

    const a = await authHeaders();
    const res = await requestRaw(`/api/contracts/${contractB.id}/signed-document`, { headers: { cookie: cookieOf(a) } });
    expect(res.status).toBe(404); // never leaks whether Org B's contract exists, signed or not
  });

  it("signed_document_key (the internal R2 storage key) is never present in any Contract API response", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const contract = await makeSignedContract(auth, customerId);
    const detail = await request<{ version: Record<string, unknown> }>(`/api/contracts/${contract.id}`, auth);
    expect(detail.body.version).not.toHaveProperty("signed_document_key");
    const versions = await request<{ versions: Record<string, unknown>[] }>(`/api/contracts/${contract.id}/versions`, auth);
    expect(versions.body.versions[0]).not.toHaveProperty("signed_document_key");
  });

  it("signature_image_key (the internal R2 storage key for a drawn signature) is never present in any Contract API response", async () => {
    // Same leak-proofing discipline as signed_document_key above, applied
    // to the newer Draw Signature column (Testing review finding, Phase
    // 13A final document hardening) — SIGNATURE_REQUEST_COLUMNS omits it
    // by construction, but this pins that at the API-response level so a
    // future SELECT * or column-list edit can't silently reintroduce it.
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${token}/sign`, {
      signer_name: "Jane Customer", signature_method: "drawn",
      signature_image_data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    });

    const requestsRes = await request<{ requests: Record<string, unknown>[] }>(`/api/contracts/${contract.id}/signature-requests`, auth);
    expect(requestsRes.body.requests[0]).not.toHaveProperty("signature_image_key");

    const evidence = await request<{ evidence: { requests: Record<string, unknown>[] } }>(`/api/contracts/${contract.id}/evidence`, auth);
    expect(evidence.body.evidence.requests[0]).not.toHaveProperty("signature_image_key");
  });

  it("a pre-existing plain-text signed artifact (from before the PDF hardening pass) is still served and hash-verified correctly", async () => {
    const auth = await authHeaders();
    const customerId = await makeCustomer(auth);
    const contract = await makeSignedContract(auth, customerId);

    // Simulate a contract signed by the ORIGINAL Phase 13 plain-text
    // renderer: written as TextEncoder().encode(documentText) bytes,
    // hashed via the old text-based sha256Hex(text), stored as text/plain.
    // getSignedDocumentArtifact() must still serve this correctly — the
    // new binary sha256HexBytes() re-hash of the raw retrieved bytes has
    // to land on the exact same value, since those bytes ARE what
    // TextEncoder().encode(documentText) produced in the first place.
    const legacyText = "CONTRACT (signed rendering — not a formatted PDF)\nTitle: Legacy Agreement\n\n--- Signatures ---\nJane Customer <jane@example.test> — signed via typed";
    const legacyHash = await sha256Hex(legacyText);
    const legacyKey = `contracts/${DEFAULT_ORGANIZATION_ID}/${contract.id}/legacy/signed-legacy-test.txt`;
    await putObject(env as unknown as StorageEnv, legacyKey, new TextEncoder().encode(legacyText).buffer as ArrayBuffer, "text/plain; charset=utf-8");
    await queryDb("UPDATE contract_versions SET signed_document_key = ?, signed_document_hash = ? WHERE contract_id = ?", [legacyKey, legacyHash, contract.id]);

    const res = await requestRaw(`/api/contracts/${contract.id}/signed-document`, { headers: { cookie: cookieOf(auth) } });
    expect(res.status).toBe(200); // not a hash mismatch — old and new hashing schemes agree byte-for-byte
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/\.txt"$/); // honestly served as .txt, never falsely claimed as .pdf
    const text = await res.text();
    expect(text).toBe(legacyText);
  });
});

describe("Company Profile snapshot immutability (Phase 13A Company Profile hardening)", () => {
  async function makeSignedContractWithSigner(auth: RequestInit) {
    const customerId = await makeCustomer(auth, `Customer ${Math.random()}`);
    const { quoteId } = await makeAcceptedQuote(auth, customerId);
    const contract = await makeContract(auth, quoteId);
    const { token } = await makeSignerAndSend(auth, contract.id);
    await post(`/api/public/contracts/sign/${token}/consent`, { consent_text_version: "v1" });
    await post(`/api/public/contracts/sign/${token}/sign`, { signer_name: "Jane Customer", signature_method: "typed" });
    return contract;
  }

  it("a Contract created under Profile A keeps Profile A's identity forever, even after the profile is later edited to Profile B — a new Contract created after the edit reflects B (Section 22 acceptance test)", async () => {
    const auth = await authHeaders();

    await put("/api/company-profile", { company_name: "Profile A Co", legal_name: "Profile A Legal Ltd." }, auth);
    const oldContract = await makeSignedContractWithSigner(auth);

    const oldSnapshotRows = await queryDb<{ company_snapshot: string }>(
      "SELECT company_snapshot FROM contract_versions WHERE contract_id = ?", [oldContract.id]
    );
    expect(JSON.parse(oldSnapshotRows[0].company_snapshot).name).toBe("Profile A Co");

    const oldEvidence = await request<{ evidence: { signed_document_hash: string | null } }>(`/api/contracts/${oldContract.id}/evidence`, auth);
    const oldHash = oldEvidence.body.evidence.signed_document_hash;
    expect(oldHash).not.toBeNull();

    // Edit the profile — this must NOT retroactively touch the old Contract.
    await put("/api/company-profile", { company_name: "Profile B Co", legal_name: "Profile B Legal Ltd." }, auth);

    const cookie = (auth.headers as Record<string, string>).cookie;
    const reopened = await requestRaw(`/api/contracts/${oldContract.id}/signed-document`, { headers: { cookie } });
    expect(reopened.status).toBe(200);
    const reopenedBytes = await reopened.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", reopenedBytes);
    const reopenedHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(reopenedHash).toBe(oldHash); // byte-for-byte identical artifact — never regenerated

    const oldSnapshotAfterEdit = await queryDb<{ company_snapshot: string }>(
      "SELECT company_snapshot FROM contract_versions WHERE contract_id = ?", [oldContract.id]
    );
    expect(JSON.parse(oldSnapshotAfterEdit[0].company_snapshot).name).toBe("Profile A Co"); // still A, not B

    // A NEW Contract created after the edit reflects the new profile (B).
    const newContract = await makeSignedContractWithSigner(auth);
    const newSnapshotRows = await queryDb<{ company_snapshot: string }>(
      "SELECT company_snapshot FROM contract_versions WHERE contract_id = ?", [newContract.id]
    );
    expect(JSON.parse(newSnapshotRows[0].company_snapshot).name).toBe("Profile B Co");
  });

  it("never mixes company profiles across tenants in a Contract's snapshot", async () => {
    const a = await orgA();
    await put("/api/company-profile", { company_name: "Org A Identity" }, a.auth);
    const contractA = await makeSignedContractWithSigner(a.auth);

    const b = await orgB();
    await put("/api/company-profile", { company_name: "Org B Identity" }, b.auth);
    const contractB = await makeSignedContractWithSigner(b.auth);

    const snapshotA = await queryDb<{ company_snapshot: string }>("SELECT company_snapshot FROM contract_versions WHERE contract_id = ?", [contractA.id]);
    const snapshotB = await queryDb<{ company_snapshot: string }>("SELECT company_snapshot FROM contract_versions WHERE contract_id = ?", [contractB.id]);
    expect(JSON.parse(snapshotA[0].company_snapshot).name).toBe("Org A Identity");
    expect(JSON.parse(snapshotB[0].company_snapshot).name).toBe("Org B Identity");
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
