/**
 * Phase 9.2 — narrow, provider-specific send interfaces. Deliberately two
 * separate interfaces, not one generic `MessageProvider` (per this phase's
 * explicit instruction) — email and SMS have genuinely different inputs
 * (subject/html/text vs. a single body) and different providers, and
 * collapsing them would just push a runtime `if (channel === ...)` branch
 * into every adapter instead of letting the dispatcher pick the right one.
 */

export interface EmailSendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** The outbox row's own stable `dedupe_key` (Phase 9.0) — passed through
   *  so an adapter that supports provider-side send idempotency (Resend
   *  does, via an `Idempotency-Key` header) can use OUR stable identity as
   *  its own, closing the "provider accepted the message but the Worker
   *  died before marking the row sent" duplicate-send window (Phase 9.4's
   *  "Uncertain Provider Outcome" finding). Not independently re-verified
   *  against Resend's live API this session — see the Phase 9.4 report for
   *  the exact confidence level; a harmless no-op if the provider ignores
   *  the header. */
  idempotencyKey: string;
}

export interface SmsSendInput {
  to: string;
  body: string;
  /** See EmailSendInput.idempotencyKey. Twilio's core Messages API has no
   *  documented equivalent to a Stripe/Resend-style idempotency-key header
   *  (unlike Resend) — the Twilio adapter deliberately does NOT invent one.
   *  Carried on the interface for symmetry/future use, currently unused by
   *  createTwilioSmsProvider(). This is a genuine, disclosed residual gap
   *  for SMS, not an oversight — see the Phase 9.4 report. */
  idempotencyKey: string;
}

export interface ProviderSendResult {
  providerMessageId: string;
}

export interface EmailProvider {
  send(input: EmailSendInput): Promise<ProviderSendResult>;
}

export interface SmsProvider {
  send(input: SmsSendInput): Promise<ProviderSendResult>;
}

/** A sanitized, safe-to-persist error — never wraps a raw provider response,
 *  header, or stack trace. Adapters throw this (never a raw Error carrying
 *  provider internals); the dispatcher persists `.code`/`.message` verbatim
 *  into `notification_outbox.last_error` / `notification_delivery_attempts`,
 *  so sanitization must happen HERE, at the adapter boundary, not later. */
export class ProviderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const SAFE_CODE_PATTERN = /^[a-z0-9_]+$/;

/** Maps an HTTP status from a provider response to a short, safe error code
 *  — never includes the response body (which may echo back request headers,
 *  account identifiers, or other provider-internal detail). */
export function statusToErrorCode(status: number): string {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_server_error";
  if (status >= 400) return "provider_rejected_request";
  return "provider_unknown_error";
}

/** Truncates and strips anything resembling a credential before it can ever
 *  reach a stored column. Defense in depth — adapters should never pass a
 *  raw provider body through in the first place, but this is what the test
 *  suite's secret-leak tests actually verify against. */
export function sanitizeErrorMessage(message: string): string {
  const stripped = message
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/Basic\s+\S+/gi, "[redacted]")
    .replace(/"?(api[_-]?key|auth[_-]?token|authorization|password|secret)"?\s*[:=]\s*"?[^\s",}]+/gi, "$1=[redacted]");
  return stripped.slice(0, 300);
}

export function safeCode(code: string): string {
  const trimmed = code.trim().toLowerCase().slice(0, 40);
  return SAFE_CODE_PATTERN.test(trimmed) ? trimmed : "provider_unknown_error";
}
