import { describe, expect, it } from "vitest";
import { ApplicationError, ConflictError, NotFoundError } from "@/lib/errors";
import { CustomerService } from "@/modules/customers/customer.service";
import { OrganizationService } from "@/modules/identity/organization.service";
import { PricebookService } from "@/modules/pricebook/pricebook.service";
import { EstimateService } from "./estimate.service";
import { EstimateParityService } from "./parity.service";
import { TaxService } from "./tax.service";
describe.sequential("PostgreSQL Estimate parity", () => {
  let a: Awaited<
      ReturnType<OrganizationService["createOrganizationWithOwner"]>
    >,
    b: typeof a,
    customer: Awaited<ReturnType<CustomerService["createCustomer"]>>,
    foreignCustomer: typeof customer,
    item: Awaited<ReturnType<PricebookService["createItem"]>>;
  const actor = () => ({
      userId: a.user.id,
      organizationId: a.organization.id,
      role: "owner" as const,
    }),
    foreign = () => ({
      userId: b.user.id,
      organizationId: b.organization.id,
      role: "owner" as const,
    });
  const estimates = new EstimateService(),
    parity = new EstimateParityService();
  it("creates tax fixtures", async () => {
    const org = new OrganizationService();
    a = await org.createOrganizationWithOwner(
      { name: "Parity A", slug: "parity-a" },
      {
        name: "A",
        email: "parity-a@example.test",
        password: "Synthetic-Pass-123",
      },
    );
    b = await org.createOrganizationWithOwner(
      { name: "Parity B", slug: "parity-b" },
      {
        name: "B",
        email: "parity-b@example.test",
        password: "Synthetic-Pass-456",
      },
    );
    customer = await new CustomerService().createCustomer(actor(), {
      name: "Proposal Customer",
    });
    foreignCustomer = await new CustomerService().createCustomer(foreign(), {
      name: "Foreign",
    });
    item = await new PricebookService().createItem(actor(), {
      type: "service",
      name: "Taxed service",
      sellPriceCents: 11200,
      taxable: true,
    });
    await new TaxService().publish(actor(), {
      enabled: true,
      countryCode: "CA",
      regionCode: "BC",
      currency: "CAD",
      pricesIncludeTax: true,
      defaultTaxable: true,
      components: [
        { code: "GST", name: "GST", rateBasisPoints: 500 },
        { code: "PST", name: "PST", rateBasisPoints: 700 },
      ],
    });
  });
  it("snapshots inclusive components when issuing a public proposal", async () => {
    const q = await estimates.create(actor(), { customerId: customer.id });
    await estimates.addLine(actor(), q.id, {
      optionId: q.options[0]!.id,
      pricebookItemId: item.id,
    });
    const issued = await parity.issuePublicLink(actor(), q.id),
      view = await parity.publicView(issued.token);
    expect(view?.options[0]).toMatchObject({
      subtotalCents: 10000,
      taxCents: 1200,
      totalCents: 11200,
    });
    expect(JSON.stringify(view)).not.toContain("costCents");
    expect(await parity.publicView("x".repeat(43))).toBeNull();
    await expect(parity.publicView("not-a-well-formed-token")).rejects.toBeInstanceOf(ApplicationError);
  });
  it("supports idempotent exact-version customer selection and blocks foreign options", async () => {
    const q = await estimates.create(actor(), {
      customerId: customer.id,
      tiers: ["good", "better"],
    });
    await estimates.addLine(actor(), q.id, {
      optionId: q.options[0]!.id,
      description: "Choice",
      unitPriceCents: 100,
    });
    const link = await parity.issuePublicLink(actor(), q.id);
    await expect(
      parity.selectPublic(
        link.token,
        {
          optionId: "00000000-0000-4000-8000-000000000001",
          selectorName: "Customer",
        },
        { ip: null, userAgent: null },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await parity.selectPublic(
        link.token,
        { optionId: q.options[0]!.id, selectorName: "Customer" },
        { ip: "127.0.0.1", userAgent: "test" },
      ),
    ).toEqual({ quoteId: q.id });
    expect(
      await parity.selectPublic(
        link.token,
        { optionId: q.options[0]!.id, selectorName: "Customer" },
        { ip: null, userAgent: null },
      ),
    ).toEqual({ quoteId: q.id });
  });
  it("revokes links and prevents cross-tenant token management", async () => {
    const q = await estimates.create(actor(), { customerId: customer.id });
    const link = await parity.issuePublicLink(actor(), q.id);
    await expect(
      parity.revokePublicLink(foreign(), q.id, link.link.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    await parity.revokePublicLink(actor(), q.id, link.link.id);
    expect(await parity.publicView(link.token)).toBeNull();
  });
  it("creates one concurrent revision and preserves the old version", async () => {
    const q = await estimates.create(actor(), {
      customerId: customer.id,
      tiers: ["good"],
    });
    await estimates.addLine(actor(), q.id, {
      optionId: q.options[0]!.id,
      description: "Original",
      unitPriceCents: 999,
    });
    await estimates.transition(actor(), q.id, { toStatus: "sent" });
    const outcomes = await Promise.allSettled([
      parity.createRevision(actor(), q.id),
      parity.createRevision(actor(), q.id),
    ]);
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const current = await estimates.get(actor(), q.id);
    expect(current.version.versionNumber).toBe(2);
    expect(current.options[0]!.lines[0]!.description).toBe("Original");
  });
  it("updates removes and reorders draft lines with stale-write rejection", async () => {
    const q = await estimates.create(actor(), {
        customerId: customer.id,
        tiers: ["custom"],
      }),
      o = q.options[0]!;
    await estimates.addLine(actor(), q.id, {
      optionId: o.id,
      description: "A",
      unitPriceCents: 100,
    });
    await estimates.addLine(actor(), q.id, {
      optionId: o.id,
      description: "B",
      unitPriceCents: 200,
    });
    let view = await estimates.get(actor(), q.id);
    const option = view.options[0]!;
    const line = option.lines[0]!;
    await parity.updateLine(actor(), q.id, option.id, line.id, {
      description: "A2",
      category: "service",
      quantityMilli: 2000,
      unit: "each",
      unitPriceCents: 100,
      taxable: true,
      expectedRowVersion: option.rowVersion,
    });
    view = await estimates.get(actor(), q.id);
    await expect(
      parity.removeLine(
        actor(),
        q.id,
        option.id,
        view.options[0]!.lines[1]!.id,
        option.rowVersion,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await parity.reorderLines(actor(), q.id, {
      optionId: option.id,
      lineIds: view.options[0]!.lines.map((x) => x.id).reverse(),
      expectedRowVersion: view.options[0]!.rowVersion,
    });
    expect(
      (await estimates.get(actor(), q.id)).options[0]!.lines[0]!.description,
    ).toBe("B");
  });
  it("keeps tax profiles tenant-local", async () => {
    expect(await new TaxService().current(actor())).not.toBeNull();
    expect(await new TaxService().current(foreign())).toBeNull();
    await expect(
      estimates.create(actor(), { customerId: foreignCustomer.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
