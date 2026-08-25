/**
 * Phase 13B — PaymentProvider abstraction (Section 9). Core must never be
 * locked to one payment company: every call site that needs to talk to a
 * payment processor goes through this interface, never a provider SDK
 * directly. This pass ships exactly one implementation, `MockPaymentProvider`
 * — a fully local, deterministic simulator with zero network calls and zero
 * real credentials — per the task's explicit instruction not to activate or
 * configure a real production provider this phase.
 *
 * Shape mirrors what a real card/Interac processor (Stripe, Moneris,
 * Helcim, Bambora — see the production-provider recommendation in
 * docs/PLATFORM-GENERALIZATION-AUDIT.md) actually needs: create a session,
 * poll/verify its status, verify an inbound webhook's authenticity, cancel
 * a still-pending session, and (forward-looking only — not exercised by any
 * route this phase) issue a refund. `financial.ts`'s payment-session
 * functions are the ONLY caller of this interface — no route handler
 * touches a provider directly.
 */

export type PaymentSessionStatus = "pending" | "succeeded" | "failed" | "cancelled" | "expired";

export interface CreatePaymentSessionInput {
  amountCents: number;
  currency: string;
  invoiceIdentifier: string;
  /** Opaque metadata a real provider would echo back on its webhook —
   *  never trusted as authoritative on its own (see webhook verification). */
  metadata: Record<string, string>;
}

export interface CreatePaymentSessionResult {
  providerSessionId: string;
}

export interface PaymentStatusResult {
  status: PaymentSessionStatus;
  providerTransactionId: string | null;
}

export interface WebhookEvent {
  providerSessionId: string;
  status: PaymentSessionStatus;
  providerTransactionId: string | null;
  amountCents: number;
}

export interface RefundResult {
  providerRefundId: string;
}

export interface PaymentProvider {
  readonly name: string;
  createPaymentSession(input: CreatePaymentSessionInput): Promise<CreatePaymentSessionResult>;
  getPaymentStatus(providerSessionId: string): Promise<PaymentStatusResult>;
  /** Verifies an inbound webhook's authenticity and returns the parsed
   *  event, or `null` if the signature/body is invalid — callers must
   *  treat `null` as "reject, do not act on this payload", never fall
   *  back to trusting it anyway. */
  verifyWebhook(rawBody: string, signature: string | null, secret: string): Promise<WebhookEvent | null>;
  cancelPaymentSession(providerSessionId: string): Promise<void>;
  refundPayment(providerTransactionId: string, amountCents: number): Promise<RefundResult>;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time-ish comparison — string length/content differences don't
 *  short-circuit at the first byte via `===`, avoiding a trivial timing
 *  oracle on the signature check (same discipline as any secret compare). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Local/mock provider (Section 9's required default for this phase). No
 *  network calls, no external state — a "session" is fully described by
 *  its own id; this class holds no state of its own. `getPaymentStatus`
 *  cannot know anything a real provider wouldn't have told us, so the
 *  caller (financial.ts) is responsible for tracking OUR OWN
 *  `payment_sessions` row as the durable record — this class only ever
 *  simulates what a provider's OWN API surface looks like, exercising the
 *  exact call shape (including real HMAC webhook-signature verification)
 *  a production adapter would need to satisfy, per Section 30's explicit
 *  instruction that the mock "simulate equivalent business rules where
 *  practical." */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";

  async createPaymentSession(input: CreatePaymentSessionInput): Promise<CreatePaymentSessionResult> {
    const id = `mock_sess_${toBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
    void input;
    return { providerSessionId: id };
  }

  /** The mock provider has no independent state to poll — the real
   *  provider status IS whatever the webhook already told us, which
   *  financial.ts persists on `payment_sessions.status`. Exposed for
   *  interface completeness / future-real-provider parity; not called on
   *  the hot path (the webhook path is authoritative here). */
  async getPaymentStatus(): Promise<PaymentStatusResult> {
    return { status: "pending", providerTransactionId: null };
  }

  /** Real HMAC-SHA256 verification against a per-deployment secret — the
   *  ONE piece of "production provider" logic this mock genuinely
   *  exercises for real, so the webhook route's security code path is
   *  actually tested, not stubbed to `return true`. `rawBody` must be the
   *  exact bytes that were signed (never a re-serialized/parsed-then-
   *  reserialized version — re-serialization can silently change byte
   *  content, e.g. key order, and would break real-provider verification
   *  the same way it would break this one). */
  async verifyWebhook(rawBody: string, signature: string | null, secret: string): Promise<WebhookEvent | null> {
    if (!signature) return null;
    let expected: string;
    try {
      expected = await hmacSha256Hex(secret, rawBody);
    } catch {
      return null;
    }
    if (!safeEqual(expected, signature)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.providerSessionId !== "string" || typeof p.status !== "string" || typeof p.amountCents !== "number") return null;
    if (!["pending", "succeeded", "failed", "cancelled", "expired"].includes(p.status)) return null;
    return {
      providerSessionId: p.providerSessionId,
      status: p.status as PaymentSessionStatus,
      providerTransactionId: typeof p.providerTransactionId === "string" ? p.providerTransactionId : null,
      amountCents: p.amountCents,
    };
  }

  async cancelPaymentSession(): Promise<void> {
    // No external state to cancel — the caller marks its own
    // payment_sessions row cancelled. Present for interface parity.
  }

  async refundPayment(providerTransactionId: string): Promise<RefundResult> {
    return { providerRefundId: `mock_refund_${toBase64Url(crypto.getRandomValues(new Uint8Array(12)))}_${providerTransactionId.slice(0, 8)}` };
  }
}

/** Signs a payload the same way a real provider's webhook sender would —
 *  used by the mock "customer clicks Pay Now" flow to construct a
 *  same-shape signed event and feed it through the REAL verification path
 *  (see financial.ts#confirmMockPayment), rather than bypassing signature
 *  checking for the mock case. Not part of the PaymentProvider interface —
 *  a real provider signs on ITS side; only the mock needs to sign on ours
 *  because there is no separate external process to do it. */
export async function signMockWebhookPayload(secret: string, event: WebhookEvent): Promise<{ rawBody: string; signature: string }> {
  const rawBody = JSON.stringify(event);
  const signature = await hmacSha256Hex(secret, rawBody);
  return { rawBody, signature };
}
