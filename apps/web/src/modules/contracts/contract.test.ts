import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/lib/errors";
import { can } from "@/auth/permissions";
import {
  addSignerSchema,
  createContractSchema,
  signContractSchema,
} from "./contract.schema";
import {
  assertCanRevise,
  assertDraft,
  binarySha256,
  contractDocumentHash,
  createContractCapability,
  deriveSigningStatus,
  hashContractCapability,
  parseDrawnSignature,
} from "./contract.rules";

describe("Contract domain rules", () => {
  it("creates high-entropy hashed capabilities without storing the raw value", () => {
    const token = createContractCapability();
    expect(token.length).toBeGreaterThan(40);
    expect(hashContractCapability(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashContractCapability(token)).not.toContain(token);
  });
  it("derives multi-signer lifecycle deterministically", () => {
    expect(deriveSigningStatus(["pending", "viewed"])).toBe("sent");
    expect(deriveSigningStatus(["signed", "pending"])).toBe("partially_signed");
    expect(deriveSigningStatus(["signed", "signed"])).toBe("signed");
    expect(deriveSigningStatus(["signed", "declined"])).toBe("declined");
    expect(deriveSigningStatus(["revoked", "expired"])).toBe("expired");
  });
  it("freezes issued content and disallows signed revisions", () => {
    expect(() => assertDraft("sent")).toThrow(ConflictError);
    expect(() => assertCanRevise("signed")).toThrow(ConflictError);
    expect(() => assertCanRevise("declined")).not.toThrow();
  });
  it("validates strict creation, signer, and signing inputs", () => {
    expect(
      createContractSchema.safeParse({
        quoteId: crypto.randomUUID(),
        title: "Agreement",
        organizationId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      addSignerSchema.safeParse({ name: "Signer", email: "bad" }).success,
    ).toBe(false);
    expect(
      signContractSchema.safeParse({ signerName: "Signer", method: "drawn" })
        .success,
    ).toBe(false);
  });
  it("accepts a real PNG signature and rejects disguised bytes", () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    expect(
      parseDrawnSignature(`data:image/png;base64,${png.toString("base64")}`),
    ).toHaveLength(9);
    expect(() =>
      parseDrawnSignature(
        `data:image/png;base64,${Buffer.from("not png").toString("base64")}`,
      ),
    ).toThrow(ValidationError);
  });
  it("keeps Contract permissions front-office only", () => {
    expect(can({ role: "manager" }, "contract.send")).toBe(true);
    expect(can({ role: "member" }, "contract.read")).toBe(false);
    expect(can({ role: "viewer" }, "contract.read")).toBe(true);
    expect(can({ role: "viewer" }, "contract.update")).toBe(false);
  });
  it("produces stable document fingerprints", () => {
    expect(contractDocumentHash({ a: 1 })).toBe(contractDocumentHash({ a: 1 }));
    expect(contractDocumentHash({ a: 1 })).not.toBe(
      contractDocumentHash({ a: 2 }),
    );
  });
  it("hashes retained bytes exactly", () => {
    expect(binarySha256(new TextEncoder().encode("artifact"))).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(binarySha256(new Uint8Array([1]))).not.toBe(
      binarySha256(new Uint8Array([2])),
    );
  });
});
