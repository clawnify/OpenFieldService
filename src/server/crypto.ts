/**
 * AES-256-GCM encryption for secrets at rest (OAuth access/refresh tokens).
 * Key comes from the TOKEN_ENCRYPTION_KEY env var: a base64-encoded 32-byte key,
 * e.g. generated with `openssl rand -base64 32`.
 */

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = Buffer.from(base64Key, "base64");
  if (raw.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded)");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts to `<iv>.<ciphertext>`, both base64url. */
export async function encryptSecret(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`;
}

export async function decryptSecret(payload: string, base64Key: string): Promise<string> {
  const [ivB64, ctB64] = payload.split(".");
  if (!ivB64 || !ctB64) throw new Error("Malformed encrypted payload");
  const key = await importKey(base64Key);
  const iv = new Uint8Array(Buffer.from(ivB64, "base64url"));
  const ciphertext = new Uint8Array(Buffer.from(ctB64, "base64url"));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
