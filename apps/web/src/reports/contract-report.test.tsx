import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { ContractReport, type ContractPdfModel } from "./contract-report";
describe("ContractReport", () => {
  it("renders an immutable Contract snapshot", async () => {
    const model: ContractPdfModel = {
      identifier: "CONTRACT-1",
      versionNumber: 1,
      title: "Agreement",
      body: "Frozen terms",
      effectiveOn: null,
      company: { name: "Synthetic Service" },
      customer: { name: "Synthetic Customer" },
      commercial: {
        quoteIdentifier: "QUOTE-1",
        optionName: "Better",
        lines: [
          {
            description: "Service",
            quantityMilli: 1000,
            unit: "each",
            unitPriceCents: 10000,
            totalCents: 10000,
          },
        ],
        subtotalCents: 10000,
        discountCents: 0,
        taxCents: 1200,
        totalCents: 11200,
        currency: "CAD",
        taxComponents: [
          { name: "Tax", rateBasisPoints: 1200, amountCents: 1200 },
        ],
      },
      signatures: [
        {
          signerName: "Synthetic Signer",
          role: "customer",
          method: "typed",
          signedAt: new Date(0).toISOString(),
          ip: null,
          userAgent: null,
        },
      ],
      documentHash: "a".repeat(64),
    };
    const pdf = await renderToBuffer(<ContractReport model={model} />);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(500);
  });
});
