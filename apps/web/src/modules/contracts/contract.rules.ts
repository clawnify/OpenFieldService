import { createHash, randomBytes } from "node:crypto";
import { ConflictError, ValidationError } from "@/lib/errors";

export const SIGNABLE_CONTRACT_STATUSES = ["sent", "partially_signed"] as const;
export function hashContractCapability(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
export function createContractCapability(): string {
  return randomBytes(32).toString("base64url");
}
export function contractDocumentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function binarySha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function canReviseContract(status: string): boolean {
  return [
    "sent",
    "partially_signed",
    "declined",
    "expired",
    "cancelled",
  ].includes(status);
}
export function assertDraft(status: string): void {
  if (status !== "draft")
    throw new ConflictError("Issued Contract versions are immutable");
}
export function assertCanRevise(status: string): void {
  if (!canReviseContract(status))
    throw new ConflictError(
      "A revision cannot be created from this Contract state",
    );
}
export function deriveSigningStatus(
  statuses: readonly string[],
): "sent" | "partially_signed" | "signed" | "declined" | "expired" {
  if (statuses.some((x) => x === "declined")) return "declined";
  const signed = statuses.filter((x) => x === "signed").length;
  if (signed === statuses.length && signed > 0) return "signed";
  if (signed > 0) return "partially_signed";
  if (
    statuses.length > 0 &&
    statuses.every((x) => ["expired", "revoked"].includes(x))
  )
    return "expired";
  return "sent";
}
export function parseDrawnSignature(dataUrl: string): Uint8Array {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match)
    throw new ValidationError("Drawn signature must be a PNG data URL");
  const bytes = Uint8Array.from(Buffer.from(match[1]!, "base64"));
  if (
    bytes.length < 8 ||
    bytes.length > 2_000_000 ||
    !bytes
      .slice(0, 8)
      .every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i])
  )
    throw new ValidationError("Invalid drawn signature image");
  return bytes;
}
