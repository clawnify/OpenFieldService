import { describe, expect, it } from "vitest";
import type { ObjectStorage } from "@/lib/r2";
import { ApplicationError, ConflictError, NotFoundError } from "@/lib/errors";
import { AuditRepository } from "@/modules/audit/audit.repository";
import { CustomerService } from "@/modules/customers/customer.service";
import { OrganizationService } from "@/modules/identity/organization.service";
import { EstimateService } from "@/modules/estimates/estimate.service";
import { EstimateParityService } from "@/modules/estimates/parity.service";
import { ContractService } from "./contract.service";

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Uint8Array>();
  deleted: string[] = [];
  failPut = false;
  failAfterPut = false;
  async put(key: string, body: Uint8Array) {
    if (this.failPut) throw new Error("storage unavailable");
    this.objects.set(key, body);
    if (this.failAfterPut) throw new Error("ambiguous storage failure");
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error("missing");
    return body;
  }
  async delete(key: string) {
    this.objects.delete(key);
    this.deleted.push(key);
  }
  async signedDownloadUrl(key: string, expiresIn = 300) {
    if (!this.objects.has(key)) throw new Error("missing");
    return `https://storage.example.test/${encodeURIComponent(key)}?ttl=${expiresIn}`;
  }
}

describe.sequential("PostgreSQL Contracts", () => {
  let a: Awaited<
      ReturnType<OrganizationService["createOrganizationWithOwner"]>
    >,
    b: typeof a;
  let customer: Awaited<ReturnType<CustomerService["createCustomer"]>>;
  const storage = new MemoryStorage(),
    service = new ContractService(storage),
    estimates = new EstimateService(),
    parity = new EstimateParityService();
  const actor = () => ({
    userId: a.user.id,
    organizationId: a.organization.id,
    role: "owner" as const,
  });
  const foreign = () => ({
    userId: b.user.id,
    organizationId: b.organization.id,
    role: "owner" as const,
  });
  async function acceptedQuote() {
    const quote = await estimates.create(actor(), {
      customerId: customer.id,
      tiers: ["good"],
    });
    await estimates.addLine(actor(), quote.id, {
      optionId: quote.options[0]!.id,
      description: "Immutable service",
      unitPriceCents: 12_345,
    });
    const link = await parity.issuePublicLink(actor(), quote.id);
    await parity.selectPublic(
      link.token,
      { optionId: quote.options[0]!.id, selectorName: "Synthetic Customer" },
      { ip: "203.0.113.1", userAgent: "integration" },
    );
    return quote;
  }
  async function draftContract() {
    const quote = await acceptedQuote();
    return service.create(actor(), {
      quoteId: quote.id,
      title: "Synthetic Agreement",
      body: "Frozen contractual terms",
    });
  }
  async function sentContract(two = false) {
    const contract = await draftContract();
    await service.addSigner(actor(), contract.id, {
      name: "Synthetic Signer",
      email: "signer@example.test",
      role: "customer",
    });
    if (two)
      await service.addSigner(actor(), contract.id, {
        name: "Second Signer",
        email: "second@example.test",
        role: "co_owner",
      });
    const sent = await service.send(actor(), contract.id, {});
    return { contract, sentContract: sent.contract, links: sent.links };
  }

  it("creates isolated fixtures", async () => {
    const organizations = new OrganizationService();
    a = await organizations.createOrganizationWithOwner(
      { name: "Contract Tenant A", slug: "contract-a" },
      {
        name: "Owner A",
        email: "contract-a@example.test",
        password: "Synthetic-Pass-123",
      },
    );
    b = await organizations.createOrganizationWithOwner(
      { name: "Contract Tenant B", slug: "contract-b" },
      {
        name: "Owner B",
        email: "contract-b@example.test",
        password: "Synthetic-Pass-456",
      },
    );
    customer = await new CustomerService().createCustomer(actor(), {
      name: "Synthetic Contract Customer",
      email: "customer@example.test",
    });
  });
  it("binds exactly one Contract to an immutable accepted Quote option", async () => {
    const quote = await acceptedQuote(),
      contract = await service.create(actor(), {
        quoteId: quote.id,
        title: "Installation Agreement",
      });
    expect(contract).toMatchObject({
      quoteId: quote.id,
      acceptedQuoteVersionId: quote.currentVersionId,
      acceptedOptionId: quote.options[0]!.id,
      acceptedTotalCents: 12_345,
      status: "draft",
    });
    const detail = await service.get(actor(), contract.id);
    const snapshot = JSON.parse(detail.version.commercialSnapshot) as {
      lines: { description: string }[];
      totalCents: number;
      customerSelection: { selectorName: string; selectorIp: string };
      taxSnapshot: Record<string, unknown> | null;
    };
    expect(snapshot).toMatchObject({
      totalCents: 12_345,
      lines: [{ description: "Immutable service" }],
      customerSelection: {
        selectorName: "Synthetic Customer",
        selectorIp: "203.0.113.1",
      },
    });
    expect(JSON.stringify(snapshot.taxSnapshot)).not.toContain(actor().organizationId);
    await expect(
      service.create(actor(), { quoteId: quote.id, title: "Duplicate" }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      service.create(foreign(), { quoteId: quote.id, title: "Foreign" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
  it("uses row-version guards and freezes sent terms", async () => {
    const contract = await draftContract();
    await service.updateDraft(actor(), contract.id, {
      title: "Updated",
      expectedRowVersion: 0,
    });
    await expect(
      service.updateDraft(actor(), contract.id, {
        title: "Stale",
        expectedRowVersion: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await service.addSigner(actor(), contract.id, {
      name: "Synthetic Signer",
      email: "signer@example.test",
    });
    await service.send(actor(), contract.id, {});
    await expect(
      service.updateDraft(actor(), contract.id, {
        title: "Forbidden",
        expectedRowVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
  it("requires consent, signs idempotently, retains a private PDF, and isolates access", async () => {
    const { contract, links } = await sentContract(),
      token = links[0]!.token;
    await expect(
      service.sign(
        token,
        { signerName: "Synthetic Signer", method: "typed" },
        { ip: null, userAgent: null },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(service.publicView("not-a-well-formed-token")).rejects.toBeInstanceOf(ApplicationError);
    const publicView = await service.publicView(token);
    expect(publicView?.signer.name).toBe("Synthetic Signer");
    expect(JSON.stringify(publicView)).not.toContain("203.0.113.1");
    expect(JSON.stringify(publicView)).not.toContain("selectorUserAgent");
    await service.consent(
      token,
      { consentTextVersion: "v1" },
      { ip: "203.0.113.2", userAgent: "browser" },
    );
    const signed = await service.sign(
      token,
      { signerName: "Synthetic Signer", method: "typed" },
      { ip: "203.0.113.2", userAgent: "browser" },
    );
    expect(signed.status).toBe("signed");
    expect(
      (
        await service.sign(
          token,
          { signerName: "Synthetic Signer", method: "typed" },
          { ip: null, userAgent: null },
        )
      ).idempotent,
    ).toBe(true);
    const download = await service.signedDocumentUrl(actor(), contract.id);
    expect(download.url).toContain("storage.example.test");
    const retainedKey = decodeURIComponent(
      download.url.split("/").at(-1)!.split("?")[0]!,
    );
    expect(storage.objects.get(retainedKey)?.slice(0, 4).toString()).toBe(
      "37,80,68,70",
    );
    await expect(
      service.signedDocumentUrl(foreign(), contract.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    storage.objects.set(retainedKey, new TextEncoder().encode("tampered"));
    await expect(
      service.signedDocumentUrl(actor(), contract.id),
    ).rejects.toBeInstanceOf(ConflictError);
  });
  it("derives partial and final multi-signer status", async () => {
    const { contract, links } = await sentContract(true);
    for (const link of links)
      await service.consent(
        link.token,
        { consentTextVersion: "v1" },
        { ip: null, userAgent: null },
      );
    await service.sign(
      links[0]!.token,
      { signerName: "Synthetic Signer", method: "click_to_sign" },
      { ip: null, userAgent: null },
    );
    expect((await service.get(actor(), contract.id)).contract.status).toBe(
      "partially_signed",
    );
    await service.sign(
      links[1]!.token,
      { signerName: "Second Signer", method: "typed" },
      { ip: null, userAgent: null },
    );
    expect((await service.get(actor(), contract.id)).contract.status).toBe(
      "signed",
    );
  });
  it("supports drawn signatures with server-generated keys", async () => {
    const { contract, links } = await sentContract(),
      token = links[0]!.token;
    await service.consent(
      token,
      { consentTextVersion: "v1" },
      { ip: null, userAgent: null },
    );
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    await service.sign(
      token,
      {
        signerName: "Synthetic Signer",
        method: "drawn",
        signatureImageDataUrl: `data:image/png;base64,${png.toString("base64")}`,
      },
      { ip: null, userAgent: null },
    );
    expect(
      [...storage.objects.keys()].some((key) =>
        key.startsWith(
          `organizations/${actor().organizationId}/contract_signature/`,
        ),
      ),
    ).toBe(true);
    expect(
      (await service.get(actor(), contract.id)).requests[0],
    ).not.toHaveProperty("tokenHash", expect.any(String));
  });
  it("revisions preserve snapshots and invalidate old signing capabilities", async () => {
    const { contract, links } = await sentContract();
    await service.decline(
      links[0]!.token,
      { reason: "Please revise" },
      { ip: null, userAgent: null },
    );
    const revision = await service.createRevision(actor(), contract.id);
    expect(revision.versionNumber).toBe(2);
    expect(await service.publicView(links[0]!.token)).toBeNull();
    const detail = await service.get(actor(), contract.id);
    expect(detail.contract.status).toBe("draft");
    expect(revision.commercialSnapshot).toBe(
      contract.version.commercialSnapshot,
    );
  });
  it("serializes duplicate creation and concurrent revision allocation", async () => {
    const quote = await acceptedQuote(),
      creates = await Promise.allSettled([
        service.create(actor(), { quoteId: quote.id, title: "First" }),
        service.create(actor(), { quoteId: quote.id, title: "Second" }),
      ]);
    expect(creates.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    const created = creates.find((value) => value.status === "fulfilled");
    if (!created || created.status !== "fulfilled") throw new Error("Contract missing");
    await service.addSigner(actor(), created.value.id, {
      name: "Synthetic Signer",
      email: "revision@example.test",
    });
    const sent = await service.send(actor(), created.value.id, {});
    await service.decline(
      sent.links[0]!.token,
      { reason: "Revise" },
      { ip: null, userAgent: null },
    );
    const revisions = await Promise.allSettled([
      service.createRevision(actor(), created.value.id),
      service.createRevision(actor(), created.value.id),
    ]);
    expect(revisions.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect((await service.get(actor(), created.value.id)).version.versionNumber).toBe(2);
  });
  it("serializes signing against capability revocation", async () => {
    const { contract, links } = await sentContract(),
      link = links[0]!;
    await service.consent(
      link.token,
      { consentTextVersion: "v1" },
      { ip: null, userAgent: null },
    );
    const outcomes = await Promise.allSettled([
      service.sign(
        link.token,
        { signerName: "Synthetic Signer", method: "typed" },
        { ip: null, userAgent: null },
      ),
      service.revokeSigningRequest(actor(), contract.id, link.requestId),
    ]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(["signed", "expired"]).toContain(
      (await service.get(actor(), contract.id)).contract.status,
    );
  });
  it("serializes simultaneous signing and keeps one retained artifact", async () => {
    const { contract, links } = await sentContract(),
      token = links[0]!.token;
    await service.consent(
      token,
      { consentTextVersion: "v1" },
      { ip: null, userAgent: null },
    );
    const results = await Promise.allSettled([
      service.sign(
        token,
        { signerName: "Synthetic Signer", method: "typed" },
        { ip: null, userAgent: null },
      ),
      service.sign(
        token,
        { signerName: "Synthetic Signer", method: "typed" },
        { ip: null, userAgent: null },
      ),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(2);
    expect((await service.get(actor(), contract.id)).contract.status).toBe(
      "signed",
    );
  });
  it("rolls back signing and compensates an ambiguous artifact upload failure", async () => {
    const { contract, links } = await sentContract(),
      token = links[0]!.token,
      before = new Set(storage.objects.keys());
    await service.consent(
      token,
      { consentTextVersion: "v1" },
      { ip: null, userAgent: null },
    );
    storage.failAfterPut = true;
    await expect(
      service.sign(
        token,
        { signerName: "Synthetic Signer", method: "typed" },
        { ip: null, userAgent: null },
      ),
    ).rejects.toThrow("ambiguous storage failure");
    storage.failAfterPut = false;
    expect((await service.get(actor(), contract.id)).contract.status).toBe(
      "sent",
    );
    expect([...storage.objects.keys()].filter((key) => !before.has(key))).toHaveLength(0);
    expect(
      (
        await service.sign(
          token,
          { signerName: "Synthetic Signer", method: "typed" },
          { ip: null, userAgent: null },
        )
      ).status,
    ).toBe("signed");
  });
  it("retains signed evidence after void and records audit", async () => {
    const { contract, links } = await sentContract(),
      token = links[0]!.token;
    await service.consent(
      token,
      { consentTextVersion: "v1" },
      { ip: null, userAgent: null },
    );
    await service.sign(
      token,
      { signerName: "Synthetic Signer", method: "typed" },
      { ip: null, userAgent: null },
    );
    await service.void(actor(), contract.id, { reason: "Mutual cancellation" });
    expect((await service.get(actor(), contract.id)).contract.status).toBe(
      "voided",
    );
    expect(
      (await service.signedDocumentUrl(actor(), contract.id)).sha256,
    ).toMatch(/^[a-f0-9]{64}$/);
    const audit = await new AuditRepository().listForEntity(
      actor().organizationId,
      "contract",
      contract.id,
    );
    expect(audit.map((x) => x.action)).toContain(
      "contract.signed_document_retained",
    );
    expect(JSON.stringify(audit)).not.toContain(token);
  });
});
