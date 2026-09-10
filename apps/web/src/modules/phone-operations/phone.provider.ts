import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getServerEnv } from "@/lib/env";

export interface ProtectedSecret { ciphertext: string; iv: string; tag: string }
export interface SecretProtector { protect(value: string): ProtectedSecret; reveal(value: ProtectedSecret): string }
export class AesGcmSecretProtector implements SecretProtector {
  private readonly key: Buffer;
  constructor(key: string) { this.key = createHash("sha256").update(key).digest(); }
  protect(value: string) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv), encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return { ciphertext: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") }; }
  reveal(value: ProtectedSecret) { const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(value.iv, "base64")); decipher.setAuthTag(Buffer.from(value.tag, "base64")); return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8"); }
}
export interface OutboundCallRequest { accountSid: string; authToken: string; from: string; to: string; statusCallbackUrl: string; voiceUrl: string }
export interface OutboundCallResult { providerCallId: string; status: string }
export interface PhoneProviderAdapter { placeCall(input: OutboundCallRequest): Promise<OutboundCallResult> }
export class TwilioPhoneAdapter implements PhoneProviderAdapter {
  constructor(private readonly request: typeof fetch = fetch) {}
  async placeCall(input: OutboundCallRequest) { const body = new URLSearchParams({ From: input.from, To: input.to, Url: input.voiceUrl, StatusCallback: input.statusCallbackUrl, StatusCallbackMethod: "POST" }); const response = await this.request(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(input.accountSid)}/Calls.json`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${input.accountSid}:${input.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body }); if (!response.ok) throw new Error("Phone provider rejected the outbound call"); const data = await response.json() as { sid?: string; status?: string }; if (!data.sid) throw new Error("Phone provider returned an invalid response"); return { providerCallId: data.sid, status: data.status ?? "queued" }; }
}
export function phoneProtectorFromEnvironment() { const key = getServerEnv().PHONE_OPERATIONS_ENCRYPTION_KEY; if (!key) throw new Error("Phone Operations encryption is not configured"); return new AesGcmSecretProtector(key); }
